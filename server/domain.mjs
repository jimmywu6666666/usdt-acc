import { generateTotpSecret, hashPassword } from "./auth.mjs";
import { isValidTronAddress } from "./tron-provider.mjs";

const requiredArrays = ["tenants", "users", "wallets", "annotations", "chainTransactions", "auditLogs"];

export function validateState(state) {
  if (!state || typeof state !== "object") return "state 必须是对象";
  for (const key of requiredArrays) {
    if (!Array.isArray(state[key])) return `${key} 必须是数组`;
  }
  if (!state.categories || !Array.isArray(state.categories.income) || !Array.isArray(state.categories.expense)) {
    return "categories.income 和 categories.expense 必须是数组";
  }
  if (state.platformPayments && !Array.isArray(state.platformPayments)) return "platformPayments 必须是数组";
  if (state.receivablePayables && !Array.isArray(state.receivablePayables)) return "receivablePayables 必须是数组";
  if (state.receivableSettlements && !Array.isArray(state.receivableSettlements)) return "receivableSettlements 必须是数组";
  return null;
}

export function reconcileState(state) {
  migrateAnnotationState(state);
  reconcileInternalTransfers(state);
  const validationError = validateState(state);
  if (validationError) throw new Error(validationError);
  return state;
}

export function migrateAnnotationState(state) {
  if (!state || typeof state !== "object") return state;
  state.annotations ||= [];
  state.chainTransactions ||= [];
  state.auditLogs ||= [];
  state.walletBalanceSnapshots ||= [];
  state.platformPayments ||= [];
  state.receivablePayables ||= [];
  state.receivableSettlements ||= [];
  state.entries ||= [];
  state.legacyEntries ||= [];
  state.subscriptionSettings ||= {};
  state.subscriptionSettings.monthlyFee = positiveNumberOrDefault(state.subscriptionSettings.monthlyFee, 100);
  state.subscriptionSettings.platformWalletAddress ||= "";
  state.subscriptionSettings.enabled = state.subscriptionSettings.enabled === true;
  state.subscriptionSettings.autoDisable = state.subscriptionSettings.autoDisable !== false;
  state.systemSettings ||= {};
  state.systemSettings.walletEnabledLimit = nonNegativeIntegerOrDefault(state.systemSettings.walletEnabledLimit, 0);

  for (const tx of state.chainTransactions) {
    delete tx.matchedEntryId;
    delete tx.deletedAt;
    delete tx.deletedBy;
    tx.currentAnnotationId ||= null;
  }

  for (const entry of state.entries) {
    const tx = state.chainTransactions.find((item) => item.id === entry.chainTxId);
    if (!tx) {
      if (!state.legacyEntries.some((item) => item.id === entry.id)) state.legacyEntries.push(entry);
      continue;
    }
    if (state.annotations.some((item) => item.legacyEntryId === entry.id)) continue;
    const annotation = {
      id: `annotation_${entry.id}`,
      tenantId: entry.tenantId,
      chainTxId: tx.id,
      category: entry.category || categoryFallback(tx.direction),
      note: entry.note || "",
      attachmentName: entry.attachmentName || "",
      attachment: entry.attachment || null,
      annotatedBy: entry.submittedBy,
      annotatedAt: entry.createdAt || entry.occurredAt || tx.chainTime,
      status: normalizeLegacyStatus(entry.status),
      reviewedBy: entry.reviewedBy || null,
      reviewedAt: entry.reviewedAt || null,
      rejectionReason: entry.rejectionReason || "",
      previousAnnotationId: null,
      version: 1,
      correctionType: entry.status === "corrected" ? "correction" : null,
      createdAt: entry.createdAt || entry.occurredAt || tx.chainTime,
      legacyEntryId: entry.id,
    };
    state.annotations.push(annotation);
    tx.currentAnnotationId = annotation.id;
  }
  state.entries = [];
  for (const wallet of state.wallets || []) {
    if (wallet.managedFrom) continue;
    const annotatedTimes = state.chainTransactions
      .filter((tx) => tx.walletId === wallet.id && tx.currentAnnotationId)
      .map((tx) => tx.chainTime)
      .filter(Boolean)
      .sort();
    wallet.managedFrom = annotatedTimes[0] || wallet.createdAt || startOfLocalDay().toISOString();
  }
  for (const tenant of state.tenants || []) {
    tenant.subscriptionStatus ||= tenant.subscriptionExpiresAt ? (new Date(tenant.subscriptionExpiresAt).getTime() >= Date.now() ? "active" : "expired") : "unset";
  }
  for (const item of state.receivablePayables || []) {
    updateReceivablePayableStatus(state, item);
  }
  return state;
}

export function appendLog(state, { tenantId, userId, action, target, createdAt = new Date().toISOString() }) {
  state.auditLogs.unshift({
    id: `log_${cryptoRandom()}`,
    tenantId,
    userId,
    action,
    target,
    createdAt,
  });
}

export function recordWalletBalanceSnapshot(state, { wallet, balance, capturedAt = new Date().toISOString() }) {
  state.walletBalanceSnapshots ||= [];
  const dateKey = businessDateKey(capturedAt);
  const existing = state.walletBalanceSnapshots.find((snapshot) => (
    snapshot.walletId === wallet.id && snapshot.dateKey === dateKey
  ));
  if (existing) return existing;
  const snapshot = {
    id: `balance_${cryptoRandom()}`,
    tenantId: wallet.tenantId,
    walletId: wallet.id,
    dateKey,
    balance: Number(balance),
    capturedAt,
  };
  state.walletBalanceSnapshots.unshift(snapshot);
  return snapshot;
}

function businessDateKey(dateValue) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(dateValue));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function walletBalanceSnapshotForDate(state, { walletId, dateKey }) {
  return (state.walletBalanceSnapshots || [])
    .filter((snapshot) => snapshot.walletId === walletId && snapshot.dateKey >= dateKey)
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey) || new Date(left.capturedAt) - new Date(right.capturedAt))[0] || null;
}

export function createAnnotation(state, { user, input, now = new Date().toISOString() }) {
  reconcileState(state);
  assertTenantSubscriptionActive(state, user?.tenantId);
  const tx = getVisibleTransaction(state, user, input.chainTxId);
  if (!isManagedTransactionGroup(state, tx)) {
    throw badRequest("历史无需批注流水不需要批注");
  }
  if (tx.transactionType === "transfer" && tx.internalTransferStatus !== "paired") {
    throw badRequest("内部划转另一侧流水尚未同步，确认完整后才能批注");
  }
  if (!tx.confirmed) throw badRequest("链上交易尚未确认，暂时不能批注");
  const linkedTransactions = linkedTransferTransactions(state, tx);
  const current = linkedTransactions.map((item) => currentAnnotation(state, item)).find(Boolean) || null;
  if (current && !["rejected", "reversed"].includes(current.status)) {
    throw badRequest("该链上流水已有有效批注");
  }
  const annotation = buildAnnotation(state, {
    user,
    tx,
    input,
    now,
    previous: current?.status === "rejected" ? current : null,
  });
  state.annotations.unshift(annotation);
  annotation.linkedChainTxIds = linkedTransactions.map((item) => item.id);
  linkedTransactions.forEach((item) => {
    item.currentAnnotationId = annotation.id;
  });
  appendLog(state, {
    tenantId: tx.tenantId,
    userId: user.id,
    action: current?.status === "rejected" ? "修改并重新提交批注" : "提交链上流水批注",
    target: annotation.id,
    createdAt: now,
  });
  return annotation;
}

export function resubmitAnnotation(state, { user, annotationId, input, now = new Date().toISOString() }) {
  reconcileState(state);
  const previous = findAnnotation(state, annotationId);
  assertTenantSubscriptionActive(state, previous.tenantId);
  if (previous.status !== "rejected") throw badRequest("只有已驳回的批注可以修改后重新提交");
  if (user.role === "employee" && previous.annotatedBy !== user.id) throw forbidden("只能修改自己提交的批注");
  if (user.role !== "admin" && previous.tenantId !== user.tenantId) throw forbidden("没有操作该批注的权限");
  const tx = getVisibleTransaction(state, user, previous.chainTxId);
  const annotation = buildAnnotation(state, { user, tx, input, now, previous });
  state.annotations.unshift(annotation);
  const linkedTransactions = linkedTransferTransactions(state, tx);
  annotation.linkedChainTxIds = linkedTransactions.map((item) => item.id);
  linkedTransactions.forEach((item) => {
    item.currentAnnotationId = annotation.id;
  });
  appendLog(state, {
    tenantId: tx.tenantId,
    userId: user.id,
    action: "修改并重新提交批注",
    target: annotation.id,
    createdAt: now,
  });
  return annotation;
}

export function reviewAnnotation(state, { user, annotationId, action, rejectionReason, now = new Date().toISOString() }) {
  reconcileState(state);
  const annotation = findAnnotation(state, annotationId);
  assertTenantSubscriptionActive(state, annotation.tenantId);
  assertSupervisor(state, user.id, annotation.tenantId);
  if (annotation.status !== "pending") throw badRequest("只有待审核批注可以处理");
  if (!["approve", "reject"].includes(action)) throw badRequest("审核操作不正确");

  if (action === "reject") {
    const reason = String(rejectionReason || "").trim();
    if (!reason) throw badRequest("驳回时必须填写原因");
    annotation.status = "rejected";
    annotation.rejectionReason = reason;
    annotation.reviewedBy = user.id;
    annotation.reviewedAt = now;
    appendLog(state, { tenantId: annotation.tenantId, userId: user.id, action: "驳回批注", target: annotation.id, createdAt: now });
    return annotation;
  }

  annotation.status = "approved";
  annotation.reviewedBy = user.id;
  annotation.reviewedAt = now;
  const previous = annotation.previousAnnotationId
    ? state.annotations.find((item) => item.id === annotation.previousAnnotationId)
    : null;
  if (previous?.status === "approved") {
    previous.status = annotation.correctionType === "reversal" ? "reversed" : "corrected";
    previous.supersededBy = annotation.id;
  }
  const tx = state.chainTransactions.find((item) => item.id === annotation.chainTxId);
  if (tx) linkedTransferTransactions(state, tx).forEach((item) => {
    item.currentAnnotationId = annotation.id;
  });
  appendLog(state, {
    tenantId: annotation.tenantId,
    userId: user.id,
    action: annotation.correctionType === "reversal" ? "审核通过冲正" : annotation.correctionType === "correction" ? "审核通过修正" : "审核通过批注",
    target: annotation.id,
    createdAt: now,
  });
  return annotation;
}

export function requestAnnotationCorrection(state, { user, annotationId, input, now = new Date().toISOString() }) {
  reconcileState(state);
  const previous = findAnnotation(state, annotationId);
  assertTenantSubscriptionActive(state, previous.tenantId);
  if (previous.status !== "approved" || previous.correctionType === "reversal") throw badRequest("只有当前已通过批注可以申请修正");
  if (user.role === "employee" && previous.annotatedBy !== user.id) throw forbidden("只能修正自己提交的批注");
  if (user.role !== "admin" && previous.tenantId !== user.tenantId) throw forbidden("没有操作该批注的权限");
  const tx = getVisibleTransaction(state, user, previous.chainTxId);
  ensureNoPendingVersion(state, tx.id);
  const annotation = buildAnnotation(state, { user, tx, input, now, previous, correctionType: "correction" });
  annotation.linkedChainTxIds = linkedTransferTransactions(state, tx).map((item) => item.id);
  state.annotations.unshift(annotation);
  appendLog(state, { tenantId: tx.tenantId, userId: user.id, action: "提交批注修正", target: annotation.id, createdAt: now });
  return annotation;
}

export function requestAnnotationReversal(state, { user, annotationId, reason, now = new Date().toISOString() }) {
  reconcileState(state);
  const previous = findAnnotation(state, annotationId);
  assertTenantSubscriptionActive(state, previous.tenantId);
  if (previous.status !== "approved" || previous.correctionType === "reversal") throw badRequest("只有当前已通过批注可以申请冲正");
  if (user.role === "employee" && previous.annotatedBy !== user.id) throw forbidden("只能冲正自己提交的批注");
  if (user.role !== "admin" && previous.tenantId !== user.tenantId) throw forbidden("没有操作该批注的权限");
  const reversalReason = String(reason || "").trim();
  if (!reversalReason) throw badRequest("请输入冲正原因");
  const tx = getVisibleTransaction(state, user, previous.chainTxId);
  ensureNoPendingVersion(state, tx.id);
  const annotation = buildAnnotation(state, {
    user,
    tx,
    input: {
      category: previous.category,
      note: `冲正原因：${reversalReason}`,
      attachment: null,
    },
    now,
    previous,
    correctionType: "reversal",
  });
  annotation.linkedChainTxIds = linkedTransferTransactions(state, tx).map((item) => item.id);
  state.annotations.unshift(annotation);
  appendLog(state, { tenantId: tx.tenantId, userId: user.id, action: "提交批注冲正", target: annotation.id, createdAt: now });
  return annotation;
}

export function markTransactionNonBusiness(state, { user, txId, reason, now = new Date().toISOString() }) {
  reconcileState(state);
  const tx = getVisibleTransaction(state, user, txId);
  assertTenantSubscriptionActive(state, tx.tenantId);
  assertSupervisorOrAdmin(state, user, tx.tenantId);
  if (!tx.confirmed) throw badRequest("链上交易尚未确认，暂时不能标记非业务");
  if (tx.transactionType === "transfer" && tx.internalTransferStatus !== "paired") {
    throw badRequest("内部划转另一侧流水尚未同步，确认完整后才能处理");
  }
  if (!isManagedTransactionGroup(state, tx)) throw badRequest("历史无需批注流水不需要标记非业务");
  const linkedTransactions = linkedTransferTransactions(state, tx);
  const current = linkedTransactions.map((item) => currentAnnotation(state, item)).find(Boolean) || null;
  if (current) throw badRequest("该流水已有批注，不能标记为非业务");
  const nonBusinessReason = String(reason || "").trim();
  if (!nonBusinessReason) throw badRequest("请输入非业务原因");
  const annotation = {
    id: id("annotation"),
    tenantId: tx.tenantId,
    chainTxId: tx.id,
    category: "非业务流水",
    note: `非业务原因：${nonBusinessReason}`,
    attachmentName: "",
    attachment: null,
    annotatedBy: user.id,
    annotatedAt: now,
    status: "non_business",
    reviewedBy: user.id,
    reviewedAt: now,
    rejectionReason: "",
    previousAnnotationId: null,
    version: nextAnnotationVersion(state, tx.id),
    correctionType: null,
    createdAt: now,
    linkedChainTxIds: linkedTransactions.map((item) => item.id),
  };
  state.annotations.unshift(annotation);
  linkedTransactions.forEach((item) => {
    item.currentAnnotationId = annotation.id;
  });
  appendLog(state, { tenantId: tx.tenantId, userId: user.id, action: "标记非业务流水", target: annotation.id, createdAt: now });
  return annotation;
}

export function restoreNonBusinessTransaction(state, { user, annotationId, now = new Date().toISOString() }) {
  reconcileState(state);
  const annotation = findAnnotation(state, annotationId);
  assertTenantSubscriptionActive(state, annotation.tenantId);
  if (annotation.status !== "non_business") throw badRequest("只有非业务流水可以恢复待批注");
  assertSupervisorOrAdmin(state, user, annotation.tenantId);
  const tx = getVisibleTransaction(state, user, annotation.chainTxId);
  linkedTransferTransactions(state, tx).forEach((item) => {
    if (item.currentAnnotationId === annotation.id) item.currentAnnotationId = null;
  });
  annotation.status = "restored";
  annotation.reviewedBy = user.id;
  annotation.reviewedAt = now;
  appendLog(state, { tenantId: annotation.tenantId, userId: user.id, action: "恢复非业务流水为待批注", target: annotation.id, createdAt: now });
  return annotation;
}

export function createReceivablePayable(state, { user, input, now = new Date().toISOString() }) {
  reconcileState(state);
  if (!["employee", "supervisor"].includes(user?.role)) throw forbidden("只有员工或主管可以创建往来款");
  const tenantId = user.tenantId;
  assertTenantSubscriptionActive(state, tenantId);
  const type = String(input.type || "");
  if (!["receivable", "payable"].includes(type)) throw badRequest("往来款类型不正确");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw badRequest("往来款金额必须大于 0");
  const counterparty = String(input.counterparty || "").trim();
  if (!counterparty) throw badRequest("请输入目标方");
  const category = String(input.category || "").trim();
  if (!category) throw badRequest("请选择分类");
  const note = String(input.note || "").trim();
  if (!note) throw badRequest("请输入业务说明");
  const item = {
    id: id("rp"),
    tenantId,
    type,
    counterparty,
    amount,
    category,
    note,
    dueDate: input.dueDate || "",
    attachmentName: input.attachmentName || "",
    attachment: input.attachment || null,
    createdBy: user.id,
    createdAt: now,
    reviewStatus: user.role === "supervisor" ? "approved" : "pending",
    reviewedBy: user.role === "supervisor" ? user.id : null,
    reviewedAt: user.role === "supervisor" ? now : null,
    rejectionReason: "",
    status: "open",
    voidedAt: null,
    voidedBy: null,
    voidReason: "",
  };
  state.receivablePayables.unshift(item);
  appendLog(state, {
    tenantId,
    userId: user.id,
    action: type === "receivable" ? "提交应收款" : "提交应付款",
    target: `${counterparty}:${amount}`,
    createdAt: now,
  });
  return updateReceivablePayableStatus(state, item);
}

export function reviewReceivablePayable(state, { user, itemId, action, rejectionReason = "", now = new Date().toISOString() }) {
  reconcileState(state);
  const item = state.receivablePayables.find((entry) => entry.id === itemId);
  if (!item) throw notFound("往来款不存在");
  assertTenantSubscriptionActive(state, item.tenantId);
  assertSupervisor(state, user.id, item.tenantId);
  if (item.reviewStatus !== "pending") throw badRequest("该往来款当前不在待审核状态");
  if (action === "approve") {
    item.reviewStatus = "approved";
    item.rejectionReason = "";
  } else if (action === "reject") {
    const reason = String(rejectionReason || "").trim();
    if (!reason) throw badRequest("请输入驳回原因");
    item.reviewStatus = "rejected";
    item.rejectionReason = reason;
  } else {
    throw badRequest("审核动作不正确");
  }
  item.reviewedBy = user.id;
  item.reviewedAt = now;
  appendLog(state, {
    tenantId: item.tenantId,
    userId: user.id,
    action: action === "approve" ? "审核通过往来款" : "驳回往来款",
    target: item.id,
    createdAt: now,
  });
  return updateReceivablePayableStatus(state, item);
}

export function createReceivableSettlement(state, { user, itemId, txId, note = "", now = new Date().toISOString() }) {
  reconcileState(state);
  const item = state.receivablePayables.find((entry) => entry.id === itemId);
  if (!item) throw notFound("往来款不存在");
  assertTenantSubscriptionActive(state, item.tenantId);
  if (user.role !== "admin" && item.tenantId !== user.tenantId) throw forbidden("没有操作该往来款的权限");
  if (!["employee", "supervisor"].includes(user.role)) throw forbidden("只有员工或主管可以提交平账");
  if (item.reviewStatus !== "approved") throw badRequest("往来款审核通过后才能平账");
  if (item.status === "settled") throw badRequest("该往来款已平账");
  if (item.status === "voided") throw badRequest("已作废往来款不能平账");
  const tx = state.chainTransactions.find((entry) => entry.id === txId);
  if (!tx || tx.tenantId !== item.tenantId) throw notFound("链上流水不存在");
  if (!isManagedTransactionGroup(state, tx)) throw badRequest("历史无需批注流水不能用于平账");
  const expectedDirection = item.type === "receivable" ? "income" : "expense";
  if (tx.direction !== expectedDirection || tx.transactionType === "transfer") {
    throw badRequest(item.type === "receivable" ? "应收款只能使用进账流水平账" : "应付款只能使用出账流水平账");
  }
  if (state.receivableSettlements.some((entry) => entry.txId === tx.id && !["rejected", "revoked"].includes(entry.status))) {
    throw badRequest("该链上流水已用于往来款平账");
  }
  const settlement = {
    id: id("rps"),
    tenantId: item.tenantId,
    itemId: item.id,
    txId: tx.id,
    amount: Number(tx.amount),
    note: String(note || "").trim(),
    status: user.role === "supervisor" ? "approved" : "pending",
    submittedBy: user.id,
    submittedAt: now,
    reviewedBy: user.role === "supervisor" ? user.id : null,
    reviewedAt: user.role === "supervisor" ? now : null,
    rejectionReason: "",
    revokedBy: null,
    revokedAt: null,
    revokeReason: "",
  };
  state.receivableSettlements.unshift(settlement);
  updateReceivablePayableStatus(state, item);
  appendLog(state, {
    tenantId: item.tenantId,
    userId: user.id,
    action: user.role === "supervisor" ? "确认往来款平账" : "提交往来款平账",
    target: `${item.id}:${tx.hash}:${settlement.amount}`,
    createdAt: now,
  });
  return settlement;
}

export function reviewReceivableSettlement(state, { user, settlementId, action, rejectionReason = "", now = new Date().toISOString() }) {
  reconcileState(state);
  const settlement = state.receivableSettlements.find((entry) => entry.id === settlementId);
  if (!settlement) throw notFound("平账记录不存在");
  assertTenantSubscriptionActive(state, settlement.tenantId);
  assertSupervisor(state, user.id, settlement.tenantId);
  if (settlement.status !== "pending") throw badRequest("该平账当前不在待审核状态");
  if (action === "approve") {
    settlement.status = "approved";
    settlement.rejectionReason = "";
  } else if (action === "reject") {
    const reason = String(rejectionReason || "").trim();
    if (!reason) throw badRequest("请输入驳回原因");
    settlement.status = "rejected";
    settlement.rejectionReason = reason;
  } else {
    throw badRequest("审核动作不正确");
  }
  settlement.reviewedBy = user.id;
  settlement.reviewedAt = now;
  const item = state.receivablePayables.find((entry) => entry.id === settlement.itemId);
  if (item) updateReceivablePayableStatus(state, item);
  appendLog(state, {
    tenantId: settlement.tenantId,
    userId: user.id,
    action: action === "approve" ? "审核通过往来款平账" : "驳回往来款平账",
    target: settlement.id,
    createdAt: now,
  });
  return settlement;
}

export function voidReceivablePayable(state, { user, itemId, reason, now = new Date().toISOString() }) {
  reconcileState(state);
  const item = state.receivablePayables.find((entry) => entry.id === itemId);
  if (!item) throw notFound("往来款不存在");
  assertTenantSubscriptionActive(state, item.tenantId);
  assertSupervisor(state, user.id, item.tenantId);
  if (approvedSettlementsForItem(state, item.id).length) throw badRequest("已有有效平账记录，不能作废");
  const voidReason = String(reason || "").trim();
  if (!voidReason) throw badRequest("请输入作废原因");
  item.status = "voided";
  item.reviewStatus = item.reviewStatus === "pending" ? "rejected" : item.reviewStatus;
  item.voidedAt = now;
  item.voidedBy = user.id;
  item.voidReason = voidReason;
  appendLog(state, { tenantId: item.tenantId, userId: user.id, action: "作废往来款", target: `${item.id}:${voidReason}`, createdAt: now });
  return item;
}

export function getReceivableAttachment(state, { user, itemId }) {
  reconcileState(state);
  const item = state.receivablePayables.find((entry) => entry.id === itemId);
  if (!item) throw notFound("往来款不存在");
  if (user.role !== "admin" && item.tenantId !== user.tenantId) throw forbidden("没有查看该凭证的权限");
  if (user.role === "employee" && !user.canViewAll && item.createdBy !== user.id) throw forbidden("没有查看该凭证的权限");
  if (!item.attachment) throw notFound("该往来款没有凭证");
  return item.attachment;
}

export function getTransactionDetail(state, { user, txId }) {
  reconcileState(state);
  const tx = getVisibleTransaction(state, user, txId);
  const linkedTransactions = linkedTransferTransactions(state, tx);
  const linkedIds = new Set(linkedTransactions.map((item) => item.id));
  const annotations = state.annotations
    .filter((item) => linkedIds.has(item.chainTxId) || item.linkedChainTxIds?.some((id) => linkedIds.has(id)))
    .sort((left, right) => right.version - left.version);
  const logs = state.auditLogs.filter((log) => annotations.some((item) => item.id === log.target) || log.target === tx.id);
  return { tx, pairedTx: linkedTransactions.find((item) => item.id !== tx.id) || null, annotations, logs };
}

export function getAnnotationAttachment(state, { user, annotationId }) {
  reconcileState(state);
  const annotation = findAnnotation(state, annotationId);
  if (user.role !== "admin" && annotation.tenantId !== user.tenantId) {
    throw forbidden("没有下载该凭证的权限");
  }
  if (user.role === "employee" && !user.canViewAll && annotation.annotatedBy !== user.id) {
    throw forbidden("没有下载该凭证的权限");
  }
  if (!annotation.attachment) throw notFound("该批注没有凭证");
  return annotation.attachment;
}

export function walletBalance(chainTransactions, walletId) {
  return chainTransactions.reduce((sum, tx) => {
    if (tx.walletId !== walletId || !tx.confirmed) return sum;
    return sum + (tx.direction === "income" ? Number(tx.amount) : -Number(tx.amount));
  }, 0);
}

export function exportAnnotationsCsv(state, { user, filters = {} }) {
  reconcileState(state);
  const rows = visibleTransactions(state, user, filters);
  const headers = ["链上时间", "方向", "金额", "钱包", "对方地址", "交易哈希", "分类", "用途说明", "批注人", "审核状态"];
  return [
    headers.join(","),
    ...rows.map(({ tx, annotation }) => [
      csvCell(formatDate(tx.chainTime)),
      csvCell(tx.transactionType === "transfer" ? "内部划转" : directionLabel(tx.direction)),
      csvCell(tx.amount),
      csvCell(transactionWalletLabel(state, tx)),
      csvCell(tx.counterparty || ""),
      csvCell(tx.hash),
      csvCell(annotation?.category || ""),
      csvCell(annotation?.note || ""),
      csvCell(annotation ? userName(state, annotation.annotatedBy) : ""),
      csvCell(tx.internalTransferStatus === "pending" ? "内部划转待确认" : annotationStatusLabel(annotation)),
    ].join(",")),
  ].join("\n");
}

export function exportReceivablePayablesCsv(state, { user, filters = {} }) {
  reconcileState(state);
  const rows = visibleReceivablePayables(state, user, filters);
  const headers = ["创建时间", "类型", "目标方", "分类", "金额", "已平", "剩余", "多收/多付", "业务状态", "审核状态", "创建人", "说明", "平账流水"];
  return [
    headers.join(","),
    ...rows.map((item) => {
      const settlements = (state.receivableSettlements || [])
        .filter((settlement) => settlement.itemId === item.id && settlement.status === "approved")
        .map((settlement) => {
          const tx = state.chainTransactions.find((entry) => entry.id === settlement.txId);
          return tx ? `${formatDate(tx.chainTime)} ${tx.hash} ${settlement.amount}` : `${settlement.txId} ${settlement.amount}`;
        }).join("；");
      return [
        csvCell(formatDate(item.createdAt)),
        csvCell(item.type === "receivable" ? "应收款" : "应付款"),
        csvCell(item.counterparty),
        csvCell(item.category),
        csvCell(item.amount),
        csvCell(item.settledAmount || 0),
        csvCell(item.remainingAmount || 0),
        csvCell(item.overAmount ? `${item.type === "receivable" ? "多收" : "多付"} ${item.overAmount}` : ""),
        csvCell(receivableStatusLabel(item.status)),
        csvCell(reviewStatusLabel(item.reviewStatus)),
        csvCell(userName(state, item.createdBy)),
        csvCell(item.note || ""),
        csvCell(settlements),
      ].join(",");
    }),
  ].join("\n");
}

export function createWallet(state, { user, input, now = new Date().toISOString() }) {
  assertSupervisor(state, user.id, user.tenantId);
  assertTenantSubscriptionActive(state, user.tenantId);
  const alias = String(input.alias || "").trim();
  const address = String(input.address || "").trim();
  const chain = input.chain || "TRC20";
  if (!alias) throw badRequest("钱包别名不能为空");
  if (chain !== "TRC20") throw badRequest("第一版只支持 TRC20");
  if (!isValidTronAddress(address)) throw badRequest("TRC20 钱包地址格式或校验码不正确");
  if (state.wallets.some((item) => item.tenantId === user.tenantId && item.address === address)) throw badRequest("本系统已存在该钱包地址");
  assertWalletEnabledLimit(state, user.tenantId);
  const managedFrom = parseManagedFrom(input.managedFrom, now);
  const wallet = { id: id("wallet"), tenantId: user.tenantId, alias, chain, address, enabled: true, managedFrom, createdAt: now };
  state.wallets.unshift(wallet);
  appendLog(state, { tenantId: user.tenantId, userId: user.id, action: "新增钱包并设置纳入管理时间", target: `${alias}:${managedFrom}`, createdAt: now });
  return wallet;
}

export function updateWalletManagedFrom(state, { user, walletId, managedFrom, now = new Date().toISOString() }) {
  const wallet = state.wallets.find((item) => item.id === walletId);
  if (!wallet) throw notFound("钱包不存在");
  assertSupervisor(state, user.id, wallet.tenantId);
  throw badRequest("钱包纳入管理起始时间创建后不可修改");
}

export function disableWallet(state, { user, walletId, now = new Date().toISOString() }) {
  const wallet = state.wallets.find((item) => item.id === walletId);
  if (!wallet) throw notFound("钱包不存在");
  assertSupervisor(state, user.id, wallet.tenantId);
  wallet.enabled = false;
  wallet.disabledAt = now;
  wallet.disabledBy = user.id;
  appendLog(state, { tenantId: wallet.tenantId, userId: user.id, action: "停用钱包", target: wallet.alias, createdAt: now });
  return wallet;
}

export function enableWallet(state, { user, walletId, now = new Date().toISOString() }) {
  const wallet = state.wallets.find((item) => item.id === walletId);
  if (!wallet) throw notFound("钱包不存在");
  assertSupervisor(state, user.id, wallet.tenantId);
  assertTenantSubscriptionActive(state, wallet.tenantId);
  if (!wallet.enabled) assertWalletEnabledLimit(state, wallet.tenantId);
  wallet.enabled = true;
  wallet.enabledAt = now;
  wallet.enabledBy = user.id;
  appendLog(state, { tenantId: wallet.tenantId, userId: user.id, action: "启用钱包", target: wallet.alias, createdAt: now });
  return wallet;
}

export function createEmployee(state, { user, input, now = new Date().toISOString() }) {
  assertSupervisor(state, user.id, user.tenantId);
  const name = String(input.name || "").trim();
  const role = input.role === "supervisor" ? "supervisor" : "employee";
  const loginName = String(input.loginName || "").trim();
  const password = String(input.password || "");
  if (!name) throw badRequest("账号姓名不能为空");
  validateNewLogin(state, loginName, password);
  const teamUser = {
    id: id("user"),
    tenantId: user.tenantId,
    name,
    loginName,
    role,
    canViewAll: role === "supervisor" ? true : input.canViewAll === true,
    passwordHash: hashPassword(password),
    totpSecret: generateTotpSecret(),
  };
  state.users.push(teamUser);
  appendLog(state, {
    tenantId: user.tenantId,
    userId: user.id,
    action: role === "supervisor" ? "创建主管账号" : "创建员工账号",
    target: name,
    createdAt: now,
  });
  return teamUser;
}

export function updateEmployeePermission(state, { user, employeeId, canViewAll, now = new Date().toISOString() }) {
  const employee = state.users.find((item) => item.id === employeeId);
  if (!employee) throw notFound("员工账号不存在");
  if (user.role !== "admin") assertSupervisor(state, user.id, employee.tenantId);
  if (employee.role !== "employee") throw badRequest("只能修改员工账号权限");
  employee.canViewAll = canViewAll === true;
  appendLog(state, { tenantId: employee.tenantId, userId: user.id, action: "修改员工查看权限", target: employee.id, createdAt: now });
  return employee;
}

export function createTenant(state, { user, input, now = new Date().toISOString() }) {
  assertAdmin(user);
  const name = String(input.name || "").trim();
  const supervisorName = String(input.supervisorName || "").trim();
  const supervisorLoginName = String(input.supervisorLoginName || "").trim();
  const supervisorPassword = String(input.supervisorPassword || "");
  if (!name || !supervisorName) throw badRequest("系统名称和主管姓名不能为空");
  validateNewLogin(state, supervisorLoginName, supervisorPassword);
  const tenant = { id: id("tenant"), name, enabled: true, createdAt: now };
  const supervisor = {
    id: id("user"),
    tenantId: tenant.id,
    name: supervisorName,
    loginName: supervisorLoginName,
    role: "supervisor",
    canViewAll: true,
    passwordHash: hashPassword(supervisorPassword),
    totpSecret: generateTotpSecret(),
  };
  state.tenants.push(tenant);
  state.users.push(supervisor);
  state.activeTenantId = tenant.id;
  appendLog(state, { tenantId: tenant.id, userId: user.id, action: "开通独立系统", target: name, createdAt: now });
  return { tenant, supervisor };
}

export function updateTenantStatus(state, { user, tenantId, enabled, now = new Date().toISOString() }) {
  assertAdmin(user);
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant) throw notFound("系统不存在");
  tenant.enabled = enabled === true;
  tenant.updatedAt = now;
  appendLog(state, {
    tenantId: tenant.id,
    userId: user.id,
    action: tenant.enabled ? "启用独立系统" : "停用独立系统",
    target: tenant.name,
    createdAt: now,
  });
  return tenant;
}

export function resetUserTotp(state, { user, userId, now = new Date().toISOString() }) {
  const target = state.users.find((item) => item.id === userId);
  if (!target) throw notFound("账号不存在");
  if (target.id !== user.id && user.role !== "admin") {
    assertSupervisor(state, user.id, target.tenantId);
    if (target.tenantId !== user.tenantId) throw forbidden("没有操作该账号的权限");
  }
  target.totpSecret = generateTotpSecret();
  appendLog(state, {
    tenantId: target.tenantId || null,
    userId: user.id,
    action: "重置登录密钥",
    target: target.name,
    createdAt: now,
  });
  return target;
}

export function resetUserPassword(state, { user, userId, password, now = new Date().toISOString() }) {
  const target = state.users.find((item) => item.id === userId);
  if (!target) throw notFound("账号不存在");
  if (target.id !== user.id && user.role !== "admin") {
    assertSupervisor(state, user.id, target.tenantId);
    if (target.tenantId !== user.tenantId) throw forbidden("没有操作该账号的权限");
  }
  const newPassword = String(password || "");
  if (newPassword.length < 6) throw badRequest("新密码至少 6 位");
  target.passwordHash = hashPassword(newPassword);
  appendLog(state, {
    tenantId: target.tenantId || null,
    userId: user.id,
    action: "重置登录密码",
    target: target.name,
    createdAt: now,
  });
  return target;
}

function validateNewLogin(state, loginName, password) {
  if (!loginName) throw badRequest("登录账号不能为空");
  if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(loginName)) {
    throw badRequest("登录账号需为 3-32 位字母、数字、点、下划线、@ 或横线");
  }
  if (state.users.some((item) => sameLoginName(item.loginName || item.id || item.name, loginName))) {
    throw badRequest("登录账号已存在");
  }
  if (password.length < 6) throw badRequest("初始密码至少 6 位");
}

function sameLoginName(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

export function updateSubscriptionSettings(state, { user, input, now = new Date().toISOString() }) {
  reconcileState(state);
  assertAdmin(user);
  const monthlyFee = Number(input.monthlyFee);
  const platformWalletAddress = String(input.platformWalletAddress || "").trim();
  if (!Number.isFinite(monthlyFee) || monthlyFee <= 0) throw badRequest("月租费用必须大于 0");
  if (platformWalletAddress && !isValidTronAddress(platformWalletAddress)) throw badRequest("平台收款钱包地址格式或校验码不正确");
  state.subscriptionSettings = {
    monthlyFee,
    platformWalletAddress,
    enabled: input.enabled === true,
    autoDisable: input.autoDisable !== false,
    updatedAt: now,
  };
  appendLog(state, {
    tenantId: null,
    userId: user.id,
    action: "修改租用收费设置",
    target: `${monthlyFee} USDT/月:${platformWalletAddress || "未设置"}`,
    createdAt: now,
  });
  return state.subscriptionSettings;
}

export function updateSystemSettings(state, { user, input, now = new Date().toISOString() }) {
  reconcileState(state);
  assertAdmin(user);
  const walletEnabledLimit = Number(input.walletEnabledLimit);
  if (!Number.isInteger(walletEnabledLimit) || walletEnabledLimit < 0) throw badRequest("钱包启用数限制必须是 0 或正整数");
  state.systemSettings = {
    ...(state.systemSettings || {}),
    walletEnabledLimit,
    updatedAt: now,
  };
  appendLog(state, {
    tenantId: null,
    userId: user.id,
    action: "修改系统钱包限制",
    target: walletEnabledLimit > 0 ? `每个系统最多启用 ${walletEnabledLimit} 个钱包` : "不限制启用钱包数量",
    createdAt: now,
  });
  return state.systemSettings;
}

export function submitSubscriptionHash(state, {
  user,
  hash,
  transaction,
  now = new Date().toISOString(),
}) {
  reconcileState(state);
  const tenant = state.tenants.find((item) => item.id === user?.tenantId);
  if (!tenant || user.role !== "supervisor") throw forbidden("只有主管可以提交租用续费哈希");
  const settings = state.subscriptionSettings;
  if (!settings.enabled) throw badRequest("平台收款自动续费未启用");
  if (!settings.platformWalletAddress) throw badRequest("管理员暂未配置平台收款钱包");
  const normalizedHash = String(hash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHash)) throw badRequest("交易哈希格式不正确");
  if (state.platformPayments.some((payment) => String(payment.hash || "").toLowerCase() === normalizedHash)) {
    throw badRequest("该交易哈希已提交或已处理，不能重复提交");
  }
  if (!transaction || String(transaction.hash || "").toLowerCase() !== normalizedHash) {
    throw badRequest("未在平台收款钱包中找到该交易哈希");
  }
  if (transaction.confirmed === false) throw badRequest("链上交易尚未确认");
  if (transaction.direction !== "income") throw badRequest("该交易不是转入平台收款钱包");

  const payment = {
    id: id("pay"),
    hash: normalizedHash,
    eventIndex: transaction.eventIndex ?? null,
    fromAddress: transaction.counterparty || transaction.from || "",
    toAddress: settings.platformWalletAddress,
    amount: Number(transaction.amount),
    tenantId: tenant.id,
    status: "submitted",
    months: 0,
    days: 0,
    reason: "",
    chainTime: transaction.chainTime || now,
    createdAt: now,
    processedAt: null,
    processedBy: null,
    source: "hash",
  };
  const months = subscriptionMonths(payment.amount, settings.monthlyFee);
  if (months.status === "ok") {
    payment.status = "applied";
    payment.months = months.months;
    payment.reason = `交易哈希自动续费 ${months.months} 个月`;
    payment.processedAt = now;
    payment.processedBy = user.id;
    renewTenantSubscription(state, { tenant, months: months.months, payment, actor: user, now });
  } else {
    payment.status = months.status;
    payment.reason = months.reason;
  }
  state.platformPayments.unshift(payment);
  appendLog(state, {
    tenantId: tenant.id,
    userId: user.id,
    action: "提交租用续费哈希",
    target: `${normalizedHash}:${payment.status}`,
    createdAt: now,
  });
  return payment;
}

export function manualRenewSubscriptionPayment(state, {
  user,
  paymentId,
  tenantId,
  months,
  days,
  reason,
  now = new Date().toISOString(),
}) {
  reconcileState(state);
  assertAdmin(user);
  const payment = state.platformPayments.find((item) => item.id === paymentId);
  if (!payment) throw notFound("平台收款记录不存在");
  if (["applied", "manual_applied", "offline_applied"].includes(payment.status)) throw badRequest("该收款已处理，不能重复续费");
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant) throw notFound("系统不存在");
  const numericMonths = Number(months);
  const numericDays = Number(days);
  const hasMonths = Number.isInteger(numericMonths) && numericMonths > 0;
  const hasDays = Number.isInteger(numericDays) && numericDays > 0;
  if (!hasMonths && !hasDays) throw badRequest("请输入正整数续费月数或续费天数");
  const manualReason = String(reason || "").trim();
  if (!manualReason) throw badRequest("请输入手工续费原因");
  payment.status = "manual_applied";
  payment.tenantId = tenant.id;
  payment.months = hasMonths ? numericMonths : 0;
  payment.days = hasDays ? numericDays : 0;
  payment.reason = manualReason;
  payment.processedAt = now;
  payment.processedBy = user.id;
  renewTenantSubscription(state, {
    tenant,
    months: hasMonths ? numericMonths : 0,
    days: hasDays ? numericDays : 0,
    payment,
    actor: user,
    now,
    manual: true,
  });
  return payment;
}

export function manualRenewTenantSubscription(state, {
  user,
  tenantId,
  months,
  days,
  amount = null,
  reason,
  now = new Date().toISOString(),
}) {
  reconcileState(state);
  assertAdmin(user);
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant) throw notFound("系统不存在");
  const numericMonths = Number(months);
  const numericDays = Number(days);
  const hasMonths = Number.isInteger(numericMonths) && numericMonths > 0;
  const hasDays = Number.isInteger(numericDays) && numericDays > 0;
  if (!hasMonths && !hasDays) throw badRequest("请输入正整数续费月数或续费天数");
  const manualReason = String(reason || "").trim();
  if (!manualReason) throw badRequest("请输入手工续费原因");
  const numericAmount = amount === null || amount === "" || amount === undefined ? null : Number(amount);
  if (numericAmount !== null && (!Number.isFinite(numericAmount) || numericAmount < 0)) throw badRequest("实收金额不能小于 0");
  const payment = {
    id: id("pay"),
    hash: `manual-${cryptoRandom()}`,
    eventIndex: null,
    fromAddress: "",
    toAddress: state.subscriptionSettings.platformWalletAddress || "",
    amount: numericAmount,
    memo: "",
    tenantId: tenant.id,
    status: "offline_applied",
    months: hasMonths ? numericMonths : 0,
    days: hasDays ? numericDays : 0,
    reason: manualReason,
    chainTime: now,
    createdAt: now,
    processedAt: now,
    processedBy: user.id,
    source: "manual",
  };
  state.platformPayments.unshift(payment);
  renewTenantSubscription(state, {
    tenant,
    months: hasMonths ? numericMonths : 0,
    days: hasDays ? numericDays : 0,
    payment,
    actor: user,
    now,
    manual: true,
  });
  return payment;
}

export function enforceTenantSubscriptions(state, { user, now = new Date().toISOString() }) {
  reconcileState(state);
  if (!state.subscriptionSettings.autoDisable) return [];
  const expired = [];
  for (const tenant of state.tenants || []) {
    if (!tenant.subscriptionExpiresAt || tenant.enabled === false) continue;
    if (new Date(tenant.subscriptionExpiresAt).getTime() >= new Date(now).getTime()) continue;
    tenant.enabled = false;
    tenant.subscriptionStatus = "expired";
    tenant.subscriptionExpiredAt = now;
    expired.push(tenant);
    appendLog(state, {
      tenantId: tenant.id,
      userId: user?.id || "system",
      action: "租用到期自动停用",
      target: tenant.name,
      createdAt: now,
    });
  }
  return expired;
}

export function createCategory(state, { user, input, now = new Date().toISOString() }) {
  assertAdmin(user);
  const type = input.type;
  const name = String(input.name || "").trim();
  if (!["income", "expense"].includes(type)) throw badRequest("分类类型不正确");
  if (!name) throw badRequest("分类名称不能为空");
  if (!state.categories[type].includes(name)) state.categories[type].push(name);
  appendLog(state, { tenantId: null, userId: user.id, action: "新增全局分类", target: name, createdAt: now });
  return { type, name };
}

export function updateCategory(state, { user, type, oldName, input, now = new Date().toISOString() }) {
  assertAdmin(user);
  const nextName = String(input.name || "").trim();
  if (!["income", "expense"].includes(type)) throw badRequest("分类类型不正确");
  if (!oldName) throw badRequest("请选择要修改的分类");
  if (!nextName) throw badRequest("分类名称不能为空");
  const categories = state.categories[type] || [];
  const index = categories.indexOf(oldName);
  if (index < 0) throw badRequest("原分类不存在");
  if (categories.includes(nextName) && nextName !== oldName) throw badRequest("分类名称已存在");
  categories[index] = nextName;
  appendLog(state, { tenantId: null, userId: user.id, action: "修改全局分类", target: `${oldName} -> ${nextName}`, createdAt: now });
  return { type, oldName, name: nextName };
}

export function syncChainTransactions(state, {
  user,
  tenantId,
  externalTransactions = null,
  now = new Date().toISOString(),
  logEmptySync = true,
}) {
  reconcileState(state);
  const visibleTenantId = visibleTenantForUser(user, tenantId);
  if (!visibleTenantId) throw badRequest("请选择所属系统");
  assertSupervisorOrAdmin(state, user, visibleTenantId);
  if (user?.role !== "admin") assertTenantSubscriptionActive(state, visibleTenantId);
  const wallets = state.wallets.filter((wallet) => wallet.tenantId === visibleTenantId && wallet.enabled);
  const created = [];
  const source = externalTransactions || wallets.map((wallet, index) => ({
    walletId: wallet.id,
    hash: `${wallet.address.slice(0, 8).toLowerCase()}-sync-${wallet.id}-${Date.now()}-${index}`,
    direction: index % 2 ? "expense" : "income",
    amount: index % 2 ? 800.03 : 1200 + index * 100,
    counterparty: `T${cryptoRandom().padEnd(33, "x").slice(0, 33)}`,
    confirmed: true,
    chainTime: now,
  }));
  for (const item of source) {
    const wallet = wallets.find((candidate) => candidate.id === item.walletId);
    const duplicate = state.chainTransactions.some((tx) => {
      if (tx.tenantId !== visibleTenantId || tx.walletId !== item.walletId || tx.hash !== item.hash) return false;
      if (tx.eventIndex != null || item.eventIndex != null) return String(tx.eventIndex) === String(item.eventIndex);
      return tx.direction === item.direction
        && tx.counterparty === (item.counterparty || "")
        && Number(tx.amount) === Number(item.amount);
    });
    if (!wallet || duplicate) continue;
    const tx = {
      id: id("tx"),
      tenantId: visibleTenantId,
      walletId: wallet.id,
      hash: item.hash,
      eventIndex: item.eventIndex ?? null,
      direction: item.direction,
      amount: Number(item.amount),
      counterparty: item.counterparty || "",
      confirmed: item.confirmed !== false,
      chainTime: item.chainTime,
      currentAnnotationId: null,
      createdAt: now,
      source: externalTransactions ? "tron" : "mock",
    };
    state.chainTransactions.unshift(tx);
    created.push(tx);
  }
  reconcileInternalTransfers(state);
  if (logEmptySync || created.length > 0) {
    appendLog(state, { tenantId: visibleTenantId, userId: user.id, action: "同步链上流水", target: `wallets:${wallets.length};created:${created.length}`, createdAt: now });
  }
  return created;
}

export function searchChainTransactions(state, { user, query, tenantId, now = new Date().toISOString() }) {
  reconcileState(state);
  const keyword = String(query || "").trim();
  if (!keyword) throw badRequest("请输入交易哈希或钱包地址");
  const visibleTenantId = visibleTenantForUser(user, tenantId);
  const rows = state.chainTransactions.filter((tx) => {
    if (visibleTenantId && tx.tenantId !== visibleTenantId) return false;
    if (user.role !== "admin" && tx.tenantId !== user.tenantId) return false;
    const wallet = state.wallets.find((item) => item.id === tx.walletId);
    return tx.hash.includes(keyword) || tx.counterparty?.includes(keyword) || wallet?.address === keyword;
  });
  appendLog(state, { tenantId: user.role === "admin" ? visibleTenantId : user.tenantId, userId: user.id, action: "手动查询链上流水", target: keyword, createdAt: now });
  return rows;
}

export function getAuditLogsForUser(state, { user, tenantId }) {
  const visibleTenantId = visibleTenantForUser(user, tenantId);
  return state.auditLogs.filter((log) => {
    if (user.role === "admin") return !visibleTenantId || log.tenantId === visibleTenantId;
    if (log.tenantId !== user.tenantId) return false;
    if (isAdminAuditLog(state, log)) return false;
    if (isRoutineAuditLog(log)) return false;
    return user.role !== "employee" || log.userId === user.id;
  });
}

const adminReadOnlyAuditActions = new Set([
  "查看批注凭证",
  "下载批注附件",
  "导出链上流水批注",
  "导出账目",
  "手动查询链上流水",
  "同步链上流水",
]);

export function isAdminReadOnlyAuditLog(state, log) {
  return isAdminAuditLog(state, log) && adminReadOnlyAuditActions.has(log.action);
}

export function isAdminAuditLog(state, log) {
  const actor = state.users.find((user) => user.id === log.userId);
  return actor?.role === "admin";
}

const routineAuditActions = new Set([
  "登录系统",
  "登录失败",
  "查看批注凭证",
  "下载批注附件",
  "导出链上流水批注",
  "导出账目",
  "手动查询链上流水",
  "同步链上流水",
  "链上钱包同步失败",
  "修改租用收费设置",
  "自动确认租用续费",
  "手工确认租用续费",
  "线下手工租用续费",
  "租户续费自动启用",
  "租用到期自动停用",
  "开通独立系统",
  "启用独立系统",
  "停用独立系统",
  "新增全局分类",
  "修改全局分类",
]);

export function isRoutineAuditLog(log) {
  return routineAuditActions.has(log?.action);
}

export function assertSupervisor(state, userId, tenantId) {
  const user = state.users.find((item) => item.id === userId);
  if (!user || user.role !== "supervisor" || user.tenantId !== tenantId) throw forbidden("当前账号没有主管权限");
  return user;
}

export function assertAdmin(user) {
  if (!user || user.role !== "admin") throw forbidden("当前账号没有管理员权限");
}

export function assertSupervisorOrAdmin(state, user, tenantId) {
  if (user?.role === "admin") return user;
  return assertSupervisor(state, user?.id, tenantId);
}

export function assertTenantSubscriptionActive(state, tenantId, now = new Date().toISOString()) {
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant) throw forbidden("所属系统不存在");
  if (tenant.enabled === false) throw forbidden("当前系统已停用，不能进行业务操作");
  if (!tenant.subscriptionExpiresAt) throw forbidden("当前系统租用未开通，请先完成租用续费");
  if (new Date(tenant.subscriptionExpiresAt).getTime() < new Date(now).getTime()) {
    throw forbidden("当前系统租用已到期，请先完成租用续费");
  }
  return tenant;
}

export function tenantSubscriptionActive(state, tenantId, now = new Date().toISOString()) {
  const tenant = state.tenants.find((item) => item.id === tenantId);
  if (!tenant || tenant.enabled === false || !tenant.subscriptionExpiresAt) return false;
  return new Date(tenant.subscriptionExpiresAt).getTime() >= new Date(now).getTime();
}

export function visibleTenantForUser(user, tenantId) {
  return user.role === "admin" ? tenantId : user.tenantId;
}

function buildAnnotation(state, { user, tx, input, now, previous = null, correctionType = null }) {
  const transfer = tx.transactionType === "transfer";
  const category = transfer ? "内部划转" : String(input.category || "").trim();
  const note = String(input.note || "").trim();
  if (!category) throw badRequest("请选择收支分类");
  if (!transfer && !state.categories[tx.direction]?.includes(category)) throw badRequest("所选分类与链上收付方向不一致");
  if (!note) throw badRequest("请填写客户信息、业务说明或资金用途");
  return {
    id: id("annotation"),
    tenantId: tx.tenantId,
    chainTxId: tx.id,
    category,
    note,
    attachmentName: input.attachment?.name || previous?.attachmentName || "",
    attachment: input.attachment || previous?.attachment || null,
    annotatedBy: user.id,
    annotatedAt: now,
    status: "pending",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: "",
    previousAnnotationId: previous?.id || null,
    version: previous ? Number(previous.version || 1) + 1 : nextAnnotationVersion(state, tx.id),
    correctionType,
    createdAt: now,
  };
}

function getVisibleTransaction(state, user, txId) {
  const tx = state.chainTransactions.find((item) => item.id === txId);
  if (!tx) throw notFound("链上流水不存在");
  if (user.role !== "admin" && tx.tenantId !== user.tenantId) throw forbidden("没有查看该链上流水的权限");
  if (user.role === "employee" && !user.canViewAll) {
    const linkedIds = new Set(linkedTransferTransactions(state, tx).map((item) => item.id));
    const own = state.annotations.some((item) => (
      linkedIds.has(item.chainTxId) || item.linkedChainTxIds?.some((id) => linkedIds.has(id))
    ) && item.annotatedBy === user.id);
    if (tx.currentAnnotationId && !own) throw forbidden("没有查看该链上流水的权限");
  }
  return tx;
}

function visibleTransactions(state, user, filters) {
  const tenantId = user.role === "admin" ? filters.tenantId : user.tenantId;
  return state.chainTransactions
    .map((tx) => ({ tx, annotation: currentAnnotation(state, tx) }))
    .filter(({ tx, annotation }) => {
      if (tx.transactionType === "transfer" && tx.pairedTxId && !tx.transferPrimary) return false;
      if (tenantId && tx.tenantId !== tenantId) return false;
      if (user.role === "employee" && !user.canViewAll && annotation && annotation.annotatedBy !== user.id) return false;
      const direction = tx.transactionType === "transfer" ? "transfer" : tx.direction;
      const status = transactionStatus(state, tx, annotation);
      if (filters.direction && direction !== filters.direction) return false;
      if (filters.status && status !== filters.status) return false;
      if (filters.walletId && !linkedTransferTransactions(state, tx).some((item) => item.walletId === filters.walletId)) return false;
      if (filters.minAmount && Number(tx.amount) < Number(filters.minAmount)) return false;
      if (filters.maxAmount && Number(tx.amount) > Number(filters.maxAmount)) return false;
      if (filters.from && tx.chainTime < `${filters.from}T00:00:00`) return false;
      if (filters.to && tx.chainTime > `${filters.to}T23:59:59`) return false;
      if (filters.keyword) {
        const text = `${tx.hash} ${tx.counterparty || ""} ${annotation?.note || ""} ${annotation?.category || ""} ${annotation ? userName(state, annotation.annotatedBy) : ""}`;
        if (!text.includes(filters.keyword)) return false;
      }
      return true;
    })
    .sort((left, right) => compareTransactionRows(state, left, right));
}

function visibleReceivablePayables(state, user, filters = {}) {
  const tenantId = user.role === "admin" ? filters.tenantId : user.tenantId;
  return (state.receivablePayables || [])
    .filter((item) => {
      if (tenantId && item.tenantId !== tenantId) return false;
      if (user.role === "employee" && !user.canViewAll && item.createdBy !== user.id) return false;
      if (filters.type && item.type !== filters.type) return false;
      if (filters.status && item.status !== filters.status) return false;
      if (filters.reviewStatus && item.reviewStatus !== filters.reviewStatus) return false;
      if (filters.counterparty && !String(item.counterparty || "").includes(filters.counterparty)) return false;
      if (filters.keyword) {
        const text = `${item.counterparty || ""} ${item.category || ""} ${item.note || ""} ${userName(state, item.createdBy)}`;
        if (!text.includes(filters.keyword)) return false;
      }
      return true;
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function transactionStatus(state, tx, annotation) {
  if (tx.internalTransferStatus === "pending") return "transfer_pending";
  if (annotation?.status === "approved" && annotation.correctionType === "reversal") return "reversal";
  if (annotation) return annotationStatus(annotation);
  return isManagedTransactionGroup(state, tx) ? "unannotated" : "historical";
}

function compareTransactionRows(state, left, right) {
  const priority = {
    rejected: 0,
    unannotated: 1,
    pending: 2,
    transfer_pending: 3,
    approved: 4,
    reversal: 5,
    corrected: 6,
    reversed: 6,
    historical: 7,
  };
  const statusDifference = (priority[transactionStatus(state, left.tx, left.annotation)] ?? 6)
    - (priority[transactionStatus(state, right.tx, right.annotation)] ?? 6);
  if (statusDifference) return statusDifference;
  const timeDifference = new Date(right.tx.chainTime).getTime() - new Date(left.tx.chainTime).getTime();
  if (timeDifference) return timeDifference;
  return String(right.tx.id).localeCompare(String(left.tx.id));
}

function currentAnnotation(state, tx) {
  if (!tx.currentAnnotationId) return null;
  return state.annotations.find((item) => item.id === tx.currentAnnotationId) || null;
}

function findAnnotation(state, annotationId) {
  const annotation = state.annotations.find((item) => item.id === annotationId);
  if (!annotation) throw notFound("批注不存在");
  return annotation;
}

function ensureNoPendingVersion(state, txId) {
  const tx = state.chainTransactions.find((item) => item.id === txId);
  const linkedIds = new Set(linkedTransferTransactions(state, tx).map((item) => item.id));
  if (state.annotations.some((item) => (linkedIds.has(item.chainTxId) || item.linkedChainTxIds?.some((id) => linkedIds.has(id))) && item.status === "pending")) {
    throw badRequest("该流水已有待审核版本");
  }
}

function nextAnnotationVersion(state, txId) {
  const tx = state.chainTransactions.find((item) => item.id === txId);
  const linkedIds = new Set(linkedTransferTransactions(state, tx).map((item) => item.id));
  return Math.max(0, ...state.annotations
    .filter((item) => linkedIds.has(item.chainTxId) || item.linkedChainTxIds?.some((id) => linkedIds.has(id)))
    .map((item) => Number(item.version || 1))) + 1;
}

function normalizeLegacyStatus(status) {
  return ["pending", "approved", "rejected", "corrected", "reversed", "non_business", "restored"].includes(status) ? status : "approved";
}

function positiveNumberOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function nonNegativeIntegerOrDefault(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : fallback;
}

function assertWalletEnabledLimit(state, tenantId) {
  const limit = nonNegativeIntegerOrDefault(state.systemSettings?.walletEnabledLimit, 0);
  if (!limit) return;
  const enabledCount = state.wallets.filter((wallet) => wallet.tenantId === tenantId && wallet.enabled).length;
  if (enabledCount >= limit) {
    throw badRequest(`启用钱包数量已达上限（${limit} 个），请先停用其他钱包后再操作`);
  }
}

function subscriptionMonths(amount, monthlyFee) {
  const value = Number(amount);
  const fee = Number(monthlyFee);
  if (!Number.isFinite(value) || value <= 0) return { status: "amount_abnormal", reason: "金额无效" };
  if (!Number.isFinite(fee) || fee <= 0) return { status: "amount_abnormal", reason: "月租费用未正确配置" };
  if (value + 0.000001 < fee) return { status: "amount_insufficient", reason: "金额不足，不自动续费" };
  const months = Math.round(value / fee);
  if (Math.abs(value - months * fee) > 0.000001) {
    return { status: "amount_abnormal", reason: "付款金额不是月租整数倍" };
  }
  return { status: "ok", months };
}

function renewTenantSubscription(state, { tenant, months = 0, days = 0, payment, actor, now, manual = false }) {
  const currentExpiry = tenant.subscriptionExpiresAt ? new Date(tenant.subscriptionExpiresAt) : null;
  const base = currentExpiry && currentExpiry.getTime() > new Date(now).getTime() ? currentExpiry : new Date(now);
  tenant.subscriptionExpiresAt = addDays(addMonths(base, months), days).toISOString();
  tenant.subscriptionStatus = "active";
  tenant.lastPaidAt = payment.chainTime || now;
  tenant.lastPaymentTxHash = payment.hash;
  tenant.lastPaidMonths = months;
  tenant.lastPaidDays = days;
  const wasDisabled = tenant.enabled === false;
  tenant.enabled = true;
  tenant.updatedAt = now;
  appendLog(state, {
    tenantId: tenant.id,
    userId: actor.id,
    action: payment.source === "manual" ? "线下手工租用续费" : manual ? "手工确认租用续费" : "自动确认租用续费",
    target: `${payment.hash}:${months}个月${days ? `+${days}天` : ""}:${tenant.subscriptionExpiresAt}`,
    createdAt: now,
  });
  if (wasDisabled) {
    appendLog(state, {
      tenantId: tenant.id,
      userId: actor.id,
      action: "租户续费自动启用",
      target: tenant.name,
      createdAt: now,
    });
  }
}

function addMonths(date, months) {
  const next = new Date(date);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + Number(days || 0));
  return next;
}

function categoryFallback(direction) {
  return direction === "income" ? "其他进账" : "其他出账";
}

function annotationStatus(annotation) {
  return annotation?.status || "unannotated";
}

function annotationStatusLabel(annotation) {
  if (!annotation) return "待批注";
  if (annotation.correctionType === "reversal" && annotation.status === "approved") return "已冲正";
  return {
    pending: "待审核",
    approved: "已通过",
    rejected: "已驳回",
    corrected: "已被修正",
    reversed: "已被冲正",
    non_business: "非业务流水",
    restored: "已恢复待批注",
  }[annotation.status] || annotation.status;
}

function receivableStatusLabel(status) {
  return ({
    open: "未平账",
    partial: "部分平账",
    settled: "已平账",
    voided: "已作废",
  })[status] || status || "";
}

function reviewStatusLabel(status) {
  return ({
    pending: "待审核",
    approved: "已审核",
    rejected: "已驳回",
  })[status] || status || "";
}

export function isManagedTransaction(tx, wallet) {
  if (!wallet?.managedFrom) return true;
  return new Date(tx.chainTime).getTime() >= new Date(wallet.managedFrom).getTime();
}

function isManagedTransactionGroup(state, tx) {
  return linkedTransferTransactions(state, tx).some((item) => {
    const wallet = state.wallets.find((candidate) => candidate.id === item.walletId);
    return isManagedTransaction(item, wallet);
  });
}

function parseManagedFrom(value, now) {
  if (!value) return startOfLocalDay(new Date(now)).toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest("纳入管理起始时间不正确");
  const current = new Date(now);
  if (parsed.getTime() > current.getTime()) throw badRequest("纳入管理起始时间不能晚于当前时间");
  const earliest = startOfLocalDay(current);
  earliest.setDate(earliest.getDate() - 29);
  if (parsed.getTime() < earliest.getTime()) throw badRequest("纳入管理起始时间最多只能选择最近 30 天");
  return parsed.toISOString();
}

function startOfLocalDay(value = new Date()) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function directionLabel(direction) {
  return direction === "income" ? "进账" : "出账";
}

export function reconcileInternalTransfers(state) {
  const walletsByAddress = new Map((state.wallets || []).map((wallet) => [`${wallet.tenantId}:${wallet.address}`, wallet]));
  for (const tx of state.chainTransactions || []) {
    tx.pairedTxId = null;
    tx.transactionType = tx.transactionType === "transfer" ? null : tx.transactionType;
    tx.internalTransferStatus = null;
    tx.transferPrimary = false;
  }
  for (const outgoing of state.chainTransactions || []) {
    if (outgoing.direction !== "expense") continue;
    const targetWallet = walletsByAddress.get(`${outgoing.tenantId}:${outgoing.counterparty}`);
    if (!targetWallet || targetWallet.id === outgoing.walletId) continue;
    const sourceWallet = state.wallets.find((wallet) => wallet.id === outgoing.walletId);
    outgoing.transactionType = "transfer";
    outgoing.internalTransferStatus = "pending";
    outgoing.transferPrimary = true;
    const incoming = state.chainTransactions.find((candidate) => {
      return candidate.tenantId === outgoing.tenantId
        && candidate.walletId === targetWallet.id
        && candidate.direction === "income"
        && candidate.hash === outgoing.hash
        && Number(candidate.amount) === Number(outgoing.amount)
        && (!sourceWallet || candidate.counterparty === sourceWallet.address);
    });
    if (!incoming) continue;
    outgoing.pairedTxId = incoming.id;
    outgoing.internalTransferStatus = "paired";
    incoming.pairedTxId = outgoing.id;
    incoming.transactionType = "transfer";
    incoming.internalTransferStatus = "paired";
    incoming.transferPrimary = false;
    const annotationId = outgoing.currentAnnotationId || incoming.currentAnnotationId;
    if (annotationId) {
      outgoing.currentAnnotationId = annotationId;
      incoming.currentAnnotationId = annotationId;
    }
  }
  for (const incoming of state.chainTransactions || []) {
    if (incoming.direction !== "income" || incoming.transactionType === "transfer") continue;
    const sourceWallet = walletsByAddress.get(`${incoming.tenantId}:${incoming.counterparty}`);
    if (!sourceWallet || sourceWallet.id === incoming.walletId) continue;
    incoming.transactionType = "transfer";
    incoming.internalTransferStatus = "pending";
    incoming.transferPrimary = true;
  }
  return state;
}

function linkedTransferTransactions(state, tx) {
  if (!tx) return [];
  if (!tx.pairedTxId) return [tx];
  const paired = state.chainTransactions.find((item) => item.id === tx.pairedTxId);
  return paired ? [tx, paired] : [tx];
}

function approvedSettlementsForItem(state, itemId) {
  return (state.receivableSettlements || []).filter((settlement) => (
    settlement.itemId === itemId && settlement.status === "approved"
  ));
}

function updateReceivablePayableStatus(state, item) {
  const paidAmount = approvedSettlementsForItem(state, item.id)
    .reduce((sum, settlement) => sum + Number(settlement.amount || 0), 0);
  item.settledAmount = Number(paidAmount.toFixed(6));
  item.remainingAmount = Math.max(Number(item.amount || 0) - item.settledAmount, 0);
  item.overAmount = Math.max(item.settledAmount - Number(item.amount || 0), 0);
  if (item.status === "voided") return item;
  if (item.reviewStatus !== "approved") {
    item.status = "open";
  } else if (item.settledAmount <= 0) {
    item.status = "open";
  } else if (item.settledAmount < Number(item.amount || 0)) {
    item.status = "partial";
  } else {
    item.status = "settled";
  }
  return item;
}

function walletName(state, walletId) {
  return state.wallets.find((wallet) => wallet.id === walletId)?.alias || "-";
}

function transactionWalletLabel(state, tx) {
  if (tx.transactionType !== "transfer") return walletName(state, tx.walletId);
  const paired = tx.pairedTxId ? state.chainTransactions.find((item) => item.id === tx.pairedTxId) : null;
  if (paired) {
    const outgoing = tx.direction === "expense" ? tx : paired;
    const incoming = tx.direction === "income" ? tx : paired;
    return `${walletName(state, outgoing.walletId)} → ${walletName(state, incoming.walletId)}`;
  }
  const counterpartyWallet = state.wallets.find((wallet) => wallet.tenantId === tx.tenantId && wallet.address === tx.counterparty);
  return tx.direction === "expense"
    ? `${walletName(state, tx.walletId)} → ${counterpartyWallet?.alias || "系统钱包待同步"}`
    : `${counterpartyWallet?.alias || "系统钱包待同步"} → ${walletName(state, tx.walletId)}`;
}

function userName(state, userId) {
  return state.users.find((user) => user.id === userId)?.name || "-";
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function csvCell(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function forbidden(message) {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

function id(prefix) {
  return `${prefix}_${cryptoRandom()}`;
}

function cryptoRandom() {
  return Math.random().toString(36).slice(2, 9);
}
