import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_DEMO_PASSWORD = "123456";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

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

export function generateTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpSetupForUser(user, issuer = "智慧星 USDT 财务记账系统") {
  if (!user?.totpSecret) return null;
  const label = `${issuer}:${user.loginName || user.name || user.id}`;
  const params = new URLSearchParams({
    secret: user.totpSecret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return {
    loginName: user.loginName || user.id,
    secret: user.totpSecret,
    otpauthUrl: `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`,
  };
}

export function verifyTotp(user, code, options = {}) {
  if (!user?.totpSecret) return true;
  const normalized = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const windowSize = Number.isInteger(options.window) ? options.window : 1;
  const counter = Math.floor(now.getTime() / 1000 / 30);
  for (let offset = -windowSize; offset <= windowSize; offset += 1) {
    if (hotp(user.totpSecret, counter + offset) === normalized) return true;
  }
  return false;
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, totpSecret, ...safeUser } = user;
  safeUser.totpEnabled = Boolean(totpSecret);
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

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(secret) {
  const normalized = String(secret || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac("sha1", key).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1000000).padStart(6, "0");
}
