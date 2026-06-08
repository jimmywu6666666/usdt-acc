import {
  appendLog,
  enforceTenantSubscriptions,
  recordWalletBalanceSnapshot,
  syncChainTransactions,
  tenantSubscriptionActive,
} from "./domain.mjs";

const DEFAULT_INITIAL_DAYS = 30;
const DEFAULT_OVERLAP_MINUTES = 10;

export async function syncTenantWallets({
  storage,
  tronProvider,
  tenantId,
  actorUserId,
  now = new Date(),
  env = process.env,
  retry = retryOperation,
  logEmptySync = true,
}) {
  if (tronProvider.kind !== "tron") {
    throw httpError(503, tronProvider.reason || "尚未配置真实 TRON 接口");
  }

  const currentState = await storage.readState();
  if (!currentState) throw httpError(404, "系统状态尚未初始化");
  const actor = resolveSyncActor(currentState, tenantId, actorUserId);
  const wallets = currentState.wallets.filter((wallet) => wallet.tenantId === tenantId && wallet.enabled);
  if (!wallets.length) throw httpError(400, "当前系统没有启用中的钱包");

  const initialSyncDays = Math.max(1, Number(env.TRON_INITIAL_SYNC_DAYS || DEFAULT_INITIAL_DAYS));
  const overlapMs = Math.max(1, Number(env.TRON_SYNC_OVERLAP_MINUTES || DEFAULT_OVERLAP_MINUTES)) * 60 * 1000;
  const syncTime = now.toISOString();
  const batches = await Promise.allSettled(wallets.map(async (wallet) => {
    const latest = currentState.chainTransactions
      .filter((tx) => tx.walletId === wallet.id)
      .sort((left, right) => new Date(right.chainTime) - new Date(left.chainTime))[0];
    const defaultInitialStart = now.getTime() - initialSyncDays * 24 * 60 * 60 * 1000;
    const managedStart = wallet.managedFrom ? new Date(wallet.managedFrom).getTime() : defaultInitialStart;
    const minTimestamp = latest?.chainTime
      ? new Date(new Date(latest.chainTime).getTime() - overlapMs).toISOString()
      : new Date(Math.min(defaultInitialStart, managedStart)).toISOString();
    const [transactions, balance] = await Promise.all([
      retry(() => tronProvider.fetchWalletTransactions(wallet, { minTimestamp })),
      retry(() => tronProvider.fetchWalletBalance(wallet)),
    ]);
    return { walletId: wallet.id, transactions: transactions.map((tx) => ({ ...tx, walletId: wallet.id })), balance };
  }));

  const successful = batches.filter((result) => result.status === "fulfilled").map((result) => result.value);
  const failed = batches.flatMap((result, index) => result.status === "rejected"
    ? [{ walletId: wallets[index].id, alias: wallets[index].alias, error: result.reason?.message || "同步失败" }]
    : []);
  const externalTransactions = successful.flatMap((item) => item.transactions);
  let createdCount = 0;
  const state = await storage.mutateState(async (current) => {
    const currentActor = current.users.find((user) => user.id === actor.id) || resolveSyncActor(current, tenantId);
    if (successful.length) {
      createdCount = syncChainTransactions(current, {
        user: currentActor,
        tenantId,
        externalTransactions,
        now: syncTime,
        logEmptySync,
      }).length;
    }
    for (const result of successful) {
      const wallet = current.wallets.find((item) => item.id === result.walletId);
      if (!wallet) continue;
      wallet.chainBalance = result.balance;
      wallet.chainBalanceUpdatedAt = syncTime;
      wallet.lastSyncedAt = syncTime;
      wallet.lastSyncAttemptAt = syncTime;
      wallet.lastSyncError = "";
      recordWalletBalanceSnapshot(current, { wallet, balance: result.balance, capturedAt: syncTime });
    }
    for (const result of failed) {
      const wallet = current.wallets.find((item) => item.id === result.walletId);
      if (!wallet) continue;
      wallet.lastSyncError = result.error;
      wallet.lastSyncAttemptAt = syncTime;
      appendLog(current, {
        tenantId,
        userId: currentActor.id,
        action: "链上钱包同步失败",
        target: `${wallet.alias}:${result.error}`,
        createdAt: syncTime,
      });
    }
    return current;
  });

  if (!successful.length) {
    throw httpError(502, `TRON 同步失败：${failed.map((item) => `${item.alias} ${item.error}`).join("；")}`);
  }

  return {
    state,
    provider: tronProvider.kind,
    createdCount,
    syncedWalletCount: successful.length,
    failedWallets: failed,
  };
}

export function startChainSyncScheduler({
  storage,
  tronProvider,
  env = process.env,
  logger = console,
  setIntervalImpl = setInterval,
  setTimeoutImpl = setTimeout,
}) {
  const intervalMinutes = Number(env.CHAIN_SYNC_INTERVAL_MINUTES || 5);
  const status = {
    enabled: tronProvider.kind === "tron" && intervalMinutes > 0,
    intervalMinutes,
    running: false,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastError: "",
  };
  if (!status.enabled) return { status, stop() {} };

  const run = async () => {
    if (status.running) return;
    status.running = true;
    status.lastStartedAt = new Date().toISOString();
    status.lastError = "";
    try {
      const state = await storage.readState();
      const admin = state?.users?.find((user) => user.role === "admin");
      if (state && admin) {
        await storage.mutateState(async (current) => {
          enforceTenantSubscriptions(current, { user: current.users.find((user) => user.id === admin.id) || admin });
          return current;
        });
      }
      const tenants = state?.tenants?.filter((tenant) => (
        tenantSubscriptionActive(state, tenant.id, status.lastStartedAt)
        && state.wallets.some((wallet) => wallet.tenantId === tenant.id && wallet.enabled)
      )) || [];
      for (const tenant of tenants) {
        try {
          await syncTenantWallets({ storage, tronProvider, tenantId: tenant.id, env, logEmptySync: false });
        } catch (error) {
          status.lastError = error.message;
          logger.error(`自动同步失败 [${tenant.name}]：${error.message}`);
        }
      }
    } catch (error) {
      status.lastError = error.message;
      logger.error(`自动同步任务失败：${error.message}`);
    } finally {
      status.running = false;
      status.lastFinishedAt = new Date().toISOString();
    }
  };

  const timer = setIntervalImpl(run, intervalMinutes * 60 * 1000);
  timer.unref?.();
  const initialTimer = setTimeoutImpl(run, 0);
  initialTimer.unref?.();
  return {
    status,
    run,
    stop: () => {
      clearInterval(timer);
      clearTimeout(initialTimer);
    },
  };
}

export async function retryOperation(operation, {
  attempts = 3,
  baseDelayMs = 500,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  onRetry = () => {},
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) break;
      const delayMs = baseDelayMs * (2 ** (attempt - 1));
      onRetry({ attempt, delayMs, error });
      await wait(delayMs);
    }
  }
  throw lastError;
}

function resolveSyncActor(state, tenantId, actorUserId) {
  const requested = actorUserId ? state.users.find((user) => user.id === actorUserId) : null;
  if (requested && (requested.role === "admin" || (requested.role === "supervisor" && requested.tenantId === tenantId))) {
    return requested;
  }
  const supervisor = state.users.find((user) => user.role === "supervisor" && user.tenantId === tenantId);
  const admin = state.users.find((user) => user.role === "admin");
  if (!supervisor && !admin) throw httpError(403, "当前系统缺少可执行同步的主管或管理员");
  return supervisor || admin;
}

function isRetryable(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  return !status || status === 429 || status >= 500;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
