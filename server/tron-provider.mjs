import { createHash } from "node:crypto";

const DEFAULT_BASE_URL = "https://api.trongrid.io";
const DEFAULT_USDT_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function createTronProvider(env = process.env) {
  const baseUrl = (env.TRON_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiKey = env.TRON_API_KEY || "";
  const configuredMode = env.TRON_PROVIDER || "auto";
  const usesTronGrid = /trongrid\.io$/i.test(new URL(baseUrl).hostname);
  const realEnabled = configuredMode === "trongrid" || configuredMode === "node" || (configuredMode === "auto" && (!usesTronGrid || apiKey));

  if (!realEnabled) {
    return {
      kind: "unconfigured",
      configured: false,
      reason: usesTronGrid ? "未配置 TRON_API_KEY" : "未启用 TRON 接口",
      async fetchWalletTransactions() {
        throw providerNotConfigured();
      },
      async fetchWalletBalance() {
        throw providerNotConfigured();
      },
      async searchTransaction() {
        throw providerNotConfigured();
      },
    };
  }

  return new TronHttpProvider({
    baseUrl,
    apiKey,
    usdtContract: env.TRON_USDT_CONTRACT || DEFAULT_USDT_CONTRACT,
  });
}

export class TronHttpProvider {
  kind = "tron";
  configured = true;

  constructor({ baseUrl = DEFAULT_BASE_URL, apiKey = "", usdtContract = DEFAULT_USDT_CONTRACT, fetchImpl = fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.usdtContract = usdtContract;
    this.fetchImpl = fetchImpl;
  }

  async fetchWalletTransactions(wallet, { minTimestamp } = {}) {
    const rows = [];
    let fingerprint = "";
    do {
      const url = new URL(`${this.baseUrl}/v1/accounts/${encodeURIComponent(wallet.address)}/transactions/trc20`);
      url.searchParams.set("only_confirmed", "true");
      url.searchParams.set("limit", "200");
      url.searchParams.set("order_by", "block_timestamp,desc");
      url.searchParams.set("contract_address", this.usdtContract);
      if (minTimestamp) url.searchParams.set("min_timestamp", String(new Date(minTimestamp).getTime()));
      if (fingerprint) url.searchParams.set("fingerprint", fingerprint);
      const payload = await this.request(url);
      rows.push(...(payload.data || []));
      fingerprint = payload.meta?.fingerprint || "";
    } while (fingerprint && rows.length < 1000);
    return rows.map((item) => normalizeTrc20Transaction(item, wallet, this.usdtContract)).filter(Boolean);
  }

  async fetchWalletBalance(wallet) {
    const url = new URL(`${this.baseUrl}/v1/accounts/${encodeURIComponent(wallet.address)}/trc20/balance`);
    url.searchParams.set("contract_address", this.usdtContract);
    const payload = await this.request(url);
    return normalizeTrc20Balance(payload, this.usdtContract);
  }

  async searchTransaction(query) {
    if (!/^[a-fA-F0-9]{64}$/.test(query)) return null;
    const [transaction, info] = await Promise.all([
      this.request(`${this.baseUrl}/wallet/gettransactionbyid`, {
        method: "POST",
        body: JSON.stringify({ value: query }),
      }),
      this.request(`${this.baseUrl}/wallet/gettransactioninfobyid`, {
        method: "POST",
        body: JSON.stringify({ value: query }),
      }),
    ]);
    if (!transaction?.txID && !info?.id) return null;
    return {
      hash: transaction.txID || info.id || query,
      confirmed: Boolean(info?.blockNumber || info?.receipt),
      chainTime: info?.blockTimeStamp ? new Date(info.blockTimeStamp).toISOString() : null,
      result: info?.receipt?.result || transaction?.ret?.[0]?.contractRet || "UNKNOWN",
      blockNumber: info?.blockNumber ?? null,
      feeSun: info?.fee ?? 0,
      raw: { transaction, info },
    };
  }

  async request(url, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(this.apiKey ? { "TRON-PRO-API-KEY": this.apiKey } : {}),
      ...options.headers,
    };
    const response = await this.fetchImpl(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      const error = new Error(payload.error || payload.message || `TRON API 请求失败（${response.status}）`);
      error.statusCode = 502;
      throw error;
    }
    return payload;
  }
}

export function normalizeTrc20Transaction(item, wallet, expectedContract = DEFAULT_USDT_CONTRACT) {
  const tokenAddress = item.token_info?.address || item.contract_address;
  if (tokenAddress && tokenAddress !== expectedContract) return null;
  const decimals = Number(item.token_info?.decimals ?? 6);
  const amount = Number(item.value) / (10 ** decimals);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const incoming = item.to === wallet.address;
  const outgoing = item.from === wallet.address;
  if (!incoming && !outgoing) return null;
  return {
    hash: item.transaction_id,
    eventIndex: item.event_index ?? item.eventIndex ?? null,
    direction: incoming ? "income" : "expense",
    amount,
    counterparty: incoming ? item.from : item.to,
    confirmed: true,
    chainTime: new Date(Number(item.block_timestamp)).toISOString(),
    memo: item.memo || item.note || item.data || item.raw_data?.data || "",
    tokenContract: tokenAddress || DEFAULT_USDT_CONTRACT,
  };
}

export function normalizeTrc20Balance(payload, expectedContract = DEFAULT_USDT_CONTRACT) {
  const data = payload?.data ?? payload;
  const candidates = Array.isArray(data) ? data : [data];
  for (const item of candidates) {
    if (item == null) continue;
    if (typeof item === "number" || typeof item === "string") {
      const value = Number(item);
      if (Number.isFinite(value)) return value;
    }
    const contract = item.contract_address || item.contractAddress || item.token_info?.address;
    if (contract && contract !== expectedContract) continue;
    const decimals = Number(item.decimals ?? item.token_info?.decimals ?? 6);
    const raw = item.balance ?? item.value ?? item[expectedContract];
    if (raw !== undefined) {
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      return item.balance !== undefined && String(raw).includes(".") ? value : value / (10 ** decimals);
    }
    if (item && typeof item === "object" && item[expectedContract] !== undefined) {
      return Number(item[expectedContract]) / (10 ** decimals);
    }
  }
  return 0;
}

export function isValidTronAddress(address) {
  if (typeof address !== "string" || !address.startsWith("T") || address.length !== 34) return false;
  let value = 0n;
  for (const character of address) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) return false;
    value = value * 58n + BigInt(index);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 255n));
    value >>= 8n;
  }
  for (const character of address) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  if (bytes.length !== 25 || bytes[0] !== 0x41) return false;
  const payload = Buffer.from(bytes.slice(0, 21));
  const checksum = Buffer.from(bytes.slice(21));
  const first = createHash("sha256").update(payload).digest();
  const expected = createHash("sha256").update(first).digest().subarray(0, 4);
  return checksum.equals(expected);
}

function providerNotConfigured() {
  const error = new Error("尚未配置真实 TRON 接口，请先设置 TRON_API_KEY");
  error.statusCode = 503;
  return error;
}
