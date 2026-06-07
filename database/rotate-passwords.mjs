import "../server/config.mjs";
import { randomBytes } from "node:crypto";
import { writeFile, chmod } from "node:fs/promises";
import { hashPassword } from "../server/auth.mjs";

if (!process.env.DATABASE_URL || !process.env.PASSWORD_OUTPUT_FILE) {
  console.error("缺少 DATABASE_URL 或 PASSWORD_OUTPUT_FILE");
  process.exitCode = 1;
} else {
  const pg = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT state FROM app_state WHERE id = 1 FOR UPDATE");
    const state = result.rows[0]?.state;
    if (!state) throw new Error("app_state 尚未初始化");
    const credentials = [];
    for (const user of state.users) {
      const password = randomBytes(18).toString("base64url");
      user.passwordHash = hashPassword(password);
      credentials.push(`${user.name} (${user.role})\n账号 ID: ${user.id}\n密码: ${password}\n`);
    }
    await client.query("UPDATE app_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1", [JSON.stringify(state)]);
    await client.query("DELETE FROM user_sessions");
    await client.query("COMMIT");
    await writeFile(process.env.PASSWORD_OUTPUT_FILE, credentials.join("\n"), "utf8");
    await chmod(process.env.PASSWORD_OUTPUT_FILE, 0o600);
    console.log(`已更新 ${credentials.length} 个账号密码并注销全部会话`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
