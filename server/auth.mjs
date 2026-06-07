import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_DEMO_PASSWORD = "123456";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const digest = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `${salt}:${digest}`;
}

export function verifyPassword(user, password, options = {}) {
  const allowDemoPassword = options.allowDemoPassword !== false;
  const stored = user.passwordHash || (allowDemoPassword ? hashPassword(DEFAULT_DEMO_PASSWORD, user.id) : "");
  const [salt, digest] = stored.split(":");
  if (!salt || !digest) return false;
  const expected = hashPassword(password, salt).split(":")[1];
  return safeEqual(digest, expected);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

export async function createSession(storage, user) {
  return storage.createSession(user.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
}

export async function destroySession(storage, token) {
  await storage.revokeSession(token);
}

export function getToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

export async function requireSession(storage, req, state) {
  const token = getToken(req);
  const session = await storage.findSession(token);
  if (!session) {
    const error = new Error("请先登录");
    error.statusCode = 401;
    throw error;
  }
  const user = state.users.find((item) => item.id === session.userId);
  if (!user) {
    await storage.revokeSession(token);
    const error = new Error("登录账号不存在");
    error.statusCode = 401;
    throw error;
  }
  await storage.touchSession(session.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
  return { token, user };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
