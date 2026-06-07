import test from "node:test";
import assert from "node:assert/strict";
import { retryOperation, startChainSyncScheduler, syncTenantWallets } from "../server/chain-sync.mjs";

function createState() {
  return {
    categories: { income: ["客户回款"], expense: ["供应商付款"] },
    tenants: [{ id: "tenant", name: "团队", enabled: true }],
    users: [{ id: "supervisor", tenantId: "tenant", name: "主管", role: "supervisor", canViewAll: true }],
    wallets: [
      { id: "wallet-a", tenantId: "tenant", alias: "钱包 A", address: "TA", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
      { id: "wallet-b", tenantId: "tenant", alias: "钱包 B", address: "TB", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
    ],
    chainTransactions: [],
    annotations: [],
    entries: [],
    legacyEntries: [],
    auditLogs: [],
  };
}

function memoryStorage(state) {
  return {
    async readState() {
      return state;
    },
    async mutateState(mutator) {
      state = await mutator(state);
      return state;
    },
  };
}

test("retries temporary chain provider failures", async () => {
  let attempts = 0;
  const retryDelays = [];
  const result = await retryOperation(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("rate limited"), { statusCode: 429 });
    return "ok";
  }, {
    wait: async () => {},
    onRetry: ({ delayMs }) => retryDelays.push(delayMs),
  });
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(retryDelays, [500, 1000]);
});

test("syncs healthy wallets while preserving a failed wallet error", async () => {
  const state = createState();
  const provider = {
    kind: "tron",
    async fetchWalletTransactions(wallet) {
      if (wallet.id === "wallet-b") throw Object.assign(new Error("temporary failure"), { statusCode: 502 });
      return [{
        hash: "hash-a",
        eventIndex: 1,
        direction: "income",
        amount: 12,
        counterparty: "TCounterparty",
        confirmed: true,
        chainTime: "2026-06-06T00:00:00.000Z",
      }];
    },
    async fetchWalletBalance(wallet) {
      if (wallet.id === "wallet-b") throw Object.assign(new Error("temporary failure"), { statusCode: 502 });
      return 12;
    },
  };
  const result = await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    actorUserId: "supervisor",
    now: new Date("2026-06-06T01:00:00.000Z"),
    retry: (operation) => operation(),
  });
  assert.equal(result.createdCount, 1);
  assert.equal(result.syncedWalletCount, 1);
  assert.equal(result.failedWallets.length, 1);
  assert.equal(state.wallets[0].chainBalance, 12);
  assert.equal(state.walletBalanceSnapshots.length, 1);
  assert.equal(state.walletBalanceSnapshots[0].walletId, "wallet-a");
  assert.equal(state.walletBalanceSnapshots[0].balance, 12);
  assert.equal(state.wallets[1].lastSyncError, "temporary failure");
  assert.equal(state.auditLogs[0].action, "链上钱包同步失败");
});

test("stores one daily wallet balance snapshot per wallet in China date", async () => {
  const state = createState();
  let balance = 12;
  const provider = {
    kind: "tron",
    async fetchWalletTransactions() {
      return [];
    },
    async fetchWalletBalance() {
      return balance;
    },
  };
  await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    actorUserId: "supervisor",
    now: new Date("2026-06-07T17:00:00.000Z"),
    retry: (operation) => operation(),
  });
  balance = 18;
  await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    actorUserId: "supervisor",
    now: new Date("2026-06-07T18:00:00.000Z"),
    retry: (operation) => operation(),
  });
  assert.equal(state.walletBalanceSnapshots.length, 2);
  assert.equal(state.walletBalanceSnapshots.every((snapshot) => snapshot.dateKey === "2026-06-08"), true);
  assert.equal(state.walletBalanceSnapshots.find((snapshot) => snapshot.walletId === "wallet-a").balance, 12);
  assert.equal(state.wallets.find((wallet) => wallet.id === "wallet-a").chainBalance, 18);
});

test("persists wallet failures even when every wallet fails", async () => {
  const state = createState();
  const provider = {
    kind: "tron",
    async fetchWalletTransactions() {
      throw Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    },
    async fetchWalletBalance() {
      throw Object.assign(new Error("provider unavailable"), { statusCode: 503 });
    },
  };
  await assert.rejects(() => syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    actorUserId: "supervisor",
    retry: (operation) => operation(),
  }), /TRON 同步失败/);
  assert.equal(state.wallets.every((wallet) => wallet.lastSyncError === "provider unavailable"), true);
  assert.equal(state.auditLogs.filter((log) => log.action === "链上钱包同步失败").length, 2);
});

test("manual empty chain sync keeps an audit log", async () => {
  const state = createState();
  const provider = {
    kind: "tron",
    async fetchWalletTransactions() {
      return [];
    },
    async fetchWalletBalance() {
      return 0;
    },
  };
  const result = await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    actorUserId: "supervisor",
    now: new Date("2026-06-06T01:00:00.000Z"),
    retry: (operation) => operation(),
  });
  assert.equal(result.createdCount, 0);
  assert.equal(state.auditLogs.filter((log) => log.action === "同步链上流水").length, 1);
});

test("automatic empty chain sync does not create audit noise", async () => {
  const state = createState();
  const provider = {
    kind: "tron",
    async fetchWalletTransactions() {
      return [];
    },
    async fetchWalletBalance() {
      return 0;
    },
  };
  const result = await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    now: new Date("2026-06-06T01:00:00.000Z"),
    retry: (operation) => operation(),
    logEmptySync: false,
  });
  assert.equal(result.createdCount, 0);
  assert.equal(state.auditLogs.filter((log) => log.action === "同步链上流水").length, 0);
});

test("automatic chain sync still logs newly imported transactions", async () => {
  const state = createState();
  const provider = {
    kind: "tron",
    async fetchWalletTransactions(wallet) {
      return [{
        hash: `hash-${wallet.id}`,
        eventIndex: 1,
        direction: "income",
        amount: 12,
        counterparty: "TCounterparty",
        confirmed: true,
        chainTime: "2026-06-06T00:00:00.000Z",
      }];
    },
    async fetchWalletBalance() {
      return 12;
    },
  };
  const result = await syncTenantWallets({
    storage: memoryStorage(state),
    tronProvider: provider,
    tenantId: "tenant",
    now: new Date("2026-06-06T01:00:00.000Z"),
    retry: (operation) => operation(),
    logEmptySync: false,
  });
  assert.equal(result.createdCount, 2);
  assert.equal(state.auditLogs.filter((log) => log.action === "同步链上流水").length, 1);
});

test("automatic scheduler skips tenants without enabled wallets", async () => {
  const state = createState();
  state.wallets.forEach((wallet) => {
    wallet.enabled = false;
  });
  let syncCalls = 0;
  const scheduler = startChainSyncScheduler({
    storage: memoryStorage(state),
    tronProvider: {
      kind: "tron",
      async fetchWalletTransactions() {
        syncCalls += 1;
        return [];
      },
      async fetchWalletBalance() {
        return 0;
      },
    },
    env: { CHAIN_SYNC_INTERVAL_MINUTES: "5" },
    setIntervalImpl() {
      return { unref() {} };
    },
    setTimeoutImpl() {
      return { unref() {} };
    },
  });
  await scheduler.run();
  assert.equal(syncCalls, 0);
  assert.equal(scheduler.status.lastError, "");
});

test("scheduler requests an immediate startup sync", () => {
  const state = createState();
  let scheduled;
  startChainSyncScheduler({
    storage: memoryStorage(state),
    tronProvider: { kind: "tron" },
    setIntervalImpl() {
      return { unref() {} };
    },
    setTimeoutImpl(callback, delay) {
      scheduled = { callback, delay };
      return { unref() {} };
    },
  });
  assert.equal(scheduled.delay, 0);
  assert.equal(typeof scheduled.callback, "function");
});
