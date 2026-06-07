import test from "node:test";
import assert from "node:assert/strict";
import { stateForUser } from "../server/state-view.mjs";

function fixture() {
  return {
    activeTenantId: "tenant_beta",
    activeUserId: "admin",
    activeView: "dashboard",
    categories: { income: ["收入"], expense: ["支出"] },
    tenants: [
      { id: "tenant_alpha", name: "Alpha" },
      { id: "tenant_beta", name: "Beta" },
    ],
    users: [
      { id: "admin", tenantId: null, name: "管理员", role: "admin", passwordHash: "secret" },
      { id: "sup_a", tenantId: "tenant_alpha", name: "主管", role: "supervisor", passwordHash: "secret" },
      { id: "emp_a", tenantId: "tenant_alpha", name: "员工甲", role: "employee", canViewAll: false, passwordHash: "secret" },
      { id: "emp_b", tenantId: "tenant_alpha", name: "员工乙", role: "employee", canViewAll: true, passwordHash: "secret" },
      { id: "sup_b", tenantId: "tenant_beta", name: "Beta主管", role: "supervisor", passwordHash: "secret" },
    ],
    wallets: [
      { id: "wallet_a", tenantId: "tenant_alpha", managedFrom: "2026-06-01T00:00:00.000Z" },
      { id: "wallet_b", tenantId: "tenant_beta" },
    ],
    chainTransactions: [
      { id: "unannotated", tenantId: "tenant_alpha", walletId: "wallet_a", chainTime: "2026-06-02T00:00:00.000Z", currentAnnotationId: null },
      { id: "historical", tenantId: "tenant_alpha", walletId: "wallet_a", chainTime: "2026-05-01T00:00:00.000Z", currentAnnotationId: null },
      { id: "own", tenantId: "tenant_alpha", walletId: "wallet_a", chainTime: "2026-06-02T00:00:00.000Z", currentAnnotationId: "annotation_own" },
      { id: "other", tenantId: "tenant_alpha", walletId: "wallet_a", chainTime: "2026-06-02T00:00:00.000Z", currentAnnotationId: "annotation_other" },
      { id: "beta", tenantId: "tenant_beta", currentAnnotationId: null },
    ],
    annotations: [
      {
        id: "annotation_own", tenantId: "tenant_alpha", chainTxId: "own", annotatedBy: "emp_a",
        attachment: { name: "proof.png", storageKey: "tenant_alpha/private.webp", mimeType: "image/webp" },
      },
      { id: "annotation_other", tenantId: "tenant_alpha", chainTxId: "other", annotatedBy: "emp_b" },
    ],
    walletBalanceSnapshots: [
      { id: "snap_a", tenantId: "tenant_alpha", walletId: "wallet_a", dateKey: "2026-06-08", balance: 100 },
      { id: "snap_b", tenantId: "tenant_beta", walletId: "wallet_b", dateKey: "2026-06-08", balance: 200 },
    ],
    platformPayments: [
      {
        id: "pay_a", tenantId: "tenant_alpha", hash: "hash_a", amount: 100,
        status: "applied", months: 1, days: 0, reason: "续费 1 个月",
        chainTime: "2026-06-08T00:00:00.000Z", createdAt: "2026-06-08T00:01:00.000Z",
        fromAddress: "TFrom", toAddress: "TPlatform", processedBy: "sup_a",
      },
      { id: "pay_b", tenantId: "tenant_beta", hash: "hash_b", amount: 100 },
    ],
    subscriptionSettings: {
      enabled: true,
      monthlyFee: 100,
      platformWalletAddress: "TPlatform",
      autoDisable: true,
    },
    entries: [],
    legacyEntries: [],
    auditLogs: [
      { id: "own_log", tenantId: "tenant_alpha", userId: "emp_a" },
      { id: "other_log", tenantId: "tenant_alpha", userId: "emp_b" },
      { id: "login_log", tenantId: "tenant_alpha", userId: "sup_a", action: "登录系统" },
      { id: "sync_log", tenantId: "tenant_alpha", userId: "sup_a", action: "同步链上流水" },
      { id: "query_log", tenantId: "tenant_alpha", userId: "sup_a", action: "手动查询链上流水" },
      { id: "admin_read_log", tenantId: "tenant_alpha", userId: "admin", action: "查看批注凭证" },
      { id: "admin_write_log", tenantId: "tenant_alpha", userId: "admin", action: "标记非业务流水" },
      { id: "admin_subscription_log", tenantId: "tenant_alpha", userId: "admin", action: "修改租用收费设置" },
      { id: "auto_subscription_log", tenantId: "tenant_alpha", userId: "sup_a", action: "自动确认租用续费" },
      { id: "beta_log", tenantId: "tenant_beta", userId: "sup_b" },
    ],
  };
}

test("supervisors only receive their tenant data", () => {
  const state = fixture();
  const view = stateForUser(state, state.users.find((item) => item.id === "sup_a"));
  assert.deepEqual(view.tenants.map((item) => item.id), ["tenant_alpha"]);
  assert.deepEqual(new Set(view.wallets.map((item) => item.tenantId)), new Set(["tenant_alpha"]));
  assert.deepEqual(view.walletBalanceSnapshots.map((item) => item.id), ["snap_a"]);
  assert.deepEqual(new Set(view.chainTransactions.map((item) => item.tenantId)), new Set(["tenant_alpha"]));
  assert.equal(view.users.some((item) => item.id === "sup_b"), false);
  assert.equal(view.users.some((item) => "passwordHash" in item), false);
  assert.equal("storageKey" in view.annotations[0].attachment, false);
  assert.deepEqual(view.platformPayments.map((item) => item.id), ["pay_a"]);
  assert.equal("fromAddress" in view.platformPayments[0], false);
  assert.equal("toAddress" in view.platformPayments[0], false);
  assert.equal("processedBy" in view.platformPayments[0], false);
  assert.equal(view.subscriptionSettings.monthlyFee, 100);
  assert.equal(view.subscriptionSettings.platformWalletAddress, "TPlatform");
  assert.equal(view.auditLogs.some((item) => item.id === "admin_read_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "login_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "sync_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "query_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "admin_write_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "admin_subscription_log"), false);
  assert.equal(view.auditLogs.some((item) => item.id === "auto_subscription_log"), false);
});

test("limited employees receive unannotated work and their own records only", () => {
  const state = fixture();
  const view = stateForUser(state, state.users.find((item) => item.id === "emp_a"));
  assert.deepEqual(new Set(view.chainTransactions.map((item) => item.id)), new Set(["unannotated", "own"]));
  assert.deepEqual(view.annotations.map((item) => item.id), ["annotation_own"]);
  assert.deepEqual(view.auditLogs.map((item) => item.id), ["own_log"]);
  assert.deepEqual(view.platformPayments, []);
  assert.equal(view.users.some((item) => item.id === "emp_b"), false);
  assert.equal(view.users.some((item) => item.id === "sup_b"), false);
});

test("employees with full ledger visibility receive all tenant records but no other tenant", () => {
  const state = fixture();
  const view = stateForUser(state, state.users.find((item) => item.id === "emp_b"));
  assert.deepEqual(new Set(view.chainTransactions.map((item) => item.id)), new Set(["unannotated", "historical", "own", "other"]));
  assert.deepEqual(new Set(view.annotations.map((item) => item.id)), new Set(["annotation_own", "annotation_other"]));
  assert.equal(view.chainTransactions.some((item) => item.tenantId === "tenant_beta"), false);
  assert.deepEqual(view.auditLogs.map((item) => item.id), ["other_log"]);
});
