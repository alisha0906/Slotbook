import { Link } from "react-router-dom";

/**
 * Landing page with pointers into the two demo booking pages and the host
 * dashboard. Keeps the app discoverable for a reviewer opening the root URL.
 */
export function HomePage() {
  return (
    <div className="container">
      <div className="card">
        <h1>Slotbook</h1>
        <p className="muted">A small, reliable booking engine. Pick a demo surface:</p>
        <h2 style={{ marginTop: 20 }}>Public booking pages</h2>
        <ul>
          <li>
            <Link to="/demo/intro-call">/demo/intro-call</Link> — 30-min one-on-one
          </li>
          <li>
            <Link to="/demo/group-office">/demo/group-office</Link> — 60-min group (capacity 5)
          </li>
        </ul>
        <h2 style={{ marginTop: 20 }}>Host</h2>
        <ul>
          <li>
            <Link to="/dashboard">/dashboard</Link> — host login &amp; upcoming bookings
          </li>
        </ul>
        <p className="small muted" style={{ marginTop: 20 }}>
          Demo host login: <code>demo@slotbook.test</code> / <code>demo1234</code>
        </p>
      </div>
    </div>
  );
}
