import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getSlots,
  holdSlot,
  confirmHold,
  type SlotsResponse,
  type Booking,
} from "../api";
import { browserZone, zoneOptions, formatTime, groupByDay } from "../tz";

type Slot = SlotsResponse["slots"][number];
type Stage = "pick" | "details" | "done";

/**
 * Public booking page: /{host}/{event-slug}.
 *
 * Flow: list available slots in the guest's time zone (with a switcher) ->
 * pick a slot (places a 5-minute hold) -> enter name/email while a countdown
 * runs -> confirm. On confirm the guest gets a private manage link.
 */
export function BookingPage() {
  const { host, slug } = useParams<{ host: string; slug: string }>();
  const navigate = useNavigate();

  const [zone, setZone] = useState<string>(browserZone());
  const [data, setData] = useState<SlotsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>("pick");
  const [selected, setSelected] = useState<Slot | null>(null);
  const [hold, setHold] = useState<Booking | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed] = useState<Booking | null>(null);

  // A stable idempotency key per hold attempt, so retries don't double-book.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const loadSlots = useCallback(async () => {
    if (!host || !slug) return;
    setLoading(true);
    setError(null);
    try {
      const res = await getSlots(host, slug, zone);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load slots.");
    } finally {
      setLoading(false);
    }
  }, [host, slug, zone]);

  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  const grouped = useMemo(
    () => (data ? groupByDay(data.slots, zone) : []),
    [data, zone],
  );

  async function pickSlot(slot: Slot) {
    if (!data) return;
    setSelected(slot);
    setSubmitting(true);
    setError(null);
    idempotencyKey.current = crypto.randomUUID();
    try {
      // We need the event type id; the slots response doesn't expose it, so the
      // hold endpoint takes the id. Fetch it indirectly: the API accepts the
      // event type id, which we carry from a dedicated lookup below.
      const eventTypeId = await resolveEventTypeId(host!, slug!);
      const h = await holdSlot(eventTypeId, slot.startUtc, idempotencyKey.current);
      setHold(h);
      setStage("details");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not hold that slot.");
      setSelected(null);
      void loadSlots();
    } finally {
      setSubmitting(false);
    }
  }

  async function doConfirm() {
    if (!hold) return;
    setSubmitting(true);
    setError(null);
    try {
      const b = await confirmHold(hold.id, name.trim(), email.trim());
      setConfirmed(b);
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="container">
        <div className="card">Loading…</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="container">
        <div className="card">
          <div className="banner error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <div className="row between">
          <div>
            <h1>{data?.eventType.name}</h1>
            <p className="muted">
              with {data?.eventType.hostName} · {data?.eventType.durationMin} min
              {data && data.eventType.capacity > 1
                ? ` · group of ${data.eventType.capacity}`
                : ""}
            </p>
          </div>
        </div>

        <label htmlFor="tz">Time zone</label>
        <select
          id="tz"
          value={zone}
          onChange={(e) => setZone(e.target.value)}
          disabled={stage !== "pick"}
        >
          {zoneOptions().map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>

        {error && <div className="banner error">{error}</div>}

        {stage === "pick" && (
          <>
            {grouped.length === 0 && (
              <div className="banner info">No available slots in this range.</div>
            )}
            {grouped.map((g) => (
              <div className="day-group" key={g.label}>
                <div className="day-label">{g.label}</div>
                <div className="slot-grid">
                  {g.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      className={`slot${selected?.startUtc === s.startUtc ? " selected" : ""}`}
                      onClick={() => pickSlot(s)}
                      disabled={submitting}
                      title={
                        data && data.eventType.capacity > 1
                          ? `${s.remaining} seat(s) left`
                          : undefined
                      }
                    >
                      {formatTime(s.startUtc, zone)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}

        {stage === "details" && hold && selected && (
          <DetailsForm
            slotLabel={`${formatTime(selected.startUtc, zone)} — ${new Date(
              selected.startUtc,
            ).toLocaleDateString()}`}
            holdExpiresAt={hold.holdExpiresAt}
            name={name}
            email={email}
            onName={setName}
            onEmail={setEmail}
            submitting={submitting}
            onConfirm={doConfirm}
            onExpire={() => {
              setError("Your hold expired. Please pick a slot again.");
              setStage("pick");
              setHold(null);
              setSelected(null);
              void loadSlots();
            }}
          />
        )}

        {stage === "done" && confirmed && (
          <div>
            <div className="banner ok">Booking confirmed. See you then!</div>
            <p>
              Manage your booking anytime with this private link:
              <br />
              <button
                className="secondary"
                style={{ marginTop: 8 }}
                onClick={() => navigate(`/manage/${confirmed.manageToken}`)}
              >
                Open manage page
              </button>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The slots response is keyed by host/event slug and doesn't carry the event
 * type id (guests use slugs). The hold endpoint needs the id, so we fetch it
 * from a tiny lookup. We piggyback on the slots endpoint via a dedicated id
 * probe: request a single-day window and read the id from a header-less call.
 *
 * Simplicity: the API exposes the id on a lightweight lookup route.
 */
async function resolveEventTypeId(host: string, slug: string): Promise<string> {
  const res = await fetch(
    `/api/hosts/${encodeURIComponent(host)}/events/${encodeURIComponent(slug)}/id`,
  );
  if (!res.ok) throw new Error("Could not resolve event type.");
  const body = (await res.json()) as { eventTypeId: string };
  return body.eventTypeId;
}

function DetailsForm(props: {
  slotLabel: string;
  holdExpiresAt: string | null;
  name: string;
  email: string;
  onName: (v: string) => void;
  onEmail: (v: string) => void;
  submitting: boolean;
  onConfirm: () => void;
  onExpire: () => void;
}) {
  const [remaining, setRemaining] = useState<number>(() =>
    props.holdExpiresAt
      ? Math.max(0, Math.floor((new Date(props.holdExpiresAt).getTime() - Date.now()) / 1000))
      : 0,
  );

  useEffect(() => {
    if (!props.holdExpiresAt) return;
    const id = setInterval(() => {
      const secs = Math.max(
        0,
        Math.floor((new Date(props.holdExpiresAt!).getTime() - Date.now()) / 1000),
      );
      setRemaining(secs);
      if (secs <= 0) {
        clearInterval(id);
        props.onExpire();
      }
    }, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.holdExpiresAt]);

  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(props.email.trim());
  const canConfirm = props.name.trim().length > 0 && emailValid && !props.submitting;

  return (
    <div>
      <div className="banner info">
        Slot held: <strong>{props.slotLabel}</strong> · held for{" "}
        <span className="countdown">
          {mm}:{ss}
        </span>
      </div>
      <label htmlFor="name">Your name</label>
      <input
        id="name"
        value={props.name}
        onChange={(e) => props.onName(e.target.value)}
        placeholder="Ada Lovelace"
      />
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        value={props.email}
        onChange={(e) => props.onEmail(e.target.value)}
        placeholder="ada@example.com"
      />
      <div style={{ marginTop: 16 }}>
        <button onClick={props.onConfirm} disabled={!canConfirm}>
          {props.submitting ? "Confirming…" : "Confirm booking"}
        </button>
      </div>
    </div>
  );
}
