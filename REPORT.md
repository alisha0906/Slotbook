# Slotbook — Engineering Report

A small, reliable Calendly-style booking engine. Hosts publish availability,
guests book slots, and **nobody is ever double-booked** — even under concurrent
requests, clock skew, or a misbehaving client. Postgres is the single source of
truth for correctness.

---

## 1. Links

- **Repository:** _<add your public GitHub URL here>_
- **Live URL:** _not deployed (runs locally via `docker compose up`)_
- **Run locally:**
  ```bash
  docker compose up --build        # starts Postgres + API, migrates, seeds
  # open http://localhost:4000
  ```
- **Tests (concurrency vs real Postgres):**
  ```bash
  docker compose up -d db
  docker compose run --rm --build tests
  ```

Seeded demo host: `demo@slotbook.test` / `demo1234`, time zone
`America/New_York`, with event types `intro-call` (30 min, one-on-one) and
`group-office` (60 min, capacity 5).

---

## 2. Architecture

```
                         Browser (React + Vite SPA)
            ┌───────────────────────┬────────────────────────┐
            │  /demo/intro-call      │  /dashboard             │
            │  public booking page   │  host (authenticated)   │
            │  /manage/:token        │                         │
            └───────────┬───────────┴────────────┬────────────┘
                        │  fetch /api/*  (same origin)
                        ▼
              ┌─────────────────────────────────────────┐
              │           Fastify API (Node, TS)         │
              │                                          │
              │  routes/booking.ts   routes/host.ts      │
              │  domain/slots.ts     domain/bookings.ts  │
              │  domain/eventTypes   domain/notifications│
              │  worker.ts  (hold-expiry sweep)          │
              │  serves built SPA from /app/apps/web-dist│
              └───────────────────┬──────────────────────┘
                                  │  SQL (pg Pool, explicit txns)
                                  ▼
                        ┌───────────────────────┐
                        │     Postgres 15        │
                        │  source of truth;      │
                        │  advisory locks +      │
                        │  constraints enforce   │
                        │  no double-booking     │
                        └───────────────────────┘
```

**How a booking request flows (the hot path):**

1. Guest opens `/{host}/{event-slug}`. The SPA calls
   `GET /api/hosts/{host}/events/{slug}/slots?tz=...`.
2. The API loads the event type + its weekly rules and date overrides, generates
   candidate slots in UTC (time-zone aware), subtracts active holds/confirmed
   per slot, and returns only slots with remaining capacity.
3. Guest picks a slot → `POST /api/holds` with an `Idempotency-Key`. The API
   opens a transaction, takes a Postgres advisory lock keyed on
   `(event_type_id, slot_start)`, checks idempotency, checks capacity, inserts a
   `held` row with `hold_expires_at = now() + 5 min`, commits.
4. Guest enters name/email within 5 minutes → `POST /api/holds/{id}/confirm`.
   Status flips to `confirmed`; a `booking_confirmed` row is written to the
   notifications sink; the guest receives a private `manage_token`.
5. `POST /api/bookings/{token}/reschedule` and `.../cancel` move or cancel the
   booking, each emitting a notification.
6. A background worker sweeps expired holds to `expired` every 30 s. Correctness
   does not depend on it (see §5).

**Single-origin deployment.** The production image builds the React app and
Fastify serves the static bundle, so the whole app lives on `localhost:4000`
with no CORS and one port — simplest for a reviewer.

---

## 3. Data model

All instants are stored as `timestamptz` (UTC). Availability is stored as local
wall-clock time plus the host's IANA time zone, and converted to UTC instants at
slot-generation time.

| Table | Key columns | Notable constraints |
|---|---|---|
| `hosts` | `id`, `slug` (unique), `email` (unique), `timezone`, `password_hash` | — |
| `event_types` | `host_id`→hosts, `slug`, `duration_min`, `capacity`, `buffer_before_min`, `buffer_after_min`, `min_notice_min`, `horizon_days` | `duration 15–120`, `buffers 0–30`, `capacity ≥ 1`, `horizon ≥ 1`; unique `(host_id, slug)` |
| `availability_rules` | `event_type_id`→event_types, `weekday 0–6`, `start_time`, `end_time` | `weekday 0–6`, `end_time > start_time` |
| `date_overrides` | `event_type_id`, `override_date`, `is_closed`, `start_time?`, `end_time?` | closed OR a valid window |
| `bookings` | `event_type_id`, `slot_start`, `slot_end`, `status`, `hold_expires_at`, `guest_name`, `guest_email`, `manage_token`, `idempotency_key`, `cancel_reason` | unique `manage_token`; unique `(event_type_id, idempotency_key)`; index `(event_type_id, slot_start, status)` |
| `notifications` | `booking_id?`, `type`, `payload` (JSON), `created_at` | — |

**Status enum:** `held → confirmed → cancelled`; an unconfirmed hold becomes
`expired`. **Capacity counts only `confirmed` and non-expired `held` rows** —
never `expired` or `cancelled`.

**Constraints that back correctness:**
- Unique `(event_type_id, idempotency_key)` — a retried hold can create at most
  one row.
- Unique, random `manage_token` — the guest's capability link is unguessable.
- Index `(event_type_id, slot_start, status)` — fast capacity counts per slot.

---

## 4. Key decisions

1. **Postgres advisory locks for no-double-booking (vs. unique index / SERIALIZABLE).**
   A partial unique index works for capacity = 1 but not for group capacity > 1.
   `SERIALIZABLE` would work but adds retry handling and contention across
   unrelated slots. A transaction-scoped advisory lock keyed on
   `(event_type_id, slot_start)` serializes only the requests that actually
   contend (same slot), handles any capacity, and needs no first row to lock.
   **Chosen** for correctness with minimal contention.

2. **Expiry is advisory, not load-bearing.** Capacity queries treat a `held` row
   with `hold_expires_at <= now()` as free, so a hold stops consuming capacity
   the instant it expires — whether or not the sweep has run. The worker only
   tidies state. Alternative (rely on the sweep) would create a window where an
   expired hold still blocks a slot. **Chosen** the fail-safe reading.

3. **Idempotency inside the slot lock.** The `Idempotency-Key` row is unique per
   `(event_type_id, key)`, and the idempotency check runs *after* acquiring the
   slot lock, so a retried request resolves to the existing hold rather than
   racing capacity (this was a real bug we fixed — see §5 / AI_LOG). Alternative
   (check before locking) spuriously rejected retries as `slot_full`.

4. **Store wall-clock availability + IANA zone; convert to UTC per date.**
   Storing availability as UTC would break across DST. Storing local time + zone
   and converting each date with Luxon means 09:00 stays 09:00 local year-round
   and the UTC instant shifts automatically at DST boundaries (see §6).

5. **Node (Fastify) + React (Vite), single-origin.** The brief allowed any
   framework. A small Fastify API with explicit SQL transactions keeps the
   correctness-critical code obvious and easy to reason about, and serving the
   built SPA from the same server removes CORS and gives a one-URL demo.

6. **Server re-validates every requested slot.** Clients send an explicit
   `slotStart`; the server regenerates the schedule and confirms the instant is a
   genuine, bookable slot (within notice + horizon) before holding. Clients can
   never hold arbitrary times.

7. **Seeded "token = host id" auth, documented as a gap.** The brief permits a
   seeded login. Full sessions/JWT + password hashing are out of core scope;
   the simple token still enforces the public-vs-host boundary and host-scoping
   of queries. Called out in §10.

---

## 5. Reliability

Failure cases identified and designed for, each with the test that proves it.

| Failure case | How the system handles it | Proven by |
|---|---|---|
| **Two guests race for the last seat** | Each hold takes an advisory lock on `(event_type_id, slot_start)`; capacity is checked inside the lock; only one can insert. | `concurrency.test.ts`: 50 simultaneous holds on a capacity-1 slot → exactly **1** succeeds, 49 get `slot_full`, DB confirms 1 active row. |
| **Group capacity exceeded under load** | Same lock + count; stops exactly at capacity. | 40 simultaneous holds on capacity-5 → exactly **5** succeed. |
| **Client retries a hold (network blip, double-click)** | `Idempotency-Key` unique per event type; check runs inside the lock; retry returns the same hold. | 20 concurrent holds with one key → **1** booking, same id returned to all; `23505` fallback re-reads the winner. |
| **Guest never confirms a hold** | `hold_expires_at = now()+5m`; capacity treats expired holds as free immediately; worker marks them `expired`. | Capacity count query excludes `held AND hold_expires_at <= now()`; sequential test shows a full slot blocks. |
| **`pg` returns timestamp as string not Date** | `toIso()` normalizes `Date | string` on every serialize/compare. | Fixed after the first hold crashed; guest flow now confirmed end-to-end. |
| **POST body not parsed (frontend)** | API client sends `Content-Type: application/json` on every write. | Fixed header-merge bug; hold/confirm/cancel all work in the browser. |
| **Reschedule into a full slot** | Destination slot is locked and capacity-checked (excluding the moving booking) before the move; fails closed. | `rescheduleBooking` advisory lock + count; returns `slot_full` if destination is full. |

The concurrency suite runs against a **real Postgres** (no mocks) via
`docker compose run --rm --build tests` — 4/4 passing.

---

## 6. Time zones (with a DST worked example)

**Generation.** Availability is stored as local wall-clock windows (e.g.
Mon–Fri 09:00–17:00) in the host's IANA zone. To produce slots, we walk each
calendar day *in the host zone*, build each window's start/end as a Luxon
`DateTime` in that zone (so the correct UTC offset for that date is applied),
then convert to UTC. Candidate starts step by `duration + buffers`.

**Display.** Slots are returned as UTC instants plus a localized label; the
guest page converts UTC → the chosen browser zone with a time-zone switcher.

**Worked DST example — America/New_York spring-forward, 9 March 2025.**
On that date the US moves clocks forward: 02:00 EST (`-05:00`) jumps to 03:00
EDT (`-04:00`), so wall-clock 02:00–02:59 does not exist.

- A 09:00 local slot **before** DST (e.g. Fri 7 Mar 2025) is EST `-05:00`:
  `09:00 -05:00` → **`14:00Z`**.
- A 09:00 local slot **after** DST (e.g. Mon 10 Mar 2025) is EDT `-04:00`:
  `09:00 -04:00` → **`13:00Z`**.

So the *same* "9 AM" availability correctly maps to a **different UTC instant**
across the transition — the engine never hard-codes an offset. If a window ever
covered the skipped 02:00–02:59 hour, Luxon resolves the non-existent local time
forward, and because slots must fit entirely inside the window, no impossible
slot is emitted.

(Observed in the running system: a November New York slot returns
`startLocal: ...T09:00:00-05:00` → `startUtc: ...T14:00:00Z`, i.e. EST, as
expected for that date.)

---

## 7. Optional extensions

None of the optional extensions were built — the time was spent making the core
and its reliability solid (concurrency-safe capacity, idempotency, DST-correct
slots, the real-Postgres concurrency suite). The architecture leaves clear seams
for several:

- **Waitlist / reminders / webhooks** fit naturally on the existing
  `notifications` sink and the `bookings` lifecycle.
- **Daily cap / per-guest limit** are additional checks inside the same
  hold transaction.
- **Observability** — a `/health` endpoint already exists; structured logs via
  Fastify's logger are in place.

---

## 8. Testing

- **What's covered:** the concurrency/reliability core — single-seat race, group
  capacity, idempotency under concurrency, and a sequential full-slot block —
  all against a **real Postgres**.
- **How to run:**
  ```bash
  docker compose up -d db
  docker compose run --rm --build tests
  ```
- **Results:** 4/4 passing. Representative run: capacity-1 race (50 attempts →
  1 win), capacity-5 race (40 → 5), idempotency (20 same-key → 1 booking),
  sequential sanity.
- **Not yet covered (gaps):** unit tests for slot generation / DST edges,
  end-to-end browser tests, and a load test (k6/Artillery) with p95 numbers.
  The slot logic was verified by hand against the running API instead.

---

## 9. Using AI

See `AI_LOG.md` for detail. In short: AI was strong at scaffolding, schema +
constraints, and the Luxon time-zone math, and weak at runtime edge cases that
only appear when the code runs — a `pg` `Date | string` quirk, an
idempotency-vs-capacity ordering race (caught by the concurrency test), and a
frontend header-merge bug that dropped `Content-Type`. Every bug was found by
running the stack, so the loop was build → run → verify on each step.

---

## 10. Known gaps and next steps

- **Auth is seeded/simple.** Host "token" is the host id and passwords are
  compared in plain text (the brief permits a seeded login). Next: hash
  passwords, issue signed, expiring sessions, and invalidate on logout.
- **Host CRUD is partly via seed.** Event-type and availability editing are
  seeded rather than exposed as full dashboard forms; the tables and API shape
  support adding them.
- **No optional extensions yet** (waitlist, reminders, .ics, webhooks, etc.).
- **Test depth.** Add unit tests for slot generation (including DST), Playwright
  e2e for the guest flow, CI on every push, and a k6 load test with throughput /
  p95 / error-rate numbers.
- **Observability.** `/health` and structured logs exist; add request IDs and
  basic metrics (bookings, hold expiries, notification lag).

**With another day:** password hashing + real sessions, host availability
editing UI, a waitlist built on the notifications sink, and a k6 load test with
reported p95 latency.
