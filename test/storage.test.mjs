import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "../server/storage.mjs";

function emptyState() {
  return {
    activeTenantId: "tenant_alpha",
    activeUserId: "user_admin",
    activeView: "dashboard",
    categories: { income: [], expense: [] },
    tenants: [],
    users: [],
    wallets: [],
    entries: [],
    chainTransactions: [],
    auditLogs: [],
  };
}

test("file storage persists state mutations and sessions across instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "usdt-ledger-storage-"));
  const options = {
    stateFile: path.join(directory, "state.json"),
    sessionsFile: path.join(directory, "sessions.json"),
  };
  try {
    const first = new FileStorage(options);
    await first.writeState(emptyState());
    await first.mutateState((state) => {
      state.tenants.push({ id: "tenant_alpha", name: "Alpha", enabled: true });
      return state;
    });
    const token = await first.createSession("user_admin", new Date(Date.now() + 60_000).toISOString());

    const second = new FileStorage(options);
    const state = await second.readState();
    const session = await second.findSession(token);
    assert.equal(state.tenants[0].name, "Alpha");
    assert.equal(session.userId, "user_admin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
