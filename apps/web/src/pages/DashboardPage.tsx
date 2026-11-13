import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  hostLogin,
  hostUpcoming,
  hostCancel,
  type HostBooking,
} from "../api";
import { browserZone, formatDateTime } from "../tz";

const TOKEN_KEY = "slotbook_host_token";

/**
 * Host dashboard: /dashboard.
 * Seeded login, then a list of upcoming bookings with a cancel action.
 */
export function DashboardPage() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [hostName, setHostName] = useState<string>("");
  const [email, setEmail] = useState("demo@slotbook.test");
  const [password, setPassword] = useState("demo1234");
  const [bookings, setBookings] = useState<HostBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zone = browserZone();

  const loadBookings = useCallback(async (t: string) => {
    try {
      const res = await hostUpcoming(t);
      setBookings(res.bookings);
    } catch (e) {
      // Token likely invalid/expired — force re-login.
      setError(e instanceof Error ? e.message : "Session error.");
      setToken(null);
      localStorage.removeItem(TOKEN_KEY);
    }
  }, []);

  useEffect(() => {
    if (token) void loadBookings(token);
  }, [token, loadBookings]);

  async function doLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await hostLogin(email.trim(), password);
      localStorage.setItem(TOKEN_KEY, res.token);
      setToken(res.token);
      setHostName(res.host.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setBookings([]);
  }

  async function cancel(id: string) {
    if (!token) return;
    const reason = prompt("Reason for cancelling?") ?? "";
    setBusy(true);
    try {
      await hostCancel(token, id, reason);
      await loadBookings(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <div className="container">
        <div className="card">
          <h1>Host login</h1>
          {error && <div className="banner error">{error}</div>}
          <form onSubmit={doLogin}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div style={{ marginTop: 16 }}>
              <button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
          </form>
          <p className="small muted" style={{ marginTop: 12 }}>
            Demo: <code>demo@slotbook.test</code> / <code>demo1234</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <div className="row between">
          <h1>Upcoming bookings{hostName ? ` — ${hostName}` : ""}</h1>
          <button className="secondary" onClick={logout}>
            Log out
          </button>
        </div>
        {error && <div className="banner error">{error}</div>}
        {bookings.length === 0 ? (
          <div className="banner info">No upcoming bookings.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When ({zone})</th>
                <th>Event</th>
                <th>Guest</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((b) => (
                <tr key={b.id}>
                  <td>{formatDateTime(b.slotStart, zone)}</td>
                  <td>{b.eventTypeName}</td>
                  <td>
                    {b.guestName ?? "—"}
                    {b.guestEmail ? (
                      <div className="small muted">{b.guestEmail}</div>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${b.status}`}>{b.status}</span>
                  </td>
                  <td>
                    <div className="row">
                      {/* Opens the manage page (reschedule or cancel) in a new
                          tab so the host keeps the dashboard open. */}
                      <Link
                        to={`/manage/${b.manageToken}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <button className="secondary">Manage</button>
                      </Link>
                      <button className="danger" onClick={() => cancel(b.id)} disabled={busy}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
