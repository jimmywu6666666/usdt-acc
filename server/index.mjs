import "./config.mjs";
import { createServer } from "node:http";
import { readdir, stat, statfs } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendLog,
  assertAdmin,
  assertSupervisorOrAdmin,
  createCategory,
  createEmployee,
  createAnnotation,
  createReceivablePayable,
  createReceivableSettlement,
  createTenant,
  createWallet,
  disableWallet,
  enableWallet,
  exportAnnotationsCsv,
  exportReceivablePayablesCsv,
  getAnnotationAttachment,
  getReceivableAttachment,
  getAuditLogsForUser,
  getTransactionDetail,
  manualRenewSubscriptionPayment,
  manualRenewTenantSubscription,
  markTransactionNonBusiness,
  reconcileState,
  requestAnnotationCorrection,
  requestAnnotationReversal,
  restoreNonBusinessTransaction,
  resubmitAnnotation,
  resetUserPassword,
  resetUserTotp,
  reviewAnnotation,
  reviewReceivablePayable,
  reviewReceivableSettlement,
  searchChainTransactions,
  submitSubscriptionHash,
  updateSubscriptionSettings,
  updateSystemSettings,
  updateCategory,
  updateEmployeePermission,
  updateTenantStatus,
  updateWalletManagedFrom,
  voidReceivablePayable,
} from "./domain.mjs";
import { createSession, destroySession, getToken, publicUser, requireSession, totpSetupForUser, verifyPassword, verifyTotp } from "./auth.mjs";
import { createStorage } from "./storage.mjs";
import { createTronProvider } from "./tron-provider.mjs";
import { startChainSyncScheduler, syncTenantWallets } from "./chain-sync.mjs";
import { createAttachmentStore } from "./attachment-storage.mjs";
import { annotationForClient, stateForUser } from "./state-view.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const appEnv = process.env.APP_ENV || "development";
const nodeEnv = process.env.NODE_ENV || "development";
const productionMode = process.env.APP_ENV === "production";
const storage = await createStorage();
const attachmentStore = createAttachmentStore({ rootDir: process.env.ATTACHMENT_DIR || path.join(rootDir, "data/attachments") });
const tronProvider = createTronProvider();
const chainScheduler = startChainSyncScheduler({ storage, tronProvider });
const appVersionFiles = ["index.html", "assets/app.js", "assets/styles.css"];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendCsv(res, filename, csv) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  res.end(`\ufeff${csv}`);
}

async function getAppVersion() {
  const stats = await Promise.all(appVersionFiles.map(async (file) => {
    const fileStat = await stat(path.join(rootDir, file));
    return `${file}:${fileStat.size}:${Math.trunc(fileStat.mtimeMs)}`;
  }));
  return stats.join("|");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (Buffer.concat(chunks).byteLength > 15 * 1024 * 1024) {
      throw new Error("请求体过大");
    }
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function handleApi(req, res, pathname) {
  let responseUser = null;
  const authenticate = async (state) => {
    const session = await requireSession(storage, req, state);
    responseUser = session.user;
    return session;
  };
  const respond = (statusCode, payload) => {
    const responsePayload = responseUser && payload?.state
      ? { ...payload, state: stateForUser(payload.state, responseUser) }
      : payload;
    sendJson(res, statusCode, responsePayload);
  };

  if (pathname === "/api/health" && req.method === "GET") {
    respond(200, {
      ok: true,
      service: "usdt-ledger-system",
      storage: storage.kind,
      chainProvider: tronProvider.kind,
      chainConfigured: tronProvider.configured === true,
      chainReason: tronProvider.reason || "",
      chainScheduler: chainScheduler.status,
      appEnv,
      nodeEnv,
      productionMode,
    });
    return;
  }

  if (pathname === "/api/app-version" && req.method === "GET") {
    respond(200, { version: await getAppVersion() });
    return;
  }

  if (pathname === "/api/server/metrics" && req.method === "GET") {
    const state = await storage.readState();
    if (!state) throw Object.assign(new Error("系统状态尚未初始化"), { statusCode: 404 });
    const { user } = await authenticate(state);
    assertAdmin(user);
    const metrics = await collectServerMetrics(state);
    respond(200, metrics);
    return;
  }

  if (pathname === "/api/chain/status" && req.method === "GET") {
    const state = await storage.readState();
    if (!state) throw Object.assign(new Error("系统状态尚未初始化"), { statusCode: 404 });
    const { user } = await authenticate(state);
    const tenantId = user.role === "admin"
      ? new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("tenantId") || state.activeTenantId
      : user.tenantId;
    const wallets = state.wallets.filter((wallet) => wallet.tenantId === tenantId && wallet.enabled);
    respond(200, {
      configured: tronProvider.configured === true,
      provider: tronProvider.kind,
      reason: tronProvider.reason || "",
      scheduler: chainScheduler.status,
      walletCount: wallets.length,
      walletBalanceSnapshots: (state.walletBalanceSnapshots || []).filter((snapshot) => snapshot.tenantId === tenantId),
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        alias: wallet.alias,
        chainBalance: wallet.chainBalance ?? null,
        lastSyncedAt: wallet.lastSyncedAt || null,
        lastSyncAttemptAt: wallet.lastSyncAttemptAt || null,
        lastSyncError: wallet.lastSyncError || "",
        chainBalanceUpdatedAt: wallet.chainBalanceUpdatedAt || null,
      })),
    });
    return;
  }

  if (pathname === "/api/auth/accounts" && req.method === "GET") {
    const state = await storage.readState();
    const hasAccounts = Boolean(state?.users?.length);
    respond(200, {
      hasAccounts,
      users: productionMode || !state ? [] : state.users.map(publicUser),
      appEnv,
      nodeEnv,
      productionMode,
    });
    return;
  }

  if (pathname === "/api/auth/login" && req.method === "POST") {
    const state = await storage.readState();
    if (!state) {
      const error = new Error("系统状态尚未初始化");
      error.statusCode = 404;
      throw error;
    }
    const body = await readJsonBody(req);
    const loginName = String(body.loginName || body.account || body.userId || "").trim();
    const user = findLoginUser(state.users || [], loginName);
    if (!user || !verifyPassword(user, body.password || "", { allowDemoPassword: !productionMode })) {
      appendLog(state, {
        tenantId: user?.tenantId || null,
        userId: user?.id || loginName || "unknown",
        action: "登录失败",
        target: user?.name || loginName || "未知账号",
      });
      await storage.writeState?.(state);
      const error = new Error("账号或密码不正确");
      error.statusCode = 401;
      throw error;
    }
    if (user.totpSecret && !verifyTotp(user, body.totpCode || body.totp || "")) {
      appendLog(state, {
        tenantId: user.tenantId || null,
        userId: user.id,
        action: "登录失败",
        target: `${user.name}:登录密钥`,
      });
      await storage.writeState?.(state);
      const error = new Error("动态验证码不正确");
      error.statusCode = 401;
      throw error;
    }
    appendLog(state, { tenantId: user.tenantId || null, userId: user.id, action: "登录系统", target: user.name });
    await storage.writeState?.(state);
    const token = await createSession(storage, user);
    responseUser = user;
    state.activeUserId = user.id;
    if (user.tenantId) state.activeTenantId = user.tenantId;
    respond(200, { token, user: publicUser(user), state });
    return;
  }

  if (pathname === "/api/auth/logout" && req.method === "POST") {
    await destroySession(storage, getToken(req));
    respond(200, { ok: true });
    return;
  }

  if (pathname === "/api/state" && req.method === "GET") {
    const state = await storage.readState();
    if (!state) {
      respond(200, { state: null });
      return;
    }
    reconcileState(state);
    const { user } = await authenticate(state);
    state.activeUserId = user.id;
    if (user.tenantId) state.activeTenantId = user.tenantId;
    respond(200, { state });
    return;
  }

  if (pathname === "/api/state" && req.method === "PUT") {
    if (productionMode) {
      const error = new Error("生产环境禁止从前端初始化系统状态");
      error.statusCode = 403;
      throw error;
    }
    const body = await readJsonBody(req);
    const existingState = await storage.readState();
    if (existingState) {
      const error = new Error("系统状态已初始化，禁止客户端整体覆盖服务器数据");
      error.statusCode = 409;
      throw error;
    }
    reconcileState(body.state);
    await storage.writeState(body.state);
    respond(200, { ok: true });
    return;
  }

  if (pathname === "/api/chain/sync" && req.method === "POST") {
    const body = await readJsonBody(req);
    const currentState = await storage.readState();
    if (!currentState) throw Object.assign(new Error("系统状态尚未初始化"), { statusCode: 404 });
    const { user: currentUser } = await authenticate(currentState);
    const tenantId = currentUser.role === "admin" ? body.tenantId : currentUser.tenantId;
    assertSupervisorOrAdmin(currentState, currentUser, tenantId);
    const result = await syncTenantWallets({
      storage,
      tronProvider,
      tenantId,
      actorUserId: currentUser.id,
    });
    respond(200, { ok: true, ...result });
    return;
  }

  if (pathname === "/api/subscription/settings" && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateSubscriptionSettings(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/system/settings" && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateSystemSettings(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/subscription/submit-hash" && req.method === "POST") {
    const body = await readJsonBody(req);
    const currentState = await storage.readState();
    if (!currentState) throw Object.assign(new Error("系统状态尚未初始化"), { statusCode: 404 });
    const { user: currentUser } = await authenticate(currentState);
    if (currentUser.role !== "supervisor") throw Object.assign(new Error("只有主管可以提交租用续费哈希"), { statusCode: 403 });
    const settings = currentState.subscriptionSettings || {};
    if (!settings.platformWalletAddress) throw Object.assign(new Error("管理员暂未配置平台收款钱包"), { statusCode: 400 });
    if (tronProvider.kind !== "tron") throw Object.assign(new Error(tronProvider.reason || "尚未配置真实 TRON 接口"), { statusCode: 503 });
    const submittedHash = String(body.hash || "").trim().toLowerCase();
    const minTimestamp = new Date(Date.now() - Number(process.env.TRON_SUBSCRIPTION_HASH_LOOKBACK_DAYS || 90) * 24 * 60 * 60 * 1000).toISOString();
    const transactions = await tronProvider.fetchWalletTransactions({
      id: "platform_subscription_wallet",
      address: settings.platformWalletAddress,
    }, { minTimestamp });
    const transaction = transactions.find((item) => String(item.hash || "").toLowerCase() === submittedHash);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      submitSubscriptionHash(current, { user, hash: submittedHash, transaction });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const manualSubscriptionRenew = pathname.match(/^\/api\/subscription-payments\/([^/]+)\/manual-renew$/);
  if (manualSubscriptionRenew && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      manualRenewSubscriptionPayment(current, {
        user,
        paymentId: manualSubscriptionRenew[1],
        tenantId: body.tenantId,
        months: body.months,
        days: body.days,
        reason: body.reason,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const manualTenantSubscriptionRenew = pathname.match(/^\/api\/tenants\/([^/]+)\/manual-renew$/);
  if (manualTenantSubscriptionRenew && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      manualRenewTenantSubscription(current, {
        user,
        tenantId: manualTenantSubscriptionRenew[1],
        months: body.months,
        days: body.days,
        amount: body.amount,
        reason: body.reason,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/chain/search" && req.method === "POST") {
    const body = await readJsonBody(req);
    let results = [];
    let externalResult = null;
    let searchTenantId = null;
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      searchTenantId = user.role === "admin" ? body.tenantId || current.activeTenantId : user.tenantId;
      results = searchChainTransactions(current, { user, query: body.query, tenantId: body.tenantId });
      return current;
    });
    if (!results.length && tronProvider.kind === "tron") {
      const wallet = state.wallets.find((item) => item.address === body.query && item.tenantId === searchTenantId);
      if (wallet) {
        externalResult = await tronProvider.fetchWalletTransactions(wallet, {
          minTimestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
      } else {
        externalResult = await tronProvider.searchTransaction(body.query);
      }
    }
    respond(200, {
      ok: true,
      state,
      results,
      externalResult,
      provider: tronProvider.kind,
      configured: tronProvider.configured === true,
      reason: tronProvider.reason || "",
    });
    return;
  }

  if (pathname === "/api/annotations" && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      const annotation = createAnnotation(current, { user, input: { ...body, attachment: null } });
      await storeAnnotationUpload(annotation, body.attachment);
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/receivable-payables" && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      const item = createReceivablePayable(current, { user, input: { ...body, attachment: null } });
      await storeReceivableUpload(item, body.attachment);
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const receivableReview = pathname.match(/^\/api\/receivable-payables\/([^/]+)\/review$/);
  if (receivableReview && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      reviewReceivablePayable(current, {
        user,
        itemId: receivableReview[1],
        action: body.action,
        rejectionReason: body.rejectionReason,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const receivableVoid = pathname.match(/^\/api\/receivable-payables\/([^/]+)\/void$/);
  if (receivableVoid && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      voidReceivablePayable(current, { user, itemId: receivableVoid[1], reason: body.reason });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const receivableSettlement = pathname.match(/^\/api\/receivable-payables\/([^/]+)\/settlements$/);
  if (receivableSettlement && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      createReceivableSettlement(current, {
        user,
        itemId: receivableSettlement[1],
        txId: body.txId,
        note: body.note,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const settlementReview = pathname.match(/^\/api\/receivable-settlements\/([^/]+)\/review$/);
  if (settlementReview && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      reviewReceivableSettlement(current, {
        user,
        settlementId: settlementReview[1],
        action: body.action,
        rejectionReason: body.rejectionReason,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/wallets" && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      createWallet(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const disableWalletMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/disable$/);
  if (disableWalletMatch && req.method === "PATCH") {
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      disableWallet(current, { user, walletId: disableWalletMatch[1] });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const enableWalletMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/enable$/);
  if (enableWalletMatch && req.method === "PATCH") {
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      enableWallet(current, { user, walletId: enableWalletMatch[1] });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const updateWalletManagedFromMatch = pathname.match(/^\/api\/wallets\/([^/]+)\/managed-from$/);
  if (updateWalletManagedFromMatch && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateWalletManagedFrom(current, {
        user,
        walletId: updateWalletManagedFromMatch[1],
        managedFrom: body.managedFrom,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/users" && req.method === "POST") {
    const body = await readJsonBody(req);
    let createdUser = null;
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      createdUser = createEmployee(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state, totpSetup: totpSetupForUser(createdUser) });
    return;
  }

  const resetTotp = pathname.match(/^\/api\/users\/([^/]+)\/totp$/);
  if (resetTotp && req.method === "PATCH") {
    let targetUser = null;
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      targetUser = resetUserTotp(current, { user, userId: resetTotp[1] });
      return current;
    });
    respond(200, { ok: true, state, totpSetup: totpSetupForUser(targetUser) });
    return;
  }

  const resetPassword = pathname.match(/^\/api\/users\/([^/]+)\/password$/);
  if (resetPassword && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      resetUserPassword(current, { user, userId: resetPassword[1], password: body.password });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const updatePermission = pathname.match(/^\/api\/users\/([^/]+)\/permission$/);
  if (updatePermission && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateEmployeePermission(current, { user, employeeId: updatePermission[1], canViewAll: body.canViewAll });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/tenants" && req.method === "POST") {
    const body = await readJsonBody(req);
    let created = null;
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      created = createTenant(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state, totpSetup: totpSetupForUser(created?.supervisor) });
    return;
  }

  const tenantStatus = pathname.match(/^\/api\/tenants\/([^/]+)\/status$/);
  if (tenantStatus && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateTenantStatus(current, { user, tenantId: tenantStatus[1], enabled: body.enabled === true });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/categories" && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      createCategory(current, { user, input: body });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const categoryUpdate = pathname.match(/^\/api\/categories\/(income|expense)\/(.+)$/);
  if (categoryUpdate && req.method === "PATCH") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      updateCategory(current, {
        user,
        type: categoryUpdate[1],
        oldName: decodeURIComponent(categoryUpdate[2]),
        input: body,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  if (pathname === "/api/exports/annotations" && req.method === "POST") {
    const body = await readJsonBody(req);
    let csv = "";
    await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      csv = exportAnnotationsCsv(current, { user, filters: body.filters || {} });
      appendLog(current, {
        tenantId: user.role === "admin" ? body.filters?.tenantId || current.activeTenantId : user.tenantId,
        userId: user.id,
        action: "导出链上流水批注",
        target: `filters:${Object.keys(body.filters || {}).filter((key) => body.filters[key]).join("|") || "全部"}`,
      });
      return current;
    });
    sendCsv(res, `ledger-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    return;
  }

  if (pathname === "/api/exports/receivables" && req.method === "POST") {
    const body = await readJsonBody(req);
    let csv = "";
    await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      csv = exportReceivablePayablesCsv(current, { user, filters: body.filters || {} });
      appendLog(current, {
        tenantId: user.role === "admin" ? body.filters?.tenantId || current.activeTenantId : user.tenantId,
        userId: user.id,
        action: "导出往来款",
        target: `filters:${Object.keys(body.filters || {}).filter((key) => body.filters[key]).join("|") || "全部"}`,
      });
      return current;
    });
    sendCsv(res, `receivables-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    return;
  }

  if (pathname === "/api/audit-logs" && req.method === "GET") {
    const state = await storage.readState();
    if (!state) {
      respond(200, { logs: [] });
      return;
    }
    const { user } = await authenticate(state);
    const tenantId = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("tenantId");
    respond(200, { logs: getAuditLogsForUser(state, { user, tenantId }) });
    return;
  }

  const annotationReview = pathname.match(/^\/api\/annotations\/([^/]+)\/review$/);
  if (annotationReview && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      reviewAnnotation(current, {
        user,
        annotationId: annotationReview[1],
        action: body.action,
        rejectionReason: body.rejectionReason,
      });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const transactionNonBusiness = pathname.match(/^\/api\/chain-transactions\/([^/]+)\/non-business$/);
  if (transactionNonBusiness && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      markTransactionNonBusiness(current, { user, txId: transactionNonBusiness[1], reason: body.reason });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const annotationRestore = pathname.match(/^\/api\/annotations\/([^/]+)\/restore-non-business$/);
  if (annotationRestore && req.method === "POST") {
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      restoreNonBusinessTransaction(current, { user, annotationId: annotationRestore[1] });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const annotationResubmit = pathname.match(/^\/api\/annotations\/([^/]+)\/resubmit$/);
  if (annotationResubmit && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      const annotation = resubmitAnnotation(current, {
        user,
        annotationId: annotationResubmit[1],
        input: { ...body, attachment: null },
      });
      await storeAnnotationUpload(annotation, body.attachment);
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const annotationCorrection = pathname.match(/^\/api\/annotations\/([^/]+)\/correct$/);
  if (annotationCorrection && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      const annotation = requestAnnotationCorrection(current, {
        user,
        annotationId: annotationCorrection[1],
        input: { ...body, attachment: null },
      });
      await storeAnnotationUpload(annotation, body.attachment);
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const annotationReversal = pathname.match(/^\/api\/annotations\/([^/]+)\/reverse$/);
  if (annotationReversal && req.method === "POST") {
    const body = await readJsonBody(req);
    const state = await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      requestAnnotationReversal(current, { user, annotationId: annotationReversal[1], reason: body.reason });
      return current;
    });
    respond(200, { ok: true, state });
    return;
  }

  const txDetail = pathname.match(/^\/api\/chain-transactions\/([^/]+)\/detail$/);
  if (txDetail && req.method === "GET") {
    const state = await storage.readState();
    if (!state) throw Object.assign(new Error("系统状态尚未初始化"), { statusCode: 404 });
    const { user } = await authenticate(state);
    const detail = getTransactionDetail(state, { user, txId: txDetail[1] });
    respond(200, { ...detail, annotations: detail.annotations.map(annotationForClient) });
    return;
  }

  const annotationAttachment = pathname.match(/^\/api\/annotations\/([^/]+)\/attachment$/);
  if (annotationAttachment && req.method === "GET") {
    let attachment;
    await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      attachment = getAnnotationAttachment(current, { user, annotationId: annotationAttachment[1] });
      appendLog(current, {
        tenantId: user.role === "admin" ? current.annotations.find((item) => item.id === annotationAttachment[1])?.tenantId : user.tenantId,
        userId: user.id,
        action: "查看批注凭证",
        target: annotationAttachment[1],
      });
      return current;
    });
    const file = await attachmentStore.read(attachment);
    sendAttachment(res, file);
    return;
  }

  const receivableAttachment = pathname.match(/^\/api\/receivable-payables\/([^/]+)\/attachment$/);
  if (receivableAttachment && req.method === "GET") {
    let attachment;
    await storage.mutateState(async (current) => {
      const { user } = await authenticate(current);
      attachment = getReceivableAttachment(current, { user, itemId: receivableAttachment[1] });
      appendLog(current, {
        tenantId: user.role === "admin" ? current.receivablePayables.find((item) => item.id === receivableAttachment[1])?.tenantId : user.tenantId,
        userId: user.id,
        action: "查看往来款凭证",
        target: receivableAttachment[1],
      });
      return current;
    });
    const file = await attachmentStore.read(attachment);
    sendAttachment(res, file);
    return;
  }

  respond(404, { error: "API 不存在" });
}

function findLoginUser(users, loginName) {
  const normalized = normalizeLoginName(loginName);
  if (!normalized) return null;
  return users.find((user) => (
    normalizeLoginName(user.loginName) === normalized
    || normalizeLoginName(user.name) === normalized
    || normalizeLoginName(user.id) === normalized
  )) || null;
}

function normalizeLoginName(value) {
  return String(value || "").trim().toLowerCase();
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
  if (safePath !== "/index.html" && !safePath.startsWith("/assets/")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
    return;
  }
  const filePath = path.resolve(rootDir, `.${safePath}`);
  const assetsDir = path.join(rootDir, "assets");
  const validPath = safePath === "/index.html"
    ? filePath === path.join(rootDir, "index.html")
    : filePath.startsWith(`${assetsDir}${path.sep}`);
  if (!validPath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}

async function storeAnnotationUpload(annotation, upload) {
  if (!upload) return;
  const stored = await attachmentStore.saveUpload(upload, { tenantId: annotation.tenantId });
  annotation.attachment = stored;
  annotation.attachmentName = stored.name;
}

async function storeReceivableUpload(item, upload) {
  if (!upload) return;
  const stored = await attachmentStore.saveUpload(upload, { tenantId: item.tenantId });
  item.attachment = stored;
  item.attachmentName = stored.name;
}

function sendAttachment(res, file) {
  const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  res.writeHead(200, {
    "Content-Type": file.mimeType,
    "Content-Length": file.buffer.byteLength,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(file.buffer);
}

async function collectServerMetrics(state) {
  const [cpu, disk, attachments, database, backups] = await Promise.all([
    sampleCpuUsage(),
    diskUsage(rootDir),
    attachmentStore.stats(),
    storage.metrics?.() || Promise.resolve({ kind: storage.kind, connected: false }),
    backupMetrics(),
  ]);
  const proofItems = [
    ...(state.annotations || []),
    ...(state.receivablePayables || []),
  ].filter((item) => item.attachment);
  const storedAttachmentBytes = proofItems.reduce((sum, item) => (
    sum + Number(item.attachment?.byteSize || 0)
  ), 0);
  const now = new Date();
  const todayStart = startOfChinaDay(now);
  const monthStart = startOfChinaMonth(now);
  const attachmentGrowth = attachmentGrowthStats(state, { todayStart, monthStart });
  const logs = [...(state.auditLogs || [])].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
  const adminIds = new Set((state.users || []).filter((user) => user.role === "admin").map((user) => user.id));
  const loginLogs = logs.filter((log) => log.action === "登录系统");
  const failedLoginLogs = logs.filter((log) => log.action === "登录失败");
  return {
    capturedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu,
    memory: {
      totalBytes: os.totalmem(),
      freeBytes: os.freemem(),
      usedBytes: os.totalmem() - os.freemem(),
      processRssBytes: process.memoryUsage().rss,
      processHeapUsedBytes: process.memoryUsage().heapUsed,
    },
    disk,
    database,
    backups,
    service: {
      storage: storage.kind,
      chainProvider: tronProvider.kind,
      chainConfigured: tronProvider.configured === true,
      chainReason: tronProvider.reason || "",
      chainScheduler: chainScheduler.status,
      host,
      port,
    },
    data: {
      tenants: (state.tenants || []).length,
      users: (state.users || []).length,
      wallets: (state.wallets || []).length,
      chainTransactions: (state.chainTransactions || []).length,
      annotations: (state.annotations || []).length,
      auditLogs: (state.auditLogs || []).length,
      walletBalanceSnapshots: (state.walletBalanceSnapshots || []).length,
    },
    attachments: {
      annotationCount: proofItems.length,
      storedAttachmentBytes,
      fileCount: attachments.fileCount,
      totalBytes: attachments.totalBytes,
      rootDir: attachments.rootDir,
      growth: attachmentGrowth,
    },
    events: {
      syncFailures: logs.filter((log) => log.action === "链上钱包同步失败").slice(0, 5),
    },
    security: {
      adminUsers: adminIds.size,
      activeSessions: database.userSessions ?? null,
      lastLoginAt: loginLogs[0]?.createdAt || null,
      failedLoginsToday: failedLoginLogs.filter((log) => new Date(log.createdAt) >= todayStart).length,
      failedLoginsThisMonth: failedLoginLogs.filter((log) => new Date(log.createdAt) >= monthStart).length,
      recentFailedLogins: failedLoginLogs.slice(0, 5),
    },
  };
}

async function backupMetrics() {
  const backupDir = process.env.BACKUP_DIR || "/var/lib/usdt-ledger/backups";
  const [directory, timer] = await Promise.all([
    directorySummary(backupDir),
    systemdTimerStatus("usdt-ledger-backup.timer"),
  ]);
  const files = directory.files.filter((file) => (
    file.name.endsWith(".dump") || file.name.endsWith(".tar.gz") || file.name.endsWith(".sha256")
  ));
  const latestBySuffix = (suffix) => files
    .filter((file) => file.name.endsWith(suffix))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)[0] || null;
  return {
    rootDir: backupDir,
    exists: directory.exists,
    fileCount: files.length,
    totalBytes: directory.totalBytes,
    latestDatabaseBackup: backupFileForClient(latestBySuffix(".dump")),
    latestAttachmentBackup: backupFileForClient(latestBySuffix(".tar.gz")),
    latestChecksum: backupFileForClient(latestBySuffix(".sha256")),
    timer,
  };
}

async function directorySummary(directory) {
  const files = [];
  let totalBytes = 0;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (!entries) return { exists: false, files, totalBytes };
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const filePath = path.join(directory, entry.name);
    const info = await stat(filePath).catch(() => null);
    if (!info) return;
    totalBytes += info.size;
    files.push({ name: entry.name, size: info.size, mtime: info.mtime.toISOString(), mtimeMs: info.mtimeMs });
  }));
  return { exists: true, files, totalBytes };
}

function backupFileForClient(file) {
  if (!file) return null;
  return { name: file.name, size: file.size, mtime: file.mtime };
}

async function systemdTimerStatus(timerName) {
  const active = await execFileText("systemctl", ["is-active", timerName]);
  const enabled = await execFileText("systemctl", ["is-enabled", timerName]);
  const next = await execFileText("systemctl", ["show", timerName, "--property=NextElapseUSecRealtime", "--value"]);
  const last = await execFileText("systemctl", ["show", timerName, "--property=LastTriggerUSec", "--value"]);
  return {
    name: timerName,
    active: active.ok ? active.stdout.trim() : "unknown",
    enabled: enabled.ok ? enabled.stdout.trim() : "unknown",
    nextRun: systemdUsecToIso(next.stdout),
    lastRun: systemdUsecToIso(last.stdout),
  };
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 3000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || "", stderr: stderr || "", error: error?.message || "" });
    });
  });
}

function systemdUsecToIso(value) {
  const text = String(value || "").trim();
  if (!text || text === "0" || text === "n/a" || text === "infinity") return null;
  const millis = Number(text) / 1000;
  return Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null;
}

function attachmentGrowthStats(state, { todayStart, monthStart }) {
  const proofItems = [
    ...(state.annotations || []),
    ...(state.receivablePayables || []),
  ].filter((item) => item.attachment);
  const summarize = (start) => proofItems.reduce((summary, item) => {
    if (new Date(item.createdAt || item.annotatedAt || 0) < start) return summary;
    summary.count += 1;
    summary.bytes += Number(item.attachment?.byteSize || 0);
    summary.originalBytes += Number(item.attachment?.originalByteSize || item.attachment?.byteSize || 0);
    return summary;
  }, { count: 0, bytes: 0, originalBytes: 0 });
  const total = proofItems.reduce((summary, item) => {
    summary.originalBytes += Number(item.attachment?.originalByteSize || item.attachment?.byteSize || 0);
    summary.bytes += Number(item.attachment?.byteSize || 0);
    return summary;
  }, { bytes: 0, originalBytes: 0 });
  return {
    today: summarize(todayStart),
    month: summarize(monthStart),
    savedBytes: Math.max(0, total.originalBytes - total.bytes),
  };
}

function startOfChinaDay(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00+08:00`);
}

function startOfChinaMonth(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-01T00:00:00+08:00`);
}

async function sampleCpuUsage() {
  const start = cpuSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const end = cpuSnapshot();
  let idle = 0;
  let total = 0;
  for (let index = 0; index < end.length; index += 1) {
    idle += end[index].idle - start[index].idle;
    total += end[index].total - start[index].total;
  }
  const usagePercent = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
  return {
    cores: os.cpus().length,
    model: os.cpus()[0]?.model || "",
    usagePercent,
    loadAverage: os.loadavg(),
  };
}

function cpuSnapshot() {
  return os.cpus().map((cpu) => {
    const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: cpu.times.idle, total };
  });
}

async function diskUsage(targetPath) {
  const info = await statfs(targetPath);
  const totalBytes = Number(info.blocks) * Number(info.bsize);
  const freeBytes = Number(info.bavail) * Number(info.bsize);
  return {
    path: targetPath,
    totalBytes,
    freeBytes,
    usedBytes: totalBytes - freeBytes,
  };
}

export function createLedgerServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url.pathname);
        return;
      }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "服务器错误" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createLedgerServer().listen(port, host, () => {
    console.log(`USDT 财务记账系统已启动：http://${host}:${port}`);
  });
}
