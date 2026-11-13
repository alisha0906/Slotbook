# AI_LOG

How AI (an in-editor coding assistant) was used to build Slotbook, where it
helped, where it got things wrong, and what was changed by hand.

## How I worked with it

- The assistant scaffolded the monorepo, the Postgres schema + migration, the
  slot-generation logic, the Fastify API, the concurrency test, and the React
  UI, then iterated against a **real Postgres running in Docker** after every
  change. Nothing was accepted as "done" until it was verified against the
  running stack (health check, curl flows, the Vitest suite, and the browser).
- The environment was Windows + WSL2 (Ubuntu) with Docker Engine inside WSL.
  The one-command path (`docker compose up --build`) was the verification loop.

## Where it helped

- **Schema and constraints.** Translating the brief into tables with the right
  `CHECK` constraints (duration 15–120, buffers 0–30, capacity ≥ 1) and the
  unique indexes that back correctness — `(event_type_id, idempotency_key)` and
  `manage_token` — was fast and accurate.
- **Time-zone slot generation.** Getting Luxon to materialize availability
  windows in the host zone and convert to UTC (so DST offsets apply per-date)
  was produced correctly the first time and matched hand-checked expectations
  (e.g. a November New York slot came back at `-05:00`).
- **Concurrency design.** The advisory-lock-per-slot approach for "no
  double-booking" was proposed and implemented cleanly, and the test that fires
  50 simultaneous holds at a capacity-1 slot proved it.

## Where it got things wrong (and what was fixed)

Three real bugs surfaced only by running the code — a good reminder that an
assistant's output needs execution, not just review.

1. **`pg` timestamps: `Date` vs `string`.**
   The first hold attempt crashed with `b.slot_start.toISOString is not a
   function`. The serialization code assumed the `pg` driver always returns
   `timestamptz` as a JS `Date`, but in the `INSERT ... RETURNING` path the
   value arrived as a string. **Fix:** a `toIso()` helper that normalizes
   `Date | string` everywhere a row timestamp is serialized or compared. The
   `BookingRow` type was widened to `Date | string` to make the hazard explicit.

2. **Idempotency vs capacity ordering (concurrency).**
   The concurrency test caught this one. With 20 concurrent holds sharing one
   `Idempotency-Key`, only 11 succeeded — the rest were wrongly rejected as
   `slot_full`. Root cause: the idempotency check ran *before* the per-slot
   advisory lock, so same-key requests all passed the initial "no existing row"
   check, then raced for capacity. **Fix:** take the slot lock first, then check
   idempotency inside the lock. Now a retry always resolves to the existing hold
   instead of racing capacity. This was a genuine correctness fix, not a test
   tweak — and it made the suite faster (same-key requests short-circuit).

3. **Fetch headers dropped `Content-Type` (frontend).**
   In the browser, every POST (hold, confirm, cancel) failed with
   `400 invalid_body` / "Expected object, received string", while the identical
   request worked from curl. Root cause in the API client: the `fetch` wrapper
   set merged headers first, then spread `...init` *after* — and because `init`
   carried its own `headers` (e.g. the `Idempotency-Key`), the spread
   overwrote the merged headers and dropped `Content-Type: application/json`.
   Fastify then didn't JSON-parse the body, so the handler received a raw
   string. **Fix:** spread `...init` first, set `headers` last so the merge
   wins. GET reads had masked the bug because they passed no custom headers.

## What was changed by hand / decided by the human

- Stack choice: **Node API (Fastify) + React (Vite)**, single-port serving (the
  API serves the built SPA) rather than a Next.js all-in-one.
- Product decisions during the build: guest booking stays fully public (no
  login) while the host dashboard is auth-gated; the dashboard gained a "Manage"
  action (reschedule/cancel) in addition to host cancel.
- Scope calls: keep the seeded "token = host id" auth and document it as a known
  gap rather than build full sessions/JWT, since real auth is beyond the core.

## Takeaway

The assistant was strongest at structure, schema, and the time-zone math, and
weakest at runtime edge cases that only appear when the code actually runs
against Postgres and a browser. Every one of the three bugs above was found by
running the stack, which is why the workflow was build → run → verify on every
step.
