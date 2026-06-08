import test from "node:test";
import assert from "node:assert/strict";
import {
  autoCloseStaleSupportTickets,
  createAnnotation,
  createReceivablePayable,
  createReceivableSettlement,
  createSupportTicket,
  createCategory,
  createEmployee,
  createTenant,
  createWallet,
  disableWallet,
  enableWallet,
  enforceTenantSubscriptions,
  exportAnnotationsCsv,
  exportReceivablePayablesCsv,
  getAnnotationAttachment,
  getAuditLogsForUser,
  getReceivableAttachment,
  getSupportTicketAttachment,
  getTransactionDetail,
  manualRenewSubscriptionPayment,
  manualRenewTenantSubscription,
  markTransactionNonBusiness,
  migrateAnnotationState,
  requestAnnotationCorrection,
  requestAnnotationReversal,
  restoreNonBusinessTransaction,
  resubmitAnnotation,
  resetUserPassword,
  resetUserTotp,
  reviewAnnotation,
  reviewReceivablePayable,
  reviewReceivableSettlement,
  replySupportTicket,
  searchChainTransactions,
  submitSubscriptionHash,
  syncChainTransactions,
  updateCategory,
  updateEmployeePermission,
  updateSubscriptionSettings,
  updateSystemSettings,
  updateSupportTicketStatus,
  updateTenantStatus,
  updateWalletManagedFrom,
  validateState,
  walletBalance,
} from "../server/domain.mjs";
import { hashPassword, verifyPassword, verifyTotp } from "../server/auth.mjs";

function ledgerState(overrides = {}) {
  return {
    activeTenantId: "tenant_alpha",
    activeUserId: "admin",
    activeView: "dashboard",
    categories: { income: ["客户回款", "其他进账"], expense: ["供应商付款", "其他出账"] },
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" }],
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
    supportTickets: [],
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

test("unopened tenant cannot perform billable business operations", () => {
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "", subscriptionStatus: "unset" }],
  });
  assert.throws(() => createWallet(state, {
    user: user(state, "sup"),
    input: { alias: "新钱包", chain: "TRC20", address: "TUfGNh99WN3GH5WjnqFKottWuYKpjomNbd" },
  }), /租用未开通/);
  assert.throws(() => annotate(state), /租用未开通/);
  assert.throws(() => createReceivablePayable(state, {
    user: user(state, "emp"),
    input: { type: "receivable", counterparty: "客户A", amount: 100, category: "客户回款", note: "测试应收" },
  }), /租用未开通/);
  assert.throws(() => syncChainTransactions(state, { user: user(state, "sup"), tenantId: "tenant_alpha" }), /租用未开通/);
});

test("supervisor creates support ticket and admin reply moves it to tenant side", () => {
  const state = ledgerState();
  const ticket = createSupportTicket(state, {
    user: user(state, "sup"),
    input: { title: "续费未生效", category: "subscription", priority: "urgent", content: "交易哈希已提交但租用状态没有变化" },
    now: "2026-06-05T13:00:00.000Z",
  });
  assert.equal(ticket.status, "waiting_admin");
  assert.equal(ticket.messages.length, 1);
  assert.equal(state.auditLogs[0].action, "提交工单");

  replySupportTicket(state, {
    user: user(state, "admin"),
    ticketId: ticket.id,
    content: "已收到，正在核对平台收款钱包流水",
    now: "2026-06-05T13:05:00.000Z",
  });
  assert.equal(ticket.status, "waiting_tenant");
  assert.equal(ticket.messages.length, 2);
  assert.throws(() => updateSupportTicketStatus(state, {
    user: user(state, "sup"),
    ticketId: ticket.id,
    status: "open",
  }), /只有管理员可以标记工单处理中/);

  updateSupportTicketStatus(state, {
    user: user(state, "sup"),
    ticketId: ticket.id,
    status: "closed",
    now: "2026-06-05T13:10:00.000Z",
  });
  assert.equal(ticket.status, "closed");
  assert.equal(ticket.closedBy, "sup");

  replySupportTicket(state, {
    user: user(state, "sup"),
    ticketId: ticket.id,
    content: "我补充一下截图和说明",
    now: "2026-06-05T13:20:00.000Z",
  });
  assert.equal(ticket.status, "waiting_admin");
  assert.equal(ticket.closedAt, null);
  assert.equal(ticket.closedBy, null);
  assert.equal(ticket.autoClosed, false);
});

test("waiting tenant support tickets warn then auto close after four days", () => {
  const state = ledgerState();
  const ticket = createSupportTicket(state, {
    user: user(state, "sup"),
    input: { title: "需要确认", category: "other", priority: "normal", content: "请平台处理" },
    now: "2026-06-01T00:00:00.000Z",
  });
  replySupportTicket(state, {
    user: user(state, "admin"),
    ticketId: ticket.id,
    content: "请确认是否恢复",
    now: "2026-06-01T01:00:00.000Z",
  });
  assert.equal(ticket.status, "waiting_tenant");

  assert.deepEqual(autoCloseStaleSupportTickets(state, { now: "2026-06-04T01:00:00.000Z" }), []);
  assert.equal(ticket.status, "waiting_tenant");

  const closed = autoCloseStaleSupportTickets(state, { now: "2026-06-05T01:00:00.000Z" });
  assert.deepEqual(closed.map((item) => item.id), [ticket.id]);
  assert.equal(ticket.status, "closed");
  assert.equal(ticket.closedBy, "system");
  assert.equal(ticket.autoClosed, true);
  assert.equal(state.auditLogs[0].action, "工单超时自动关闭");
});

test("support ticket attachments follow tenant permissions", () => {
  const state = ledgerState({
    tenants: [
      { id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
      { id: "tenant_beta", name: "Beta", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
    ],
    users: [
      { id: "admin", tenantId: null, name: "管理员", role: "admin", canViewAll: true },
      { id: "sup", tenantId: "tenant_alpha", name: "主管", role: "supervisor", canViewAll: true },
      { id: "beta_sup", tenantId: "tenant_beta", name: "Beta 主管", role: "supervisor", canViewAll: true },
    ],
  });
  const ticket = createSupportTicket(state, {
    user: user(state, "sup"),
    input: {
      title: "同步异常",
      content: "钱包同步状态截图",
      attachment: { name: "sync-error.png", dataUrl: "data:image/png;base64,YQ==" },
    },
  });
  const messageId = ticket.messages[0].id;
  assert.equal(getSupportTicketAttachment(state, { user: user(state, "sup"), ticketId: ticket.id, messageId }).name, "sync-error.png");
  assert.equal(getSupportTicketAttachment(state, { user: user(state, "admin"), ticketId: ticket.id, messageId }).name, "sync-error.png");
  assert.throws(() => getSupportTicketAttachment(state, {
    user: user(state, "beta_sup"),
    ticketId: ticket.id,
    messageId,
  }), /没有操作该工单/);
});

test("support tickets are restricted to supervisors, admins and own tenant", () => {
  const state = ledgerState({
    tenants: [
      { id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
      { id: "tenant_beta", name: "Beta", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
    ],
    users: [
      { id: "admin", tenantId: null, name: "管理员", role: "admin", canViewAll: true },
      { id: "sup", tenantId: "tenant_alpha", name: "主管", role: "supervisor", canViewAll: true },
      { id: "emp", tenantId: "tenant_alpha", name: "员工", role: "employee", canViewAll: true },
      { id: "beta_sup", tenantId: "tenant_beta", name: "Beta 主管", role: "supervisor", canViewAll: true },
    ],
  });
  assert.throws(() => createSupportTicket(state, {
    user: user(state, "emp"),
    input: { title: "员工提交", content: "尝试提交" },
  }), /只有主管/);

  const ticket = createSupportTicket(state, {
    user: user(state, "sup"),
    input: { title: "Alpha 问题", content: "需要平台处理" },
  });
  assert.throws(() => replySupportTicket(state, {
    user: user(state, "beta_sup"),
    ticketId: ticket.id,
    content: "跨租户回复",
  }), /没有操作该工单/);
  assert.doesNotThrow(() => replySupportTicket(state, {
    user: user(state, "admin"),
    ticketId: ticket.id,
    content: "平台可回复",
  }));
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

test("verifies TOTP codes for bound accounts", () => {
  const user = { totpSecret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" };
  const now = new Date("1970-01-01T00:00:59.000Z");
  assert.equal(verifyTotp({}, "", { now }), true);
  assert.equal(verifyTotp(user, "000000", { now, window: 0 }), false);
  assert.equal(verifyTotp(user, "287082", { now, window: 0 }), true);
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
  createEmployee(state, { user: user(state, "sup"), input: { name: "员工丙", loginName: "emp_c", password: "secret123", canViewAll: false } });
  const newSupervisor = createEmployee(state, {
    user: user(state, "sup"),
    input: { name: "主管乙", role: "supervisor", loginName: "sup_b", password: "secret123" },
  });
  updateEmployeePermission(state, { user: user(state, "sup"), employeeId: "emp", canViewAll: false });
  disableWallet(state, { user: user(state, "sup"), walletId: "wallet" });
  assert.equal(state.wallets.find((item) => item.id === "wallet").enabled, false);
  enableWallet(state, { user: user(state, "sup"), walletId: "wallet" });
  assert.equal(state.wallets.find((item) => item.id === "wallet").enabled, true);
  assert.equal(user(state, "emp").canViewAll, false);
  assert.equal(newSupervisor.role, "supervisor");
  assert.equal(newSupervisor.canViewAll, true);
  assert.equal(verifyPassword(newSupervisor, "secret123", { allowDemoPassword: false }), true);
  assert.throws(() => createEmployee(state, {
    user: user(state, "sup"),
    input: { name: "重复账号", loginName: "emp_c", password: "secret123" },
  }), /登录账号已存在/);
});

test("admin and supervisor reset account password and login key within permission scope", () => {
  const state = ledgerState({
    tenants: [
      { id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
      { id: "tenant_beta", name: "Beta", enabled: true, subscriptionExpiresAt: "2026-12-31T00:00:00.000Z", subscriptionStatus: "active" },
    ],
    users: [
      { id: "admin", tenantId: null, name: "管理员", role: "admin", canViewAll: true },
      { id: "sup", tenantId: "tenant_alpha", name: "Alpha主管", role: "supervisor", canViewAll: true },
      { id: "emp", tenantId: "tenant_alpha", name: "Alpha员工", role: "employee", canViewAll: true },
      { id: "beta_emp", tenantId: "tenant_beta", name: "Beta员工", role: "employee", canViewAll: true },
    ],
  });
  resetUserPassword(state, { user: user(state, "admin"), userId: "beta_emp", password: "newpass123" });
  assert.equal(verifyPassword(user(state, "beta_emp"), "newpass123", { allowDemoPassword: false }), true);
  const reset = resetUserTotp(state, { user: user(state, "admin"), userId: "admin" });
  assert.ok(reset.totpSecret);
  updateEmployeePermission(state, { user: user(state, "admin"), employeeId: "beta_emp", canViewAll: false });
  assert.equal(user(state, "beta_emp").canViewAll, false);
  assert.throws(() => resetUserPassword(state, { user: user(state, "sup"), userId: "beta_emp", password: "newpass123" }), /没有操作该账号的权限|当前账号没有主管权限/);
});

test("users can reset their own password and login key only", () => {
  const state = ledgerState();
  resetUserPassword(state, { user: user(state, "emp"), userId: "emp", password: "selfpass123" });
  assert.equal(verifyPassword(user(state, "emp"), "selfpass123", { allowDemoPassword: false }), true);
  const reset = resetUserTotp(state, { user: user(state, "emp"), userId: "emp" });
  assert.ok(reset.totpSecret);
  assert.throws(() => resetUserPassword(state, { user: user(state, "emp"), userId: "other", password: "badpass123" }), /当前账号没有主管权限|没有操作该账号的权限/);
  assert.throws(() => resetUserTotp(state, { user: user(state, "emp"), userId: "other" }), /当前账号没有主管权限|没有操作该账号的权限/);
});

test("admin wallet enabled limit blocks new and re-enabled wallets", () => {
  const state = ledgerState();
  updateSystemSettings(state, {
    user: user(state, "admin"),
    input: { walletEnabledLimit: 1 },
  });
  assert.equal(state.systemSettings.walletEnabledLimit, 1);
  assert.throws(() => createWallet(state, {
    user: user(state, "sup"),
    input: { alias: "新钱包", chain: "TRC20", address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" },
  }), /启用钱包数量已达上限/);
  disableWallet(state, { user: user(state, "sup"), walletId: "wallet" });
  state.wallets.push({
    id: "wallet_disabled",
    tenantId: "tenant_alpha",
    alias: "停用钱包",
    chain: "TRC20",
    address: "TJRabPrwbZy45sbavfcjinPJC18kjpRTTw",
    enabled: false,
    managedFrom: "2026-06-01T00:00:00.000Z",
  });
  enableWallet(state, { user: user(state, "sup"), walletId: "wallet" });
  assert.throws(() => enableWallet(state, { user: user(state, "sup"), walletId: "wallet_disabled" }), /启用钱包数量已达上限/);
});

test("wallet management start time controls whether employees must annotate history", () => {
  const state = ledgerState({
    wallets: [{ id: "wallet", tenantId: "tenant_alpha", alias: "主钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-06T00:00:00.000Z" }],
  });
  assert.throws(() => annotate(state), /历史无需批注/);
  assert.throws(() => createAnnotation(state, {
    user: user(state, "sup"),
    input: { chainTxId: "tx", category: "供应商付款", note: "主管主动补历史批注" },
  }), /历史无需批注/);
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

test("wallet management start time cannot be older than 30 days", () => {
  const state = ledgerState();
  assert.throws(() => createWallet(state, {
    user: user(state, "sup"),
    input: {
      alias: "历史钱包",
      chain: "TRC20",
      address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      managedFrom: "2026-05-01T00:00:00.000Z",
    },
    now: "2026-06-06T01:00:00.000Z",
  }), /最近 30 天/);
});

test("receivable and payable settlement uses full managed chain transaction", () => {
  const state = ledgerState({
    chainTransactions: [
      {
        id: "income_tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "income_hash", direction: "income",
        amount: 1005, counterparty: "TCustomer", confirmed: true, chainTime: "2026-06-05T12:30:00.000Z", currentAnnotationId: null,
      },
      {
        id: "expense_tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "expense_hash", direction: "expense",
        amount: 400, counterparty: "TSupplier", confirmed: true, chainTime: "2026-06-05T13:30:00.000Z", currentAnnotationId: null,
      },
    ],
  });
  const receivable = createReceivablePayable(state, {
    user: user(state, "emp"),
    input: { type: "receivable", counterparty: "客户 A", amount: 1000, category: "客户货款", note: "订单 A" },
  });
  assert.equal(receivable.reviewStatus, "pending");
  reviewReceivablePayable(state, { user: user(state, "sup"), itemId: receivable.id, action: "approve" });
  const pendingSettlement = createReceivableSettlement(state, { user: user(state, "emp"), itemId: receivable.id, txId: "income_tx" });
  assert.equal(pendingSettlement.amount, 1005);
  assert.equal(pendingSettlement.status, "pending");
  reviewReceivableSettlement(state, { user: user(state, "sup"), settlementId: pendingSettlement.id, action: "approve" });
  assert.equal(receivable.status, "settled");
  assert.equal(receivable.settledAmount, 1005);
  assert.equal(receivable.overAmount, 5);
  assert.throws(() => createReceivableSettlement(state, { user: user(state, "emp"), itemId: receivable.id, txId: "income_tx" }), /已平账|已用于/);
});

test("admin can confirm receivable settlement for a tenant", () => {
  const state = ledgerState({
    chainTransactions: [{
      id: "income_tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "income_hash", direction: "income",
      amount: 1688.88, counterparty: "TCustomer", confirmed: true, chainTime: "2026-06-09T01:27:39.000Z", currentAnnotationId: null,
    }],
  });
  const receivable = createReceivablePayable(state, {
    user: user(state, "sup"),
    input: { type: "receivable", counterparty: "客户 A", amount: 1688.88, category: "客户货款", note: "订单 A" },
  });
  assert.equal(receivable.reviewStatus, "approved");
  const settlement = createReceivableSettlement(state, { user: user(state, "admin"), itemId: receivable.id, txId: "income_tx" });
  assert.equal(settlement.status, "approved");
  assert.equal(settlement.reviewedBy, "admin");
  assert.equal(receivable.status, "settled");
});

test("receivable settlement rejects wrong direction and historical transactions", () => {
  const state = ledgerState({
    wallets: [{ id: "wallet", tenantId: "tenant_alpha", alias: "主钱包", chain: "TRC20", address: "T123", enabled: true, managedFrom: "2026-06-06T00:00:00.000Z" }],
    chainTransactions: [
      {
        id: "old_income", tenantId: "tenant_alpha", walletId: "wallet", hash: "old_income", direction: "income",
        amount: 1000, counterparty: "TCustomer", confirmed: true, chainTime: "2026-06-05T12:30:00.000Z", currentAnnotationId: null,
      },
      {
        id: "expense_tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "expense_hash", direction: "expense",
        amount: 1000, counterparty: "TSupplier", confirmed: true, chainTime: "2026-06-07T13:30:00.000Z", currentAnnotationId: null,
      },
    ],
  });
  const receivable = createReceivablePayable(state, {
    user: user(state, "sup"),
    input: { type: "receivable", counterparty: "客户 A", amount: 1000, category: "客户货款", note: "订单 A" },
  });
  assert.throws(() => createReceivableSettlement(state, { user: user(state, "emp"), itemId: receivable.id, txId: "old_income" }), /历史无需批注/);
  assert.throws(() => createReceivableSettlement(state, { user: user(state, "emp"), itemId: receivable.id, txId: "expense_tx" }), /应收款只能使用进账/);
});

test("receivable export follows filters and includes settlement details", () => {
  const state = ledgerState({
    chainTransactions: [{
      id: "income_tx", tenantId: "tenant_alpha", walletId: "wallet", hash: "income_hash", direction: "income",
      amount: 1005, counterparty: "TCustomer", confirmed: true, chainTime: "2026-06-05T12:30:00.000Z", currentAnnotationId: null,
    }],
  });
  const receivable = createReceivablePayable(state, {
    user: user(state, "sup"),
    input: { type: "receivable", counterparty: "客户 A", amount: 1000, category: "客户货款", note: "订单 A" },
    now: "2026-06-05T12:00:00.000Z",
  });
  createReceivablePayable(state, {
    user: user(state, "sup"),
    input: { type: "payable", counterparty: "供应商 B", amount: 300, category: "供应商付款", note: "采购" },
  });
  const settlement = createReceivableSettlement(state, { user: user(state, "sup"), itemId: receivable.id, txId: "income_tx" });
  assert.equal(settlement.status, "approved");
  const csv = exportReceivablePayablesCsv(state, { user: user(state, "sup"), filters: { type: "receivable", keyword: "订单" } });
  assert.match(csv, /客户 A/);
  assert.match(csv, /income_hash/);
  assert.doesNotMatch(csv, /供应商 B/);
});

test("receivable attachments respect employee visibility", () => {
  const state = ledgerState();
  state.users.find((item) => item.id === "other").canViewAll = false;
  const receivable = createReceivablePayable(state, {
    user: user(state, "emp"),
    input: {
      type: "receivable",
      counterparty: "客户 A",
      amount: 1000,
      category: "客户货款",
      note: "订单 A",
      attachment: { name: "receipt.webp", mimeType: "image/webp", byteSize: 10 },
    },
  });
  assert.equal(getReceivableAttachment(state, { user: user(state, "emp"), itemId: receivable.id }).name, "receipt.webp");
  assert.throws(() => getReceivableAttachment(state, { user: user(state, "other"), itemId: receivable.id }), /没有查看该凭证/);
});

test("admin creates tenants and global categories", () => {
  const state = ledgerState();
  createTenant(state, {
    user: user(state, "admin"),
    input: { name: "Beta", supervisorName: "Beta 主管", supervisorLoginName: "beta_sup", supervisorPassword: "secret123" },
  });
  createCategory(state, { user: user(state, "admin"), input: { type: "income", name: "新进账分类" } });
  const supervisor = state.users.find((item) => item.name === "Beta 主管");
  assert.equal(state.tenants.at(-1).name, "Beta");
  assert.equal(supervisor.loginName, "beta_sup");
  assert.equal(verifyPassword(supervisor, "secret123", { allowDemoPassword: false }), true);
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

test("unopened tenant can use first opening discount for subscription hash", () => {
  const hash = "c".repeat(64);
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true }],
    subscriptionSettings: {
      monthlyFee: 100,
      firstOpenFee: 49,
      platformWalletAddress: "TUfGNh99WN3GH5WjnqFKottWuYKpjomNbd",
      enabled: true,
      autoDisable: true,
    },
  });
  const payment = submitSubscriptionHash(state, {
    user: user(state, "sup"),
    hash,
    now: "2026-06-08T00:00:00.000Z",
    transaction: {
      hash, direction: "income", amount: 149, counterparty: "TPayer",
      confirmed: true, chainTime: "2026-06-08T00:00:00.000Z",
    },
  });
  assert.equal(payment.status, "applied");
  assert.equal(payment.months, 2);
  assert.equal(payment.reason, "交易哈希自动续费 2 个月");
  assert.equal(state.tenants[0].subscriptionExpiresAt, "2026-08-08T00:00:00.000Z");
});

test("subscription settings and expiry are admin controlled", () => {
  const state = ledgerState({
    tenants: [{ id: "tenant_alpha", name: "Alpha", enabled: true, subscriptionExpiresAt: "2026-06-01T00:00:00.000Z" }],
  });
  updateSubscriptionSettings(state, {
    user: user(state, "admin"),
    input: { monthlyFee: 80, firstOpenFee: 39, platformWalletAddress: "TUfGNh99WN3GH5WjnqFKottWuYKpjomNbd", enabled: true, autoDisable: true },
  });
  assert.equal(state.subscriptionSettings.monthlyFee, 80);
  assert.equal(state.subscriptionSettings.firstOpenFee, 39);
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
