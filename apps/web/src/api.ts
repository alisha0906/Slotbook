/**
 * Typed client for the Slotbook API. All calls are same-origin (/api/...),
 * which works in production (Fastify serves the built app) and in dev (Vite
 * proxies /api to the API server).
 */

export interface SlotsResponse {
  eventType: {
    name: string;
    slug: string;
    durationMin: number;
    capacity: number;
    hostName: string;
    hostSlug: string;
    hostTimeZone: string;
  };
  timeZone: string;
  slots: Array<{
    startUtc: string;
    endUtc: string;
    startLocal: string;
    remaining: number;
  }>;
}

export interface Booking {
  id: string;
  eventTypeId: string;
  slotStart: string;
  slotEnd: string;
  status: "held" | "confirmed" | "cancelled" | "expired";
  holdExpiresAt: string | null;
  guestName: string | null;
  guestEmail: string | null;
  manageToken: string;
}

export interface ManageResponse {
  booking: Booking;
  eventType: {
    name: string;
    slug: string;
    durationMin: number;
    hostName: string;
    hostSlug: string;
    hostTimeZone: string;
  } | null;
}

export interface ApiError {
  error: string;
  message?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Spread init FIRST, then set headers last — otherwise `...init` would
  // overwrite the merged headers with init.headers alone, dropping
  // Content-Type: application/json on requests that pass their own headers
  // (e.g. the Idempotency-Key on holds). Without that header Fastify does not
  // JSON-parse the body and the handler receives a raw string.
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (body ?? {}) as ApiError;
    throw new Error(err.message ?? err.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}

export function getSlots(
  host: string,
  slug: string,
  tz: string,
  from?: string,
  to?: string,
): Promise<SlotsResponse> {
  const params = new URLSearchParams({ tz });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return request<SlotsResponse>(
    `/api/hosts/${encodeURIComponent(host)}/events/${encodeURIComponent(slug)}/slots?${params}`,
  );
}

export function holdSlot(
  eventTypeId: string,
  slotStart: string,
  idempotencyKey: string,
): Promise<Booking> {
  return request<Booking>("/api/holds", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ eventTypeId, slotStart }),
  });
}

export function confirmHold(
  holdId: string,
  guestName: string,
  guestEmail: string,
): Promise<Booking> {
  return request<Booking>(`/api/holds/${holdId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ guestName, guestEmail }),
  });
}

export function getBooking(token: string): Promise<ManageResponse> {
  return request<ManageResponse>(`/api/bookings/${token}`);
}

export function rescheduleBooking(token: string, slotStart: string): Promise<Booking> {
  return request<Booking>(`/api/bookings/${token}/reschedule`, {
    method: "POST",
    body: JSON.stringify({ slotStart }),
  });
}

export function cancelBooking(token: string, reason: string): Promise<Booking> {
  return request<Booking>(`/api/bookings/${token}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

// --- Host (dashboard) ------------------------------------------------------

export interface HostLoginResponse {
  token: string;
  host: { id: string; name: string; slug: string; timezone: string };
}

export interface HostBooking {
  id: string;
  eventTypeName: string;
  eventSlug: string;
  slotStart: string;
  slotEnd: string;
  status: string;
  guestName: string | null;
  guestEmail: string | null;
  manageToken: string;
}

export function hostLogin(email: string, password: string): Promise<HostLoginResponse> {
  return request<HostLoginResponse>("/api/host/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function hostUpcoming(token: string): Promise<{ bookings: HostBooking[] }> {
  return request<{ bookings: HostBooking[] }>("/api/host/bookings", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function hostCancel(
  token: string,
  bookingId: string,
  reason: string,
): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/host/bookings/${bookingId}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason }),
  });
}
