(function () {
  const STORE_KEY = "usdt-ledger-app:v2";
  const SESSION_KEY = "usdt-ledger-session:v1";
  const UI_STATE_KEY = "usdt-ledger-ui:v1";
  const API_STATE = "/api/state";
  const AUTO_REFRESH_MS = 30000;
  const APP_VERSION_CHECK_MS = 60000;
  const nowIso = () => new Date().toISOString();
  const money = (value) => Number(value || 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dateInputValue = (date) => {
    const local = new Date(date);
    local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
    return local.toISOString().slice(0, 10);
  };
  const daysAgoInputValue = (days) => {
    const date = new Date();
    date.setDate(date.getDate() - days);
    return dateInputValue(date);
  };
  const defaultEntryFilters = () => ({ from: daysAgoInputValue(29), to: dateInputValue(new Date()) });
  const defaultLogFilters = () => ({ from: daysAgoInputValue(6), to: dateInputValue(new Date()) });
  const defaultReceivableFilters = () => ({});
  const defaultAccountFilters = () => ({ tenantStatus: "enabled", role: "supervisor" });
  const statusMap = {
    unannotated: ["待批注", "orange"],
    pending: ["待审核", "amber"],
    approved: ["已通过", "green"],
    rejected: ["已驳回", "red"],
    corrected: ["已被修正", "blue"],
    reversed: ["已被冲正", "gray"],
    reversal: ["已冲正", "gray"],
    non_business: ["非业务流水", "gray"],
    restored: ["已恢复待批注", "orange"],
    historical: ["历史无需批注", "gray"],
    transfer_pending: ["内部划转待确认", "amber"],
  };
  const rpTypeMap = { receivable: "应收款", payable: "应付款" };
  const rpStatusMap = {
    open: ["未平账", "orange"],
    partial: ["部分平账", "amber"],
    settled: ["已平账", "green"],
    voided: ["已作废", "gray"],
  };
  const rpReviewMap = {
    pending: ["待审核", "amber"],
    approved: ["已审核", "green"],
    rejected: ["已驳回", "red"],
  };
  const rpSettlementStatusMap = {
    pending: ["待审核", "amber"],
    approved: ["平账已通过", "green"],
    rejected: ["平账已驳回", "red"],
    revoked: ["已撤销", "gray"],
  };
  const typeMap = { income: "进账", expense: "出账", transfer: "内部划转" };
  const supervisorLogActions = [
    "提交链上流水批注",
    "修改并重新提交批注",
    "标记非业务流水",
    "恢复非业务流水为待批注",
    "审核通过批注",
    "驳回批注",
    "提交批注修正",
    "提交批注冲正",
    "审核通过修正",
    "审核通过冲正",
    "新增钱包并设置纳入管理时间",
    "停用钱包",
    "启用钱包",
    "创建员工账号",
    "创建主管账号",
    "重置登录密钥",
    "重置登录密码",
    "修改员工查看权限",
    "提交租用续费哈希",
    "提交应收款",
    "提交应付款",
    "审核通过往来款",
    "驳回往来款",
    "提交往来款平账",
    "确认往来款平账",
    "审核通过往来款平账",
    "驳回往来款平账",
    "作废往来款",
    "导出往来款",
  ];
  const adminLogActions = [
    ...supervisorLogActions,
    "开通独立系统",
    "启用独立系统",
    "停用独立系统",
    "修改租用收费设置",
    "自动确认租用续费",
    "手工确认租用续费",
    "线下手工租用续费",
    "租户续费自动启用",
    "租用到期自动停用",
    "修改系统钱包限制",
    "新增全局分类",
    "修改全局分类",
    "登录系统",
    "登录失败",
    "查看批注凭证",
    "查看往来款凭证",
    "导出链上流水批注",
    "手动查询链上流水",
    "同步链上流水",
    "链上钱包同步失败",
  ];

  const seed = {
    activeTenantId: "tenant_alpha",
    activeUserId: "user_admin",
    activeView: "dashboard",
    editingAnnotationId: null,
    categories: {
      income: ["客户回款", "保证金", "其他进账", "临时进账"],
      expense: ["供应商付款", "运营支出", "其他出账", "临时出账"],
    },
    tenants: [
      { id: "tenant_alpha", name: "Alpha 团队", enabled: true, subscriptionExpiresAt: "", subscriptionStatus: "unset", createdAt: nowIso() },
      { id: "tenant_beta", name: "Beta 团队", enabled: true, subscriptionExpiresAt: "", subscriptionStatus: "unset", createdAt: nowIso() },
    ],
    users: [
      { id: "user_admin", tenantId: null, name: "平台管理员", loginName: "admin", role: "admin", canViewAll: true },
      { id: "user_sup_a", tenantId: "tenant_alpha", name: "Alpha 主管", loginName: "alpha_sup", role: "supervisor", canViewAll: true },
      { id: "user_emp_a", tenantId: "tenant_alpha", name: "员工小林", loginName: "xiaolin", role: "employee", canViewAll: true },
      { id: "user_emp_b", tenantId: "tenant_alpha", name: "员工小陈", loginName: "xiaochen", role: "employee", canViewAll: false },
      { id: "user_sup_b", tenantId: "tenant_beta", name: "Beta 主管", loginName: "beta_sup", role: "supervisor", canViewAll: true },
    ],
    wallets: [
      { id: "wallet_a_hot", tenantId: "tenant_alpha", alias: "热钱包 A", chain: "TRC20", address: "TQ9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWb", enabled: true },
      { id: "wallet_a_pay", tenantId: "tenant_alpha", alias: "打款钱包", chain: "TRC20", address: "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj", enabled: true },
      { id: "wallet_b_main", tenantId: "tenant_beta", alias: "Beta 主钱包", chain: "TRC20", address: "TGLm6JxLD2e4xz5CZK5sDmyTzXhYupjp5r", enabled: true },
    ],
    chainTransactions: [
      {
        id: "tx_001", tenantId: "tenant_alpha", walletId: "wallet_a_hot",
        hash: "a7db5f2c9f4b7d8a26e60b119dd95ff470b4c1", direction: "income", amount: 2500,
        counterparty: "TYn8pPZw4GvDnWGMb5tXT4bB2mR1VmWzV2", confirmed: true,
        chainTime: "2026-06-05T10:14:40.000Z", currentAnnotationId: "annotation_001",
      },
      {
        id: "tx_002", tenantId: "tenant_alpha", walletId: "wallet_a_pay",
        hash: "b8ec6a3d0e5f8c9b37f71c220ee06aa581c5d2", direction: "expense", amount: 800,
        counterparty: "TKnQeF4M2TyRjRzY8qD6Jr9fRrQz8hLqPa", confirmed: true,
        chainTime: "2026-06-05T12:09:40.000Z", currentAnnotationId: null,
      },
    ],
    annotations: [
      {
        id: "annotation_001", tenantId: "tenant_alpha", chainTxId: "tx_001", category: "客户回款",
        note: "客户 A 到账", attachmentName: "receipt-a.png", attachment: null,
        annotatedBy: "user_emp_a", annotatedAt: "2026-06-05T10:16:00.000Z", status: "approved",
        reviewedBy: "user_sup_a", reviewedAt: "2026-06-05T10:24:00.000Z", rejectionReason: "",
        previousAnnotationId: null, version: 1, correctionType: null, createdAt: "2026-06-05T10:16:00.000Z",
      },
    ],
    entries: [],
    legacyEntries: [],
    platformPayments: [],
    receivablePayables: [],
    receivableSettlements: [],
    subscriptionSettings: {
      monthlyFee: 100,
      platformWalletAddress: "",
      enabled: false,
      autoDisable: true,
    },
    systemSettings: {
      walletEnabledLimit: 0,
    },
    auditLogs: [
      { id: "log_001", tenantId: "tenant_alpha", userId: "user_emp_a", action: "提交链上流水批注", target: "annotation_001", createdAt: "2026-06-05T10:16:00.000Z" },
      { id: "log_002", tenantId: "tenant_alpha", userId: "user_sup_a", action: "审核通过批注", target: "annotation_001", createdAt: "2026-06-05T10:24:00.000Z" },
    ],
  };

  let state = structuredClone(seed);
  let session = readSession();
  let loginAccounts = [];
  let runtimeConfig = { appEnv: "development", productionMode: false };
  let toastTimer = null;
  let entryFilters = defaultEntryFilters();
  let entriesPage = 1;
  let logFilters = defaultLogFilters();
  let receivableFilters = defaultReceivableFilters();
  let accountFilters = defaultAccountFilters();
  let logsPage = 1;
  let serverMetrics = null;
  let serverMetricsTimer = null;
  let autoRefreshTimer = null;
  let autoRefreshInFlight = false;
  let appVersionTimer = null;
  let currentAppVersion = "";
  let pendingScrollTarget = null;
  let appUpdateAvailable = false;
  const ENTRY_PAGE_SIZE = 30;
  const LOG_PAGE_SIZE = 30;

  function readSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    } catch {
      return null;
    }
  }

  function authHeaders() {
    return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
  }

  async function load() {
    if (!session?.token) return structuredClone(seed);
    try {
      const response = await fetch(API_STATE, { headers: authHeaders() });
      if (response.ok) {
        const payload = await response.json();
        if (payload.state) return payload.state;
      }
      if (response.status === 401) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
        localStorage.removeItem(UI_STATE_KEY);
        return structuredClone(seed);
      }
    } catch {
      // Browser storage keeps the local preview usable.
    }
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY)) || structuredClone(seed);
    } catch {
      return structuredClone(seed);
    }
  }

  function save() {
    writeStoredState();
    saveUiState();
  }

  function writeStoredState() {
    const snapshot = { ...state };
    delete snapshot.chainStatus;
    localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
  }

  function readUiState() {
    try {
      return JSON.parse(localStorage.getItem(UI_STATE_KEY) || "null") || {};
    } catch {
      return {};
    }
  }

  function saveUiState() {
    if (!session?.token) return;
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({
      activeView: state.activeView,
      activeTenantId: state.activeTenantId,
      entryFilters,
      entriesPage,
      logFilters,
      logsPage,
      receivableFilters,
      accountFilters,
    }));
  }

  function restoreUiState() {
    const ui = readUiState();
    if (ui.activeView) state.activeView = ui.activeView;
    if (ui.activeTenantId && currentUser().role === "admin") state.activeTenantId = ui.activeTenantId;
    if (ui.entryFilters) entryFilters = { ...defaultEntryFilters(), ...ui.entryFilters };
    if (Number.isInteger(Number(ui.entriesPage)) && Number(ui.entriesPage) > 0) entriesPage = Number(ui.entriesPage);
    if (ui.logFilters) logFilters = { ...defaultLogFilters(), ...ui.logFilters };
    if (Number.isInteger(Number(ui.logsPage)) && Number(ui.logsPage) > 0) logsPage = Number(ui.logsPage);
    if (ui.receivableFilters) receivableFilters = { ...defaultReceivableFilters(), ...ui.receivableFilters };
    if (ui.accountFilters) accountFilters = { ...defaultAccountFilters(), ...ui.accountFilters };
  }

  function applyLoadedState(nextState, { preserveUi = true } = {}) {
    const ui = preserveUi ? {
      activeView: state.activeView,
      activeTenantId: state.activeTenantId,
      editingAnnotationId: state.editingAnnotationId,
    } : {};
    state = nextState;
    if (preserveUi) {
      state.activeView = ui.activeView;
      if (ui.activeTenantId && currentUser().role === "admin") state.activeTenantId = ui.activeTenantId;
      state.editingAnnotationId = ui.editingAnnotationId || null;
    }
    migrateState();
    writeStoredState();
  }

  async function apiMutate(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(options.body || {}),
    });
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 401) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
        render();
      }
      throw new Error(payload.error || "操作失败");
    }
    if (payload.state) {
      applyLoadedState(payload.state);
      saveUiState();
    }
    return payload;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    toastTimer = setTimeout(() => el.remove(), 2800);
  }

  async function copyText(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.left = "-9999px";
      input.style.top = "0";
      document.body.appendChild(input);
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, value.length);
      const copied = document.execCommand("copy");
      input.remove();
      return copied;
    }
  }

  function bindGlobalCopyHash() {
    document.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-copy-hash]");
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const ok = await copyText(target.dataset.copyHash);
      toast(ok ? "交易哈希已复制" : "复制失败，请手动复制");
    });
  }

  function startAppVersionCheck() {
    if (appVersionTimer) return;
    checkAppVersion();
    appVersionTimer = setInterval(checkAppVersion, APP_VERSION_CHECK_MS);
  }

  async function checkAppVersion() {
    try {
      const response = await fetch("/api/app-version", { headers: authHeaders() });
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.version) return;
      if (!currentAppVersion) {
        currentAppVersion = payload.version;
        return;
      }
      if (payload.version !== currentAppVersion) showAppUpdateNotice();
    } catch {
      // Version checking is advisory only; keep the current screen untouched.
    }
  }

  function showAppUpdateNotice() {
    if (appUpdateAvailable) return;
    appUpdateAvailable = true;
    const existing = document.querySelector(".app-update-notice");
    if (existing) return;
    const notice = document.createElement("div");
    notice.className = "app-update-notice";
    notice.innerHTML = `<span>系统已更新，刷新后可使用最新版本。</span><button type="button">刷新更新</button>`;
    notice.querySelector("button").addEventListener("click", () => window.location.reload());
    document.body.appendChild(notice);
  }

  function currentUser() {
    return state.users.find((user) => user.id === state.activeUserId) || state.users[0];
  }

  function visibleTenantId() {
    return currentUser().role === "admin" ? state.activeTenantId : currentUser().tenantId;
  }

  function currentTenant() {
    return state.tenants.find((tenant) => tenant.id === visibleTenantId()) || { name: "未选择系统" };
  }

  function tenantWallets() {
    return state.wallets.filter((wallet) => wallet.tenantId === visibleTenantId());
  }

  function tenantUsers() {
    return state.users.filter((user) => user.tenantId === visibleTenantId());
  }

  function tenantTransactions() {
    const user = currentUser();
    return state.chainTransactions.filter((tx) => {
      if (tx.tenantId !== visibleTenantId()) return false;
      if (tx.transactionType === "transfer" && tx.pairedTxId && !tx.transferPrimary) return false;
      if (user.role !== "employee" || user.canViewAll) return true;
      return annotationsForTx(tx.id).some((annotation) => annotation.annotatedBy === user.id) || !tx.currentAnnotationId;
    });
  }

  function tenantReceivables() {
    return (state.receivablePayables || []).filter((item) => item.tenantId === visibleTenantId());
  }

  function tenantSettlements() {
    return (state.receivableSettlements || []).filter((item) => item.tenantId === visibleTenantId());
  }

  function settlementsForItem(itemId) {
    return tenantSettlements().filter((settlement) => settlement.itemId === itemId)
      .sort((left, right) => new Date(right.submittedAt).getTime() - new Date(left.submittedAt).getTime());
  }

  function isTxUsedForReceivable(txId) {
    return (state.receivableSettlements || []).some((settlement) => (
      settlement.txId === txId && !["rejected", "revoked"].includes(settlement.status)
    ));
  }

  function receivablesForTransaction(tx) {
    const type = transactionDirection(tx) === "income" ? "receivable" : "payable";
    const txAmount = Number(tx.amount || 0);
    return tenantReceivables().filter((item) => (
      item.type === type
      && item.reviewStatus === "approved"
      && !["settled", "voided"].includes(item.status)
    )).sort((left, right) => {
      const leftDiff = Math.abs(Number(left.remainingAmount || left.amount || 0) - txAmount);
      const rightDiff = Math.abs(Number(right.remainingAmount || right.amount || 0) - txAmount);
      if (leftDiff !== rightDiff) return leftDiff - rightDiff;
      return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    });
  }

  function canSettleTransaction(tx) {
    return ["employee", "supervisor"].includes(currentUser().role)
      && tenantBusinessActive()
      && tx.transactionType !== "transfer"
      && tx.internalTransferStatus !== "pending"
      && isManagedTransaction(tx)
      && !isTxUsedForReceivable(tx.id)
      && receivablesForTransaction(tx).length > 0;
  }

  function isManagedTransaction(tx) {
    const linked = [tx, pairedTransaction(tx)].filter(Boolean);
    return linked.some((item) => {
      const wallet = state.wallets.find((candidate) => candidate.id === item.walletId);
      return !wallet?.managedFrom || new Date(item.chainTime) >= new Date(wallet.managedFrom);
    });
  }

  function currentAnnotation(tx) {
    return state.annotations.find((annotation) => annotation.id === tx.currentAnnotationId) || null;
  }

  function annotationsForTx(txId) {
    const tx = state.chainTransactions.find((item) => item.id === txId);
    const linkedIds = new Set([txId, tx?.pairedTxId].filter(Boolean));
    return state.annotations.filter((annotation) => (
      linkedIds.has(annotation.chainTxId) || annotation.linkedChainTxIds?.some((id) => linkedIds.has(id))
    )).sort((a, b) => Number(b.version) - Number(a.version));
  }

  function displayStatus(annotation) {
    if (!annotation) return "unannotated";
    if (annotation.status === "approved" && annotation.correctionType === "reversal") return "reversal";
    return annotation.status;
  }

  function transactionStatus(tx, annotation) {
    if (tx.internalTransferStatus === "pending") return "transfer_pending";
    if (annotation) return displayStatus(annotation);
    return isManagedTransaction(tx) ? "unannotated" : "historical";
  }

  function compareTransactionRows(left, right) {
    const priority = {
      rejected: 0,
      unannotated: 1,
      pending: 2,
      transfer_pending: 3,
      approved: 4,
      reversal: 5,
      non_business: 6,
      corrected: 6,
      reversed: 6,
      restored: 7,
      historical: 7,
    };
    const statusDifference = (priority[transactionStatus(left.tx, left.annotation)] ?? 6)
      - (priority[transactionStatus(right.tx, right.annotation)] ?? 6);
    if (statusDifference) return statusDifference;
    const timeDifference = new Date(right.tx.chainTime).getTime() - new Date(left.tx.chainTime).getTime();
    if (timeDifference) return timeDifference;
    return String(right.tx.id).localeCompare(String(left.tx.id));
  }

  function transactionDirection(tx) {
    return tx.transactionType === "transfer" ? "transfer" : tx.direction;
  }

  function pairedTransaction(tx) {
    return tx.pairedTxId ? state.chainTransactions.find((item) => item.id === tx.pairedTxId) || null : null;
  }

  function transactionWalletText(tx) {
    const paired = pairedTransaction(tx);
    if (tx.transactionType !== "transfer") return walletName(tx.walletId);
    if (paired) {
      const outgoing = tx.direction === "expense" ? tx : paired;
      const incoming = tx.direction === "income" ? tx : paired;
      return `${walletName(outgoing.walletId)} → ${walletName(incoming.walletId)}`;
    }
    const target = state.wallets.find((wallet) => wallet.tenantId === tx.tenantId && wallet.address === tx.counterparty);
    return tx.direction === "expense"
      ? `${walletName(tx.walletId)} → ${target?.alias || "系统钱包待同步"}`
      : `${target?.alias || "系统钱包待同步"} → ${walletName(tx.walletId)}`;
  }

  function canReview() {
    return currentUser().role === "supervisor";
  }

  function canViewReviewCenter() {
    return ["admin", "supervisor"].includes(currentUser().role);
  }

  function canManageNonBusiness() {
    return ["admin", "supervisor"].includes(currentUser().role);
  }

  function canEditAnnotation(annotation) {
    const user = currentUser();
    return user.role !== "employee" || annotation.annotatedBy === user.id;
  }

  function walletName(walletId) {
    return state.wallets.find((wallet) => wallet.id === walletId)?.alias || "-";
  }

  function userName(userId) {
    return state.users.find((user) => user.id === userId)?.name || "-";
  }

  function tenantName(tenantId) {
    return state.tenants.find((tenant) => tenant.id === tenantId)?.name || "-";
  }

  function shortHash(hash) {
    const value = String(hash || "");
    return value.length > 14 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value || "-";
  }

  function isLikelyTransactionHash(value) {
    return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
  }

  function renderCopyHash(hash, { short = false } = {}) {
    const value = String(hash || "").trim();
    if (!value) return "-";
    const text = short ? shortHash(value) : value;
    return `<button class="copy-hash mono" type="button" data-copy-hash="${escapeHtml(value)}" title="点击复制交易哈希">${escapeHtml(text)}</button>`;
  }

  function renderCategoryOptions(categories, selectedCategory = "") {
    return [
      `<option value="">请选择分类</option>`,
      ...categories.map((category) => `<option value="${escapeHtml(category)}" ${category === selectedCategory ? "selected" : ""}>${escapeHtml(category)}</option>`),
    ].join("");
  }

  function subscriptionDurationText(item) {
    const parts = [];
    if (Number(item?.months || 0) > 0) parts.push(`${item.months} 个月`);
    if (Number(item?.days || 0) > 0) parts.push(`${item.days} 天`);
    return parts.join(" + ") || "0 个月";
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "-";
  }

  function subscriptionStatusText(tenant) {
    if (!tenant.subscriptionExpiresAt) return "未开通";
    const expired = new Date(tenant.subscriptionExpiresAt).getTime() < Date.now();
    if (expired) return "已到期";
    const days = Math.ceil((new Date(tenant.subscriptionExpiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    return `剩余 ${days} 天`;
  }

  function subscriptionStatusKey(tenant) {
    if (!tenant.subscriptionExpiresAt) return "unset";
    return new Date(tenant.subscriptionExpiresAt).getTime() < Date.now() ? "expired" : "active";
  }

  function subscriptionStatusBadge(tenant) {
    return badge({
      active: ["租用有效", "green"],
      expired: ["已到期", "red"],
      unset: ["未开通", "orange"],
    }, subscriptionStatusKey(tenant));
  }

  function tenantBusinessActive(tenant = currentTenant()) {
    return tenant.enabled !== false && subscriptionStatusKey(tenant) === "active";
  }

  function tenantBusinessLockText(tenant = currentTenant()) {
    if (tenant.enabled === false) return "当前系统已停用，暂不能进行新增钱包、批注、往来款、平账和审核等业务操作。";
    if (!tenant.subscriptionExpiresAt) return "当前系统租用未开通，暂不能进行新增钱包、批注、往来款、平账和审核等业务操作。";
    if (subscriptionStatusKey(tenant) === "expired") return "当前系统租用已到期，暂不能进行新增钱包、批注、往来款、平账和审核等业务操作。";
    return "";
  }

  function renderTenantBusinessLockNotice() {
    const message = tenantBusinessLockText();
    return message ? `<div class="notice chain-status-off">${message}主管可在“租用续费”页面提交付款哈希。</div>` : "";
  }

  function platformPaymentStatusMap() {
    return {
      submitted: ["已提交", "amber"],
      applied: ["已自动续费", "green"],
      manual_applied: ["已手工续费", "blue"],
      offline_applied: ["线下手工续费", "blue"],
      unidentified: ["待人工处理", "orange"],
      amount_insufficient: ["金额不足", "red"],
      amount_abnormal: ["金额异常", "red"],
    };
  }

  function managedFromPreset(preset) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    if (preset === "7") date.setDate(date.getDate() - 6);
    if (preset === "30") date.setDate(date.getDate() - 29);
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  function managedFromMax() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 16);
  }

  function roleLabel(role) {
    return { admin: "管理员", supervisor: "主管", employee: "员工" }[role] || role;
  }

  function badge(map, key) {
    const [label, color] = map[key] || [key || "-", ""];
    return `<span class="badge ${color}">${label}</span>`;
  }

  function render() {
    const app = document.querySelector("#app");
    if (!session?.token) {
      stopAutoRefresh();
      app.innerHTML = renderLogin();
      bindLoginEvents();
      return;
    }
    startAutoRefresh();
    app.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">¥</div>
          <div>
            <h1>智慧星 USDT 财务记账系统</h1>
            <p>专业的现金流台账、批注审核与链上流水对账系统</p>
          </div>
        </div>
        <div class="top-actions">
          <label class="top-field top-system"><span class="top-label">当前系统</span>
            ${currentUser().role === "admin"
              ? `<select data-action="tenant">${state.tenants.map((tenant) => `<option value="${tenant.id}" ${tenant.id === state.activeTenantId ? "selected" : ""}>${tenant.name}</option>`).join("")}</select>`
              : `<div class="user-chip"><span>${currentTenant().name}</span></div>`}
          </label>
          <label class="top-field top-account"><span class="top-label">当前账号</span>
            <div class="user-chip"><span>${currentUser().name} / ${roleLabel(currentUser().role)}</span></div>
          </label>
          <button class="btn top-logout" data-action="logout">退出</button>
        </div>
      </header>
      <div class="layout">
        ${renderSidebar()}
        <main class="main">${renderView()}</main>
      </div>
    `;
    saveUiState();
    bindEvents();
    scrollToPendingTarget();
  }

  function renderLogin() {
    const isProduction = runtimeConfig.productionMode === true;
    return `
      <main class="login-page">
        <section class="login-panel">
          <div class="brand"><strong>智慧星 USDT 财务记账系统</strong><span>专业的现金流台账、批注审核与链上流水对账系统</span></div>
          <form id="loginForm" class="form-grid one">
            <label>账号<input name="loginName" autocomplete="username" required placeholder="请输入登录账号"></label>
            <label>密码<input name="password" type="password" value="${isProduction ? "" : "123456"}" required></label>
            <label>动态验证码<input name="totpCode" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" placeholder="已绑定登录密钥时填写 6 位验证码"></label>
            <button class="btn primary" type="submit">登录系统</button>
          </form>
          ${isProduction ? "" : `<p class="login-hint">开发测试阶段统一密码：123456</p>`}
        </section>
      </main>
    `;
  }

  function renderSidebar() {
    const role = currentUser().role;
    const nav = [
      ["dashboard", "总览"],
      ["entries", "流水账目"],
      ["receivables", "往来款管理"],
      ["wallets", "钱包管理"],
      ["reconcile", "链上查询"],
      ["logs", "操作日志"],
    ];
    if (["admin", "supervisor"].includes(role)) nav.splice(2, 0, ["review", "审核中心"]);
    if (["admin", "supervisor"].includes(role)) nav.splice(-1, 0, ["users", "账号管理"]);
    if (["admin", "supervisor"].includes(role)) nav.splice(-1, 0, ["subscription", role === "admin" ? "租用管理" : "租用续费"]);
    if (role === "admin") nav.splice(-1, 0, ["admin", "系统管理"]);
    if (role === "admin") nav.splice(-1, 0, ["server", "服务器管理"]);
    nav.splice(-1, 0, ["profile", "我的账号"]);
    nav.splice(-1, 0, ["help", "使用说明"]);
    return `<aside class="sidebar">${nav.map(([key, label]) => `<button class="nav-btn ${state.activeView === key ? "active" : ""}" data-nav="${key}">${label}</button>`).join("")}</aside>`;
  }

  function renderView() {
    const role = currentUser().role;
    if (state.activeView === "review" && !["admin", "supervisor"].includes(role)) state.activeView = "dashboard";
    if (state.activeView === "users" && !["admin", "supervisor"].includes(role)) state.activeView = "dashboard";
    if (state.activeView === "admin" && role !== "admin") state.activeView = "dashboard";
    if (state.activeView === "server" && role !== "admin") state.activeView = "dashboard";
    if (state.activeView === "subscription" && !["admin", "supervisor"].includes(role)) state.activeView = "dashboard";
    const views = {
      dashboard: renderDashboard,
      entries: renderEntries,
      new: renderNewAnnotation,
      review: renderReview,
      receivables: renderReceivables,
      wallets: renderWallets,
      reconcile: renderChain,
      users: renderUsers,
      admin: renderAdmin,
      subscription: renderSubscription,
      server: renderServer,
      profile: renderProfile,
      help: renderHelp,
      logs: renderLogs,
    };
    return (views[state.activeView] || renderDashboard)();
  }

  function pageHead(title, desc, action = "") {
    return `<div class="page-head"><div><h2>${title}</h2><p>${desc}</p></div><div>${action}</div></div>`;
  }

  function renderDashboard() {
    const rows = tenantTransactions().map((tx) => ({ tx, annotation: currentAnnotation(tx) }));
    const approved = rows.filter(({ tx, annotation }) => isManagedTransaction(tx) && tx.transactionType !== "transfer" && annotation?.status === "approved" && annotation.correctionType !== "reversal");
    const actual = rows.filter(({ tx }) => isManagedTransaction(tx) && tx.transactionType !== "transfer");
    const periods = dashboardPeriods();
    const pending = rows.filter(({ annotation }) => annotation?.status === "pending").length;
    const unannotated = rows.filter(({ tx, annotation }) => (
      isManagedTransaction(tx) && tx.internalTransferStatus !== "pending" && !annotation
    )).length;
    const receivableSummary = summarizeReceivables(tenantReceivables());
    const pendingReceivables = tenantReceivables().filter((item) => item.reviewStatus === "pending").length;
    const pendingSettlements = tenantSettlements().filter((item) => item.status === "pending").length;
    const syncErrors = tenantWallets().filter((wallet) => wallet.enabled && wallet.lastSyncError);
    return `
      ${pageHead("资金概况", "汇总业务已审核数据、钱包实际流水和链上余额变化")}
      ${syncErrors.length ? `<div class="notice danger">链上同步异常：${syncErrors.map((wallet) => `${wallet.alias}（${wallet.lastSyncError}）`).join("；")}</div>` : ""}
      <div class="section-label"><h3>业务已审核</h3><span>只统计已审核通过的业务批注</span></div>
      <section class="dashboard-business-block">
        <div class="grid stats">
          ${periods.map((period) => {
            const summary = summarizeApproved(approved, period.start, period.end);
            return `<div class="period-card">
              <div class="card-label">${period.label}</div>
              <div class="period-values">
                <div><span>进账</span><strong class="income-value">${money(summary.income)}</strong></div>
                <div><span>出账</span><strong class="expense-value">${money(summary.expense)}</strong></div>
              </div>
              <div class="card-foot">USDT</div>
            </div>`;
          }).join("")}
        </div>
      </section>
      <div class="section-label"><h3>待处理业务</h3><span>需要补充说明或主管确认的流水</span></div>
      <section class="dashboard-business-block">
        <div class="pending-business-row">
          <div class="pending-business-card review" role="button" tabindex="0" data-dashboard-target="review-annotations">
            <span>待审核批注</span>
            <strong>${pending}</strong>
            <small>主管确认业务原由与凭证</small>
          </div>
          <div class="pending-business-card annotation" role="button" tabindex="0" data-dashboard-target="entries-unannotated">
            <span>待批注流水</span>
            <strong>${unannotated}</strong>
            <small>链上已有记录但尚无业务说明</small>
          </div>
        </div>
      </section>
      <div class="section-label"><h3>钱包实际流水</h3><span>按链上流水统计，不区分是否已批注或审核</span></div>
      <section class="dashboard-business-block">
        <div class="grid stats">
          ${periods.map((period) => {
            const summary = summarizeActual(actual, period.start, period.end);
            return `<div class="period-card">
              <div class="card-label">${period.label}</div>
              <div class="period-values">
                <div><span>进账</span><strong class="income-value">${money(summary.income)}</strong></div>
                <div><span>出账</span><strong class="expense-value">${money(summary.expense)}</strong></div>
              </div>
              <div class="card-foot">USDT</div>
            </div>`;
          }).join("")}
        </div>
      </section>
      <div class="section-label"><h3>往来款概况</h3><span>只统计已审核且未作废的往来款</span></div>
      <section class="dashboard-business-block rp-overview">
        <div class="rp-pending-row">
          <div class="rp-pending-card pending" role="button" tabindex="0" data-dashboard-target="review-receivables">
            <span>待审核往来款</span>
            <strong>${pendingReceivables}</strong>
            <small>员工提交的应收应付待确认</small>
          </div>
          <div class="rp-pending-card pending" role="button" tabindex="0" data-dashboard-target="review-settlements">
            <span>待审核平账</span>
            <strong>${pendingSettlements}</strong>
            <small>往来款绑定链上流水待确认</small>
          </div>
        </div>
        <div class="stats-grid rp-stats">
          ${renderRpStat("应收总额", receivableSummary.receivable.amount, "应收已收", receivableSummary.receivable.settled, "未收", receivableSummary.receivable.remaining, "多收", receivableSummary.receivable.over, "receivable")}
          ${renderRpStat("应付总额", receivableSummary.payable.amount, "应付已付", receivableSummary.payable.settled, "未付", receivableSummary.payable.remaining, "多付", receivableSummary.payable.over, "payable")}
        </div>
      </section>
      <section class="grid dashboard-table-grid">
        <div class="dashboard-business-block dashboard-table-block">
          <div class="panel-title"><h3>链上钱包余额</h3></div>
          ${renderWalletBalanceTable()}
        </div>
        <div class="dashboard-business-block dashboard-table-block">
          <div class="panel-title"><h3>最近流水</h3><button class="btn" data-nav="entries">查看全部</button></div>
          ${renderTransactionTable(rows.slice(0, 6), false)}
        </div>
      </section>
    `;
  }

  function dashboardPeriods(reference = new Date()) {
    const today = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const monthStart = new Date(reference.getFullYear(), reference.getMonth(), 1);
    const nextMonthStart = new Date(reference.getFullYear(), reference.getMonth() + 1, 1);
    const lastMonthStart = new Date(reference.getFullYear(), reference.getMonth() - 1, 1);
    return [
      { label: "今日", start: today, end: tomorrow },
      { label: "昨日", start: yesterday, end: today },
      { label: "本月", start: monthStart, end: nextMonthStart },
      { label: "上月", start: lastMonthStart, end: monthStart },
    ];
  }

  function summarizeApproved(rows, start, end) {
    return rows.reduce((summary, { tx }) => {
      const occurredAt = new Date(tx.chainTime);
      if (occurredAt < start || occurredAt >= end) return summary;
      summary[tx.direction] += Number(tx.amount);
      return summary;
    }, { income: 0, expense: 0 });
  }

  function summarizeActual(rows, start, end) {
    return rows.reduce((summary, { tx }) => {
      const occurredAt = new Date(tx.chainTime);
      if (occurredAt < start || occurredAt >= end) return summary;
      summary[tx.direction] += Number(tx.amount);
      return summary;
    }, { income: 0, expense: 0 });
  }

  function chainBalance(walletId) {
    const wallet = state.wallets.find((item) => item.id === walletId);
    if (Number.isFinite(Number(wallet?.chainBalance))) return Number(wallet.chainBalance);
    return state.chainTransactions
      .filter((tx) => tx.walletId === walletId && tx.confirmed)
      .reduce((sum, tx) => sum + (tx.direction === "income" ? Number(tx.amount) : -Number(tx.amount)), 0);
  }

  function balanceSnapshot(walletId, startDate, endDate) {
    const startKey = dateInputValue(startDate);
    const endKey = dateInputValue(endDate);
    return (state.walletBalanceSnapshots || [])
      .filter((snapshot) => snapshot.walletId === walletId && snapshot.dateKey >= startKey && snapshot.dateKey < endKey)
      .sort((left, right) => left.dateKey.localeCompare(right.dateKey) || new Date(left.capturedAt) - new Date(right.capturedAt))[0] || null;
  }

  function walletBalanceSummary(wallet) {
    const periods = dashboardPeriods();
    const current = chainBalance(wallet.id);
    const todaySnapshot = balanceSnapshot(wallet.id, periods[0].start, periods[0].end);
    const monthSnapshot = balanceSnapshot(wallet.id, periods[2].start, periods[2].end);
    return {
      current,
      todayChange: balanceChangeInfo(current, todaySnapshot, periods[0].start),
      monthChange: balanceChangeInfo(current, monthSnapshot, periods[2].start),
    };
  }

  function balanceChangeInfo(current, snapshot, expectedStartDate) {
    if (!snapshot) return null;
    return {
      value: current - Number(snapshot.balance),
      dateKey: snapshot.dateKey,
      expectedStartKey: dateInputValue(expectedStartDate),
    };
  }

  function snapshotDateText(dateKey) {
    if (!dateKey) return "";
    const [year, month, day] = String(dateKey).split("-");
    return [year, String(Number(month || 0)), String(Number(day || 0))].filter(Boolean).join("/");
  }

  function balanceChangeLine(label, change) {
    if (!change) return `<span class="muted">${label}：暂无快照</span>`;
    const value = typeof change === "number" ? change : Number(change.value);
    const sign = value > 0 ? "+" : "";
    const tone = value > 0 ? "positive" : value < 0 ? "negative" : "neutral";
    const origin = typeof change === "object" && change.dateKey && change.dateKey !== change.expectedStartKey
      ? ` <small>自 ${snapshotDateText(change.dateKey)}</small>`
      : "";
    return `<span class="balance-change ${tone}">${label}：${sign}${money(value)}${origin}</span>`;
  }

  function renderWalletBalanceTable() {
    const wallets = tenantWallets();
    if (!wallets.length) return `<div class="empty">暂无钱包</div>`;
    const showActions = state.activeView === "wallets" && canReview();
    const canEnableWallet = tenantBusinessActive();
    return `<div class="table-wrap wallet-balance-wrap"><table class="wallet-balance-table">
      <thead><tr><th>钱包 / 状态</th><th>链上余额</th><th>地址</th></tr></thead>
      <tbody>${wallets.map((wallet) => {
        const summary = walletBalanceSummary(wallet);
        const status = wallet.enabled ? badge({ ok: ["启用", "green"] }, "ok") : badge({ off: ["停用", "red"] }, "off");
        const syncText = wallet.lastSyncError
          ? `<span class="sync-error">${escapeHtml(wallet.lastSyncError)}</span>`
          : wallet.lastSyncedAt ? `<span class="muted">同步：${formatDate(wallet.lastSyncedAt)}</span>` : "";
        return `<tr>
        <td>
          <div class="wallet-cell-head"><strong>${escapeHtml(wallet.alias)}</strong>${status}</div>
          <div class="wallet-cell-meta">${escapeHtml(wallet.chain)} · 管理起点：${formatDate(wallet.managedFrom)}</div>
          ${syncText ? `<div class="wallet-cell-sync">${syncText}</div>` : ""}
          ${showActions ? `<div class="wallet-cell-actions">${wallet.enabled ? `<button class="btn small danger" data-disable-wallet="${wallet.id}">停用</button>` : `<button class="btn small primary" data-enable-wallet="${wallet.id}" ${canEnableWallet ? "" : "disabled"}>启用</button>`}</div>` : ""}
        </td>
        <td class="wallet-balance-value">${money(summary.current)}<br>${balanceChangeLine("今日变化", summary.todayChange)}<br>${balanceChangeLine("本月变化", summary.monthChange)}</td><td class="mono">${escapeHtml(wallet.address)}</td>
      </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function renderEntries() {
    const rows = filteredTransactions();
    const totalPages = Math.max(1, Math.ceil(rows.length / ENTRY_PAGE_SIZE));
    entriesPage = Math.min(entriesPage, totalPages);
    const pageRows = rows.slice((entriesPage - 1) * ENTRY_PAGE_SIZE, entriesPage * ENTRY_PAGE_SIZE);
    return `
      ${pageHead("流水账目", "默认查看最近 30 天流水，可按状态、钱包、方向和关键词筛选", `<button class="btn primary" data-action="export">导出 CSV</button>`)}
      ${renderTenantBusinessLockNotice()}
      <form id="filters" class="filters">
        <label>开始日期<input type="date" name="from" value="${escapeHtml(entryFilters.from)}"></label>
        <label>结束日期<input type="date" name="to" value="${escapeHtml(entryFilters.to)}"></label>
        <label>方向<select name="direction"><option value="">全部</option><option value="income" ${selectedFilter("direction", "income")}>进账</option><option value="expense" ${selectedFilter("direction", "expense")}>出账</option><option value="transfer" ${selectedFilter("direction", "transfer")}>内部划转</option></select></label>
        <label>批注状态<select name="status"><option value="">全部</option><option value="unannotated" ${selectedFilter("status", "unannotated")}>待批注</option><option value="non_business" ${selectedFilter("status", "non_business")}>非业务流水</option><option value="transfer_pending" ${selectedFilter("status", "transfer_pending")}>内部划转待确认</option><option value="historical" ${selectedFilter("status", "historical")}>历史无需批注</option><option value="pending" ${selectedFilter("status", "pending")}>待审核</option><option value="approved" ${selectedFilter("status", "approved")}>已通过</option><option value="rejected" ${selectedFilter("status", "rejected")}>已驳回</option><option value="reversal" ${selectedFilter("status", "reversal")}>已冲正</option></select></label>
        <label>钱包<select name="walletId"><option value="">全部</option>${tenantWallets().map((wallet) => `<option value="${wallet.id}" ${selectedFilter("walletId", wallet.id)}>${wallet.alias}</option>`).join("")}</select></label>
        <label>最小金额<input type="number" name="minAmount" step="0.01" value="${escapeHtml(entryFilters.minAmount)}"></label>
        <label>最大金额<input type="number" name="maxAmount" step="0.01" value="${escapeHtml(entryFilters.maxAmount)}"></label>
        <label>关键词<input name="keyword" value="${escapeHtml(entryFilters.keyword)}" placeholder="哈希、地址、分类、说明、批注人"></label>
        <div class="actions"><button class="btn primary" type="submit">查询</button><button class="btn" type="reset">清空</button></div>
      </form>
      ${renderTransactionTable(pageRows, true)}
      ${renderEntriesPagination(rows.length, totalPages)}
    `;
  }

  function filteredTransactions() {
    const filters = entryFilters;
    return tenantTransactions().map((tx) => ({ tx, annotation: currentAnnotation(tx) })).filter(({ tx, annotation }) => {
      if (filters.from && tx.chainTime < `${filters.from}T00:00:00`) return false;
      if (filters.to && tx.chainTime > `${filters.to}T23:59:59`) return false;
      if (filters.direction && transactionDirection(tx) !== filters.direction) return false;
      const rowStatus = transactionStatus(tx, annotation);
      if (filters.status && rowStatus !== filters.status) return false;
      if (filters.walletId && ![tx.walletId, pairedTransaction(tx)?.walletId].includes(filters.walletId)) return false;
      if (filters.minAmount && Number(tx.amount) < Number(filters.minAmount)) return false;
      if (filters.maxAmount && Number(tx.amount) > Number(filters.maxAmount)) return false;
      if (filters.keyword) {
        const text = `${tx.hash} ${tx.counterparty} ${annotation?.category || ""} ${annotation?.note || ""} ${annotation ? userName(annotation.annotatedBy) : ""}`;
        if (!text.includes(filters.keyword)) return false;
      }
      return true;
    }).sort(compareTransactionRows);
  }

  function renderEntriesPagination(totalRows, totalPages) {
    if (!totalRows) return "";
    const start = (entriesPage - 1) * ENTRY_PAGE_SIZE + 1;
    const end = Math.min(entriesPage * ENTRY_PAGE_SIZE, totalRows);
    return `<div class="pagination">
      <span>第 ${start}-${end} 条，共 ${totalRows} 条</span>
      <div class="pagination-actions">
        <button class="btn pagination-icon" data-entry-page="1" title="首页" aria-label="首页" ${entriesPage <= 1 ? "disabled" : ""}>«</button>
        <button class="btn pagination-icon" data-entry-page="${entriesPage - 1}" title="上一页" aria-label="上一页" ${entriesPage <= 1 ? "disabled" : ""}>‹</button>
        <label class="pagination-jump">
          <span>页码</span>
          <select data-entry-page-select aria-label="选择页码">
            ${Array.from({ length: totalPages }, (_, index) => {
              const page = index + 1;
              return `<option value="${page}" ${page === entriesPage ? "selected" : ""}>第 ${page} 页</option>`;
            }).join("")}
          </select>
        </label>
        <button class="btn pagination-icon" data-entry-page="${entriesPage + 1}" title="下一页" aria-label="下一页" ${entriesPage >= totalPages ? "disabled" : ""}>›</button>
        <button class="btn pagination-icon" data-entry-page="${totalPages}" title="末页" aria-label="末页" ${entriesPage >= totalPages ? "disabled" : ""}>»</button>
      </div>
    </div>`;
  }

  function selectedFilter(name, value) {
    return entryFilters[name] === value ? "selected" : "";
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function percent(used, total) {
    return Number(total) > 0 ? (Number(used || 0) / Number(total)) * 100 : 0;
  }

  function formatDuration(seconds) {
    const total = Number(seconds || 0);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days) return `${days}天 ${hours}小时`;
    if (hours) return `${hours}小时 ${minutes}分钟`;
    return `${minutes}分钟`;
  }

  function renderTransactionTable(rows, withActions) {
    if (!rows.length) return `<div class="empty">暂无流水</div>`;
    return `<div class="table-wrap"><table>
      <thead><tr><th>链上时间</th><th>方向</th><th>金额</th><th>钱包</th><th>分类/说明</th><th>批注人</th><th>状态</th>${withActions ? "<th>操作</th>" : ""}</tr></thead>
      <tbody>${rows.map(({ tx, annotation }) => {
        const direction = transactionDirection(tx);
        const status = transactionStatus(tx, annotation);
        return `<tr class="tx-row ${withActions ? `tx-status-${status}` : ""}">
        <td>${formatDate(tx.chainTime)}</td><td>${directionPill(direction)}</td><td class="amount-${direction}">${money(tx.amount)}</td><td>${transactionWalletText(tx)}</td>
        <td>${annotation?.category || "-"}<br><span class="muted">${annotation?.note || (tx.internalTransferStatus === "pending" ? "等待另一侧钱包流水同步" : "尚未批注")}</span>${annotation?.rejectionReason ? `<div class="inline-alert danger">驳回原因：${escapeHtml(annotation.rejectionReason)}</div>` : ""}${annotation?.attachmentName ? `<br><button class="attachment-link" data-attachment="${annotation.id}">${annotation.attachmentName}</button>` : ""}</td>
        <td>${annotation ? userName(annotation.annotatedBy) : "-"}</td><td>${badge(statusMap, status)}</td>
        ${withActions ? `<td>${transactionActions(tx, annotation)}</td>` : ""}
      </tr>`;
      }).join("")}</tbody>
    </table></div>`;
  }

  function directionPill(direction) {
    return `<span class="direction-pill direction-${direction}">${typeMap[direction]}</span>`;
  }

  function transactionActions(tx, annotation) {
    const actions = [`<button class="btn" data-detail="${tx.id}">详情</button>`];
    const businessActive = tenantBusinessActive();
    if (businessActive && !annotation && isManagedTransaction(tx) && tx.internalTransferStatus !== "pending") actions.push(`<button class="btn primary" data-annotate-tx="${tx.id}">批注</button>`);
    if (canSettleTransaction(tx)) actions.push(`<button class="btn settle" data-settle-tx="${tx.id}">${transactionDirection(tx) === "income" ? "平应收" : "平应付"}</button>`);
    if (businessActive && !annotation && isManagedTransaction(tx) && tx.internalTransferStatus !== "pending" && canManageNonBusiness()) actions.push(`<button class="btn warn" data-non-business="${tx.id}">非业务</button>`);
    if (businessActive && annotation?.status === "non_business" && canManageNonBusiness()) actions.push(`<button class="btn" data-restore-non-business="${annotation.id}">恢复待批注</button>`);
    if (businessActive && annotation?.status === "rejected" && canEditAnnotation(annotation)) actions.push(`<button class="btn primary" data-resubmit="${annotation.id}">修改重提</button>`);
    if (businessActive && annotation?.status === "approved" && annotation.correctionType !== "reversal" && canEditAnnotation(annotation)) {
      actions.push(`<button class="btn warn" data-correct="${annotation.id}">修正</button>`);
      actions.push(`<button class="btn danger" data-reverse="${annotation.id}">冲正</button>`);
    }
    return actions.join("");
  }

  function renderAnnotationTxSummary(tx) {
    const direction = transactionDirection(tx);
    return `<section class="annotation-modal-summary summary-${direction}">
      <div class="summary-item"><span>链上时间</span><strong>${formatDate(tx.chainTime)}</strong></div>
      <div class="summary-item"><span>方向</span><strong>${directionPill(direction)}</strong></div>
      <div class="summary-item highlight amount"><span>金额</span><strong class="amount-${direction}">${money(tx.amount)} USDT</strong></div>
      <div class="summary-item"><span>钱包</span><strong><span class="summary-wallet">${escapeHtml(transactionWalletText(tx))}</span></strong></div>
      <div class="summary-item wide hash"><span>交易哈希</span>${renderCopyHash(tx.hash)}</div>
    </section>`;
  }

  function renderNewAnnotation() {
    const editing = state.annotations.find((annotation) => annotation.id === state.editingAnnotationId) || null;
    const editingTx = editing ? state.chainTransactions.find((tx) => tx.id === editing.chainTxId) : null;
    const available = tenantTransactions().filter((tx) => !currentAnnotation(tx)
      && tx.internalTransferStatus !== "pending"
      && isManagedTransaction(tx));
    const selectedTx = editingTx || available[0] || null;
    const categories = selectedTx ? selectedTx.transactionType === "transfer" ? ["内部划转"] : state.categories[selectedTx.direction] : [];
    return `
      ${pageHead(editing ? "修改并重新提交" : "批注链上流水", "先选择真实链上进出账，再补充业务分类、用途和凭证；金额及钱包不可修改")}
      ${renderTenantBusinessLockNotice()}
      <section class="panel">
        ${tenantBusinessActive() && selectedTx ? `<form id="annotationForm" class="form-grid">
          <label>链上流水
            <select name="chainTxId" data-chain-tx ${editing ? "disabled" : ""}>
              ${(editing ? [editingTx] : available).map((tx) => `<option value="${tx.id}" ${tx.id === selectedTx.id ? "selected" : ""}>${formatDate(tx.chainTime)} · ${typeMap[transactionDirection(tx)]} ${money(tx.amount)} · ${transactionWalletText(tx)}</option>`).join("")}
            </select>
          </label>
          ${renderAnnotationTxSummary(selectedTx)}
          <label>分类<select name="category" required>${renderCategoryOptions(categories, editing?.category || "")}</select></label>
          <div class="proof-field">
            <span>凭证上传 <em class="optional-mark">选填</em></span>
            <div class="proof-upload" data-proof-upload tabindex="0">
              <input id="proofFile" name="attachmentFile" type="file" accept="image/*">
              <label class="btn" for="proofFile">上传图片</label>
              <span class="proof-upload-hint">或点击此处后粘贴截图</span>
              <div class="proof-preview" data-proof-preview hidden>
                <img data-proof-image alt="凭证预览">
                <span data-proof-name></span>
              </div>
            </div>
          </div>
          <label>备注用途<textarea name="note" required placeholder="客户信息、业务说明等">${editing?.note || ""}</textarea></label>
          ${editing?.rejectionReason ? `<div class="notice danger">上次驳回原因：${editing.rejectionReason}</div>` : ""}
          <div class="actions"><button class="btn primary" type="submit">${editing ? "重新提交审核" : "提交批注审核"}</button>${editing ? `<button class="btn" type="button" data-cancel-edit>取消</button>` : ""}</div>
        </form>` : `<div class="empty">当前没有待批注的链上流水。被驳回的记录可在“流水账目”中修改后重新提交。</div>`}
      </section>
    `;
  }

  function renderReview() {
    const pending = state.annotations.filter((annotation) => annotation.tenantId === visibleTenantId() && annotation.status === "pending");
    const pendingReceivables = tenantReceivables().filter((item) => item.reviewStatus === "pending");
    const pendingSettlements = tenantSettlements().filter((settlement) => settlement.status === "pending");
    const showActions = canReview() && tenantBusinessActive();
    return `
      ${pageHead("审核中心", canReview() ? "审核批注、往来款和平账申请，确认业务说明、凭证和链上金额是否一致" : "查看当前系统待审核事项，便于排查和跟进")}
      ${renderTenantBusinessLockNotice()}
      ${canViewReviewCenter() ? `
        <section class="review-section review-section-annotation" data-review-section="annotations"><div class="section-label"><h3>批注待审核</h3><span>${pending.length} 条</span></div>${renderReviewCards(pending, showActions)}</section>
        <section class="review-section review-section-receivable" data-review-section="receivables"><div class="section-label"><h3>往来款待审核</h3><span>${pendingReceivables.length} 条</span></div>${renderReceivableReviewCards(pendingReceivables, showActions)}</section>
        <section class="review-section review-section-settlement" data-review-section="settlements"><div class="section-label"><h3>平账待审核</h3><span>${pendingSettlements.length} 条</span></div>${renderSettlementReviewCards(pendingSettlements, showActions)}</section>
      ` : `<div class="panel empty">当前账号没有审核权限</div>`}
    `;
  }

  function renderReviewCards(rows, showReviewActions = false) {
    if (!rows.length) return `<div class="panel empty slim">暂无待审核批注</div>`;
    return `<div class="review-cards">${rows.map((annotation) => {
      const tx = state.chainTransactions.find((item) => item.id === annotation.chainTxId);
      const direction = transactionDirection(tx);
      const reviewKind = annotation.correctionType === "correction" ? "修正审核" : annotation.correctionType === "reversal" ? "冲正审核" : "批注审核";
      return `<article class="review-card review-card-annotation review-${direction} ${annotation.correctionType ? `review-${annotation.correctionType}` : ""}">
        <div class="review-card-head"><strong><span class="review-kind review-kind-annotation">${reviewKind}</span>${directionPill(direction)} <span class="amount-${direction}">${money(tx.amount)} USDT</span></strong><span class="review-status-group">${badge(statusMap, "pending")}</span></div>
        <dl>
          <div><dt>链上时间</dt><dd>${formatDate(tx.chainTime)}</dd></div>
          <div><dt>钱包</dt><dd><span class="review-meta-tag wallet">${escapeHtml(transactionWalletText(tx))}</span></dd></div>
          <div><dt>对方地址</dt><dd class="mono">${tx.counterparty || "-"}</dd></div>
          <div><dt>批注人</dt><dd><span class="review-meta-tag annotator">${escapeHtml(userName(annotation.annotatedBy))}</span></dd></div>
          <div><dt>业务说明</dt><dd>${annotation.category} · ${annotation.note}</dd></div>
          ${annotation.rejectionReason ? `<div class="wide"><dt>驳回原因</dt><dd><div class="inline-alert danger">${escapeHtml(annotation.rejectionReason)}</div></dd></div>` : ""}
          <div><dt>凭证</dt><dd>${annotation.attachmentName ? `<button class="attachment-link" data-attachment="${annotation.id}">${annotation.attachmentName}</button>` : "无凭证"}</dd></div>
          <div><dt>版本</dt><dd>第 ${annotation.version} 版${annotation.correctionType === "correction" ? "（修正）" : annotation.correctionType === "reversal" ? "（冲正）" : ""}</dd></div>
        </dl>
        <div class="actions">${showReviewActions ? `<button class="btn success" data-review-approve="${annotation.id}">审核通过</button><button class="btn danger" data-review-reject="${annotation.id}">驳回</button>` : ""}<button class="btn" data-detail="${tx.id}">历史</button></div>
      </article>`;
    }).join("")}</div>`;
  }

  function renderReceivableReviewCards(rows, showReviewActions = false) {
    if (!rows.length) return `<div class="panel empty slim">暂无待审核往来款</div>`;
    return `<div class="review-cards">${rows.map((item) => `<article class="review-card review-card-receivable review-${item.type === "receivable" ? "income" : "expense"}">
      <div class="review-card-head"><strong><span class="review-kind review-kind-receivable">往来款审核</span>${badge({ receivable: ["应收款", "green"], payable: ["应付款", "red"] }, item.type)} <span>${money(item.amount)} USDT</span></strong>${badge(rpReviewMap, item.reviewStatus)}</div>
      <dl>
        <div><dt>目标方</dt><dd>${escapeHtml(item.counterparty)}</dd></div>
        <div><dt>分类</dt><dd>${escapeHtml(item.category)}</dd></div>
        <div><dt>提交人</dt><dd><span class="review-meta-tag annotator">${escapeHtml(userName(item.createdBy))}</span></dd></div>
        <div><dt>提交时间</dt><dd>${formatDate(item.createdAt)}</dd></div>
        <div class="wide"><dt>业务说明</dt><dd>${escapeHtml(item.note)}</dd></div>
        <div><dt>凭证</dt><dd>${item.attachmentName ? `<button class="attachment-link" data-rp-attachment="${item.id}">${escapeHtml(item.attachmentName)}</button>` : "无凭证"}</dd></div>
      </dl>
      <div class="actions">${showReviewActions ? `<button class="btn success" data-rp-review="${item.id}" data-action="approve">审核通过</button><button class="btn danger" data-rp-review="${item.id}" data-action="reject">驳回</button>` : ""}<button class="btn" data-rp-detail="${item.id}">详情</button></div>
    </article>`).join("")}</div>`;
  }

  function renderSettlementReviewCards(rows, showReviewActions = false) {
    if (!rows.length) return `<div class="panel empty slim">暂无待审核平账</div>`;
    return `<div class="review-cards">${rows.map((settlement) => {
      const item = tenantReceivables().find((entry) => entry.id === settlement.itemId);
      const tx = state.chainTransactions.find((entry) => entry.id === settlement.txId);
      if (!item || !tx) return "";
      const direction = transactionDirection(tx);
      const nextSettled = Number(item.settledAmount || 0) + Number(settlement.amount || 0);
      const over = Math.max(nextSettled - Number(item.amount || 0), 0);
      return `<article class="review-card review-card-settlement review-${direction}">
        <div class="review-card-head"><strong><span class="review-kind review-kind-settlement">平账审核</span>${directionPill(direction)} <span class="amount-${direction}">${money(settlement.amount)} USDT</span></strong>${badge(rpSettlementStatusMap, settlement.status)}</div>
        <dl>
          <div><dt>往来款</dt><dd>${rpTypeMap[item.type]} · ${escapeHtml(item.counterparty)}</dd></div>
          <div><dt>原始金额</dt><dd>${money(item.amount)} USDT</dd></div>
          <div><dt>链上时间</dt><dd>${formatDate(tx.chainTime)}</dd></div>
          <div><dt>钱包</dt><dd><span class="review-meta-tag wallet">${escapeHtml(transactionWalletText(tx))}</span></dd></div>
          <div><dt>提交人</dt><dd><span class="review-meta-tag annotator">${escapeHtml(userName(settlement.submittedBy))}</span></dd></div>
          <div><dt>平账结果</dt><dd>${over > 0 ? `${item.type === "receivable" ? "多收" : "多付"} ${money(over)} USDT` : "不超额"}</dd></div>
          <div class="wide"><dt>交易哈希</dt><dd>${renderCopyHash(tx.hash)}</dd></div>
        </dl>
        <div class="actions">${showReviewActions ? `<button class="btn success" data-rps-review="${settlement.id}" data-action="approve">审核通过</button><button class="btn danger" data-rps-review="${settlement.id}" data-action="reject">驳回</button>` : ""}<button class="btn" data-rp-detail="${item.id}">详情</button></div>
      </article>`;
    }).join("")}</div>`;
  }

  function renderReceivables() {
    const items = filteredReceivables();
    const stats = summarizeReceivables(items);
    const canCreate = ["employee", "supervisor"].includes(currentUser().role) && tenantBusinessActive();
    return `
      ${pageHead("往来款管理", "管理应收款和应付款；平账从流水账目发起，先选链上流水再选往来款", `<button class="btn primary" data-action="export-receivables">导出 CSV</button>`)}
      ${renderTenantBusinessLockNotice()}
      <section class="stats-grid rp-stats">
        ${renderRpStat("应收总额", stats.receivable.amount, "应收已收", stats.receivable.settled, "未收", stats.receivable.remaining, "多收", stats.receivable.over, "receivable")}
        ${renderRpStat("应付总额", stats.payable.amount, "应付已付", stats.payable.settled, "未付", stats.payable.remaining, "多付", stats.payable.over, "payable")}
      </section>
      <section class="grid two-col receivable-layout">
        ${canCreate ? `<div class="panel">
          <div class="panel-title"><h3>新增往来款</h3><span>员工提交后由主管审核</span></div>
          <form id="receivableForm" class="form-grid one">
            <label>类型<select name="type"><option value="receivable">应收款</option><option value="payable">应付款</option></select></label>
            <label>目标方<input name="counterparty" required placeholder="客户、供应商、合作方"></label>
            <label>金额<input name="amount" type="number" min="0.000001" step="0.000001" required></label>
            <label>分类<input name="category" required placeholder="客户货款、供应商款、保证金等"></label>
            <label><span class="field-label">到期日期 <em class="optional-mark">选填</em></span><input name="dueDate" type="date"></label>
            <label>业务说明<textarea name="note" required placeholder="客户信息、业务说明等"></textarea></label>
            <div class="proof-field">
              <span>凭证上传 <em class="optional-mark">选填</em></span>
              <div class="proof-upload" data-proof-upload tabindex="0">
                <input id="receivableProofFile" name="attachmentFile" type="file" accept="image/*">
                <label class="btn" for="receivableProofFile">上传图片</label>
                <span class="proof-upload-hint">或点击此处后粘贴截图</span>
                <div class="proof-preview" data-proof-preview hidden>
                  <img data-proof-image alt="凭证预览">
                  <span data-proof-name></span>
                </div>
              </div>
            </div>
            <div class="actions"><button class="btn primary" type="submit">提交往来款</button></div>
          </form>
        </div>` : ""}
        <div class="panel ${canCreate ? "" : "wide-panel"}">
          <div class="panel-title"><h3>往来款列表</h3><span>在流水账目中选择链上流水后提交平账</span></div>
          ${renderReceivableFilters()}
          ${renderReceivableTable(items)}
        </div>
      </section>
    `;
  }

  function filteredReceivables() {
    return tenantReceivables().filter((item) => {
      if (receivableFilters.type && item.type !== receivableFilters.type) return false;
      if (receivableFilters.status && item.status !== receivableFilters.status) return false;
      if (receivableFilters.reviewStatus && item.reviewStatus !== receivableFilters.reviewStatus) return false;
      if (receivableFilters.counterparty && !String(item.counterparty || "").includes(receivableFilters.counterparty)) return false;
      if (receivableFilters.keyword) {
        const text = `${item.counterparty || ""} ${item.category || ""} ${item.note || ""} ${userName(item.createdBy)}`;
        if (!text.includes(receivableFilters.keyword)) return false;
      }
      return true;
    }).sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  }

  function renderReceivableFilters() {
    return `<form id="receivableFilters" class="filters compact-filters">
      <label>类型<select name="type"><option value="">全部</option><option value="receivable" ${selectedReceivableFilter("type", "receivable")}>应收款</option><option value="payable" ${selectedReceivableFilter("type", "payable")}>应付款</option></select></label>
      <label>平账状态<select name="status"><option value="">全部</option><option value="open" ${selectedReceivableFilter("status", "open")}>未平账</option><option value="partial" ${selectedReceivableFilter("status", "partial")}>部分平账</option><option value="settled" ${selectedReceivableFilter("status", "settled")}>已平账</option><option value="voided" ${selectedReceivableFilter("status", "voided")}>已作废</option></select></label>
      <label>审核状态<select name="reviewStatus"><option value="">全部</option><option value="pending" ${selectedReceivableFilter("reviewStatus", "pending")}>待审核</option><option value="approved" ${selectedReceivableFilter("reviewStatus", "approved")}>已审核</option><option value="rejected" ${selectedReceivableFilter("reviewStatus", "rejected")}>已驳回</option></select></label>
      <label>目标方<input name="counterparty" value="${escapeHtml(receivableFilters.counterparty || "")}" placeholder="客户、供应商"></label>
      <label>关键词<input name="keyword" value="${escapeHtml(receivableFilters.keyword || "")}" placeholder="分类、说明、创建人"></label>
      <div class="actions"><button class="btn primary" type="submit">查询</button><button class="btn" type="reset">清空</button></div>
    </form>`;
  }

  function selectedReceivableFilter(key, value) {
    return receivableFilters[key] === value ? "selected" : "";
  }

  function summarizeReceivables(items) {
    return items.filter((item) => item.reviewStatus === "approved" && item.status !== "voided").reduce((acc, item) => {
      const key = item.type;
      acc[key].amount += Number(item.amount || 0);
      acc[key].settled += Number(item.settledAmount || 0);
      acc[key].remaining += Number(item.remainingAmount || 0);
      acc[key].over += Number(item.overAmount || 0);
      return acc;
    }, {
      receivable: { amount: 0, settled: 0, remaining: 0, over: 0 },
      payable: { amount: 0, settled: 0, remaining: 0, over: 0 },
    });
  }

  function renderRpStat(title, amount, settledLabel, settled, remainingLabel, remaining, overLabel, over, tone = "") {
    return `<div class="stat-card rp-stat-card ${tone}">
      <span>${title}</span><strong>${money(amount)}</strong><small>USDT</small>
      <div class="stat-breakdown"><span>${settledLabel}：${money(settled)}</span><span>${remainingLabel}：${money(remaining)}</span><span>${overLabel}：${money(over)}</span></div>
    </div>`;
  }

  function renderReceivableTable(items) {
    const rows = items.map((item) => {
      const overText = Number(item.overAmount || 0) > 0 ? `<span class="${item.type === "receivable" ? "amount-income" : "amount-expense"}">${item.type === "receivable" ? "多收" : "多付"} ${money(item.overAmount)}</span>` : "-";
      return `<tr>
        <td>${formatDate(item.createdAt)}<br><span class="muted">${escapeHtml(userName(item.createdBy))}</span></td>
        <td>${badge({ receivable: ["应收款", "green"], payable: ["应付款", "red"] }, item.type)}</td>
        <td><strong>${escapeHtml(item.counterparty)}</strong><br><span class="muted">${escapeHtml(item.category)}</span>${item.attachmentName ? `<br><button class="attachment-link" data-rp-attachment="${item.id}">${escapeHtml(item.attachmentName)}</button>` : ""}</td>
        <td>${money(item.amount)}</td>
        <td>${money(item.settledAmount || 0)}</td>
        <td>${money(item.remainingAmount || 0)}</td>
        <td>${overText}</td>
        <td>${badge(rpStatusMap, item.status)}<br>${badge(rpReviewMap, item.reviewStatus)}</td>
        <td>${receivableActions(item)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="receivable-table">
      <thead><tr><th>创建</th><th>类型</th><th>目标方/分类</th><th>金额</th><th>已平</th><th>剩余</th><th>差额</th><th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="empty slim">暂无往来款</td></tr>`}</tbody>
    </table></div>`;
  }

  function receivableActions(item) {
    const actions = [`<button class="btn" data-rp-detail="${item.id}">详情</button>`];
    const businessActive = tenantBusinessActive();
    if (businessActive && canReview() && item.reviewStatus === "pending") {
      actions.push(`<button class="btn success" data-rp-review="${item.id}" data-action="approve">通过</button>`);
      actions.push(`<button class="btn danger" data-rp-review="${item.id}" data-action="reject">驳回</button>`);
    }
    if (businessActive && canReview() && !approvedSettlementsForReceivable(item.id).length && item.status !== "voided") {
      actions.push(`<button class="btn warn" data-rp-void="${item.id}">作废</button>`);
    }
    return actions.join("");
  }

  function approvedSettlementsForReceivable(itemId) {
    return tenantSettlements().filter((settlement) => settlement.itemId === itemId && settlement.status === "approved");
  }

  function renderWallets() {
    const walletList = `<div class="panel wallet-list-panel"><div class="panel-title"><h3>钱包列表</h3></div>${renderWalletBalanceTable()}</div>`;
    const walletStatusNotice = renderWalletStatusNotice();
    const businessActive = tenantBusinessActive();
    const syncAction = canViewReviewCenter() && businessActive ? `<button class="btn primary" data-action="sync-chain">立即同步</button>` : "";
    if (!canReview()) {
      return `${pageHead("钱包管理", "查看本系统钱包、链上余额和同步状态，历史流水会永久保留", syncAction)}${renderTenantBusinessLockNotice()}${walletStatusNotice}${walletList}`;
    }
    const createWalletPanel = businessActive ? `<div class="panel wallet-create-panel">
      <div class="panel-title"><h3>新增钱包</h3></div>
      <form id="walletForm" class="form-grid one">
        <label>钱包别名<input name="alias" required></label>
        <label>链类型<select name="chain"><option>TRC20</option></select></label>
        <label>钱包地址<input name="address" required placeholder="T..."></label>
        <label>纳入管理范围
          <select name="managedPreset" data-managed-preset>
            <option value="today">从今天开始</option>
            <option value="7">最近 7 天</option>
            <option value="30">最近 30 天</option>
            <option value="custom">自定义时间（30 天内）</option>
          </select>
        </label>
        <label>纳入管理起始时间<input name="managedFrom" type="datetime-local" value="${managedFromPreset("today")}" min="${managedFromPreset("30")}" max="${managedFromMax()}" required readonly data-managed-from></label>
        <p class="form-hint">纳入管理时间用于划定需要处理的链上流水范围：起始时间之后的流水会进入待批注，起始时间之前的历史流水默认只可查询，不要求补批注。</p>
        <div class="actions"><button class="btn primary" type="submit">新增钱包</button></div>
      </form>
    </div>` : `<div class="panel wallet-create-panel"><div class="panel-title"><h3>新增钱包</h3></div><div class="empty slim">租用有效后才可以新增或启用钱包。</div></div>`;
    return `
      ${pageHead("钱包管理", "维护本系统钱包、链上余额和同步状态，停用钱包不会影响历史流水", syncAction)}
      ${renderTenantBusinessLockNotice()}
      ${walletStatusNotice}
      <section class="grid two-col">
        ${createWalletPanel}
        ${walletList}
      </section>
    `;
  }

  function renderWalletStatusNotice() {
    const limitInfo = walletLimitInfo();
    return renderChainStatusNotice(limitInfo.text, { warning: limitInfo.reached });
  }

  function walletLimitInfo() {
    const limit = Number(state.systemSettings?.walletEnabledLimit || 0);
    if (!limit) return { text: "", reached: false };
    const enabledCount = tenantWallets().filter((wallet) => wallet.enabled).length;
    const limitReached = enabledCount >= limit;
    return { text: ` · 已启用 ${enabledCount}/${limit} 个${limitReached ? " · 已达上限" : ""}`, reached: limitReached };
  }

  function renderChain() {
    return `
      ${pageHead("链上查询", "手动查询交易哈希或钱包地址，核查单笔链上记录")}
      <section class="panel">
        <form id="chainSearchForm" class="form-grid one">
          <label>交易哈希或钱包地址<input name="query" required placeholder="输入 TxHash 或 T 开头地址"></label>
          <div class="actions"><button class="btn primary" type="submit">查询链上记录</button></div>
        </form>
        <div id="manualResult"></div>
      </section>
    `;
  }

  function renderChainStatusNotice(extraText = "", { warning = false } = {}) {
    const chainStatus = state.chainStatus;
    if (!chainStatus) return "";
    return chainStatus.configured
      ? `<div class="notice ${warning ? "chain-status-off" : "chain-status-ok"}">钱包链上同步已启用 · ${chainStatus.walletCount} 个钱包${latestChainSyncText(chainStatus)}${chainSchedulerText(chainStatus.scheduler)}${extraText}</div>`
      : `<div class="notice chain-status-off">钱包链上同步未启用：${chainStatus.reason || "未配置 TRON_API_KEY"}。配置后可自动同步钱包流水。</div>`;
  }

  function latestChainSyncText(chainStatus) {
    const latest = (chainStatus.wallets || []).map((wallet) => wallet.lastSyncedAt).filter(Boolean).sort().at(-1);
    return latest ? ` · 最近同步 ${formatDate(latest)}` : " · 尚未完成首次同步";
  }

  function chainSchedulerText(scheduler) {
    if (!scheduler?.enabled) return " · 自动同步未启用";
    if (scheduler.running) return ` · 正在自动同步（每 ${scheduler.intervalMinutes} 分钟）`;
    return ` · 每 ${scheduler.intervalMinutes} 分钟自动同步${scheduler.lastError ? ` · 最近异常：${scheduler.lastError}` : ""}`;
  }

  function renderUsers() {
    const role = currentUser().role;
    const canCreate = role === "supervisor";
    const desc = role === "admin"
      ? "开通和管理租户，维护主管账号、登录密码和登录密钥"
      : "主管可创建员工或主管账号，并设置员工是否可查看全部账目";
    if (role === "admin") {
      return `
        ${pageHead("账号管理", desc)}
        <section class="grid two-col">
          <div class="panel"><div class="panel-title"><h3>开通独立系统</h3></div>
            <form id="tenantForm" class="form-grid one">
              <label>系统名称<input name="name" required></label>
              <label>首位主管姓名<input name="supervisorName" required></label>
              <label>主管登录账号<input name="supervisorLoginName" autocomplete="off" required placeholder="3-32 位字母、数字或 _ . @ -"></label>
              <label>主管初始密码<input name="supervisorPassword" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 位"></label>
              <div class="actions"><button class="btn primary" type="submit">开通系统</button></div>
            </form>
          </div>
          <div class="panel">
            <div class="panel-title"><h3>账号筛选</h3><span>默认只看启用中的系统里的主管账号</span></div>
            ${renderAccountFilters()}
          </div>
        </section>
        <section class="panel">
          <div class="panel-title"><h3>租户管理</h3><span>查看各系统状态、主管、钱包和流水规模</span></div>
          ${renderTenantManagement()}
        </section>
        <section class="panel">${renderUserTable()}</section>
      `;
    }
    return `
      ${pageHead("账号管理", desc)}
      ${canCreate ? `<section class="user-management-layout">
        <div class="panel user-create-panel"><div class="panel-title"><h3>新增账号</h3></div>
          <form id="userForm" class="form-grid one compact-form">
            <label>姓名<input name="name" required></label>
            <label>角色<select name="role"><option value="employee">员工</option><option value="supervisor">主管</option></select></label>
            <label>登录账号<input name="loginName" autocomplete="off" required placeholder="3-32 位字母、数字或 _ . @ -"></label>
            <label>初始密码<input name="password" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 位"></label>
            <label class="checkline"><input name="canViewAll" type="checkbox" checked> 查看全部账目(取消勾选则只可以查看员工自己提交的账目)</label>
            <div class="actions"><button class="btn primary" type="submit">创建账号</button></div>
          </form>
        </div><div class="panel">${renderUserTable()}</div>
      </section>` : `<div class="panel">${renderUserTable()}</div>`}
    `;
  }

  function renderUserTable() {
    const isAdmin = currentUser().role === "admin";
    const users = isAdmin ? filteredAdminUsers() : tenantUsers();
    const tenantColumn = isAdmin ? "<th>所属系统</th>" : "";
    const rows = users.map((user) => {
      const canEditPermission = user.role === "employee" && (isAdmin || currentUser().role === "supervisor");
      const operations = `
        <td><div class="row-actions">
          ${canEditPermission ? `<label class="checkline compact"><input type="checkbox" data-user-view-all="${user.id}" ${user.canViewAll ? "checked" : ""}> 允许查看全部</label>` : ""}
          <button class="btn small" data-reset-password="${user.id}">重置密码</button>
          <button class="btn small" data-reset-totp="${user.id}">重置登录密钥</button>
        </div></td>`;
      return `<tr>
        <td>${escapeHtml(user.name)}</td>
        <td>${escapeHtml(user.loginName || user.id || "-")}</td>
        ${isAdmin ? `<td>${escapeHtml(user.tenantId ? tenantName(user.tenantId) : "平台")}</td>` : ""}
        <td>${roleLabel(user.role)}</td>
        <td>${user.totpEnabled ? "已绑定" : "未绑定"}</td>
        <td>${user.role === "employee" ? (user.canViewAll ? "是" : "否") : "-"}</td>
        ${operations}
      </tr>`;
    }).join("");
    return `<div class="panel-title"><h3>账号列表</h3></div><div class="table-wrap user-table-wrap"><table class="user-table">
      <thead><tr><th>姓名</th><th>登录账号</th>${tenantColumn}<th>角色</th><th>登录密钥</th><th>查看全部账目</th><th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="${isAdmin ? 7 : 6}" class="empty">暂无账号</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderProfile() {
    const user = currentUser();
    return `
      ${pageHead("我的账号", "查看自己的登录信息，修改密码或重新绑定登录密钥")}
      <section class="grid two-col">
        <div class="panel">
          <div class="panel-title"><h3>账号信息</h3></div>
          <div class="metric-list">
            <div><span>姓名</span><strong>${escapeHtml(user.name)}</strong></div>
            <div><span>登录账号</span><strong>${escapeHtml(user.loginName || user.id || "-")}</strong></div>
            <div><span>角色</span><strong>${roleLabel(user.role)}</strong></div>
            <div><span>所属系统</span><strong>${escapeHtml(user.tenantId ? tenantName(user.tenantId) : "平台")}</strong></div>
            <div><span>登录密钥</span><strong>${user.totpEnabled ? "已绑定" : "未绑定"}</strong></div>
          </div>
        </div>
        <div class="panel profile-security-panel">
          <div class="panel-title"><h3>安全设置</h3></div>
          <p class="profile-security-note">修改后旧密码或旧验证码立即失效。</p>
          <div class="actions profile-actions">
            <button class="btn primary" data-reset-password="${user.id}">修改我的密码</button>
            <button class="btn" data-reset-totp="${user.id}">重置我的登录密钥</button>
          </div>
          <p class="profile-security-hint">重置登录密钥后，请立即把新密钥保存到验证器；下次登录需要使用新的 6 位动态验证码。</p>
        </div>
      </section>
    `;
  }

  function renderAccountFilters() {
    normalizeAccountFilters();
    const roleOptions = accountFilters.tenantStatus === "platform"
      ? [["admin", "管理员"]]
      : accountFilters.tenantStatus === "all"
        ? [["all", "全部角色"], ["admin", "管理员"], ["supervisor", "主管"], ["employee", "员工"]]
        : [["supervisor", "主管"], ["employee", "员工"], ["all", "全部角色"]];
    return `<form id="accountFilters" class="form-grid one compact-form">
      <label>账号范围<select name="tenantStatus">
        <option value="enabled" ${accountFilters.tenantStatus === "enabled" ? "selected" : ""}>启用中的系统</option>
        <option value="disabled" ${accountFilters.tenantStatus === "disabled" ? "selected" : ""}>已停用的系统</option>
        <option value="all" ${accountFilters.tenantStatus === "all" ? "selected" : ""}>全部账号</option>
        <option value="platform" ${accountFilters.tenantStatus === "platform" ? "selected" : ""}>平台账号</option>
      </select></label>
      <label>账号角色<select name="role">
        ${roleOptions.map(([value, label]) => `<option value="${value}" ${accountFilters.role === value ? "selected" : ""}>${label}</option>`).join("")}
      </select></label>
      <label>关键词<input name="keyword" value="${escapeHtml(accountFilters.keyword || "")}" placeholder="姓名、登录账号、系统"></label>
      <div class="actions"><button class="btn primary" type="submit">查询</button><button class="btn" type="reset">重置</button></div>
    </form>`;
  }

  function normalizeAccountFilters(next = accountFilters) {
    const normalized = { ...defaultAccountFilters(), ...next };
    if (normalized.tenantStatus === "platform") normalized.role = "admin";
    if (["enabled", "disabled"].includes(normalized.tenantStatus) && normalized.role === "admin") normalized.role = "supervisor";
    accountFilters = normalized;
    return normalized;
  }

  function filteredAdminUsers() {
    normalizeAccountFilters();
    const keyword = String(accountFilters.keyword || "").trim();
    return state.users.filter((user) => {
      const tenant = user.tenantId ? state.tenants.find((item) => item.id === user.tenantId) : null;
      if (accountFilters.role && accountFilters.role !== "all" && user.role !== accountFilters.role) return false;
      if (accountFilters.tenantStatus === "platform" && user.tenantId) return false;
      if (accountFilters.tenantStatus === "enabled" && (!tenant || tenant.enabled === false)) return false;
      if (accountFilters.tenantStatus === "disabled" && (!tenant || tenant.enabled !== false)) return false;
      if (keyword) {
        const text = `${user.name || ""} ${user.loginName || ""} ${tenant?.name || "平台"}`;
        if (!text.includes(keyword)) return false;
      }
      return true;
    }).sort((left, right) => {
      const leftTenant = left.tenantId ? tenantName(left.tenantId) : "平台";
      const rightTenant = right.tenantId ? tenantName(right.tenantId) : "平台";
      return leftTenant.localeCompare(rightTenant, "zh-CN") || roleLabel(left.role).localeCompare(roleLabel(right.role), "zh-CN") || String(left.name).localeCompare(String(right.name), "zh-CN");
    });
  }

  function renderSubscription() {
    const settings = state.subscriptionSettings || {};
    if (currentUser().role === "supervisor") {
      const tenant = currentTenant();
      return `
        ${pageHead("租用续费", "查看租用状态，付款后提交交易哈希完成自动续费")}
        <section class="grid two-col subscription-overview">
          <div class="panel">
            <div class="panel-title"><h3>当前租用状态</h3>${subscriptionStatusBadge(tenant)}</div>
            <div class="subscription-status-card">
              <div>
                <span>到期时间</span>
                <strong>${formatDate(tenant.subscriptionExpiresAt)}</strong>
                <em>${subscriptionStatusText(tenant)}</em>
              </div>
              <div>
                <span>系统名称</span>
                <strong>${escapeHtml(tenant.name)}</strong>
                <em>${tenant.enabled ? "系统启用中" : "系统已停用"}</em>
              </div>
              <div>
                <span>月租费用</span>
                <strong>${money(settings.monthlyFee)} USDT</strong>
                <em>${settings.enabled ? "支持提交交易哈希续费" : "暂未启用哈希续费"}</em>
              </div>
            </div>
          </div>
          <div class="panel">
            <div class="panel-title"><h3>提交续费哈希</h3><span>同一交易哈希只能提交一次</span></div>
            <div class="metric-list">
              <div><span>平台收款钱包</span><strong class="mono">${escapeHtml(settings.platformWalletAddress || "管理员暂未配置")}</strong></div>
              <div><span>哈希续费</span><strong>${settings.enabled ? "已启用" : "未启用"}</strong></div>
            </div>
            <form id="subscriptionHashForm" class="form-grid one">
              <label>交易哈希<input name="hash" required placeholder="64 位交易哈希"></label>
              <div class="actions"><button class="btn primary" type="submit">提交哈希续费</button></div>
            </form>
            <p class="muted">系统会校验该哈希是否转入平台收款钱包、链上确认状态和是否重复提交，处理结果以页面提示为准。</p>
          </div>
        </section>
        <section class="panel">
          <div class="panel-title"><h3>续费提交记录</h3><span>仅显示本系统记录</span></div>
          ${renderSupervisorSubscriptionHistory()}
        </section>
      `;
    }
    if (currentUser().role !== "admin") return `<div class="panel empty">只有管理员或主管可以进入租用管理</div>`;
    return `
      ${pageHead("租用管理", "配置月租费用和平台收款钱包，处理租户提交的交易哈希和异常续费")}
      <section class="grid two-col">
        <div class="panel">
          <div class="panel-title"><h3>收费设置</h3><span>平台收款钱包用于租户续费，不计入租户业务流水</span></div>
          <form id="subscriptionSettingsForm" class="form-grid one">
            <label>月租费用（USDT）<input name="monthlyFee" type="number" min="0.000001" step="0.000001" value="${escapeHtml(settings.monthlyFee || 100)}" required></label>
            <label><span class="field-label">平台收款钱包地址 <em class="optional-mark">启用自动续费时填写</em></span><input name="platformWalletAddress" value="${escapeHtml(settings.platformWalletAddress || "")}" placeholder="T..."></label>
            <label class="checkline"><input name="enabled" type="checkbox" ${settings.enabled ? "checked" : ""}> 启用交易哈希自动续费</label>
            <p class="form-hint">勾选后，主管付款后可提交交易哈希，系统校验到账并自动续租；未勾选时只能由管理员手工处理。</p>
            <label class="checkline"><input name="autoDisable" type="checkbox" ${settings.autoDisable !== false ? "checked" : ""}> 到期后自动停用系统</label>
            <div class="actions"><button class="btn primary" type="submit">保存设置</button></div>
          </form>
        </div>
        <div class="panel">
          <div class="panel-title"><h3>识别规则</h3></div>
          <div class="metric-list">
            <div><span>租户识别</span><strong>主管提交交易哈希</strong></div>
            <div><span>防重复</span><strong>同一交易哈希只能处理一次</strong></div>
            <div><span>异常处理</span><strong>未通过自动校验的付款进入平台收入列表处理</strong></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>租户租用状态</h3><span>可对体外收费或异常付款直接手工续费</span></div>
        ${renderSubscriptionTenants()}
      </section>
      <section class="panel">
        <div class="panel-title"><h3>平台收入列表</h3><span>查看租户提交哈希后的付款处理结果</span></div>
        ${renderPlatformPayments()}
      </section>
    `;
  }

  function renderSubscriptionTenants() {
    const rows = state.tenants.map((tenant) => `<tr>
      <td><strong>${escapeHtml(tenant.name)}</strong></td>
      <td>${formatDate(tenant.subscriptionExpiresAt)}</td>
      <td>${tenant.enabled ? badge({ on: ["启用", "green"] }, "on") : badge({ off: ["停用", "red"] }, "off")}</td>
      <td>${subscriptionStatusText(tenant)}</td>
      <td>${tenant.lastPaymentTxHash ? renderCopyHash(tenant.lastPaymentTxHash, { short: true }) : "-"}</td>
      <td><button class="btn small primary" data-tenant-manual-renew="${tenant.id}">手工续费</button></td>
    </tr>`).join("");
    return `<div class="table-wrap"><table>
      <thead><tr><th>系统</th><th>到期时间</th><th>系统状态</th><th>租用状态</th><th>最近付款</th><th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty slim">暂无租户</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderPlatformPayments() {
    const payments = (state.platformPayments || []).slice().sort((left, right) => new Date(right.chainTime) - new Date(left.chainTime));
    const rows = payments.map((payment) => {
      const canManual = !["applied", "manual_applied", "offline_applied"].includes(payment.status);
      return `<tr>
        <td>${formatDate(payment.chainTime)}</td>
        <td class="amount-income">${money(payment.amount)}</td>
        <td>${badge(platformPaymentStatusMap(), payment.status)}</td>
        <td>${escapeHtml(tenantName(payment.tenantId))}</td>
        <td>${renderCopyHash(payment.hash, { short: true })}</td>
        <td>${escapeHtml(payment.reason || payment.memo || "-")}</td>
        <td>${canManual ? `<button class="btn small primary" data-manual-renew="${payment.id}">手工续费</button>` : subscriptionDurationText(payment)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table>
      <thead><tr><th>链上时间</th><th>金额</th><th>状态</th><th>租户</th><th>交易哈希</th><th>说明</th><th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="7" class="empty slim">暂无平台收入记录</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderSupervisorSubscriptionHistory() {
    const payments = (state.platformPayments || []).slice().sort((left, right) => {
      const leftTime = left.chainTime || left.createdAt || "";
      const rightTime = right.chainTime || right.createdAt || "";
      return new Date(rightTime) - new Date(leftTime);
    });
    const rows = payments.map((payment) => `<tr>
      <td>${formatDate(payment.chainTime || payment.createdAt)}</td>
      <td class="amount-income">${money(payment.amount)}</td>
      <td>${badge(platformPaymentStatusMap(), payment.status)}</td>
      <td>${renderCopyHash(payment.hash, { short: true })}</td>
      <td>${subscriptionDurationText(payment)}</td>
      <td>${escapeHtml(payment.reason || "-")}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="subscription-history-table">
      <thead><tr><th>提交/链上时间</th><th>金额</th><th>处理状态</th><th>交易哈希</th><th>续费时长</th><th>说明</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6" class="empty slim">暂无续费提交记录</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderAdmin() {
    if (currentUser().role !== "admin") return `<div class="panel empty">只有管理员可以进入系统管理</div>`;
    return `
      ${pageHead("系统管理", "维护系统级限制和统一收支分类")}
      <section class="grid two-col">
        <div class="panel"><div class="panel-title"><h3>钱包启用限制</h3><span>按每个系统单独计算</span></div>
          <form id="systemSettingsForm" class="form-grid one">
            <label>每个系统最多启用钱包数<input name="walletEnabledLimit" type="number" min="0" step="1" value="${escapeHtml(state.systemSettings?.walletEnabledLimit ?? 0)}" required></label>
            <p class="form-hint">填 0 表示不限制；达到限制后，主管不能新增启用钱包，也不能把停用钱包重新启用。</p>
            <div class="actions"><button class="btn primary" type="submit">保存限制</button></div>
          </form>
        </div>
        <div class="panel">
          <div class="panel-title"><h3>管理入口</h3></div>
          <div class="metric-list">
            <div><span>开通系统和租户状态</span><strong>账号管理</strong></div>
            <div><span>租用收费和续费</span><strong>租用管理</strong></div>
            <div><span>服务器性能和备份</span><strong>服务器管理</strong></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>新增统一分类</h3></div>
        <form id="categoryForm" class="form-grid">
          <label>收支类型<select name="type"><option value="income">进账</option><option value="expense">出账</option></select></label>
          <label>分类名称<input name="name" required></label>
          <div class="actions"><button class="btn primary" type="submit">新增分类</button></div>
        </form>
      </section>
      <section class="panel">
        <div class="panel-title"><h3>统一分类列表</h3><span>修改只影响后续批注可选项，历史已审核记录保持原分类</span></div>
        <div class="grid two-col">
          ${renderCategoryList("income", "进账分类")}
          ${renderCategoryList("expense", "出账分类")}
        </div>
      </section>
    `;
  }

  function renderTenantManagement() {
    const rows = state.tenants.map((tenant) => {
      const users = state.users.filter((item) => item.tenantId === tenant.id);
      const wallets = state.wallets.filter((item) => item.tenantId === tenant.id);
      const transactions = state.chainTransactions.filter((item) => item.tenantId === tenant.id);
      const annotations = state.annotations.filter((item) => item.tenantId === tenant.id);
      const supervisors = users.filter((item) => item.role === "supervisor").map((item) => item.name).join("、") || "-";
      return `<tr>
        <td><strong>${escapeHtml(tenant.name)}</strong></td>
        <td>${badge({ enabled: ["启用", "green"], disabled: ["停用", "red"] }, tenant.enabled ? "enabled" : "disabled")}</td>
        <td>${formatDate(tenant.subscriptionExpiresAt)}</td>
        <td>${escapeHtml(supervisors)}</td>
        <td>${users.filter((item) => item.role === "employee").length}</td>
        <td>${wallets.length} / 启用 ${wallets.filter((item) => item.enabled).length}</td>
        <td>${transactions.length}</td>
        <td>${annotations.length}</td>
        <td>${formatDate(tenant.createdAt)}</td>
        <td>
          <button class="btn small ${tenant.enabled ? "danger" : "primary"}" data-tenant-status="${tenant.id}" data-enabled="${tenant.enabled ? "false" : "true"}">
            ${tenant.enabled ? "停用" : "启用"}
          </button>
        </td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table>
      <thead><tr><th>系统</th><th>状态</th><th>到期时间</th><th>主管</th><th>员工数</th><th>钱包</th><th>链上流水</th><th>批注</th><th>创建时间</th><th>操作</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="10" class="empty slim">暂无独立系统</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderCategoryList(type, title) {
    const categories = state.categories[type] || [];
    return `<div class="category-box">
      <h4>${title}</h4>
      <div class="category-list">
        ${categories.map((category) => `<div class="category-row"><span>${escapeHtml(category)}</span><button class="btn small" data-edit-category="${escapeHtml(type)}" data-category-name="${escapeHtml(category)}">重命名</button></div>`).join("") || `<div class="empty slim">暂无分类</div>`}
      </div>
    </div>`;
  }

  function renderServer() {
    if (currentUser().role !== "admin") return `<div class="panel empty">只有管理员可以进入服务器管理</div>`;
    if (!serverMetrics) {
      return `
        ${pageHead("服务器管理", "实时查看服务器资源、附件空间和系统数据量", `<button class="btn primary" data-action="refresh-server">刷新</button>`)}
        <div class="panel empty">正在读取服务器状态...</div>
      `;
    }
    const memoryPercent = percent(serverMetrics.memory.usedBytes, serverMetrics.memory.totalBytes);
    const diskPercent = percent(serverMetrics.disk.usedBytes, serverMetrics.disk.totalBytes);
    return `
      ${pageHead("服务器管理", "实时查看服务器资源、服务健康、数据库、附件空间和安全异常", `<button class="btn primary" data-action="refresh-server">刷新</button>`)}
      <section class="grid server-stats">
        ${metricCard("CPU 使用率", `${serverMetrics.cpu.usagePercent.toFixed(1)}%`, `${serverMetrics.cpu.cores} 核 · ${serverMetrics.cpu.model || "未知型号"}`, serverMetrics.cpu.usagePercent)}
        ${metricCard("内存使用", `${memoryPercent.toFixed(1)}%`, `${formatBytes(serverMetrics.memory.usedBytes)} / ${formatBytes(serverMetrics.memory.totalBytes)}`, memoryPercent)}
        ${metricCard("磁盘使用", `${diskPercent.toFixed(1)}%`, `${formatBytes(serverMetrics.disk.usedBytes)} / ${formatBytes(serverMetrics.disk.totalBytes)}`, diskPercent)}
        ${metricCard("服务运行", formatDuration(serverMetrics.uptimeSeconds), `${serverMetrics.platform} · ${serverMetrics.node}`, null)}
      </section>
      <section class="grid server-panels">
        <div class="panel">
          <div class="panel-title"><h3>服务健康</h3><span>${formatDate(serverMetrics.capturedAt)}</span></div>
          <div class="metric-list">
            <div><span>TRON 接口</span><strong>${healthText(serverMetrics.service.chainConfigured, "已启用", "未启用")}</strong></div>
            <div><span>链上服务</span><strong>${escapeHtml(serverMetrics.service.chainProvider || "-")}</strong></div>
            <div><span>自动同步</span><strong>${serverMetrics.service.chainScheduler?.enabled ? `每 ${serverMetrics.service.chainScheduler.intervalMinutes} 分钟` : "未启用"}</strong></div>
            <div><span>同步状态</span><strong>${serverMetrics.service.chainScheduler?.running ? "正在同步" : "空闲"}</strong></div>
            <div><span>最近开始</span><strong>${formatDate(serverMetrics.service.chainScheduler?.lastStartedAt)}</strong></div>
            <div><span>最近完成</span><strong>${formatDate(serverMetrics.service.chainScheduler?.lastFinishedAt)}</strong></div>
            <div><span>最近异常</span><strong>${escapeHtml(serverMetrics.service.chainScheduler?.lastError || serverMetrics.service.chainReason || "无")}</strong></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title"><h3>数据库状态</h3><span>${databaseLabel(serverMetrics.database.kind)}</span></div>
          <div class="metric-list">
            <div><span>连接状态</span><strong>${serverMetrics.database.connected ? "正常" : "异常"}</strong></div>
            ${serverMetrics.database.databaseName ? `<div><span>数据库名</span><strong>${escapeHtml(serverMetrics.database.databaseName)}</strong></div>` : ""}
            <div><span>数据库大小</span><strong>${formatBytes(serverMetrics.database.totalBytes)}</strong></div>
            <div><span>状态数据大小</span><strong>${formatBytes(serverMetrics.database.appStateBytes)}</strong></div>
            ${serverMetrics.database.connections != null ? `<div><span>连接数</span><strong>${serverMetrics.database.connections} / ${serverMetrics.database.maxConnections || "-"}</strong></div>` : ""}
            ${serverMetrics.database.userSessions != null ? `<div><span>在线会话</span><strong>${serverMetrics.database.userSessions}</strong></div>` : ""}
            ${serverMetrics.database.updatedAt ? `<div><span>最近写入</span><strong>${formatDate(serverMetrics.database.updatedAt)}</strong></div>` : ""}
          </div>
        </div>
        ${renderBackupPanel(serverMetrics.backups)}
      </section>
      <section class="grid server-panels">
        <div class="panel">
          <div class="panel-title"><h3>安全状态</h3></div>
          <div class="metric-list">
            <div><span>管理员账号</span><strong>${serverMetrics.security.adminUsers}</strong></div>
            <div><span>有效会话</span><strong>${serverMetrics.security.activeSessions ?? "-"}</strong></div>
            <div><span>最近登录</span><strong>${formatDate(serverMetrics.security.lastLoginAt)}</strong></div>
            <div><span>今日登录失败</span><strong>${serverMetrics.security.failedLoginsToday}</strong></div>
            <div><span>本月登录失败</span><strong>${serverMetrics.security.failedLoginsThisMonth}</strong></div>
          </div>
        </div>
        <div class="panel">
          <div class="panel-title"><h3>附件凭证空间</h3><span>${formatDate(serverMetrics.capturedAt)}</span></div>
          <div class="metric-list">
            <div><span>凭证数量</span><strong>${serverMetrics.attachments.annotationCount}</strong></div>
            <div><span>附件文件</span><strong>${serverMetrics.attachments.fileCount}</strong></div>
            <div><span>附件目录占用</span><strong>${formatBytes(serverMetrics.attachments.totalBytes)}</strong></div>
            <div><span>记录内大小</span><strong>${formatBytes(serverMetrics.attachments.storedAttachmentBytes)}</strong></div>
            <div><span>今日新增</span><strong>${serverMetrics.attachments.growth.today.count} 个 / ${formatBytes(serverMetrics.attachments.growth.today.bytes)}</strong></div>
            <div><span>本月新增</span><strong>${serverMetrics.attachments.growth.month.count} 个 / ${formatBytes(serverMetrics.attachments.growth.month.bytes)}</strong></div>
            <div><span>压缩节省</span><strong>${formatBytes(serverMetrics.attachments.growth.savedBytes)}</strong></div>
          </div>
          <p class="muted mono">${escapeHtml(serverMetrics.attachments.rootDir || "-")}</p>
        </div>
        <div class="panel">
          <div class="panel-title"><h3>系统数据量</h3></div>
          <div class="metric-list">
            <div><span>系统</span><strong>${serverMetrics.data.tenants}</strong></div>
            <div><span>账号</span><strong>${serverMetrics.data.users}</strong></div>
            <div><span>钱包</span><strong>${serverMetrics.data.wallets}</strong></div>
            <div><span>链上流水</span><strong>${serverMetrics.data.chainTransactions}</strong></div>
            <div><span>批注记录</span><strong>${serverMetrics.data.annotations}</strong></div>
            <div><span>余额快照</span><strong>${serverMetrics.data.walletBalanceSnapshots}</strong></div>
            <div><span>操作日志</span><strong>${serverMetrics.data.auditLogs}</strong></div>
          </div>
        </div>
      </section>
      <section class="grid server-events">
        ${eventPanel("最近同步失败", serverMetrics.events.syncFailures)}
        ${eventPanel("最近登录失败", serverMetrics.security.recentFailedLogins)}
      </section>
    `;
  }

  function renderBackupPanel(backups = {}) {
    const timerActive = backups.timer?.active === "active";
    const timerEnabled = backups.timer?.enabled === "enabled";
    return `<div class="panel">
      <div class="panel-title"><h3>备份状态</h3><span>${healthText(backups.exists, "目录正常", "目录异常")}</span></div>
      <div class="metric-list">
        <div><span>定时备份</span><strong>${healthText(timerActive && timerEnabled, timerActive ? "运行中" : "未运行", "异常")}</strong></div>
        <div><span>最近执行</span><strong>${formatDate(backups.timer?.lastRun)}</strong></div>
        <div><span>下次执行</span><strong>${formatDate(backups.timer?.nextRun)}</strong></div>
        <div><span>备份文件</span><strong>${backups.fileCount ?? 0}</strong></div>
        <div><span>目录占用</span><strong>${formatBytes(backups.totalBytes || 0)}</strong></div>
        <div><span>最近数据库</span><strong>${backupFileText(backups.latestDatabaseBackup)}</strong></div>
        <div><span>最近附件</span><strong>${backupFileText(backups.latestAttachmentBackup)}</strong></div>
        <div><span>最近校验</span><strong>${backupFileText(backups.latestChecksum)}</strong></div>
      </div>
      <p class="muted mono">${escapeHtml(backups.rootDir || "-")}</p>
    </div>`;
  }

  function backupFileText(file) {
    if (!file) return "-";
    return `${formatDate(file.mtime)} · ${formatBytes(file.size)}`;
  }

  function metricCard(label, value, foot, barValue) {
    const width = barValue == null ? 0 : Math.max(0, Math.min(100, barValue));
    const tone = width >= 85 ? "danger" : width >= 70 ? "warn" : "ok";
    return `<div class="card metric-card">
      <div class="card-label">${label}</div>
      <div class="card-value">${value}</div>
      ${barValue == null ? "" : `<div class="metric-bar"><span class="${tone}" style="width:${width}%"></span></div>`}
      <div class="card-foot">${escapeHtml(foot || "")}</div>
    </div>`;
  }

  function databaseLabel(kind) {
    return kind === "postgresql" ? "PostgreSQL" : "本地文件";
  }

  function healthText(ok, yes, no) {
    return `<span class="health ${ok ? "ok" : "warn"}">${ok ? yes : no}</span>`;
  }

  function eventPanel(title, rows = []) {
    return `<div class="panel">
      <div class="panel-title"><h3>${title}</h3></div>
      ${rows.length ? `<div class="event-list">${rows.map((log) => `<div>
        <strong>${escapeHtml(log.action || "-")}</strong>
        <span>${formatDate(log.createdAt)} · ${escapeHtml(userName(log.userId))}</span>
        <p>${escapeHtml(log.target || "-")}</p>
      </div>`).join("")}</div>` : `<div class="empty slim">暂无记录</div>`}
    </div>`;
  }

  function renderHelp() {
    return `
      ${pageHead("使用说明", "主管和员工日常操作说明，功能调整后会同步更新")}
      <section class="panel help-doc">
        ${helpSection("一、登录和基础规则", [
          "登录后，系统会根据账号角色显示可用菜单。",
          "正式登录使用登录账号和密码；已绑定登录密钥的账号还需要输入验证器里的 6 位动态验证码。",
          "所有用户都可以在我的账号中修改自己的登录密码或重置自己的登录密钥。",
          "员工主要处理链上流水批注、往来款提交、平账提交、账目查询和自己的操作日志。",
          "主管除员工功能外，还可以审核批注、审核往来款、审核平账、管理员工账号、维护本系统钱包、处理非业务流水和提交租用续费哈希。",
          "系统里的金额、钱包、方向、链上时间和交易哈希都来自链上流水，不能手工修改。",
          "业务信息通过批注补充，包括分类、备注用途和凭证图片。",
          "凭证只支持图片上传，也可以直接粘贴截图。",
        ])}
        ${helpSection("二、总览", [
          "总览用于查看本系统现金流概况，包括业务已审核、待处理业务、钱包实际流水、往来款概况、链上钱包余额和最近流水。",
          "正式业务统计以已通过的批注为准，待审核或已驳回的记录不会直接计入正式业务统计。",
          "钱包实际流水按链上进出统计，不区分是否已批注或审核，适合和业务已审核数据进行对比。",
          "往来款概况用于查看应收、应付、已平、未平、多收和多付情况。",
          "链上钱包余额显示当前链上余额以及今日、本月余额变化，便于核对钱包实际现金流。",
        ])}
        ${helpSection("三、流水账目", [
          "流水账目用于查看已经同步到系统里的 TRC20 USDT 链上流水。",
          "待批注表示链上已有流水但还没有补充业务信息。",
          "待审核表示已经提交批注，等待主管审核。",
          "已通过表示主管审核通过，计入业务统计。",
          "已驳回表示主管退回，员工可以修改后重新提交。",
          "已被修正表示已有新的修正版本通过，原版本保留但不再作为当前有效版本。",
          "已被冲正表示该流水保留历史，但不再计入业务收支。",
          "非业务流水表示主管确认该笔不是业务收支，例如测试款或系统上线验证款。",
          "历史无需批注表示早于钱包纳入管理时间的历史流水，默认不要求补批注。",
          "内部划转待确认表示只同步到了内部划转的一侧，等另一侧钱包流水同步后再处理。",
          "查询时可按时间、方向、批注状态、钱包、金额范围和关键词筛选。",
        ])}
        ${helpSection("四、员工提交批注", [
          "员工在流水账目中找到需要处理的链上流水，点击批注后填写分类、备注用途和凭证图片。",
          "备注用途建议填写客户信息、业务说明、资金用途等。",
          "提交后状态变为待审核，由主管审核。",
          "金额和钱包不需要填写，系统以链上数据为准。",
          "内部划转不计入进账、出账统计，但需要补充用途说明并审核。",
          "被驳回后，员工可以按驳回原因修改并重新提交。",
        ])}
        ${helpSection("五、主管审核批注", [
          "主管在审核中心处理待审核记录。",
          "审核时需要确认业务原由是否清楚、分类是否正确、凭证是否能证明该笔收付款，以及链上金额、方向、钱包是否与实际业务一致。",
          "审核通过后，该批注成为当前有效记录，并进入业务统计。",
          "驳回时必须填写原因，员工修改后可重新提交。",
          "已通过记录需要调整时，主管可发起修正或冲正。",
          "修正用于分类、说明、凭证等内容需要调整的情况；修正通过后新版本生效。",
          "冲正用于该笔不应继续计入业务收支的情况；冲正通过后链上流水仍保留，但不再计入业务统计。",
        ])}
        ${helpSection("六、往来款管理", [
          "往来款管理用于记录和查看应收款、应付款。",
          "应收款表示别人欠本系统的钱，后续用进账流水平账；应付款表示本系统欠别人的钱，后续用出账流水平账。",
          "员工可以提交应收款或应付款，主管审核通过后才能平账；主管创建的往来款直接生效。",
          "提交往来款时可上传或粘贴凭证图片，方便主管审核业务来源和金额依据。",
          "平账从流水账目发起：先找到实际收款或付款的链上流水，再选择对应的应收款或应付款。",
          "进账流水只能平应收款，出账流水只能平应付款。",
          "链上流水只要在钱包纳入管理时间之后即可用于平账，不要求先完成批注审核。",
          "纳入管理时间之前的历史无需批注流水不能用于平账。",
          "一笔链上流水只能绑定一笔往来款，且必须整笔用于平账，不能拆分或部分平账。",
          "一笔往来款可以通过多笔链上流水分多次平账。",
          "如果实际收付金额超过往来款金额，系统会显示多收或多付金额。",
          "员工提交平账后由主管审核，主管自己提交的平账直接确认。",
        ])}
        ${helpSection("七、钱包管理", [
          "主管可新增 TRC20 USDT 钱包、设置钱包纳入管理起始时间、查看链上余额和同步状态、停用或启用钱包、手动触发链上同步。",
          "纳入管理范围可选择从今天开始、最近 7 天、最近 30 天，或自定义最近 30 天内的具体时间。",
          "钱包不能删除，停用后可再次启用，不需要重新添加。",
          "停用钱包不影响历史流水，启用后会重新参与链上同步。",
          "停用钱包只是暂停自动同步和新增待办，重新启用后会自动补同步停用期间的链上流水。",
          "补同步到的流水仍按原钱包纳入管理时间判断是否需要批注。",
          "纳入管理起始时间之前的流水可查询，但默认不要求员工补批注。",
          "纳入管理起始时间创建后不可修改，避免历史流水统计口径发生变化。",
        ])}
        ${helpSection("八、账号管理", [
          "主管可以创建员工或主管账号，并设置员工是否允许查看全部账目。",
          "新增账号时需要填写姓名、登录账号和初始密码；正式登录页使用账号和密码登录，不再选择角色。",
          "新增账号后系统会显示登录密钥和扫码链接，请交给对应人员保存到验证器；重置登录密钥后旧验证码会立即失效。",
          "重置登录密码后旧密码立即失效；重置登录密钥后旧动态验证码立即失效，需要重新绑定验证器。",
          "主管账号默认可以查看和审核本系统数据，不显示员工查看范围开关。",
          "勾选查看全部账目时，员工可以查看本系统全部账目。",
          "取消勾选时，员工只能查看自己提交或需要自己处理的记录。",
          "员工无权限创建账号或修改其他员工权限。",
        ])}
        ${helpSection("九、租用续费", [
          "主管可在租用续费页面查看当前系统到期时间、剩余租用天数、系统启用状态、月租费用和平台收款钱包地址。",
          "系统未开通、已到期或已停用时，可以登录查看历史和提交续费哈希，但不能新增钱包、启用钱包、提交批注、创建往来款、提交平账或处理审核。",
          "页面会显示本系统续费提交记录，包括交易哈希、金额、处理状态、续费时长和说明。",
          "续费时，先按页面显示的平台收款钱包完成 USDT 转账。",
          "转账完成后复制交易哈希，并在租用续费页面提交。",
          "系统会校验该哈希是否转入平台收款钱包、链上确认状态和是否重复提交。",
          "同一交易哈希只能提交一次。",
          "请确认交易已经成功上链并获得确认后再提交。",
          "如果提交后没有自动完成续费，请联系平台处理。",
        ])}
        ${helpSection("十、链上查询", [
          "链上查询用于手动核查交易哈希或钱包地址。",
          "可查询某笔交易是否已同步到系统，并核对交易哈希、链上时间、方向、金额和对方地址。",
          "链上查询只是查询工具，不等同于批注、平账或审核。",
        ])}
        ${helpSection("十一、操作日志", [
          "操作日志用于追踪系统内的重要业务和管理操作，包括提交批注、审核通过或驳回、修正、冲正、往来款提交、审核、平账、钱包变更、权限变更和续费处理等。",
          "主管可查看本系统业务相关日志，主要用于追踪提交、审核、调整、钱包、权限和续费处理。",
          "员工只能查看与自己相关的日志。",
        ])}
        ${helpSection("十二、日常建议", [
          "收付款发生后，应尽快处理对应链上流水批注。",
          "批注备注尽量写清楚客户、业务和用途，避免日后追溯困难。",
          "凭证图片建议保留关键交易信息、客户信息或业务凭据。",
          "主管审核时不要只看金额，应结合业务说明和凭证确认。",
          "发现链上流水和业务说明不一致时，优先驳回让员工补充或修改。",
          "应收应付尽量及时录入，避免平账时忘记业务来源。",
          "已通过记录需要调整时，使用修正或冲正，不要覆盖历史。",
        ])}
      </section>
    `;
  }

  function helpSection(title, items) {
    return `<article class="help-section"><h3>${escapeHtml(title)}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></article>`;
  }

  function renderLogs() {
    const tenantLogs = state.auditLogs.filter((log) => log.tenantId === visibleTenantId());
    const defaultActions = currentUser().role === "admin" ? adminLogActions : supervisorLogActions;
    const actionOptions = [...new Set([...defaultActions, ...tenantLogs.map((log) => log.action).filter(Boolean)])].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const actorIds = [...new Set(tenantLogs.map((log) => log.userId).filter(Boolean))];
    const logs = tenantLogs.filter((log) => {
      if (logFilters.from && new Date(log.createdAt).getTime() < new Date(`${logFilters.from}T00:00:00`).getTime()) return false;
      if (logFilters.to && new Date(log.createdAt).getTime() > new Date(`${logFilters.to}T23:59:59.999`).getTime()) return false;
      if (logFilters.userId && log.userId !== logFilters.userId) return false;
      if (logFilters.action && log.action !== logFilters.action) return false;
      return true;
    }).sort((left, right) => {
      const timeDifference = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
      if (timeDifference) return timeDifference;
      return String(right.id).localeCompare(String(left.id));
    });
    const totalPages = Math.max(1, Math.ceil(logs.length / LOG_PAGE_SIZE));
    logsPage = Math.min(logsPage, totalPages);
    const pageLogs = logs.slice((logsPage - 1) * LOG_PAGE_SIZE, logsPage * LOG_PAGE_SIZE);
    return `
      ${pageHead("操作日志", "默认显示最近 7 天")}
      <form id="logFilters" class="filters">
        <label>开始日期<input type="date" name="from" value="${escapeHtml(logFilters.from)}"></label>
        <label>结束日期<input type="date" name="to" value="${escapeHtml(logFilters.to)}"></label>
        <label>操作人<select name="userId"><option value="">全部操作人</option>${actorIds.map((userId) => `<option value="${escapeHtml(userId)}" ${logFilters.userId === userId ? "selected" : ""}>${escapeHtml(userName(userId))}</option>`).join("")}</select></label>
        <label>动作<select name="action">
          <option value="">全部动作</option>
          ${actionOptions.map((action) => `<option value="${escapeHtml(action)}" ${logFilters.action === action ? "selected" : ""}>${escapeHtml(action)}</option>`).join("")}
        </select></label>
        <div class="actions"><button class="btn primary" type="submit">查询</button><button class="btn" type="reset">清空</button></div>
      </form>
      <div class="table-wrap"><table><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th></tr></thead>
      <tbody>${pageLogs.map((log) => `<tr><td>${formatDate(log.createdAt)}</td><td>${escapeHtml(userName(log.userId))}</td><td>${escapeHtml(log.action)}</td><td class="mono">${escapeHtml(log.target)}</td></tr>`).join("")}</tbody></table></div>
      ${renderLogsPagination(logs.length, totalPages)}
    `;
  }

  function renderLogsPagination(totalRows, totalPages) {
    if (!totalRows) return "";
    const start = (logsPage - 1) * LOG_PAGE_SIZE + 1;
    const end = Math.min(logsPage * LOG_PAGE_SIZE, totalRows);
    return `<div class="pagination">
      <span>第 ${start}-${end} 条，共 ${totalRows} 条</span>
      <div class="pagination-actions">
        <button class="btn pagination-icon" data-log-page="1" title="首页" aria-label="首页" ${logsPage <= 1 ? "disabled" : ""}>«</button>
        <button class="btn pagination-icon" data-log-page="${logsPage - 1}" title="上一页" aria-label="上一页" ${logsPage <= 1 ? "disabled" : ""}>‹</button>
        <label class="pagination-jump">
          <span>页码</span>
          <select data-log-page-select aria-label="选择页码">
            ${Array.from({ length: totalPages }, (_, index) => {
              const page = index + 1;
              return `<option value="${page}" ${page === logsPage ? "selected" : ""}>第 ${page} 页</option>`;
            }).join("")}
          </select>
        </label>
        <button class="btn pagination-icon" data-log-page="${logsPage + 1}" title="下一页" aria-label="下一页" ${logsPage >= totalPages ? "disabled" : ""}>›</button>
        <button class="btn pagination-icon" data-log-page="${totalPages}" title="末页" aria-label="末页" ${logsPage >= totalPages ? "disabled" : ""}>»</button>
      </div>
    </div>`;
  }

  function startAutoRefresh() {
    if (autoRefreshTimer || !session?.token) return;
    autoRefreshTimer = setInterval(refreshStateInBackground, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (!autoRefreshTimer) return;
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }

  function shouldSkipAutoRefresh() {
    if (!session?.token || autoRefreshInFlight) return true;
    if (document.hidden) return true;
    if (document.querySelector(".form-modal, .proof-modal")) return true;
    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName)) return true;
    if (state.activeView === "new" || state.editingAnnotationId) return true;
    return false;
  }

  async function refreshStateInBackground() {
    if (shouldSkipAutoRefresh()) return;
    autoRefreshInFlight = true;
    try {
      const response = await fetch(API_STATE, { headers: authHeaders() });
      if (response.status === 401) {
        session = null;
        localStorage.removeItem(SESSION_KEY);
        render();
        return;
      }
      if (!response.ok) return;
      const payload = await response.json();
      if (!payload.state) return;
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      applyLoadedState(payload.state);
      if (["wallets", "reconcile"].includes(state.activeView)) await refreshChainStatus();
      render();
      window.scrollTo(scrollX, scrollY);
    } catch {
      // Keep the current screen usable when the network is temporarily unavailable.
    } finally {
      autoRefreshInFlight = false;
    }
  }

  function activeViewNeedsChainStatus() {
    return ["wallets", "reconcile"].includes(state.activeView);
  }

  function refreshVisibleChainStatus() {
    if (!session?.token || !activeViewNeedsChainStatus()) return;
    refreshChainStatus().then(render);
  }

  function bindEvents() {
    manageServerMetricsRefresh();
    document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", () => {
      state.activeView = button.dataset.nav;
      state.editingAnnotationId = null;
      if (state.activeView === "logs") refreshLogs().then(render);
      else if (activeViewNeedsChainStatus()) refreshChainStatus().then(render);
      else if (state.activeView === "server") refreshServerMetrics().then(render);
      else render();
    }));
    document.querySelectorAll("[data-dashboard-target]").forEach((card) => {
      const openTarget = () => openDashboardTarget(card.dataset.dashboardTarget);
      card.addEventListener("click", openTarget);
      card.addEventListener("keydown", (event) => {
        if (!["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        openTarget();
      });
    });
    document.querySelector("[data-action='tenant']")?.addEventListener("change", (event) => {
      state.activeTenantId = event.target.value;
      entryFilters = defaultEntryFilters();
      entriesPage = 1;
      logFilters = defaultLogFilters();
      logsPage = 1;
      receivableFilters = defaultReceivableFilters();
      save();
      render();
      refreshVisibleChainStatus();
    });
    document.querySelector("[data-action='logout']")?.addEventListener("click", logout);
    document.querySelector("#filters")?.addEventListener("submit", (event) => {
      event.preventDefault();
      entryFilters = Object.fromEntries(new FormData(event.target).entries());
      entriesPage = 1;
      render();
    });
    document.querySelector("#filters")?.addEventListener("reset", (event) => {
      event.preventDefault();
      entryFilters = {};
      entriesPage = 1;
      render();
    });
    document.querySelectorAll("[data-entry-page]").forEach((button) => button.addEventListener("click", () => {
      changeEntriesPage(button.dataset.entryPage);
    }));
    document.querySelector("[data-entry-page-select]")?.addEventListener("change", (event) => {
      changeEntriesPage(event.target.value);
    });
    document.querySelector("#logFilters")?.addEventListener("submit", (event) => {
      event.preventDefault();
      logFilters = Object.fromEntries(new FormData(event.target).entries());
      logsPage = 1;
      render();
    });
    document.querySelector("#logFilters")?.addEventListener("reset", (event) => {
      event.preventDefault();
      logFilters = {};
      logsPage = 1;
      render();
    });
    document.querySelectorAll("[data-log-page]").forEach((button) => button.addEventListener("click", () => {
      changeLogsPage(button.dataset.logPage);
    }));
    document.querySelector("[data-log-page-select]")?.addEventListener("change", (event) => {
      changeLogsPage(event.target.value);
    });
    document.querySelector("[data-action='export']")?.addEventListener("click", exportCsv);
    document.querySelector("[data-action='export-receivables']")?.addEventListener("click", exportReceivablesCsv);
    document.querySelector("#receivableFilters")?.addEventListener("submit", (event) => {
      event.preventDefault();
      receivableFilters = Object.fromEntries(new FormData(event.target).entries());
      render();
    });
    document.querySelector("#receivableFilters")?.addEventListener("reset", (event) => {
      event.preventDefault();
      receivableFilters = defaultReceivableFilters();
      render();
    });
    document.querySelector("#accountFilters")?.addEventListener("submit", (event) => {
      event.preventDefault();
      normalizeAccountFilters(Object.fromEntries(new FormData(event.target).entries()));
      save();
      render();
    });
    document.querySelector("#accountFilters select[name='tenantStatus']")?.addEventListener("change", (event) => {
      normalizeAccountFilters({ ...accountFilters, tenantStatus: event.target.value });
      save();
      render();
    });
    document.querySelector("#accountFilters")?.addEventListener("reset", (event) => {
      event.preventDefault();
      accountFilters = defaultAccountFilters();
      save();
      render();
    });
    document.querySelector("[data-action='refresh-server']")?.addEventListener("click", () => refreshServerMetrics().then(render));
    document.querySelector("#annotationForm")?.addEventListener("submit", submitAnnotation);
    document.querySelector("[data-chain-tx]")?.addEventListener("change", (event) => {
      const tx = state.chainTransactions.find((item) => item.id === event.target.value);
      if (tx) {
        const categories = tx.transactionType === "transfer" ? ["内部划转"] : state.categories[tx.direction];
        const options = categories.map((category) => `<option>${category}</option>`).join("");
        event.target.form.elements.category.innerHTML = options;
        renderSelectedTransaction(tx);
      }
    });
    document.querySelector("[data-cancel-edit]")?.addEventListener("click", () => { state.editingAnnotationId = null; render(); });
    document.querySelector("#walletForm")?.addEventListener("submit", submitWallet);
    document.querySelector("[data-managed-preset]")?.addEventListener("change", (event) => {
      const input = document.querySelector("[data-managed-from]");
      input.readOnly = event.target.value !== "custom";
      input.value = event.target.value === "custom" ? input.value : managedFromPreset(event.target.value);
    });
    document.querySelector("#userForm select[name='role']")?.addEventListener("change", (event) => {
      document.querySelector("#userForm .checkline")?.toggleAttribute("hidden", event.target.value === "supervisor");
    });
    document.querySelector("#userForm")?.addEventListener("submit", submitUser);
    document.querySelector("#tenantForm")?.addEventListener("submit", submitTenant);
    document.querySelectorAll("[data-tenant-status]").forEach((button) => button.addEventListener("click", () => {
      updateTenantStatus(button.dataset.tenantStatus, button.dataset.enabled === "true");
    }));
    document.querySelector("#subscriptionSettingsForm")?.addEventListener("submit", submitSubscriptionSettings);
    document.querySelector("#systemSettingsForm")?.addEventListener("submit", submitSystemSettings);
    document.querySelector("#subscriptionHashForm")?.addEventListener("submit", submitSubscriptionHash);
    document.querySelector("#receivableForm")?.addEventListener("submit", submitReceivable);
    document.querySelectorAll("[data-rp-review]").forEach((button) => button.addEventListener("click", () => reviewReceivable(button.dataset.rpReview, button.dataset.action)));
    document.querySelectorAll("[data-settle-tx]").forEach((button) => button.addEventListener("click", () => openTransactionSettlement(button.dataset.settleTx)));
    document.querySelectorAll("[data-rp-detail]").forEach((button) => button.addEventListener("click", () => openReceivableDetail(button.dataset.rpDetail)));
    document.querySelectorAll("[data-rp-void]").forEach((button) => button.addEventListener("click", () => voidReceivable(button.dataset.rpVoid)));
    document.querySelectorAll("[data-rp-attachment]").forEach((button) => button.addEventListener("click", () => previewReceivableAttachment(button.dataset.rpAttachment)));
    document.querySelectorAll("[data-rps-review]").forEach((button) => button.addEventListener("click", () => reviewReceivableSettlement(button.dataset.rpsReview, button.dataset.action)));
    document.querySelectorAll("[data-manual-renew]").forEach((button) => button.addEventListener("click", () => manualRenewPayment(button.dataset.manualRenew)));
    document.querySelectorAll("[data-tenant-manual-renew]").forEach((button) => button.addEventListener("click", () => manualRenewTenant(button.dataset.tenantManualRenew)));
    document.querySelector("#categoryForm")?.addEventListener("submit", submitCategory);
    document.querySelectorAll("[data-reset-totp]").forEach((button) => button.addEventListener("click", () => resetTotp(button.dataset.resetTotp)));
    document.querySelectorAll("[data-reset-password]").forEach((button) => button.addEventListener("click", () => resetPassword(button.dataset.resetPassword)));
    document.querySelectorAll("[data-edit-category]").forEach((button) => button.addEventListener("click", () => {
      renameCategory(button.dataset.editCategory, button.dataset.categoryName);
    }));
    document.querySelector("#chainSearchForm")?.addEventListener("submit", manualChainSearch);
    document.querySelector("[data-action='sync-chain']")?.addEventListener("click", syncChain);
    document.querySelectorAll("[data-user-view-all]").forEach((input) => input.addEventListener("change", () => updateUserPermission(input.dataset.userViewAll, input.checked)));
    document.querySelectorAll("[data-disable-wallet]").forEach((button) => button.addEventListener("click", () => disableWallet(button.dataset.disableWallet)));
    document.querySelectorAll("[data-enable-wallet]").forEach((button) => button.addEventListener("click", () => enableWallet(button.dataset.enableWallet)));
    document.querySelectorAll("[data-annotate-tx]").forEach((button) => button.addEventListener("click", () => openAnnotation(button.dataset.annotateTx)));
    document.querySelectorAll("[data-resubmit]").forEach((button) => button.addEventListener("click", () => editRejected(button.dataset.resubmit)));
    document.querySelectorAll("[data-review-approve]").forEach((button) => button.addEventListener("click", () => review(button.dataset.reviewApprove, "approve")));
    document.querySelectorAll("[data-review-reject]").forEach((button) => button.addEventListener("click", () => review(button.dataset.reviewReject, "reject")));
    document.querySelectorAll("[data-correct]").forEach((button) => button.addEventListener("click", () => correctAnnotation(button.dataset.correct)));
    document.querySelectorAll("[data-reverse]").forEach((button) => button.addEventListener("click", () => reverseAnnotation(button.dataset.reverse)));
    document.querySelectorAll("[data-non-business]").forEach((button) => button.addEventListener("click", () => markNonBusiness(button.dataset.nonBusiness)));
    document.querySelectorAll("[data-restore-non-business]").forEach((button) => button.addEventListener("click", () => restoreNonBusiness(button.dataset.restoreNonBusiness)));
    document.querySelectorAll("[data-detail]").forEach((button) => button.addEventListener("click", () => showDetail(button.dataset.detail)));
    document.querySelectorAll("[data-attachment]").forEach((button) => button.addEventListener("click", () => previewAttachment(button.dataset.attachment)));
    bindProofUpload();
  }

  function openDashboardTarget(target) {
    const reviewTargets = {
      "review-annotations": "[data-review-section='annotations']",
      "review-receivables": "[data-review-section='receivables']",
      "review-settlements": "[data-review-section='settlements']",
    };
    if (target === "entries-unannotated") {
      entryFilters = { ...defaultEntryFilters(), from: "", to: "", status: "unannotated" };
      entriesPage = 1;
      state.activeView = "entries";
      state.editingAnnotationId = null;
      render();
      return;
    }
    if (reviewTargets[target]) {
      state.activeView = "review";
      state.editingAnnotationId = null;
      pendingScrollTarget = reviewTargets[target];
      render();
    }
  }

  function scrollToPendingTarget() {
    if (!pendingScrollTarget) return;
    const selector = pendingScrollTarget;
    pendingScrollTarget = null;
    requestAnimationFrame(() => {
      const target = document.querySelector(selector);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function bindProofUpload(root = document) {
    const zone = root.querySelector("[data-proof-upload]");
    const input = zone?.querySelector('input[type="file"]');
    if (!zone || !input) return;
    input.addEventListener("change", () => showProofPreview(input.files?.[0], root));
    zone.addEventListener("click", (event) => {
      if (event.target === zone || event.target.closest(".proof-upload-hint")) zone.focus();
    });
    zone.closest("form")?.addEventListener("paste", (event) => {
      const image = [...(event.clipboardData?.items || [])]
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile();
      if (!image) return;
      event.preventDefault();
      const extension = image.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const file = new File([image], `粘贴凭证-${Date.now()}.${extension}`, { type: image.type });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      showProofPreview(file, root);
      toast("凭证图片已粘贴");
    });
  }

  function showProofPreview(file, root = document) {
    const preview = root.querySelector("[data-proof-preview]");
    const image = preview?.querySelector("[data-proof-image]");
    const name = preview?.querySelector("[data-proof-name]");
    if (!preview || !image || !name || !(file instanceof File)) return;
    if (!file.type.startsWith("image/")) {
      toast("凭证只支持图片");
      return;
    }
    if (image.dataset.objectUrl) URL.revokeObjectURL(image.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    image.src = objectUrl;
    image.dataset.objectUrl = objectUrl;
    name.textContent = file.name;
    preview.hidden = false;
  }

  function renderSelectedTransaction(tx) {
    const fields = document.querySelectorAll(".readonly-field strong");
    if (fields.length >= 3) {
      fields[0].textContent = `${money(tx.amount)} USDT`;
      fields[1].textContent = transactionWalletText(tx);
      fields[2].textContent = typeMap[transactionDirection(tx)];
    }
  }

  function bindLoginEvents() {
    document.querySelector("#loginForm")?.addEventListener("submit", login);
  }

  async function loadAccounts() {
    try {
      const response = await fetch("/api/auth/accounts");
      if (!response.ok) return [];
      const payload = await response.json();
      runtimeConfig = {
        appEnv: payload.appEnv || "development",
        productionMode: payload.productionMode === true,
      };
      return payload.users || [];
    } catch {
      return [];
    }
  }

  async function ensureInitialState() {
    loginAccounts = await loadAccounts();
    if (loginAccounts.length) return;
    await fetch(API_STATE, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ state: structuredClone(seed) }) }).catch(() => {});
    loginAccounts = await loadAccounts();
  }

  async function login(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "登录失败");
      session = { token: payload.token, userId: payload.user.id };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      state = payload.state || await load();
      state.activeUserId = payload.user.id;
      if (payload.user.tenantId) state.activeTenantId = payload.user.tenantId;
      state.activeView = "dashboard";
      entryFilters = defaultEntryFilters();
      entriesPage = 1;
      logFilters = defaultLogFilters();
      logsPage = 1;
      migrateState();
      saveUiState();
      save();
      render();
      toast("登录成功");
    } catch (error) {
      toast(error.message);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", headers: authHeaders() }).catch(() => {});
    session = null;
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(UI_STATE_KEY);
    stopAutoRefresh();
    render();
  }

  function openAnnotation(txId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const tx = state.chainTransactions.find((item) => item.id === txId);
    if (!tx) return;
    openAnnotationModal({ tx });
  }

  function editRejected(annotationId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const editing = state.annotations.find((annotation) => annotation.id === annotationId);
    const tx = state.chainTransactions.find((item) => item.id === editing?.chainTxId);
    if (!editing || !tx) return;
    openAnnotationModal({ tx, editing });
  }

  function openAnnotationModal({ tx, editing = null }) {
    const categories = tx.transactionType === "transfer" ? ["内部划转"] : state.categories[tx.direction];
    const inputId = `proof-${editing?.id || tx.id}`;
    const overlay = createFormModal({
      title: editing ? "修改并重新提交" : "批注链上流水",
      desc: "金额、钱包、方向和时间来自链上，只需要补充分类、业务说明和凭证。",
      body: `
        ${renderAnnotationTxSummary(tx)}
        <label>分类
          <select name="category" required>
            ${renderCategoryOptions(categories, editing?.category || "")}
          </select>
        </label>
        <label>备注用途
          <textarea name="note" required placeholder="客户信息、业务说明等">${escapeHtml(editing?.note || "")}</textarea>
        </label>
        <div class="proof-field">
          <span>凭证上传 <em class="optional-mark">选填</em></span>
          <div class="proof-upload" data-proof-upload tabindex="0">
            <input id="${escapeHtml(inputId)}" name="attachmentFile" type="file" accept="image/*">
            <label class="btn" for="${escapeHtml(inputId)}">上传图片</label>
            <span class="proof-upload-hint">或点击此处后粘贴截图</span>
            <div class="proof-preview" data-proof-preview hidden>
              <img data-proof-image alt="凭证预览">
              <span data-proof-name></span>
            </div>
          </div>
        </div>
        ${editing?.rejectionReason ? `<div class="notice danger">上次驳回原因：${escapeHtml(editing.rejectionReason)}</div>` : ""}
      `,
      submitText: editing ? "重新提交审核" : "提交批注审核",
      confirmMessage: editing ? "确认重新提交这条批注？" : "确认提交这条批注？",
      onSubmit: async (formData, close) => {
        if (!formData.get("category")) throw new Error("请选择分类");
        const attachment = await readUpload(formData.get("attachmentFile"));
        await apiMutate(editing ? `/api/annotations/${encodeURIComponent(editing.id)}/resubmit` : "/api/annotations", {
          body: {
            chainTxId: tx.id,
            category: formData.get("category"),
            note: formData.get("note"),
            attachment,
          },
        });
        close();
        render();
        toast(editing ? "批注已重新提交，等待主管审核" : "批注已提交，等待主管审核");
      },
    });
    document.body.append(overlay);
    bindProofUpload(overlay);
  }

  async function submitAnnotation(event) {
    event.preventDefault();
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const formData = new FormData(event.target);
    const data = Object.fromEntries(formData.entries());
    const editing = state.annotations.find((annotation) => annotation.id === state.editingAnnotationId);
    const chainTxId = editing?.chainTxId || data.chainTxId;
    if (!data.category) {
      toast("请选择分类");
      return;
    }
    if (!confirm(editing ? "确认重新提交这条批注？" : "确认提交这条批注？")) return;
    const attachment = await readUpload(formData.get("attachmentFile"));
    try {
      await apiMutate(editing ? `/api/annotations/${encodeURIComponent(editing.id)}/resubmit` : "/api/annotations", {
        body: { chainTxId, category: data.category, note: data.note, attachment },
      });
      state.editingAnnotationId = null;
      state.activeView = "entries";
      render();
      toast("批注已提交，等待主管审核");
    } catch (error) {
      toast(error.message);
    }
  }

  async function review(annotationId, action) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    let rejectionReason = "";
    if (action === "reject") {
      rejectionReason = prompt("请输入驳回原因，员工修改后可重新提交") || "";
      if (!rejectionReason.trim()) return;
    }
    if (!confirm(action === "approve" ? "确认审核通过这条批注？" : "确认驳回这条批注？")) return;
    try {
      await apiMutate(`/api/annotations/${encodeURIComponent(annotationId)}/review`, { body: { action, rejectionReason } });
      render();
      toast(action === "approve" ? "批注已审核通过" : "批注已驳回，可由员工修改后重提");
    } catch (error) {
      toast(error.message);
    }
  }

  function correctAnnotation(annotationId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const annotation = state.annotations.find((item) => item.id === annotationId);
    const tx = state.chainTransactions.find((item) => item.id === annotation?.chainTxId);
    if (!annotation || !tx) return;
    const categoryOptions = tx.transactionType === "transfer" ? ["内部划转"] : state.categories[tx.direction];
    const overlay = createFormModal({
      title: "提交批注修正",
      desc: "修正会生成新的待审核版本，主管通过前原批注继续有效。",
      body: `
        ${renderAnnotationTxSummary(tx)}
        <label>修正分类
          <select name="category" required>
            ${categoryOptions.map((category) => `<option value="${escapeHtml(category)}" ${category === annotation.category ? "selected" : ""}>${escapeHtml(category)}</option>`).join("")}
          </select>
        </label>
        <label>修正后的业务说明
          <textarea name="note" required placeholder="客户信息、业务说明等">${escapeHtml(annotation.note)}</textarea>
        </label>
      `,
      submitText: "提交修正",
      confirmMessage: "确认提交这条修正申请？",
      onSubmit: async (formData, close) => {
        await apiMutate(`/api/annotations/${encodeURIComponent(annotationId)}/correct`, {
          body: { category: formData.get("category"), note: formData.get("note") },
        });
        close();
        render();
        toast("修正版本已提交，主管通过前原版本继续有效");
      },
    });
    document.body.append(overlay);
    overlay.querySelectorAll("[data-rps-review]").forEach((button) => button.addEventListener("click", async (event) => {
      event.preventDefault();
      await reviewReceivableSettlement(button.dataset.rpsReview, button.dataset.action);
      overlay.remove();
    }));
  }

  function reverseAnnotation(annotationId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const annotation = state.annotations.find((item) => item.id === annotationId);
    const tx = state.chainTransactions.find((item) => item.id === annotation?.chainTxId);
    if (!annotation || !tx) return;
    const overlay = createFormModal({
      title: "提交批注冲正",
      desc: "冲正审核通过后，该流水不再计入业务收支统计。",
      body: `
        ${renderAnnotationTxSummary(tx)}
        <label>冲正原因
          <textarea name="reason" required placeholder="说明为什么需要冲正"></textarea>
        </label>
      `,
      submitText: "提交冲正",
      danger: true,
      confirmMessage: "确认提交这条冲正申请？",
      onSubmit: async (formData, close) => {
        await apiMutate(`/api/annotations/${encodeURIComponent(annotationId)}/reverse`, { body: { reason: formData.get("reason") } });
        close();
        render();
        toast("冲正申请已提交审核");
      },
    });
    document.body.append(overlay);
    overlay.querySelectorAll("[data-rp-attachment]").forEach((button) => button.addEventListener("click", () => previewReceivableAttachment(button.dataset.rpAttachment)));
    overlay.querySelectorAll("[data-rps-review]").forEach((button) => button.addEventListener("click", () => reviewReceivableSettlement(button.dataset.rpsReview, button.dataset.action)));
  }

  function markNonBusiness(txId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const tx = state.chainTransactions.find((item) => item.id === txId);
    if (!tx) return;
    const overlay = createFormModal({
      title: "标记非业务流水",
      desc: "适用于测试充值、误转入、资金归集等无需进入业务收支统计的链上流水。",
      body: `
        ${renderAnnotationTxSummary(tx)}
        <label>非业务原因
          <textarea name="reason" required placeholder="例如：测试充值、误转入、资金归集、无需业务入账"></textarea>
        </label>
      `,
      submitText: "标记非业务",
      danger: true,
      confirmMessage: "确认将这条流水标记为非业务？",
      onSubmit: async (formData, close) => {
        await apiMutate(`/api/chain-transactions/${encodeURIComponent(txId)}/non-business`, {
          body: { reason: formData.get("reason") },
        });
        close();
        render();
        toast("已标记为非业务流水");
      },
    });
    document.body.append(overlay);
  }

  function restoreNonBusiness(annotationId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const annotation = state.annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    const overlay = createFormModal({
      title: "恢复待批注",
      desc: "恢复后该流水会重新进入待批注队列，可继续提交业务批注。",
      body: `<div class="notice">确认恢复：${escapeHtml(annotation.note || "非业务流水")}</div>`,
      submitText: "恢复待批注",
      confirmMessage: "确认恢复为待批注？",
      onSubmit: async (formData, close) => {
        await apiMutate(`/api/annotations/${encodeURIComponent(annotationId)}/restore-non-business`);
        close();
        render();
        toast("已恢复为待批注流水");
      },
    });
    document.body.append(overlay);
  }

  function createFormModal({ title, desc, body, submitText, danger = false, confirmMessage = "", onSubmit }) {
    const overlay = document.createElement("div");
    overlay.className = "form-modal";
    overlay.innerHTML = `
      <section class="form-modal-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="form-modal-head">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(desc)}</p>
          </div>
          <button class="btn pagination-icon" type="button" data-form-modal-close aria-label="关闭">×</button>
        </div>
        <form class="form-modal-body">
          ${body}
          <div class="form-modal-actions">
            <button class="btn" type="button" data-form-modal-close>取消</button>
            <button class="btn ${danger ? "danger" : "primary"}" type="submit">${escapeHtml(submitText)}</button>
          </div>
        </form>
      </section>`;
    const close = () => {
      document.removeEventListener("keydown", handleKeydown);
      overlay.remove();
    };
    const handleKeydown = (event) => {
      if (event.key === "Escape") close();
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest("[data-form-modal-close]")) close();
    });
    overlay.querySelector("form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const formData = new FormData(event.target);
      const message = typeof confirmMessage === "function" ? confirmMessage(formData) : confirmMessage;
      if (message && !confirm(message)) return;
      const submitButton = event.target.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      try {
        await onSubmit(formData, close);
      } catch (error) {
        submitButton.disabled = false;
        toast(error.message);
      }
    });
    document.addEventListener("keydown", handleKeydown);
    queueMicrotask(() => overlay.querySelector("select, textarea, input, button")?.focus());
    return overlay;
  }

  async function submitWallet(event) {
    event.preventDefault();
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(data.address || "")) {
      toast("TRC20 钱包地址应为 T 开头的 34 位地址");
      return;
    }
    if (!confirm(`确认新增钱包「${data.alias || data.address}」？新增后会按纳入管理时间参与链上同步。`)) return;
    try {
      await apiMutate("/api/wallets", {
        body: {
          alias: data.alias,
          chain: data.chain,
          address: data.address,
          managedFrom: new Date(data.managedFrom).toISOString(),
        },
      });
      render();
      toast("钱包已新增");
    } catch (error) {
      toast(error.message);
    }
  }

  async function submitUser(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    const roleText = data.role === "supervisor" ? "主管" : "员工";
    if (!confirm(`确认创建${roleText}账号「${data.name || ""}」？`)) return;
    try {
      const payload = await apiMutate("/api/users", {
        body: {
          name: data.name,
          role: data.role,
          loginName: data.loginName,
          password: data.password,
          canViewAll: data.canViewAll === "on",
        },
      });
      render();
      toast(`${roleText}账号已创建，可使用登录账号和初始密码登录`);
      showTotpSetup(payload.totpSetup);
    } catch (error) {
      toast(error.message);
    }
  }

  async function resetTotp(userId) {
    const target = state.users.find((item) => item.id === userId);
    if (!target) return;
    if (!confirm(`确认重置「${target.name}」的登录密钥？旧验证码会立即失效。`)) return;
    try {
      const payload = await apiMutate(`/api/users/${encodeURIComponent(userId)}/totp`, { method: "PATCH" });
      render();
      toast("登录密钥已重置，请重新绑定");
      showTotpSetup(payload.totpSetup);
    } catch (error) {
      toast(error.message);
    }
  }

  function resetPassword(userId) {
    const target = state.users.find((item) => item.id === userId);
    if (!target) return;
    const overlay = createFormModal({
      title: "重置登录密码",
      desc: `为「${target.name}」设置新的登录密码，保存后旧密码立即失效。`,
      body: `
        <label>新密码<input name="password" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 位"></label>
        <label>确认新密码<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="6" required placeholder="再次输入新密码"></label>
      `,
      submitText: "确认重置",
      danger: true,
      onSubmit: async (formData, close) => {
        const password = String(formData.get("password") || "");
        const passwordConfirm = String(formData.get("passwordConfirm") || "");
        if (password !== passwordConfirm) throw new Error("两次输入的新密码不一致");
        await apiMutate(`/api/users/${encodeURIComponent(userId)}/password`, { method: "PATCH", body: { password } });
        render();
        toast("登录密码已重置");
        close();
      },
    });
    document.body.append(overlay);
  }

  function showTotpSetup(setup) {
    if (!setup?.secret) return;
    const overlay = createFormModal({
      title: "登录密钥绑定信息",
      desc: "请将以下密钥添加到 Google Authenticator、Microsoft Authenticator 等验证器；关闭后页面不再显示完整密钥。",
      body: `
        <section class="annotation-modal-summary">
          <div><span>登录账号</span><strong>${escapeHtml(setup.loginName || "-")}</strong></div>
          <div class="wide"><span>密钥</span><strong class="mono">${escapeHtml(setup.secret)}</strong></div>
          <div class="wide"><span>扫码链接</span><strong class="mono">${escapeHtml(setup.otpauthUrl || "-")}</strong></div>
        </section>
        <p class="form-hint">绑定后，该账号登录时除账号密码外，还需要输入验证器里的 6 位动态验证码。</p>
      `,
      submitText: "我已保存",
      onSubmit: async (_, close) => close(),
    });
    document.body.append(overlay);
  }

  async function submitTenant(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!confirm(`确认开通系统「${data.name || ""}」并创建主管「${data.supervisorName || ""}」？`)) return;
    try {
      const payload = await apiMutate("/api/tenants", { body: data });
      render();
      toast("系统已开通，主管可使用登录账号和初始密码登录");
      showTotpSetup(payload.totpSetup);
    } catch (error) {
      toast(error.message);
    }
  }

  async function updateTenantStatus(tenantId, enabled) {
    const tenant = state.tenants.find((item) => item.id === tenantId);
    if (!tenant) return;
    if (!confirm(`${enabled ? "启用" : "停用"}「${tenant.name}」？${enabled ? "" : "停用后该系统不会参与自动链上同步，历史数据仍会保留。"}`)) return;
    try {
      await apiMutate(`/api/tenants/${encodeURIComponent(tenantId)}/status`, {
        method: "PATCH",
        body: { enabled },
      });
      render();
      toast(enabled ? "系统已启用" : "系统已停用");
    } catch (error) {
      toast(error.message);
    }
  }

  async function submitSubscriptionSettings(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!confirm("确认保存租用收费设置？这会影响平台收款钱包、月租费用和续费开关。")) return;
    try {
      await apiMutate("/api/subscription/settings", {
        method: "PATCH",
        body: {
          monthlyFee: Number(data.monthlyFee),
          platformWalletAddress: data.platformWalletAddress,
          enabled: data.enabled === "on",
          autoDisable: data.autoDisable === "on",
        },
      });
      render();
      toast("租用收费设置已保存");
    } catch (error) {
      toast(error.message);
    }
  }

  async function submitSystemSettings(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    if (!confirm(`确认保存系统限制？钱包启用上限将设置为 ${data.walletEnabledLimit || 0} 个。`)) return;
    try {
      await apiMutate("/api/system/settings", {
        method: "PATCH",
        body: { walletEnabledLimit: Number(data.walletEnabledLimit) },
      });
      render();
      toast("系统限制已保存");
    } catch (error) {
      toast(error.message);
    }
  }

  async function submitSubscriptionHash(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    try {
      await apiMutate("/api/subscription/submit-hash", { body: { hash: data.hash } });
      render();
      toast("交易哈希已提交，续费处理完成");
    } catch (error) {
      toast(error.message);
    }
  }

  async function submitReceivable(event) {
    event.preventDefault();
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const formData = new FormData(event.target);
    const data = Object.fromEntries(formData.entries());
    if (!confirm(`确认新增${data.type === "payable" ? "应付款" : "应收款"}「${data.counterparty || ""}」，金额 ${data.amount || 0} USDT？`)) return;
    try {
      const attachment = await readUpload(formData.get("attachmentFile"));
      await apiMutate("/api/receivable-payables", {
        body: {
          type: data.type,
          counterparty: data.counterparty,
          amount: Number(data.amount),
          category: data.category,
          dueDate: data.dueDate,
          note: data.note,
          attachment,
        },
      });
      render();
      toast(currentUser().role === "supervisor" ? "往来款已创建" : "往来款已提交，等待主管审核");
    } catch (error) {
      toast(error.message);
    }
  }

  async function reviewReceivable(itemId, action) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    let rejectionReason = "";
    if (action === "reject") {
      rejectionReason = prompt("请输入驳回原因") || "";
      if (!rejectionReason.trim()) return;
    }
    if (!confirm(action === "approve" ? "确认审核通过这条往来款？" : "确认驳回这条往来款？")) return;
    try {
      await apiMutate(`/api/receivable-payables/${encodeURIComponent(itemId)}/review`, { body: { action, rejectionReason } });
      render();
      toast(action === "approve" ? "往来款已审核" : "往来款已驳回");
    } catch (error) {
      toast(error.message);
    }
  }

  function openTransactionSettlement(txId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const tx = tenantTransactions().find((entry) => entry.id === txId);
    if (!tx) return;
    const items = receivablesForTransaction(tx);
    const typeText = transactionDirection(tx) === "income" ? "应收款" : "应付款";
    const options = [
      `<option value="">请选择需要平账的${typeText}</option>`,
      ...items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.counterparty)} · ${escapeHtml(item.category)} · 剩余 ${money(item.remainingAmount || item.amount)} USDT</option>`),
    ].join("");
    const preview = items.length
      ? `<div class="empty slim">请选择需要平账的${typeText}，选择后系统会显示本次平账结果。</div>`
      : `<div class="empty slim">暂无可用${typeText}。请先在往来款管理中创建并审核对应往来款。</div>`;
    const overlay = createFormModal({
      title: `提交${typeText}平账`,
      desc: "当前链上流水会整笔用于平账，不能拆分或部分平账。",
      body: `
        ${renderAnnotationTxSummary(tx)}
        <label>选择${typeText}
          <select name="itemId" data-rp-item ${items.length ? "" : "disabled"}>${options}</select>
        </label>
        <div data-rp-preview>${preview}</div>
        <label><span class="field-label">平账说明 <em class="optional-mark">选填</em></span><textarea name="note" placeholder="可填写本次平账说明"></textarea></label>
      `,
      submitText: "提交平账",
      confirmMessage: `确认提交这条${typeText}平账？`,
      onSubmit: async (formData, close) => {
        const itemId = formData.get("itemId");
        if (!itemId) throw new Error(`请选择需要平账的${typeText}`);
        await apiMutate(`/api/receivable-payables/${encodeURIComponent(itemId)}/settlements`, {
          body: { txId: tx.id, note: formData.get("note") },
        });
        close();
        render();
        toast(currentUser().role === "supervisor" ? "平账已确认" : "平账已提交，等待主管审核");
      },
    });
    document.body.append(overlay);
    overlay.querySelector("[data-rp-item]")?.addEventListener("change", (event) => {
      const item = items.find((entry) => entry.id === event.target.value);
      overlay.querySelector("[data-rp-preview]").innerHTML = item ? renderReceivableSettlementPreview(item, tx, false) : "";
    });
  }

  function renderReceivableSettlementPreview(item, tx, includeTxSummary = true) {
    const nextSettled = Number(item.settledAmount || 0) + Number(tx.amount || 0);
    const over = Math.max(nextSettled - Number(item.amount || 0), 0);
    const remaining = Math.max(Number(item.amount || 0) - nextSettled, 0);
    return `<div class="settlement-preview">
      ${includeTxSummary ? renderAnnotationTxSummary(tx) : ""}
      <section class="annotation-modal-summary">
        <div><span>往来款</span><strong>${escapeHtml(item.counterparty)}</strong></div>
        <div><span>类型</span><strong>${rpTypeMap[item.type]}</strong></div>
        <div><span>剩余金额</span><strong>${money(item.remainingAmount || item.amount)} USDT</strong></div>
        <div><span>状态</span><strong>${badge(rpStatusMap, item.status)}</strong></div>
      </section>
      <div class="notice ${over > 0 ? "chain-status-off" : "chain-status-ok"}">
        本次将整笔平账 ${money(tx.amount)} USDT；平账后${remaining > 0 ? `剩余 ${money(remaining)} USDT` : "该往来款将结清"}${over > 0 ? `，${item.type === "receivable" ? "多收" : "多付"} ${money(over)} USDT` : ""}。
      </div>
    </div>`;
  }

  async function reviewReceivableSettlement(settlementId, action) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    let rejectionReason = "";
    if (action === "reject") {
      rejectionReason = prompt("请输入驳回原因") || "";
      if (!rejectionReason.trim()) return;
    }
    if (!confirm(action === "approve" ? "确认审核通过这条平账？" : "确认驳回这条平账？")) return;
    try {
      await apiMutate(`/api/receivable-settlements/${encodeURIComponent(settlementId)}/review`, { body: { action, rejectionReason } });
      render();
      toast(action === "approve" ? "平账已审核通过" : "平账已驳回");
    } catch (error) {
      toast(error.message);
    }
  }

  function voidReceivable(itemId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const item = tenantReceivables().find((entry) => entry.id === itemId);
    if (!item) return;
    const overlay = createFormModal({
      title: `作废${rpTypeMap[item.type]}`,
      desc: "作废后该往来款不再参与待收待付统计；请确认对象和金额无误。",
      danger: true,
      body: `
        <section class="annotation-modal-summary">
          <div><span>目标方</span><strong>${escapeHtml(item.counterparty)}</strong></div>
          <div><span>类型</span><strong>${badge({ receivable: ["应收款", "green"], payable: ["应付款", "red"] }, item.type)}</strong></div>
          <div><span>金额</span><strong>${money(item.amount)} USDT</strong></div>
          <div><span>已平</span><strong>${money(item.settledAmount || 0)} USDT</strong></div>
          <div><span>剩余</span><strong>${money(item.remainingAmount || 0)} USDT</strong></div>
          <div><span>状态</span><strong>${badge(rpStatusMap, item.status)} ${badge(rpReviewMap, item.reviewStatus)}</strong></div>
          <div><span>创建人</span><strong>${escapeHtml(userName(item.createdBy))}</strong></div>
          <div><span>创建时间</span><strong>${formatDate(item.createdAt)}</strong></div>
          <div class="wide"><span>业务说明</span><strong>${escapeHtml(item.note || "-")}</strong></div>
        </section>
        <label>作废原因
          <textarea name="reason" required placeholder="说明为什么需要作废"></textarea>
        </label>
      `,
      submitText: "确认作废",
      onSubmit: async (formData, close) => {
        await apiMutate(`/api/receivable-payables/${encodeURIComponent(item.id)}/void`, {
          body: { reason: formData.get("reason") },
        });
        close();
        render();
        toast("往来款已作废");
      },
    });
    document.body.append(overlay);
  }

  function openReceivableDetail(itemId) {
    const item = tenantReceivables().find((entry) => entry.id === itemId);
    if (!item) return;
    const settlements = settlementsForItem(item.id);
    const overlay = createFormModal({
      title: `${rpTypeMap[item.type]}详情`,
      desc: `${item.counterparty} · ${money(item.amount)} USDT`,
      body: `
        <section class="annotation-modal-summary">
          <div><span>目标方</span><strong>${escapeHtml(item.counterparty)}</strong></div>
          <div><span>金额</span><strong>${money(item.amount)} USDT</strong></div>
          <div><span>已平账</span><strong>${money(item.settledAmount || 0)} USDT</strong></div>
          <div><span>剩余</span><strong>${money(item.remainingAmount || 0)} USDT</strong></div>
          <div><span>状态</span><strong>${badge(rpStatusMap, item.status)} ${badge(rpReviewMap, item.reviewStatus)}</strong></div>
          <div><span>差额</span><strong>${Number(item.overAmount || 0) > 0 ? `${item.type === "receivable" ? "多收" : "多付"} ${money(item.overAmount)} USDT` : "-"}</strong></div>
          <div><span>凭证</span><strong>${item.attachmentName ? `<button class="attachment-link" data-rp-attachment="${item.id}">${escapeHtml(item.attachmentName)}</button>` : "无凭证"}</strong></div>
          <div class="wide"><span>说明</span><strong>${escapeHtml(item.note || "-")}</strong></div>
        </section>
        <div class="detail-list">
          ${settlements.map((settlement) => renderSettlementDetailRow(settlement)).join("") || `<div class="empty slim">暂无平账记录</div>`}
        </div>
      `,
      submitText: "关闭",
      onSubmit: async (_, close) => close(),
    });
    document.body.append(overlay);
  }

  function renderSettlementDetailRow(settlement) {
    const tx = state.chainTransactions.find((entry) => entry.id === settlement.txId);
    return `<article class="detail-card">
      <div class="detail-card-title"><strong>${money(settlement.amount)} USDT</strong>${badge(rpSettlementStatusMap, settlement.status)}</div>
      <dl class="detail-grid compact">
        <div><dt>提交人</dt><dd>${escapeHtml(userName(settlement.submittedBy))}</dd></div>
        <div><dt>提交时间</dt><dd>${formatDate(settlement.submittedAt)}</dd></div>
        <div class="wide"><dt>链上流水</dt><dd>${tx ? `${formatDate(tx.chainTime)} · ${transactionWalletText(tx)} · ${renderCopyHash(tx.hash, { short: true })}` : "-"}</dd></div>
        ${settlement.status === "pending" && canReview() && tenantBusinessActive() ? `<div class="wide actions"><button class="btn success" data-rps-review="${settlement.id}" data-action="approve">审核通过</button><button class="btn danger" data-rps-review="${settlement.id}" data-action="reject">驳回</button></div>` : ""}
        ${settlement.rejectionReason ? `<div class="wide"><dt>驳回原因</dt><dd>${escapeHtml(settlement.rejectionReason)}</dd></div>` : ""}
      </dl>
    </article>`;
  }

  async function manualRenewPayment(paymentId) {
    const payment = (state.platformPayments || []).find((item) => item.id === paymentId);
    if (!payment) return;
    openSubscriptionRenewModal({
      title: "处理异常续费收入",
      desc: "选择租户并填写续费月数或天数，适合金额不是整月、金额不足但人工确认的情况。",
      defaultReason: payment.reason || "平台收入手工确认",
      payment,
      onSubmit: async ({ tenantId, months, days, reason }, close) => {
        await apiMutate(`/api/subscription-payments/${encodeURIComponent(paymentId)}/manual-renew`, {
          body: { tenantId, months, days, reason },
        });
        close();
        render();
        toast("已手工续费");
      },
    });
  }

  async function manualRenewTenant(tenantId) {
    const tenant = state.tenants.find((item) => item.id === tenantId);
    if (!tenant) return;
    openSubscriptionRenewModal({
      title: `给「${tenant.name}」手工续费`,
      desc: "填写需要增加的月数和天数，至少一项大于 0；只按天续费时月数填 0。",
      fixedTenantId: tenant.id,
      defaultReason: "体外收费或异常金额人工处理",
      includeAmount: true,
      onSubmit: async ({ months, days, amount, reason }, close) => {
        await apiMutate(`/api/tenants/${encodeURIComponent(tenantId)}/manual-renew`, {
          body: { months, days, amount, reason },
        });
        close();
        render();
        toast("租户已手工续费");
      },
    });
  }

  function openSubscriptionRenewModal({ title, desc, fixedTenantId = "", defaultReason = "", includeAmount = false, payment = null, onSubmit }) {
    const tenantOptions = state.tenants.map((tenant) => `<option value="${escapeHtml(tenant.id)}" ${tenant.id === fixedTenantId || tenant.id === payment?.tenantId ? "selected" : ""}>${escapeHtml(tenant.name)}</option>`).join("");
    const overlay = createFormModal({
      title,
      desc,
      body: `
        ${payment ? `<section class="annotation-modal-summary">
          <div><span>收款金额</span><strong>${money(payment.amount)} USDT</strong></div>
          <div><span>当前状态</span><strong>${badge(platformPaymentStatusMap(), payment.status)}</strong></div>
          <div class="wide"><span>交易哈希</span><strong>${renderCopyHash(payment.hash)}</strong></div>
        </section>` : ""}
        <label>续费租户
          <select name="tenantId" ${fixedTenantId ? "disabled" : ""}>${tenantOptions}</select>
        </label>
        <div class="grid two-col">
          <label>续费月数<input name="months" type="number" min="0" step="1" value="1" required></label>
          <label>续费天数<input name="days" type="number" min="0" step="1" value="0" required></label>
        </div>
        ${includeAmount ? `<label><span class="field-label">实收金额 <em class="optional-mark">选填</em></span><input name="amount" type="number" min="0" step="0.000001" placeholder="例如 100"></label>` : ""}
        <label>处理原因<textarea name="reason" required placeholder="填写体外收费、金额异常或人工处理原因">${escapeHtml(defaultReason)}</textarea></label>
      `,
      submitText: "确认续费",
      confirmMessage: (formData) => {
        const tenant = state.tenants.find((item) => item.id === (fixedTenantId || formData.get("tenantId")));
        return `确认给「${tenant?.name || "所选系统"}」续费 ${formData.get("months") || 0} 个月 ${formData.get("days") || 0} 天？`;
      },
      onSubmit: async (formData, close) => {
        const months = Number(formData.get("months") || 0);
        const days = Number(formData.get("days") || 0);
        if (!Number.isInteger(months) || months < 0 || !Number.isInteger(days) || days < 0 || (months <= 0 && days <= 0)) {
          throw new Error("续费月数或天数必须至少有一个正整数");
        }
        await onSubmit({
          tenantId: fixedTenantId || formData.get("tenantId"),
          months,
          days,
          amount: includeAmount ? String(formData.get("amount") || "").trim() : undefined,
          reason: String(formData.get("reason") || "").trim(),
        }, close);
      },
    });
    document.body.append(overlay);
  }

  async function submitCategory(event) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    try {
      await apiMutate("/api/categories", { body: data });
      render();
      toast("分类已更新");
    } catch (error) {
      toast(error.message);
    }
  }

  async function renameCategory(type, oldName) {
    const name = prompt(`修改分类「${oldName}」`, oldName);
    if (!name || name.trim() === oldName) return;
    try {
      await apiMutate(`/api/categories/${encodeURIComponent(type)}/${encodeURIComponent(oldName)}`, {
        method: "PATCH",
        body: { name: name.trim() },
      });
      render();
      toast("分类已重命名");
    } catch (error) {
      toast(error.message);
    }
  }

  async function updateUserPermission(userId, canViewAll) {
    const user = state.users.find((item) => item.id === userId);
    if (!confirm(`确认${canViewAll ? "允许" : "取消"}「${user?.name || "该员工"}」查看全部账目？`)) {
      render();
      return;
    }
    try {
      await apiMutate(`/api/users/${encodeURIComponent(userId)}/permission`, { method: "PATCH", body: { canViewAll } });
      render();
      toast("员工查看权限已更新");
    } catch (error) {
      toast(error.message);
      render();
    }
  }

  async function disableWallet(walletId) {
    const wallet = state.wallets.find((item) => item.id === walletId);
    if (!wallet || !confirm(`确认停用钱包「${wallet.alias}」？历史流水会继续保留。`)) return;
    try {
      await apiMutate(`/api/wallets/${encodeURIComponent(walletId)}/disable`, { method: "PATCH", body: {} });
      render();
      toast("钱包已停用");
    } catch (error) {
      toast(error.message);
    }
  }

  async function enableWallet(walletId) {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    const wallet = state.wallets.find((item) => item.id === walletId);
    if (!wallet || !confirm(`确认启用钱包「${wallet.alias}」？启用后会重新参与链上同步。`)) return;
    try {
      await apiMutate(`/api/wallets/${encodeURIComponent(walletId)}/enable`, { method: "PATCH", body: {} });
      render();
      toast("钱包已启用");
    } catch (error) {
      toast(error.message);
    }
  }

  async function syncChain() {
    if (!tenantBusinessActive()) {
      toast(tenantBusinessLockText());
      return;
    }
    try {
      const payload = await apiMutate("/api/chain/sync", { body: { tenantId: visibleTenantId() } });
      await refreshChainStatus();
      render();
      const failed = payload.failedWallets?.length ? `，${payload.failedWallets.length} 个钱包失败` : "";
      toast(`TRON 同步完成，新增 ${payload.createdCount || 0} 条流水${failed}`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function refreshChainStatus() {
    try {
      const response = await fetch(`/api/chain/status?tenantId=${encodeURIComponent(visibleTenantId())}`, { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "链上接口状态读取失败");
      state.chainStatus = payload;
      for (const walletStatus of payload.wallets || []) {
        const wallet = state.wallets.find((item) => item.id === walletStatus.id);
        if (!wallet) continue;
        wallet.chainBalance = walletStatus.chainBalance;
        wallet.chainBalanceUpdatedAt = walletStatus.chainBalanceUpdatedAt;
        wallet.lastSyncedAt = walletStatus.lastSyncedAt;
        wallet.lastSyncAttemptAt = walletStatus.lastSyncAttemptAt;
        wallet.lastSyncError = walletStatus.lastSyncError;
      }
      if (Array.isArray(payload.walletBalanceSnapshots)) {
        const visibleTenant = visibleTenantId();
        state.walletBalanceSnapshots = [
          ...(state.walletBalanceSnapshots || []).filter((snapshot) => snapshot.tenantId !== visibleTenant),
          ...payload.walletBalanceSnapshots,
        ];
      }
    } catch (error) {
      state.chainStatus = { configured: false, reason: error.message, wallets: [], walletCount: 0 };
    }
  }

  function manageServerMetricsRefresh() {
    if (state.activeView !== "server") {
      if (serverMetricsTimer) {
        clearInterval(serverMetricsTimer);
        serverMetricsTimer = null;
      }
      return;
    }
    if (serverMetricsTimer) return;
    serverMetricsTimer = setInterval(async () => {
      if (state.activeView !== "server") return manageServerMetricsRefresh();
      await refreshServerMetrics();
      render();
    }, 10000);
  }

  async function refreshServerMetrics() {
    try {
      const response = await fetch("/api/server/metrics", { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "服务器状态读取失败");
      serverMetrics = payload;
    } catch (error) {
      toast(error.message);
    }
  }

  async function manualChainSearch(event) {
    event.preventDefault();
    const query = new FormData(event.target).get("query").trim();
    const box = document.querySelector("#manualResult");
    try {
      const response = await fetch("/api/chain/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ query, tenantId: visibleTenantId() }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "查询失败");
      if (payload.state) state = payload.state;
      const result = payload.results?.[0] || (Array.isArray(payload.externalResult) ? payload.externalResult[0] : null);
      box.innerHTML = result
        ? `<div class="card" style="margin-top:12px"><div class="card-label">查询结果</div><div class="card-value">${money(result.amount)} USDT</div><div class="card-foot">${formatDate(result.chainTime)} · ${result.direction === "income" ? "转入" : "转出"} · ${result.confirmed ? "已确认" : "未确认"}</div><p>${renderCopyHash(result.hash)}</p></div>`
        : `<div class="card" style="margin-top:12px"><div class="card-label">未查询到记录</div><div class="card-foot">${payload.configured ? "TRON 链上及本地同步记录均未发现该交易。" : `当前未配置 TRON API：${payload.reason || "请设置 TRON_API_KEY"}`}</div><p class="mono">${isLikelyTransactionHash(query) ? renderCopyHash(query) : escapeHtml(query)}</p></div>`;
    } catch (error) {
      box.innerHTML = `<div class="card" style="margin-top:12px"><div class="card-label">查询失败</div><div class="card-foot">${error.message}</div></div>`;
    }
  }

  async function showDetail(txId) {
    try {
      const response = await fetch(`/api/chain-transactions/${encodeURIComponent(txId)}/detail`, { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "详情加载失败");
      const { tx, pairedTx, annotations, logs } = payload;
      openDetailViewer({ tx, pairedTx, annotations, logs });
    } catch (error) {
      toast(error.message);
    }
  }

  function openDetailViewer({ tx, pairedTx, annotations, logs }) {
    const wallet = state.wallets.find((item) => item.id === tx.walletId);
    const direction = transactionDirection(tx);
    const transferText = pairedTx
      ? `已配对内部划转：${tx.id} / ${pairedTx.id}`
      : tx.internalTransferStatus === "pending" ? "另一侧钱包流水待同步" : "";
    const overlay = document.createElement("div");
    overlay.className = "detail-viewer";
    overlay.innerHTML = `
      <section class="detail-dialog" role="dialog" aria-modal="true" aria-label="流水详情">
        <div class="detail-head">
          <div>
            <h3>${directionPill(direction)} <span class="amount-${direction}">${money(tx.amount)} USDT</span></h3>
            <p>${formatDate(tx.chainTime)} · ${escapeHtml(wallet?.alias || "-")}</p>
          </div>
          <button class="btn pagination-icon" type="button" data-detail-close aria-label="关闭详情">×</button>
        </div>
        <div class="detail-body">
          <section class="detail-section">
            <h4>链上流水</h4>
            ${renderAnnotationTxSummary(tx)}
            <dl class="detail-chain-extra">
              <div><dt>对方地址</dt><dd class="mono">${escapeHtml(tx.counterparty || "-")}</dd></div>
              ${transferText ? `<div><dt>内部划转</dt><dd class="mono">${escapeHtml(transferText)}</dd></div>` : ""}
            </dl>
          </section>
          <section class="detail-section">
            <h4>批注版本</h4>
            ${annotations.length ? `<div class="detail-list">${annotations.map((annotation) => `
              <article class="detail-card">
                <div class="detail-card-title">
                  <strong>第 ${annotation.version} 版</strong>
                  ${badge(statusMap, displayStatus(annotation))}
                </div>
                <dl class="detail-grid compact">
                  <div><dt>批注人</dt><dd>${escapeHtml(userName(annotation.annotatedBy))}</dd></div>
                  <div><dt>分类</dt><dd>${escapeHtml(annotation.category || "-")}</dd></div>
                  <div class="wide"><dt>说明</dt><dd>${escapeHtml(annotation.note || "-")}</dd></div>
                  ${annotation.rejectionReason ? `<div class="wide"><dt>驳回原因</dt><dd>${escapeHtml(annotation.rejectionReason)}</dd></div>` : ""}
                  ${annotation.attachmentName ? `<div class="wide"><dt>凭证</dt><dd><button class="attachment-link" data-detail-attachment="${annotation.id}">${escapeHtml(annotation.attachmentName)}</button></dd></div>` : ""}
                </dl>
              </article>`).join("")}</div>` : `<div class="empty slim">暂无批注版本</div>`}
          </section>
          <section class="detail-section">
            <h4>操作日志</h4>
            ${logs.length ? `<div class="detail-log-list">${logs.map((log) => `
              <div class="detail-log-row">
                <time>${formatDate(log.createdAt)}</time>
                <span>${escapeHtml(userName(log.userId))}</span>
                <strong>${escapeHtml(log.action)}</strong>
              </div>`).join("")}</div>` : `<div class="empty slim">暂无操作日志</div>`}
          </section>
        </div>
        <div class="detail-actions"><button class="btn primary" type="button" data-detail-close>关闭</button></div>
      </section>`;
    const close = () => {
      document.removeEventListener("keydown", handleKeydown);
      overlay.remove();
    };
    const handleKeydown = (event) => {
      if (event.key === "Escape") close();
    };
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target.closest("[data-detail-close]")) close();
    });
    overlay.querySelectorAll("[data-detail-attachment]").forEach((button) => {
      button.addEventListener("click", () => previewAttachment(button.dataset.detailAttachment));
    });
    document.addEventListener("keydown", handleKeydown);
    document.body.append(overlay);
    overlay.querySelector("[data-detail-close]").focus();
  }

  async function refreshLogs() {
    try {
      const response = await fetch(`/api/audit-logs?tenantId=${encodeURIComponent(visibleTenantId())}`, { headers: authHeaders() });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "日志加载失败");
      state.auditLogs = [...(payload.logs || []), ...state.auditLogs.filter((log) => log.tenantId !== visibleTenantId())];
    } catch (error) {
      toast(error.message);
    }
  }

  async function exportCsv() {
    const filters = { ...entryFilters };
    filters.tenantId = visibleTenantId();
    try {
      const response = await fetch("/api/exports/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ filters }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "导出失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `链上流水批注-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast("CSV 已导出");
    } catch (error) {
      toast(error.message);
    }
  }

  async function exportReceivablesCsv() {
    const filters = { ...receivableFilters, tenantId: visibleTenantId() };
    try {
      const response = await fetch("/api/exports/receivables", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ filters }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "导出失败");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = `往来款-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast("往来款 CSV 已导出");
    } catch (error) {
      toast(error.message);
    }
  }

  async function previewAttachment(annotationId) {
    return previewProof(`/api/annotations/${encodeURIComponent(annotationId)}/attachment`);
  }

  async function previewReceivableAttachment(itemId) {
    return previewProof(`/api/receivable-payables/${encodeURIComponent(itemId)}/attachment`);
  }

  async function previewProof(url) {
    try {
      const response = await fetch(url, { headers: authHeaders() });
      if (!response.ok) throw new Error((await response.json()).error || "凭证加载失败");
      const disposition = response.headers.get("Content-Disposition") || "";
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const name = encodedName ? decodeURIComponent(encodedName) : "凭证图片";
      const blob = await response.blob();
      if (!blob.type.startsWith("image/")) {
        downloadProofBlob(blob, name);
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      const overlay = document.createElement("div");
      overlay.className = "proof-viewer";
      overlay.innerHTML = `
        <div class="proof-viewer-dialog" role="dialog" aria-modal="true" aria-label="凭证预览">
          <div class="proof-viewer-head">
            <strong>${escapeHtml(name)}</strong>
            <button class="btn pagination-icon" type="button" data-proof-close aria-label="关闭预览">×</button>
          </div>
          <div class="proof-viewer-body"><img src="${objectUrl}" alt="${escapeHtml(name)}"></div>
          <div class="proof-viewer-actions">
            <button class="btn" type="button" data-proof-download>下载图片</button>
            <button class="btn primary" type="button" data-proof-close>关闭</button>
          </div>
        </div>`;
      const close = () => {
        document.removeEventListener("keydown", handleKeydown);
        URL.revokeObjectURL(objectUrl);
        overlay.remove();
      };
      const handleKeydown = (event) => {
        if (event.key === "Escape") close();
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-proof-close]")) close();
      });
      overlay.querySelector("[data-proof-download]").addEventListener("click", () => downloadProofBlob(blob, name));
      document.addEventListener("keydown", handleKeydown);
      document.body.append(overlay);
      overlay.querySelector("[data-proof-close]").focus();
    } catch (error) {
      toast(error.message);
    }
  }

  function downloadProofBlob(blob, name) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    toast("凭证已下载");
  }

  async function readUpload(file) {
    if (!(file instanceof File) || !file.size) return null;
    if (file.size > 10 * 1024 * 1024) throw new Error("凭证图片不能超过 10MB");
    if (!file.type.startsWith("image/")) throw new Error("凭证只支持图片");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { name: file.name, type: file.type, size: file.size, dataUrl };
  }

  function changeEntriesPage(page) {
    entriesPage = Number(page);
    render();
    window.scrollTo(0, 0);
  }

  function changeLogsPage(page) {
    logsPage = Number(page);
    render();
    window.scrollTo(0, 0);
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function migrateState() {
    state.annotations ||= [];
    state.chainTransactions ||= [];
    state.auditLogs ||= [];
    state.walletBalanceSnapshots ||= [];
    state.platformPayments ||= [];
    state.receivablePayables ||= [];
    state.receivableSettlements ||= [];
    state.subscriptionSettings ||= { monthlyFee: 100, platformWalletAddress: "", enabled: false, autoDisable: true };
    state.subscriptionSettings.monthlyFee ||= 100;
    state.subscriptionSettings.platformWalletAddress ||= "";
    state.subscriptionSettings.enabled = state.subscriptionSettings.enabled === true;
    state.subscriptionSettings.autoDisable = state.subscriptionSettings.autoDisable !== false;
    state.systemSettings ||= { walletEnabledLimit: 0 };
    state.systemSettings.walletEnabledLimit = Number.isInteger(Number(state.systemSettings.walletEnabledLimit)) && Number(state.systemSettings.walletEnabledLimit) >= 0
      ? Number(state.systemSettings.walletEnabledLimit)
      : 0;
    state.entries ||= [];
    state.legacyEntries ||= [];
    state.tenants.forEach((tenant) => {
      tenant.subscriptionStatus ||= tenant.subscriptionExpiresAt ? "active" : "unset";
    });
    for (const tx of state.chainTransactions) {
      tx.currentAnnotationId ||= null;
      delete tx.matchedEntryId;
      delete tx.deletedAt;
      delete tx.deletedBy;
    }
    for (const entry of state.entries) {
      const tx = state.chainTransactions.find((item) => item.id === entry.chainTxId);
      if (!tx) {
        if (!state.legacyEntries.some((item) => item.id === entry.id)) state.legacyEntries.push(entry);
        continue;
      }
      if (state.annotations.some((item) => item.legacyEntryId === entry.id)) continue;
      const annotation = {
        id: `annotation_${entry.id}`, tenantId: entry.tenantId, chainTxId: tx.id,
        category: entry.category || (tx.direction === "income" ? "其他进账" : "其他出账"),
        note: entry.note || "", attachmentName: entry.attachmentName || "", attachment: entry.attachment || null,
        annotatedBy: entry.submittedBy, annotatedAt: entry.createdAt || entry.occurredAt || tx.chainTime,
        status: entry.status || "approved", reviewedBy: entry.reviewedBy || null, reviewedAt: entry.reviewedAt || null,
        rejectionReason: "", previousAnnotationId: null, version: 1,
        correctionType: entry.status === "corrected" ? "correction" : null,
        createdAt: entry.createdAt || entry.occurredAt || tx.chainTime, legacyEntryId: entry.id,
      };
      state.annotations.push(annotation);
      tx.currentAnnotationId = annotation.id;
    }
    state.entries = [];
    for (const wallet of state.wallets) {
      if (wallet.managedFrom) continue;
      const annotatedTimes = state.chainTransactions
        .filter((tx) => tx.walletId === wallet.id && tx.currentAnnotationId)
        .map((tx) => tx.chainTime)
        .filter(Boolean)
        .sort();
      wallet.managedFrom = annotatedTimes[0] || wallet.createdAt || new Date(managedFromPreset("today")).toISOString();
    }
    reconcileInternalTransfers();
  }

  function reconcileInternalTransfers() {
    const walletsByAddress = new Map(state.wallets.map((wallet) => [`${wallet.tenantId}:${wallet.address}`, wallet]));
    state.chainTransactions.forEach((tx) => {
      tx.pairedTxId = null;
      if (tx.transactionType === "transfer") tx.transactionType = null;
      tx.internalTransferStatus = null;
      tx.transferPrimary = false;
    });
    state.chainTransactions.filter((tx) => tx.direction === "expense").forEach((outgoing) => {
      const targetWallet = walletsByAddress.get(`${outgoing.tenantId}:${outgoing.counterparty}`);
      if (!targetWallet || targetWallet.id === outgoing.walletId) return;
      const sourceWallet = state.wallets.find((wallet) => wallet.id === outgoing.walletId);
      outgoing.transactionType = "transfer";
      outgoing.internalTransferStatus = "pending";
      outgoing.transferPrimary = true;
      const incoming = state.chainTransactions.find((candidate) => candidate.tenantId === outgoing.tenantId
        && candidate.walletId === targetWallet.id
        && candidate.direction === "income"
        && candidate.hash === outgoing.hash
        && Number(candidate.amount) === Number(outgoing.amount)
        && (!sourceWallet || candidate.counterparty === sourceWallet.address));
      if (!incoming) return;
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
    });
    state.chainTransactions.filter((tx) => tx.direction === "income" && tx.transactionType !== "transfer").forEach((incoming) => {
      const sourceWallet = walletsByAddress.get(`${incoming.tenantId}:${incoming.counterparty}`);
      if (!sourceWallet || sourceWallet.id === incoming.walletId) return;
      incoming.transactionType = "transfer";
      incoming.internalTransferStatus = "pending";
      incoming.transferPrimary = true;
    });
  }

  async function init() {
    bindGlobalCopyHash();
    startAppVersionCheck();
    await ensureInitialState();
    state = await load();
    if (session?.token) {
      migrateState();
      restoreUiState();
      delete state.chainStatus;
      save();
    }
    render();
    refreshVisibleChainStatus();
  }

  init();
})();
