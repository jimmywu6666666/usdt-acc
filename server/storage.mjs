import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reconcileState, validateState } from "./domain.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const stateFile = path.join(dataDir, "state.json");
const sessionsFile = path.join(dataDir, "sessions.json");

export async function createStorage() {
  if (process.env.DATABASE_URL) {
    const storage = await PostgreSqlStorage.create(process.env.DATABASE_URL);
    console.log("数据存储：PostgreSQL");
    return storage;
  }
  console.log("数据存储：本地文件（设置 DATABASE_URL 可切换 PostgreSQL）");
  return new FileStorage();
}

export class FileStorage {
  kind = "file";

  constructor(options = {}) {
    this.stateFile = options.stateFile || stateFile;
    this.sessionsFile = options.sessionsFile || sessionsFile;
    this.mutationQueue = Promise.resolve();
  }

  async readState() {
    return readJson(this.stateFile, null);
  }

  async writeState(state) {
    validateAndReconcile(state);
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(this.stateFile, JSON.stringify(state, null, 2), "utf8");
  }

  async mutateState(mutator) {
    const operation = this.mutationQueue.then(async () => {
      const state = await this.readState();
      if (!state) throw httpError(404, "系统状态尚未初始化");
      const nextState = await mutator(state);
      await this.writeState(nextState);
      return nextState;
    });
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async createSession(userId, expiresAt) {
    const token = randomToken();
    const sessions = await readJson(this.sessionsFile, []);
    sessions.push({ id: randomUUID(), userId, tokenHash: tokenHash(token), expiresAt, revokedAt: null });
    await this.writeSessions(sessions);
    return token;
  }

  async findSession(token) {
    if (!token) return null;
    const sessions = await readJson(this.sessionsFile, []);
    const hash = tokenHash(token);
    const session = sessions.find((item) => item.tokenHash === hash && !item.revokedAt);
    if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
    return session;
  }

  async touchSession(sessionId, expiresAt) {
    const sessions = await readJson(this.sessionsFile, []);
    const session = sessions.find((item) => item.id === sessionId);
    if (session) session.expiresAt = expiresAt;
    await this.writeSessions(sessions);
  }

  async revokeSession(token) {
    if (!token) return;
    const sessions = await readJson(this.sessionsFile, []);
    const session = sessions.find((item) => item.tokenHash === tokenHash(token));
    if (session) session.revokedAt = new Date().toISOString();
    await this.writeSessions(sessions);
  }

  async writeSessions(sessions) {
    await mkdir(path.dirname(this.sessionsFile), { recursive: true });
    const active = sessions.filter((item) => !item.revokedAt && new Date(item.expiresAt).getTime() > Date.now() - 24 * 60 * 60 * 1000);
    await writeFile(this.sessionsFile, JSON.stringify(active, null, 2), "utf8");
  }

  async metrics() {
    const [stateInfo, sessionsInfo] = await Promise.all([
      stat(this.stateFile).catch(() => null),
      stat(this.sessionsFile).catch(() => null),
    ]);
    return {
      kind: this.kind,
      connected: true,
      stateBytes: stateInfo?.size || 0,
      sessionsBytes: sessionsInfo?.size || 0,
      totalBytes: (stateInfo?.size || 0) + (sessionsInfo?.size || 0),
      connections: null,
      maxConnections: null,
      appStateBytes: stateInfo?.size || 0,
      userSessions: null,
      updatedAt: stateInfo?.mtime?.toISOString?.() || null,
    };
  }
}

export class PostgreSqlStorage {
  static async create(connectionString) {
    let pg;
    try {
      pg = await import("pg");
    } catch {
      throw new Error("已设置 DATABASE_URL，但缺少 pg 驱动。请运行 npm install 后重试。");
    }
    const pool = new pg.Pool({ connectionString });
    await pool.query("SELECT 1");
    return new PostgreSqlStorage(pool);
  }

  constructor(pool) {
    this.pool = pool;
    this.kind = "postgresql";
  }

  async readState(client = this.pool) {
    const result = await client.query("SELECT state FROM app_state WHERE id = 1");
    return result.rows[0]?.state || null;
  }

  async writeState(state, client = this.pool) {
    validateAndReconcile(state);
    await client.query(
      `INSERT INTO app_state (id, state, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()`,
      [JSON.stringify(state)],
    );
  }

  async mutateState(mutator) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT state FROM app_state WHERE id = 1 FOR UPDATE");
      const state = result.rows[0]?.state;
      if (!state) throw httpError(404, "系统状态尚未初始化");
      const nextState = await mutator(state);
      await this.writeState(nextState, client);
      await client.query("COMMIT");
      return nextState;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createSession(userId, expiresAt) {
    const token = randomToken();
    await this.pool.query(
      `INSERT INTO user_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), userId, tokenHash(token), expiresAt],
    );
    return token;
  }

  async findSession(token) {
    if (!token) return null;
    const result = await this.pool.query(
      `SELECT id, user_id AS "userId", expires_at AS "expiresAt"
       FROM user_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash(token)],
    );
    return result.rows[0] || null;
  }

  async touchSession(sessionId, expiresAt) {
    await this.pool.query("UPDATE user_sessions SET expires_at = $2 WHERE id = $1", [sessionId, expiresAt]);
  }

  async revokeSession(token) {
    if (!token) return;
    await this.pool.query(
      "UPDATE user_sessions SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL",
      [tokenHash(token)],
    );
  }

  async metrics() {
    const [
      dbSize,
      connections,
      maxConnections,
      appState,
      sessions,
    ] = await Promise.all([
      this.pool.query("SELECT pg_database_size(current_database()) AS bytes, current_database() AS name"),
      this.pool.query("SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()"),
      this.pool.query("SHOW max_connections"),
      this.pool.query("SELECT pg_column_size(state)::bigint AS bytes, updated_at FROM app_state WHERE id = 1"),
      this.pool.query("SELECT COUNT(*)::int AS count FROM user_sessions WHERE revoked_at IS NULL AND expires_at > NOW()"),
    ]);
    return {
      kind: this.kind,
      connected: true,
      databaseName: dbSize.rows[0]?.name || "",
      totalBytes: Number(dbSize.rows[0]?.bytes || 0),
      connections: Number(connections.rows[0]?.count || 0),
      maxConnections: Number(maxConnections.rows[0]?.max_connections || 0),
      appStateBytes: Number(appState.rows[0]?.bytes || 0),
      userSessions: Number(sessions.rows[0]?.count || 0),
      updatedAt: appState.rows[0]?.updated_at || null,
    };
  }
}

function validateAndReconcile(state) {
  reconcileState(state);
  const validationError = validateState(state);
  if (validationError) throw httpError(400, validationError);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function randomToken() {
  return createHash("sha256").update(`${randomUUID()}:${Date.now()}:${Math.random()}`).digest("hex");
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
