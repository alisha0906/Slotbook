import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { config } from "../config.js";

/**
 * Minimal, dependency-light migration runner.
 *
 * Applies every .sql file in the `drizzle/` directory in lexical order, inside
 * a transaction, and records applied files in a `_migrations` table so reruns
 * are idempotent. This keeps `docker compose up` a single command with no
 * separate migration tool needed at runtime.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
// From dist/db/ or src/db/, the drizzle folder sits at ../../drizzle.
const migrationsDir = join(__dirname, "..", "..", "drizzle");

async function run(): Promise<void> {
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const { rows } = await client.query<{ name: string }>(
        "SELECT name FROM _migrations WHERE name = $1",
        [file],
      );
      if (rows.length > 0) {
        console.log(`[migrate] skip  ${file} (already applied)`);
        continue;
      }

      const sql = readFileSync(join(migrationsDir, file), "utf8");
      console.log(`[migrate] apply ${file}`);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("[migrate] done");
  } finally {
    await client.end();
  }
}

run().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
