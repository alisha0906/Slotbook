import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * Shared Postgres connection pool and Drizzle client.
 *
 * Postgres is the single source of truth for booking correctness, so every
 * request path goes through this pool. Concurrency-sensitive operations open
 * explicit transactions (see repositories) rather than relying on autocommit.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
