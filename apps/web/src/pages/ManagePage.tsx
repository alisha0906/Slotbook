import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  getBooking,
  cancelBooking,
  rescheduleBooking,
  getSlots,
  type ManageResponse,
  type SlotsResponse,
} from "../api";
import { browserZone, formatDateTime, formatTime, groupByDay } from "../tz";

/**
 * Guest manage page: /manage/:token.
 * View a booking, cancel it, or reschedule to a new slot.
 */
export function ManagePage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<ManageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zone] = useState<string>(browserZone());
  const [rescheduling, setRescheduling] = useState(false);
  const [slots, setSlots] = useState<SlotsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setData(await getBooking(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Booking not found.");
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function doCancel() {
    if (!token) return;
    const reason = prompt("Reason for cancelling? (optional)") ?? "";
    setBusy(true);
    try {
      await cancelBooking(token, reason);
      setNotice("Booking cancelled.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  async function openReschedule() {
    if (!data?.eventType) return;
    setRescheduling(true);
    try {
      const res = await getSlots(data.eventType.hostSlug, data.eventType.slug, zone);
      setSlots(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load slots.");
    }
  }

  async function doReschedule(startUtc: string) {
    if (!token) return;
    setBusy(true);
    try {
      await rescheduleBooking(token, startUtc);
      setNotice("Booking rescheduled.");
      setRescheduling(false);
      setSlots(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reschedule.");
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => (slots ? groupByDay(slots.slots, zone) : []), [slots, zone]);

  if (error && !data) {
    return (
      <div className="container">
        <div className="card">
          <div className="banner error">{error}</div>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="container">
        <div className="card">Loading…</div>
      </div>
    );
  }

  const b = data.booking;
  const canModify = b.status === "confirmed" || b.status === "held";

  return (
    <div className="container">
      <div className="card">
        <h1>Your booking</h1>
        {data.eventType && (
          <p className="muted">
            {data.eventType.name} with {data.eventType.hostName}
          </p>
        )}

        {notice && <div className="banner ok">{notice}</div>}
        {error && <div className="banner error">{error}</div>}

        <p>
          <span className={`badge ${b.status}`}>{b.status}</span>
        </p>
        <p>
          <strong>{formatDateTime(b.slotStart, zone)}</strong>
          <br />
          <span className="small muted">Shown in {zone}</span>
        </p>
        {b.guestName && (
          <p className="small muted">
            Booked by {b.guestName} ({b.guestEmail})
          </p>
        )}

        {canModify && !rescheduling && (
          <div className="row" style={{ marginTop: 16 }}>
            <button className="secondary" onClick={openReschedule} disabled={busy}>
              Reschedule
            </button>
            <button className="danger" onClick={doCancel} disabled={busy}>
              Cancel booking
            </button>
          </div>
        )}

        {rescheduling && (
          <div style={{ marginTop: 16 }}>
            <h2>Pick a new time</h2>
            {grouped.length === 0 && <div className="banner info">No slots available.</div>}
            {grouped.map((g) => (
              <div className="day-group" key={g.label}>
                <div className="day-label">{g.label}</div>
                <div className="slot-grid">
                  {g.slots.map((s) => (
                    <button
                      key={s.startUtc}
                      className="slot"
                      disabled={busy}
                      onClick={() => doReschedule(s.startUtc)}
                    >
                      {formatTime(s.startUtc, zone)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <button
              className="secondary"
              style={{ marginTop: 12 }}
              onClick={() => {
                setRescheduling(false);
                setSlots(null);
              }}
            >
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
