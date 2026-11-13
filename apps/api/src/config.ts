/**
 * Central runtime configuration, read from environment variables.
 * Fails fast if a required value is missing so misconfiguration surfaces at boot.
 */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export const config = {
  databaseUrl: required(
    "DATABASE_URL",
    "postgres://slotbook:slotbook@localhost:5432/slotbook",
  ),
  apiPort: intEnv("API_PORT", 4000),
  holdTtlMinutes: intEnv("HOLD_TTL_MINUTES", 5),
  demoHostEmail: required("DEMO_HOST_EMAIL", "demo@slotbook.test"),
  demoHostPassword: required("DEMO_HOST_PASSWORD", "demo1234"),
  nodeEnv: process.env.NODE_ENV ?? "development",
} as const;
