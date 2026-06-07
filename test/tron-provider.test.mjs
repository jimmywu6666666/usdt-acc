import test from "node:test";
import assert from "node:assert/strict";
import {
  createTronProvider,
  isValidTronAddress,
  normalizeTrc20Balance,
  normalizeTrc20Transaction,
  TronHttpProvider,
} from "../server/tron-provider.mjs";

const wallet = {
  id: "wallet",
  address: "TWalletAddress",
};

test("disables real sync until a TRON API is configured", () => {
  assert.equal(createTronProvider({}).kind, "unconfigured");
  assert.equal(createTronProvider({}).configured, false);
  assert.equal(createTronProvider({ TRON_API_KEY: "key" }).kind, "tron");
  assert.equal(createTronProvider({ TRON_PROVIDER: "mock", TRON_API_KEY: "key" }).kind, "unconfigured");
});

test("validates TRON Base58Check wallet addresses", () => {
  assert.equal(isValidTronAddress("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"), true);
  assert.equal(isValidTronAddress("TQ9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWb"), false);
  assert.equal(isValidTronAddress("TNEW"), false);
});

test("normalizes incoming and outgoing TRC20 USDT transfers", () => {
  const incoming = normalizeTrc20Transaction({
    transaction_id: "hash-in",
    token_info: { address: "USDT", decimals: 6 },
    from: "TCounterparty",
    to: wallet.address,
    value: "1250000",
    block_timestamp: 1780688703995,
  }, wallet, "USDT");
  const outgoing = normalizeTrc20Transaction({
    transaction_id: "hash-out",
    token_info: { address: "USDT", decimals: 6 },
    from: wallet.address,
    to: "TCounterparty",
    value: "800000000",
    block_timestamp: 1780688703995,
  }, wallet, "USDT");
  assert.equal(incoming.direction, "income");
  assert.equal(incoming.amount, 1.25);
  assert.equal(outgoing.direction, "expense");
  assert.equal(outgoing.amount, 800);
});

test("sends TronGrid API key and normalizes wallet history", async () => {
  let request;
  const provider = new TronHttpProvider({
    baseUrl: "https://api.trongrid.io",
    apiKey: "secret-key",
    usdtContract: "USDT",
    fetchImpl: async (url, options) => {
      request = { url: String(url), options };
      return {
        ok: true,
        async json() {
          return {
            data: [{
              transaction_id: "hash",
              token_info: { address: "USDT", decimals: 6 },
              from: "TCounterparty",
              to: wallet.address,
              value: "1000000",
              block_timestamp: 1780688703995,
            }],
          };
        },
      };
    },
  });
  const rows = await provider.fetchWalletTransactions(wallet, { minTimestamp: "2026-06-01T00:00:00.000Z" });
  assert.equal(request.options.headers["TRON-PRO-API-KEY"], "secret-key");
  assert.match(request.url, /transactions\/trc20/);
  assert.match(request.url, /contract_address=USDT/);
  assert.equal(rows[0].amount, 1);
});

test("follows TronGrid fingerprints when transaction history is paginated", async () => {
  const requests = [];
  const provider = new TronHttpProvider({
    baseUrl: "https://api.trongrid.io",
    apiKey: "secret-key",
    usdtContract: "USDT",
    fetchImpl: async (url) => {
      const requestUrl = new URL(String(url));
      requests.push(requestUrl);
      const secondPage = requestUrl.searchParams.get("fingerprint") === "next-page";
      return {
        ok: true,
        async json() {
          return {
            data: [{
              transaction_id: secondPage ? "hash-2" : "hash-1",
              event_index: secondPage ? 2 : 1,
              token_info: { address: "USDT", decimals: 6 },
              from: "TCounterparty",
              to: wallet.address,
              value: "1000000",
              block_timestamp: 1780688703995,
            }],
            meta: secondPage ? {} : { fingerprint: "next-page" },
          };
        },
      };
    },
  });
  const rows = await provider.fetchWalletTransactions(wallet);
  assert.equal(requests.length, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].eventIndex, 2);
});

test("reads the current TRC20 balance for a wallet", async () => {
  const provider = new TronHttpProvider({
    baseUrl: "https://api.trongrid.io",
    apiKey: "secret-key",
    usdtContract: "USDT",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { data: [{ contract_address: "USDT", balance: "1250000", decimals: 6 }] };
      },
    }),
  });
  assert.equal(await provider.fetchWalletBalance(wallet), 1.25);
  assert.equal(normalizeTrc20Balance({ data: [{ USDT: "800000000", decimals: 6 }] }, "USDT"), 800);
});
