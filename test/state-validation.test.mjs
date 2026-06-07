import test from "node:test";
import assert from "node:assert/strict";
import {
  createAnnotation,
  createCategory,
  createEmployee,
  createTenant,
  createWallet,
  disableWallet,
  enforceTenantSubscriptions,
  exportAnnotationsCsv,
  getAnnotationAttachment,
  getAuditLogsForUser,
  getTransactionDetail,
  manualRenewSubscriptionPayment,
  manualRenewTenantSubscription,
  markTransactionNonBusiness,
  migrateAnnotationState,
  requestAnnotationCorrection,
  requestAnnotationReversal,
  restoreNonBusinessTransaction,
  resubmitAnnotation,
  reviewAnnotation,
  searchChainTransactions,
  submitSubscriptionHash,
  syncChainTransactions,
  updateCategory,
  updateEmployeePermission,
  updateSubscriptionSettings,
  updateTenantStatus,
  updateWalletManagedFrom,
  validateState,
  walletBalance,
} from "../server/domain.mjs";
import { hashPassword, verifyPassword } from "../server/auth.mjs";

function ledgerState(overrides = {}) {
  return {
    activeTenantId: "tenant_alpha",
    activeUserId: "admin",
    activeView: "dashboard",
    categories: { income: ["客户回款", "其他进账"], expense: ["供应商付款", "其他出账"] },
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true }],
    users: [
      { id: "admin", tenantId: null, name: "管理员", role: "admin", canViewAll: true },
      { id: "sup", tenantId: "tenant_alpha", name: "主管", role: "supervisor", canViewAll: true },
      { id: "emp", tenantId: "tenant_alpha", name: "员工", role: "employee", canViewAll: true },
      { id: "other", tenantId: "tenant_alpha", name: "员工乙", role: "employee", canViewAll: true },
    ],
    wallets: [{ id: "wallet", tenantId: "tenant_alpha", alias: "主钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" }],
    annotations: [],
    entries: [],
    legacyEntries: [],
    chainTransactions: [{
      id: "tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "hash", direction: "expense",
      amount: 800, counterparty: "T999", confirmed: true, chainTime: "2026-06-05T12:30:00.000Z",
      currentAnnotationId: null,
    }],
    platformPayments: [],
    subscriptionSettings: { monthlyFee: 100, platformWalletAddress: "TUfGNh99WN3GH5WjnqFKottWuYKpjomNbd", enabled: true, autoDisable: true },
    auditLogs: [],
    ...overrides,
  };
}

const user = (state, id) => state.users.find((item) => item.id === id);

function annotate(state, overrides = {}) {
  return createAnnotation(state, {
    user: user(state, "emp"),
    input: { chainTxId: "tx", category: "供应商付款", note: "供应商货款", ...overrides },
    now: "2026-06-05T12:40:00.000Z",
  });
}

test("accepts the chain transaction and annotation state shape", () => {
  assert.equal(validateState(ledgerState()), null);
});

test("migrates a legacy matched ledger entry into an annotation", () => {
  const state = ledgerState({
    annotations: undefined,
    entries: [{
      id: "entry", tenantId: "tenant_alpha", chainTxId: "tx", category: "供应商付款",
      note: "旧账", submittedBy: "emp", status: "approved", createdAt: "2026-06-05T12:35:00.000Z",
    }],
  });
  migrateAnnotationState(state);
  assert.equal(state.annotations.length, 1);
  assert.equal(state.chainTransactions[0].currentAnnotationId, "annotation_entry");
  assert.equal(state.entries.length, 0);
});

test("verifies default and hashed passwords", () => {
  assert.equal(verifyPassword({ id: "demo" }, "123456"), true);
  assert.equal(verifyPassword({ id: "demo" }, "123456", { allowDemoPassword: false }), false);
  const hashed = { passwordHash: hashPassword("secret") };
  assert.equal(verifyPassword(hashed, "secret"), true);
});

test("creates a pending annotation without accepting amount or wallet overrides", () => {
  const state = ledgerState();
  const annotation = annotate(state, { amount: 1, walletId: "fake" });
  const tx = state.chainTransactions[0];
  assert.equal(annotation.status, "pending");
  assert.equal(annotation.chainTxId, tx.id);
  assert.equal(tx.amount, 800);
  assert.equal(tx.walletId, "wallet");
  assert.equal(tx.currentAnnotationId, annotation.id);
  assert.equal(state.auditLogs[0].action, "提交链上流水批注");
});

test("requires category to match the transaction direction", () => {
  const state = ledgerState();
  assert.throws(() => annotate(state, { category: "客户回款" }), /方向不一致/);
});

test("supervisor approves every pending annotation", () => {
  const state = ledgerState();
  const annotation = annotate(state);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: annotation.id, action: "approve" });
  assert.equal(annotation.status, "approved");
  assert.equal(annotation.reviewedBy, "sup");
});

test("rejected annotation can be edited and resubmitted as a new version", () => {
  const state = ledgerState();
  const first = annotate(state);
  reviewAnnotation(state, {
    user: user(state, "sup"), annotationId: first.id, action: "reject", rejectionReason: "缺少业务凭证",
  });
  const second = resubmitAnnotation(state, {
    user: user(state, "emp"),
    annotationId: first.id,
    input: { category: "供应商付款", note: "已补充合同编号", attachment: { name: "contract.pdf", dataUrl: "data:application/pdf;base64,abc" } },
  });
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "pending");
  assert.equal(second.version, 2);
  assert.equal(second.previousAnnotationId, first.id);
  assert.equal(state.chainTransactions[0].currentAnnotationId, second.id);
});

test("employee cannot resubmit another employee's rejected annotation", () => {
  const state = ledgerState();
  const first = annotate(state);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: first.id, action: "reject", rejectionReason: "资料不全" });
  assert.throws(() => resubmitAnnotation(state, {
    user: user(state, "other"), annotationId: first.id, input: { category: "供应商付款", note: "尝试修改" },
  }), /只能修改自己/);
});

test("approved correction keeps the old version effective until supervisor approval", () => {
  const state = ledgerState();
  const first = annotate(state);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: first.id, action: "approve" });
  const correction = requestAnnotationCorrection(state, {
    user: user(state, "emp"),
    annotationId: first.id,
    input: { category: "其他出账", note: "实际为临时垫付款" },
  });
  assert.equal(state.chainTransactions[0].currentAnnotationId, first.id);
  assert.equal(first.status, "approved");
  assert.equal(correction.status, "pending");
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: correction.id, action: "approve" });
  assert.equal(first.status, "corrected");
  assert.equal(state.chainTransactions[0].currentAnnotationId, correction.id);
});

test("approved reversal preserves the chain transaction but removes business recognition", () => {
  const state = ledgerState();
  const first = annotate(state);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: first.id, action: "approve" });
  const reversal = requestAnnotationReversal(state, {
    user: user(state, "emp"), annotationId: first.id, reason: "该笔为钱包测试转账",
  });
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: reversal.id, action: "approve" });
  assert.equal(state.chainTransactions.length, 1);
  assert.equal(first.status, "reversed");
  assert.equal(reversal.correctionType, "reversal");
  assert.equal(reversal.status, "approved");
});

test("exports chain amount with annotation and employee visibility restrictions", () => {
  const state = ledgerState();
  const annotation = annotate(state);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: annotation.id, action: "approve" });
  const csv = exportAnnotationsCsv(state, { user: user(state, "emp"), filters: { tenantId: "tenant_alpha" } });
  assert.match(csv, /800/);
  assert.match(csv, /供应商货款/);
  assert.match(csv, /员工/);
});

test("exports actionable transactions first and sorts each status by chain time descending", () => {
  const transactions = [
    { id: "approved", hash: "hash-approved", chainTime: "2026-06-05T15:00:00.000Z", currentAnnotationId: "annotation-approved" },
    { id: "unannotated-new", hash: "hash-unannotated-new", chainTime: "2026-06-05T14:00:00.000Z", currentAnnotationId: null },
    { id: "rejected", hash: "hash-rejected", chainTime: "2026-06-05T13:00:00.000Z", currentAnnotationId: "annotation-rejected" },
    { id: "unannotated-old", hash: "hash-unannotated-old", chainTime: "2026-06-05T12:30:00.000Z", currentAnnotationId: null },
    { id: "pending", hash: "hash-pending", chainTime: "2026-06-05T12:00:00.000Z", currentAnnotationId: "annotation-pending" },
  ].map((item) => ({
    tenantId: "tenant_alpha", walletId: "wallet", direction: "expense", amount: 1,
    counterparty: "T999", confirmed: true, ...item,
  }));
  const annotations = ["approved", "rejected", "pending"].map((status) => ({
    id: `annotation-${status}`, tenantId: "tenant_alpha", chainTxId: status,
    category: "供应商付款", note: status, annotatedBy: "emp", status,
    version: 1, correctionType: null, createdAt: "2026-06-05T16:00:00.000Z",
  }));
  const state = ledgerState({ chainTransactions: transactions, annotations });
  const csv = exportAnnotationsCsv(state, { user: user(state, "sup"), filters: {} });

  const positions = [
    "hash-rejected",
    "hash-unannotated-new",
    "hash-unannotated-old",
    "hash-pending",
    "hash-approved",
  ].map((hash) => csv.indexOf(hash));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
});

test("supervisor marks unannotated transaction as non-business and can restore it", () => {
  const state = ledgerState();
  const annotation = markTransactionNonBusiness(state, {
    user: user(state, "sup"),
    txId: "tx",
    reason: "测试充值，不计入业务现金流",
  });
  assert.equal(annotation.status, "non_business");
  assert.equal(state.chainTransactions[0].currentAnnotationId, annotation.id);

  const csv = exportAnnotationsCsv(state, { user: user(state, "sup"), filters: { status: "non_business" } });
  assert.match(csv, /非业务流水/);
  assert.match(csv, /测试充值/);
  assert.throws(() => createAnnotation(state, {
    user: user(state, "emp"),
    input: { chainTxId: "tx", category: "供应商付款", note: "尝试重新批注" },
  }), /已有有效批注/);

  restoreNonBusinessTransaction(state, { user: user(state, "sup"), annotationId: annotation.id });
  assert.equal(annotation.status, "restored");
  assert.equal(state.chainTransactions[0].currentAnnotationId, null);

  const newAnnotation = annotate(state);
  assert.equal(newAnnotation.status, "pending");
});

test("employee cannot mark a transaction as non-business", () => {
  const state = ledgerState();
  assert.throws(() => markTransactionNonBusiness(state, {
    user: user(state, "emp"),
    txId: "tx",
    reason: "员工尝试跳过审核",
  }), /主管权限/);
});

test("supervisor cannot see admin read-only audit logs", () => {
  const state = ledgerState({
    auditLogs: [
      { id: "admin_read", tenantId: "tenant_alpha", userId: "admin", action: "查看批注凭证", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "admin_export", tenantId: "tenant_alpha", userId: "admin", action: "导出链上流水批注", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "supervisor_login", tenantId: "tenant_alpha", userId: "sup", action: "登录系统", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "supervisor_query", tenantId: "tenant_alpha", userId: "sup", action: "手动查询链上流水", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "supervisor_sync", tenantId: "tenant_alpha", userId: "sup", action: "同步链上流水", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "supervisor_failure", tenantId: "tenant_alpha", userId: "sup", action: "链上钱包同步失败", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "supervisor_auto_renew", tenantId: "tenant_alpha", userId: "sup", action: "自动确认租用续费", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "admin_write", tenantId: "tenant_alpha", userId: "admin", action: "标记非业务流水", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "admin_subscription", tenantId: "tenant_alpha", userId: "admin", action: "修改租用收费设置", createdAt: "2026-06-07T00:00:00.000Z" },
      { id: "employee_write", tenantId: "tenant_alpha", userId: "emp", action: "提交链上流水批注", createdAt: "2026-06-07T00:00:00.000Z" },
    ],
  });
  const supervisorLogs = getAuditLogsForUser(state, { user: user(state, "sup"), tenantId: "tenant_alpha" });
  assert.deepEqual(supervisorLogs.map((log) => log.id), ["employee_write"]);

  const adminLogs = getAuditLogsForUser(state, { user: user(state, "admin"), tenantId: "tenant_alpha" });
  assert.deepEqual(adminLogs.map((log) => log.id), [
    "admin_read",
    "admin_export",
    "supervisor_login",
    "supervisor_query",
    "supervisor_sync",
    "supervisor_failure",
    "supervisor_auto_renew",
    "admin_write",
    "admin_subscription",
    "employee_write",
  ]);
});

test("returns transaction history and attachment", () => {
  const state = ledgerState();
  const annotation = annotate(state, { attachment: { name: "proof.png", dataUrl: "data:image/png;base64,abc" } });
  const detail = getTransactionDetail(state, { user: user(state, "emp"), txId: "tx" });
  const attachment = getAnnotationAttachment(state, { user: user(state, "emp"), annotationId: annotation.id });
  assert.equal(detail.annotations[0].id, annotation.id);
  assert.equal(attachment.name, "proof.png");
});

test("limited employees can only download attachments from their own annotations", () => {
  const state = ledgerState();
  const annotation = annotate(state, { attachment: { name: "proof.png", dataUrl: "data:image/png;base64,YQ==" } });
  user(state, "other").canViewAll = false;
  assert.throws(() => getAnnotationAttachment(state, {
    user: user(state, "other"),
    annotationId: annotation.id,
  }), /没有下载/);
  assert.equal(getAnnotationAttachment(state, {
    user: user(state, "sup"),
    annotationId: annotation.id,
  }).name, "proof.png");
});

test("resubmitted and corrected annotations inherit the previous attachment", () => {
  const state = ledgerState();
  const first = annotate(state, {
    attachment: { name: "proof.pdf", dataUrl: "data:application/pdf;base64,YQ==" },
  });
  reviewAnnotation(state, {
    user: user(state, "sup"), annotationId: first.id, action: "reject", rejectionReason: "补充说明",
  });
  const second = resubmitAnnotation(state, {
    user: user(state, "emp"),
    annotationId: first.id,
    input: { category: "供应商付款", note: "已补充业务说明" },
  });
  assert.equal(second.attachment, first.attachment);
  reviewAnnotation(state, { user: user(state, "sup"), annotationId: second.id, action: "approve" });
  const correction = requestAnnotationCorrection(state, {
    user: user(state, "emp"),
    annotationId: second.id,
    input: { category: "其他出账", note: "修正分类" },
  });
  assert.equal(correction.attachment, second.attachment);
});

test("calculates wallet balance from confirmed chain transactions", () => {
  const transactions = [
    { walletId: "wallet", direction: "income", amount: 1000, confirmed: true },
    { walletId: "wallet", direction: "expense", amount: 100, confirmed: true },
    { walletId: "wallet", direction: "expense", amount: 900, confirmed: false },
  ];
  assert.equal(walletBalance(transactions, "wallet"), 900);
});

test("supervisor manages wallets, employees and visibility permissions", () => {
  const state = ledgerState();
  createWallet(state, { user: user(state, "sup"), input: { alias: "新钱包", chain: "TRC20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" } });
  createEmployee(state, { user: user(state, "sup"), input: { name: "员工丙", canViewAll: false } });
  updateEmployeePermission(state, { user: user(state, "sup"), employeeId: "emp", canViewAll: false });
  disableWallet(state, { user: user(state, "sup"), walletId: "wallet" });
  assert.equal(state.wallets.find((item) => item.id === "wallet").enabled, false);
  assert.equal(user(state, "emp").canViewAll, false);
});

test("wallet management start time controls whether employees must annotate history", () => {
  const state = ledgerState({
    wallets: [{ id: "wallet", tenantId: "tenant_alpha", alias: "主钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-06T00:00:00.000Z" }],
  });
  assert.throws(() => annotate(state), /早于钱包纳入管理时间/);
  const supervisorAnnotation = createAnnotation(state, {
    user: user(state, "sup"),
    input: { chainTxId: "tx", category: "供应商付款", note: "主管主动补历史批注" },
  });
  assert.equal(supervisorAnnotation.status, "pending");
});

test("wallet management start time cannot be changed after creation", () => {
  const state = ledgerState();
  assert.throws(() => updateWalletManagedFrom(state, {
    user: user(state, "sup"),
    walletId: "wallet",
    managedFrom: "2026-06-04T00:00:00.000Z",
    now: "2026-06-06T01:00:00.000Z",
  }), /创建后不可修改/);
  assert.equal(state.wallets[0].managedFrom, "2026-06-01T00:00:00.000Z");
  assert.equal(state.auditLogs.length, 0);
});

test("admin creates tenants and global categories", () => {
  const state = ledgerState();
  createTenant(state, { user: user(state, "admin"), input: { name: "Beta", supervisorName: "Beta 主管" } });
  createCategory(state, { user: user(state, "admin"), input: { type: "income", name: "新进账分类" } });
  assert.equal(state.tenants.at(-1).name, "Beta");
  assert.equal(state.categories.income.includes("新进账分类"), true);
});

test("admin manages tenant enabled status", () => {
  const state = ledgerState();
  updateTenantStatus(state, {
    user: user(state, "admin"),
    tenantId: "tenant_alpha",
    enabled: false,
    now: "2026-06-08T01:00:00.000Z",
  });
  assert.equal(state.tenants[0].enabled, false);
  assert.equal(state.tenants[0].updatedAt, "2026-06-08T01:00:00.000Z");
  assert.equal(state.auditLogs[0].action, "停用独立系统");

  updateTenantStatus(state, {
    user: user(state, "admin"),
    tenantId: "tenant_alpha",
    enabled: true,
    now: "2026-06-08T02:00:00.000Z",
  });
  assert.equal(state.tenants[0].enabled, true);
  assert.equal(state.auditLogs[0].action, "启用独立系统");
  assert.equal(state.auditLogs[1].action, "停用独立系统");
  assert.throws(() => updateTenantStatus(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    enabled: false,
  }), /管理员权限/);
});

test("supervisor renews a tenant by submitting a unique transaction hash", () => {
  const hash = "a".repeat(64);
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-06-20T00:00:00.000Z" }],
  });
  const payment = submitSubscriptionHash(state, {
    user: user(state, "sup"),
    hash,
    now: "2026-06-08T00:00:00.000Z",
    transaction: {
      hash, direction: "income", amount: 200, counterparty: "TPayer",
      confirmed: true, chainTime: "2026-06-08T00:00:00.000Z",
    },
  });
  assert.equal(payment.status, "applied");
  assert.equal(payment.months, 2);
  assert.equal(state.tenants[0].subscriptionExpiresAt, "2026-08-20T00:00:00.000Z");
  assert.throws(() => submitSubscriptionHash(state, {
    user: user(state, "sup"),
    hash,
    transaction: { hash, direction: "income", amount: 200, confirmed: true },
  }), /不能重复提交/);
});

test("bad hash payment amount is left for admin manual renewal", () => {
  const hash = "b".repeat(64);
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: false, subscriptionExpiresAt: "2026-06-01T00:00:00.000Z" }],
  });
  const payment = submitSubscriptionHash(state, {
    user: user(state, "sup"),
    hash,
    now: "2026-06-08T00:00:00.000Z",
    transaction: {
      hash, direction: "income", amount: 150, counterparty: "TPayer",
      confirmed: true, chainTime: "2026-06-08T00:00:00.000Z",
    },
  });
  assert.equal(payment.status, "amount_abnormal");
  manualRenewSubscriptionPayment(state, {
    user: user(state, "admin"),
    paymentId: payment.id,
    tenantId: "tenant_alpha",
    months: 1,
    days: 15,
    reason: "金额不是整月，管理员确认续费",
    now: "2026-06-08T00:02:00.000Z",
  });
  assert.equal(state.tenants[0].enabled, true);
  assert.equal(state.tenants[0].subscriptionExpiresAt, "2026-07-23T00:02:00.000Z");
});

test("subscription settings and expiry are admin controlled", () => {
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-06-01T00:00:00.000Z" }],
  });
  updateSubscriptionSettings(state, {
    user: user(state, "admin"),
    input: { monthlyFee: 80, platformWalletAddress: "TUfGNh99WN3GH5WjnqFKottWuYKpjomNbd", enabled: true, autoDisable: true },
  });
  assert.equal(state.subscriptionSettings.monthlyFee, 80);
  const expired = enforceTenantSubscriptions(state, { user: user(state, "admin"), now: "2026-06-08T00:00:00.000Z" });
  assert.equal(expired.length, 1);
  assert.equal(state.tenants[0].enabled, false);
  assert.throws(() => updateSubscriptionSettings(state, {
    user: user(state, "sup"),
    input: { monthlyFee: 80 },
  }), /管理员权限/);
});

test("admin can renew a tenant manually without a chain payment", () => {
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: false, subscriptionExpiresAt: "2026-06-01T00:00:00.000Z" }],
  });
  const payment = manualRenewTenantSubscription(state, {
    user: user(state, "admin"),
    tenantId: "tenant_alpha",
    months: 2,
    days: 10,
    amount: 150,
    reason: "金额打错，人工按 2 个月 10 天处理",
    now: "2026-06-08T00:00:00.000Z",
  });
  assert.equal(payment.status, "offline_applied");
  assert.equal(payment.amount, 150);
  assert.equal(payment.days, 10);
  assert.equal(state.tenants[0].enabled, true);
  assert.equal(state.tenants[0].subscriptionExpiresAt, "2026-08-18T00:00:00.000Z");
  assert.equal(state.auditLogs[1].action, "线下手工租用续费");
  const dayOnly = manualRenewTenantSubscription(state, {
    user: user(state, "admin"),
    tenantId: "tenant_alpha",
    months: 0,
    days: 7,
    reason: "补偿 7 天",
    now: "2026-06-08T01:00:00.000Z",
  });
  assert.equal(dayOnly.days, 7);
  assert.equal(state.tenants[0].subscriptionExpiresAt, "2026-08-25T00:00:00.000Z");
  assert.throws(() => manualRenewTenantSubscription(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    months: 1,
    reason: "主管尝试续费",
  }), /管理员权限/);
});

test("admin renames global categories without touching historical annotations", () => {
  const state = ledgerState();
  const annotation = annotate(state, { category: "供应商付款", note: "历史记录" });
  updateCategory(state, {
    user: user(state, "admin"),
    type: "expense",
    oldName: "供应商付款",
    input: { name: "供应商结算" },
  });
  assert.deepEqual(state.categories.expense, ["供应商结算", "其他出账"]);
  assert.equal(annotation.category, "供应商付款");
  assert.equal(state.auditLogs[0].action, "修改全局分类");
  assert.throws(() => updateCategory(state, {
    user: user(state, "admin"),
    type: "expense",
    oldName: "供应商结算",
    input: { name: "其他出账" },
  }), /已存在/);
});

test("syncs unique chain transactions and searches by hash", () => {
  const state = ledgerState({ chainTransactions: [] });
  const created = syncChainTransactions(state, { user: user(state, "sup"), tenantId: "tenant_alpha" });
  assert.equal(created.length, 1);
  const results = searchChainTransactions(state, { user: user(state, "sup"), query: created[0].hash, tenantId: "tenant_alpha" });
  assert.equal(results[0].id, created[0].id);
});

test("keeps both sides of an internal wallet transfer with the same hash", () => {
  const state = ledgerState({
    wallets: [
      { id: "wallet", tenantId: "tenant_alpha", alias: "付款钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
      { id: "wallet-2", tenantId: "tenant_alpha", alias: "收款钱包", chain: "TRC20", address: "T456", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
    ],
    chainTransactions: [],
  });
  const created = syncChainTransactions(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    externalTransactions: [
      { walletId: "wallet", hash: "same-hash", eventIndex: 1, direction: "expense", amount: 100, counterparty: "T456", confirmed: true, chainTime: "2026-06-06T01:00:00.000Z" },
      { walletId: "wallet-2", hash: "same-hash", eventIndex: 1, direction: "income", amount: 100, counterparty: "T123", confirmed: true, chainTime: "2026-06-06T01:00:00.000Z" },
    ],
  });
  assert.equal(created.length, 2);
  const outgoing = created.find((tx) => tx.direction === "expense");
  const incoming = created.find((tx) => tx.direction === "income");
  assert.equal(outgoing.transactionType, "transfer");
  assert.equal(outgoing.internalTransferStatus, "paired");
  assert.equal(outgoing.transferPrimary, true);
  assert.equal(outgoing.pairedTxId, incoming.id);
  assert.equal(incoming.transactionType, "transfer");
  assert.equal(incoming.internalTransferStatus, "paired");
  assert.equal(incoming.transferPrimary, false);

  const annotation = createAnnotation(state, {
    user: user(state, "emp"),
    input: { chainTxId: outgoing.id, category: "供应商付款", note: "团队钱包资金调拨" },
  });
  assert.equal(annotation.category, "内部划转");
  assert.deepEqual(new Set(annotation.linkedChainTxIds), new Set([outgoing.id, incoming.id]));
  assert.equal(outgoing.currentAnnotationId, annotation.id);
  assert.equal(incoming.currentAnnotationId, annotation.id);

  reviewAnnotation(state, { user: user(state, "sup"), annotationId: annotation.id, action: "approve" });
  assert.equal(annotation.status, "approved");
  const csv = exportAnnotationsCsv(state, { user: user(state, "sup"), filters: { direction: "transfer" } });
  assert.match(csv, /内部划转/);
  assert.match(csv, /付款钱包 → 收款钱包/);
  assert.equal(csv.split("\n").length, 2);
});

test("waits for the other side before allowing an internal transfer annotation", () => {
  const state = ledgerState({
    wallets: [
      { id: "wallet", tenantId: "tenant_alpha", alias: "付款钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
      { id: "wallet-2", tenantId: "tenant_alpha", alias: "收款钱包", chain: "TRC20", address: "T456", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
    ],
    chainTransactions: [],
  });
  const [outgoing] = syncChainTransactions(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    externalTransactions: [
      { walletId: "wallet", hash: "delayed-hash", eventIndex: 2, direction: "expense", amount: 88, counterparty: "T456", confirmed: true, chainTime: "2026-06-06T02:00:00.000Z" },
    ],
  });
  assert.equal(outgoing.internalTransferStatus, "pending");
  assert.throws(() => createAnnotation(state, {
    user: user(state, "emp"),
    input: { chainTxId: outgoing.id, note: "暂时不应允许批注" },
  }), /另一侧流水尚未同步/);

  const [incoming] = syncChainTransactions(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    externalTransactions: [
      { walletId: "wallet-2", hash: "delayed-hash", eventIndex: 2, direction: "income", amount: 88, counterparty: "T123", confirmed: true, chainTime: "2026-06-06T02:00:00.000Z" },
    ],
  });
  assert.equal(outgoing.internalTransferStatus, "paired");
  assert.equal(incoming.internalTransferStatus, "paired");
});

test("recognizes an incoming-only internal transfer as waiting for confirmation", () => {
  const state = ledgerState({
    wallets: [
      { id: "wallet", tenantId: "tenant_alpha", alias: "付款钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
      { id: "wallet-2", tenantId: "tenant_alpha", alias: "收款钱包", chain: "TRC20", address: "T456", enabled: true, managedFrom: "2026-06-01T00:00:00.000Z" },
    ],
    chainTransactions: [],
  });
  const [incoming] = syncChainTransactions(state, {
    user: user(state, "sup"),
    tenantId: "tenant_alpha",
    externalTransactions: [
      { walletId: "wallet-2", hash: "incoming-first", eventIndex: 3, direction: "income", amount: 66, counterparty: "T123", confirmed: true, chainTime: "2026-06-06T03:00:00.000Z" },
    ],
  });
  assert.equal(incoming.transactionType, "transfer");
  assert.equal(incoming.internalTransferStatus, "pending");
  assert.equal(incoming.transferPrimary, true);
});
