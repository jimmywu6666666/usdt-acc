import { publicUser } from "./auth.mjs";
import { isRoutineAuditLog } from "./domain.mjs";

export function stateForUser(state, user) {
  const safeState = structuredClone(state);
  safeState.activeView = "dashboard";
  safeState.editingAnnotationId = null;
  safeState.users = safeState.users.map(publicUser);
  safeState.annotations = safeState.annotations.map(annotationForClient);
  safeState.receivablePayables ||= [];
  safeState.receivableSettlements ||= [];
  safeState.supportTickets ||= [];
  safeState.receivablePayables = safeState.receivablePayables.map(receivableForClient);
  safeState.supportTickets = safeState.supportTickets.map(supportTicketForClient);

  if (user.role === "admin") {
    const demoTenantIds = new Set(safeState.tenants.filter((item) => item.demo).map((item) => item.id));
    safeState.supportTickets = safeState.supportTickets.filter((item) => !demoTenantIds.has(item.tenantId));
    safeState.activeUserId = user.id;
    return safeState;
  }

  const tenantId = user.tenantId;
  const currentTenant = safeState.tenants.find((item) => item.id === tenantId);
  const adminUserIds = new Set(safeState.users.filter((item) => item.role === "admin").map((item) => item.id));
  const tenantUsers = safeState.users.filter((item) => (
    item.tenantId === tenantId
    && (user.role !== "employee" || user.canViewAll || item.id === user.id || item.role === "supervisor")
  ));
  safeState.activeTenantId = tenantId;
  safeState.activeUserId = user.id;
  safeState.tenants = safeState.tenants.filter((item) => item.id === tenantId);
  safeState.platformPayments = user.role === "supervisor"
    ? (safeState.platformPayments || []).filter((item) => item.tenantId === tenantId).map(platformPaymentForClient)
    : [];
  safeState.subscriptionSettings = {
    enabled: safeState.subscriptionSettings?.enabled === true,
    monthlyFee: safeState.subscriptionSettings?.monthlyFee || 0,
    firstOpenFee: Number(safeState.subscriptionSettings?.firstOpenFee || 0),
    platformWalletAddress: currentTenant?.demo ? "" : safeState.subscriptionSettings?.platformWalletAddress || "",
    autoDisable: safeState.subscriptionSettings?.autoDisable !== false,
  };
  safeState.systemSettings = {
    walletEnabledLimit: Number(safeState.systemSettings?.walletEnabledLimit || 0),
  };
  safeState.users = tenantUsers;
  safeState.demoClaims = [];
  safeState.wallets = safeState.wallets.filter((item) => item.tenantId === tenantId);
  safeState.walletBalanceSnapshots = (safeState.walletBalanceSnapshots || []).filter((item) => item.tenantId === tenantId);
  safeState.receivablePayables = (safeState.receivablePayables || []).filter((item) => item.tenantId === tenantId);
  safeState.receivableSettlements = (safeState.receivableSettlements || []).filter((item) => item.tenantId === tenantId);
  safeState.supportTickets = user.role === "supervisor"
    ? (safeState.supportTickets || []).filter((item) => item.tenantId === tenantId)
    : [];
  safeState.entries = (safeState.entries || []).filter((item) => item.tenantId === tenantId);
  safeState.legacyEntries = (safeState.legacyEntries || []).filter((item) => item.tenantId === tenantId);

  if (user.role === "employee" && !user.canViewAll) {
    const ownAnnotations = safeState.annotations.filter((item) => (
      item.tenantId === tenantId && item.annotatedBy === user.id
    ));
    const ownAnnotationIds = new Set(ownAnnotations.map((item) => item.id));
    safeState.chainTransactions = safeState.chainTransactions.filter((tx) => (
      tx.tenantId === tenantId
      && (ownAnnotationIds.has(tx.currentAnnotationId) || (!tx.currentAnnotationId && isManagedForView(safeState, tx)))
    ));
    const visibleTransactionIds = new Set(safeState.chainTransactions.map((item) => item.id));
    safeState.annotations = ownAnnotations.filter((item) => (
      visibleTransactionIds.has(item.chainTxId)
      || item.linkedChainTxIds?.some((id) => visibleTransactionIds.has(id))
    ));
    safeState.entries = safeState.entries.filter((item) => item.submittedBy === user.id);
    safeState.legacyEntries = safeState.legacyEntries.filter((item) => item.submittedBy === user.id);
    safeState.receivablePayables = safeState.receivablePayables.filter((item) => item.createdBy === user.id);
    const visibleItemIds = new Set(safeState.receivablePayables.map((item) => item.id));
    safeState.receivableSettlements = safeState.receivableSettlements.filter((item) => (
      visibleItemIds.has(item.itemId) || item.submittedBy === user.id
    ));
  } else {
    safeState.chainTransactions = safeState.chainTransactions.filter((item) => item.tenantId === tenantId);
    safeState.annotations = safeState.annotations.filter((item) => item.tenantId === tenantId);
  }

  safeState.auditLogs = safeState.auditLogs.filter((item) => (
    item.tenantId === tenantId
    && !adminUserIds.has(item.userId)
    && !isRoutineAuditLog(item)
    && (user.role !== "employee" || item.userId === user.id)
  ));
  return safeState;
}

function platformPaymentForClient(payment) {
  const {
    id,
    hash,
    amount,
    tenantId,
    status,
    months,
    days,
    reason,
    chainTime,
    createdAt,
    processedAt,
    source,
  } = payment;
  return {
    id,
    hash,
    amount,
    tenantId,
    status,
    months,
    days,
    reason,
    chainTime,
    createdAt,
    processedAt,
    source,
  };
}

function receivableForClient(item) {
  if (!item.attachment) return item;
  const { name, originalName, mimeType, byteSize, originalByteSize, compressed } = item.attachment;
  return {
    ...item,
    attachment: { name, originalName, mimeType, byteSize, originalByteSize, compressed },
  };
}

function supportTicketForClient(ticket) {
  return {
    ...ticket,
    messages: (ticket.messages || []).map((message) => {
      if (!message.attachment) return message;
      const { name, originalName, mimeType, byteSize, originalByteSize, compressed } = message.attachment;
      return {
        ...message,
        attachment: { name, originalName, mimeType, byteSize, originalByteSize, compressed },
      };
    }),
  };
}

export function annotationForClient(annotation) {
  if (!annotation.attachment) return annotation;
  const { name, originalName, mimeType, byteSize, originalByteSize, compressed } = annotation.attachment;
  return {
    ...annotation,
    attachment: { name, originalName, mimeType, byteSize, originalByteSize, compressed },
  };
}

function isManagedForView(state, tx) {
  const linkedTransactions = [tx];
  if (tx.pairedTxId) {
    const paired = state.chainTransactions.find((item) => item.id === tx.pairedTxId);
    if (paired) linkedTransactions.push(paired);
  }
  return linkedTransactions.some((item) => {
    const wallet = state.wallets.find((candidate) => candidate.id === item.walletId);
    return !wallet?.managedFrom || new Date(item.chainTime).getTime() >= new Date(wallet.managedFrom).getTime();
  });
}
