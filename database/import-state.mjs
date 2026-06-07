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
    const statePath = path.resolve(__dirname, "../data/state.json");
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO app_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
    await pool.end();
    console.log("已将 data/state.json 导入 PostgreSQL");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
