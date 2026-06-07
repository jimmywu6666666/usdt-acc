import "../server/config.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL");
  process.exitCode = 1;
} else {
  try {
    const pg = await import("pg");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    const existing = await pool.query("SELECT to_regclass('public.users') AS users_table");
    const migrations = existing.rows[0].users_table
      ? ["migrations/001_app_state.sql", "migrations/002_transitional_sessions.sql", "migrations/003_business_fields.sql", "migrations/004_transaction_annotations.sql", "migrations/005_tron_sync_fields.sql", "migrations/006_wallet_managed_from.sql", "migrations/007_internal_transfers.sql", "migrations/008_non_business_annotations.sql"]
      : ["schema.sql", "migrations/001_app_state.sql", "migrations/002_transitional_sessions.sql", "migrations/003_business_fields.sql", "migrations/004_transaction_annotations.sql", "migrations/005_tron_sync_fields.sql", "migrations/006_wallet_managed_from.sql", "migrations/007_internal_transfers.sql", "migrations/008_non_business_annotations.sql"];
    for (const migration of migrations) {
      const sql = await readFile(path.join(__dirname, migration), "utf8");
      await pool.query(sql);
      console.log(`已执行：${migration}`);
    }
    await pool.end();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
