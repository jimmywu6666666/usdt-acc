import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAttachmentStore } from "../server/attachment-storage.mjs";

test("rejects PDF proof uploads", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ledger-attachments-"));
  const store = createAttachmentStore({ rootDir });
  await assert.rejects(() => store.saveUpload({
    name: "payment-proof.pdf",
    type: "application/pdf",
    dataUrl: `data:application/pdf;base64,${Buffer.from("pdf-data").toString("base64")}`,
  }, { tenantId: "tenant_alpha" }), /凭证只支持图片/);
});

test("compresses images through the configured processor", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ledger-images-"));
  const store = createAttachmentStore({
    rootDir,
    imageProcessor: async () => ({
      buffer: Buffer.from("webp"),
      mimeType: "image/webp",
      extension: ".webp",
      compressed: true,
    }),
  });
  const attachment = await store.saveUpload({
    name: "receipt.png",
    type: "image/png",
    dataUrl: `data:image/png;base64,${Buffer.from("original-image").toString("base64")}`,
  }, { tenantId: "tenant_alpha" });

  assert.equal(attachment.compressed, true);
  assert.equal(attachment.mimeType, "image/webp");
  assert.equal(attachment.byteSize, 4);
  assert.equal(attachment.originalByteSize, 14);
  assert.match(attachment.storageKey, /^tenant_alpha\/.+\.webp$/);
});

test("rejects unsupported attachment types", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "ledger-invalid-"));
  const store = createAttachmentStore({ rootDir });
  await assert.rejects(() => store.saveUpload({
    name: "script.html",
    type: "text/html",
    dataUrl: `data:text/html;base64,${Buffer.from("<script></script>").toString("base64")}`,
  }, { tenantId: "tenant_alpha" }), /凭证只支持图片/);
});
