import "../server/config.mjs";
import { hashPassword } from "../server/auth.mjs";

if (!process.env.DATABASE_URL) {
  console.error("缺少 DATABASE_URL");
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
    for (const user of state.users) {
      user.passwordHash = hashPassword("123456", user.id);
    }
    await client.query("UPDATE app_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1", [JSON.stringify(state)]);
    await client.query("DELETE FROM user_sessions");
    await client.query("COMMIT");
    console.log(`已将 ${state.users.length} 个账号恢复为测试密码 123456`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}
