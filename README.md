# Slotbook

A small, reliable Calendly-style booking engine. Hosts publish when they are free,
guests book a slot, and nobody is ever double-booked — even under concurrency,
clock skew, or misbehaving clients. Postgres is the single source of truth for
booking correctness.

> Status: **foundation in place** (monorepo, Docker, Postgres schema, migrations,
> seed, health check). Booking API and React UI are built in subsequent passes.

## Stack

- **Backend:** Node + [Fastify](https://fastify.dev) + TypeScript
- **Frontend:** React + Vite + TypeScript _(coming next)_
- **Database:** Postgres 15
- **ORM / SQL:** [Drizzle ORM](https://orm.drizzle.team) with hand-written SQL migrations
- **Time zones:** [Luxon](https://moment.github.io/luxon/) for IANA-aware slot generation

## Layout

```
.
├── docker-compose.yml        # Postgres + API
├── apps/
│   └── api/                  # Fastify API, schema, migrations, seed
│       ├── drizzle/          # SQL migrations (applied in order at startup)
│       └── src/
│           ├── config.ts     # env-driven config
│           ├── server.ts     # Fastify app + /health
│           └── db/
│               ├── schema.ts # Drizzle schema (data model)
│               ├── client.ts # pool + drizzle client
│               ├── migrate.ts# migration runner
│               └── seed.ts   # demo host + two event types
└── packages/                 # shared types + slot logic (coming next)
```

## Run it

### Option A — Docker (one command)

```bash
docker compose up --build
```

This starts Postgres, runs migrations, seeds the demo host, and starts the API.
Check health:

```bash
curl http://localhost:4000/health
```

### Option B — local dev against compose Postgres

```bash
# 1. start just the database
docker compose up -d db

# 2. install deps and set env
pnpm install
cp .env.example .env

# 3. migrate + seed + run the API
pnpm db:migrate
pnpm db:seed
pnpm dev
```

## Seeded demo data

- **Host:** `demo` — time zone `America/New_York`
  - login: `demo@slotbook.test` / `demo1234`
- **Event types:**
  - `intro-call` — 30 min, capacity 1 (one-on-one), 10 min buffer after, 4 h notice
  - `group-office` — 60 min, capacity 5 (group), 2 h notice
  - Weekly availability Mon–Fri 09:00–17:00 (host time zone)
  - One date override: `intro-call` closed next Monday

## Data model (summary)

| Table                | Purpose                                                        |
| -------------------- | -------------------------------------------------------------- |
| `hosts`              | host identity, IANA time zone, seeded login                    |
| `event_types`        | name/slug, duration, capacity, buffers, notice, horizon        |
| `availability_rules` | weekly windows in the host's time zone                         |
| `date_overrides`     | day off or custom hours for a specific date                    |
| `bookings`           | held / confirmed / cancelled / expired, hold expiry, manage token, idempotency key |
| `notifications`      | sink for confirm / reschedule / cancel events                  |

Correctness rules baked into the model:

- All instants stored as `timestamptz` (UTC); availability stored as local
  wall-clock time + host time zone, converted to UTC at slot-generation time.
- Only `held` (not yet expired) and `confirmed` rows count against capacity.
- `(event_type_id, idempotency_key)` is unique, so a retried hold request maps
  to a single hold.
- `manage_token` is unique and unguessable (random UUID) for the guest link.

## Tests (concurrency against real Postgres)

The reliability proof runs against a real Postgres (no mocks), in one command:

```bash
docker compose up -d db
docker compose run --rm --build tests
```

This builds a test image and runs the suite in `apps/api/test/`:

- **capacity 1** — 50 simultaneous holds on one slot → exactly 1 succeeds, 49
  get `slot_full`, and the database confirms exactly 1 active row.
- **capacity 5 (group)** — 40 simultaneous holds → exactly 5 succeed.
- **idempotency** — 20 concurrent holds with the same `Idempotency-Key` resolve
  to a single booking (one row created, same id returned to all callers).
- **sequential sanity** — a second hold on a full capacity-1 slot is rejected.

How no-double-booking is guaranteed: every hold opens a transaction, takes a
Postgres transaction-scoped advisory lock keyed on `(event_type_id, slot_start)`,
then checks capacity and inserts. Concurrent holds for the same slot serialize on
that lock, so capacity can never be exceeded. Idempotency is checked inside the
lock, so a retried request returns the existing hold instead of racing capacity.

## API

All responses are JSON. Instants are UTC ISO-8601. Same-origin under `/api`.

### Public (guest)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | Available slots in a range, in time zone `tz` (defaults to the host zone). Full slots are omitted. |
| `GET` | `/api/hosts/{host}/events/{slug}/id` | Resolve a public slug to the event type id (used by the hold call). |
| `POST` | `/api/holds` | Hold a slot. Body `{ eventTypeId, slotStart }`. Send an `Idempotency-Key` header; a retry returns the same hold. → `201` booking (`status: held`, `holdExpiresAt`). |
| `POST` | `/api/holds/{id}/confirm` | Confirm a hold. Body `{ guestName, guestEmail }`. → booking (`status: confirmed`, `manageToken`). |
| `GET` | `/api/bookings/{token}` | View a booking by its private manage token. |
| `POST` | `/api/bookings/{token}/reschedule` | Move the booking. Body `{ slotStart }`. |
| `POST` | `/api/bookings/{token}/cancel` | Cancel. Body `{ reason? }`. |

### Host (authenticated — `Authorization: Bearer <token>`)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/host/login` | Body `{ email, password }`. → `{ token, host }`. |
| `GET` | `/api/host/bookings` | Upcoming `held`/`confirmed` bookings for the host. |
| `POST` | `/api/host/bookings/{id}/cancel` | Cancel one of the host's bookings. Body `{ reason? }`. |

### Ops

`GET /health` — liveness + DB readiness probe.

**Error shape:** `{ "error": "<code>", "message": "<human text>" }`. Notable
codes: `slot_full` (409), `invalid_slot` / `expired` / `invalid_state` (422),
`not_found` (404), `unauthorized` (401), `invalid_body` (400).

### Example (full guest flow)

```bash
BASE=http://localhost:4000
EVID=$(curl -s "$BASE/api/hosts/demo/events/intro-call/id" | sed 's/.*"eventTypeId":"//; s/".*//')
SLOT=$(curl -s "$BASE/api/hosts/demo/events/intro-call/slots?tz=America/New_York" \
  | grep -o '"startUtc":"[^"]*"' | head -1 | sed 's/.*:"//; s/"//')

HOLD=$(curl -s -X POST "$BASE/api/holds" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' -d "{\"eventTypeId\":\"$EVID\",\"slotStart\":\"$SLOT\"}")
HOLD_ID=$(echo "$HOLD" | grep -o '"id":"[^"]*"' | head -1 | sed 's/.*:"//; s/"//')

curl -s -X POST "$BASE/api/holds/$HOLD_ID/confirm" -H 'Content-Type: application/json' \
  -d '{"guestName":"Asha","guestEmail":"asha@example.com"}'
```

## 60-second UI tour

Open **http://localhost:4000** after `docker compose up`.

1. **Landing** (`/`) — links to the two demo booking pages and the dashboard.
2. **Book as a guest** (`/demo/intro-call`) — pick a time zone from the switcher,
   click a slot (it's held for 5 minutes, with a live countdown), enter name +
   email, and **Confirm**. You get a **Manage** link.
3. **Manage** (`/manage/:token`) — view the booking, **Reschedule** to another
   slot, or **Cancel** with a reason. (This link is public but unguessable.)
4. **Host dashboard** (`/dashboard`) — log in with `demo@slotbook.test` /
   `demo1234`. See all upcoming bookings; **Manage** opens the reschedule/cancel
   page, **Cancel** cancels with a reason. Guest booking stays public; the
   dashboard is the only login-gated surface.

## Documents

- `REPORT.md` — architecture, data model, key decisions, reliability, the DST
  worked example, testing, and known gaps.
- `AI_LOG.md` — how AI was used, the three real bugs it introduced, and the fixes.
