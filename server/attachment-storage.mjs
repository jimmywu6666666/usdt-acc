import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

export function createAttachmentStore(options = {}) {
  const rootDir = path.resolve(options.rootDir || process.env.ATTACHMENT_DIR || "data/attachments");
  const imageProcessor = options.imageProcessor || compressImage;

  return {
    rootDir,

    async saveUpload(upload, { tenantId }) {
      const decoded = decodeUpload(upload);
      if (!ALLOWED_TYPES.has(decoded.mimeType)) {
        throw httpError(400, "凭证只支持图片");
      }
      if (decoded.buffer.byteLength > MAX_UPLOAD_BYTES) {
        throw httpError(400, "凭证图片不能超过 10MB");
      }

      const stored = await imageProcessor(decoded.buffer, decoded.mimeType);

      const tenantFolder = safeSegment(tenantId);
      const storageKey = `${tenantFolder}/${randomUUID()}${stored.extension}`;
      const destination = resolveStoragePath(rootDir, storageKey);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o750 });
      await writeFile(destination, stored.buffer, { mode: 0o640 });

      return {
        name: decoded.name,
        originalName: decoded.name,
        mimeType: stored.mimeType,
        byteSize: stored.buffer.byteLength,
        originalByteSize: decoded.buffer.byteLength,
        storageKey,
        compressed: stored.compressed,
      };
    },

    async read(attachment) {
      if (attachment?.storageKey) {
        return {
          buffer: await readFile(resolveStoragePath(rootDir, attachment.storageKey)),
          mimeType: attachment.mimeType || "application/octet-stream",
          name: attachment.originalName || attachment.name || "attachment",
        };
      }
      if (attachment?.dataUrl) {
        const decoded = decodeUpload(attachment);
        return { buffer: decoded.buffer, mimeType: decoded.mimeType, name: decoded.name };
      }
      throw httpError(404, "凭证图片不存在");
    },

    async remove(attachment) {
      if (!attachment?.storageKey) return;
      await unlink(resolveStoragePath(rootDir, attachment.storageKey)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    },

    async stats() {
      return directoryStats(rootDir);
    },
  };
}

async function directoryStats(directory) {
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (entry.isFile()) {
        const info = await stat(target);
        totalBytes += info.size;
        fileCount += 1;
      }
    }
  }
  await walk(directory);
  return { totalBytes, fileCount, rootDir: directory };
}

async function compressImage(buffer) {
  let sharp;
  try {
    sharp = (await import("sharp")).default;
  } catch {
    throw httpError(500, "服务器尚未安装图片压缩组件");
  }
  const output = await sharp(buffer)
    .rotate()
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return { buffer: output, mimeType: "image/webp", extension: ".webp", compressed: true };
}

function decodeUpload(upload) {
  const name = path.basename(String(upload?.name || upload?.originalName || "attachment"));
  const match = String(upload?.dataUrl || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) throw httpError(400, "凭证图片数据格式不正确");
  const mimeType = String(upload?.type || match[1]).toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length) throw httpError(400, "凭证图片内容为空");
  return { name, mimeType, buffer };
}

function resolveStoragePath(rootDir, storageKey) {
  const target = path.resolve(rootDir, storageKey);
  if (target !== rootDir && !target.startsWith(`${rootDir}${path.sep}`)) {
    throw httpError(400, "附件路径不正确");
  }
  return target;
}

function safeSegment(value) {
  const segment = String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!segment) throw httpError(400, "附件所属系统不正确");
  return segment;
}

function extensionForType(mimeType) {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  }[mimeType] || ".bin";
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
