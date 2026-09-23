const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { LoggingJsonRpcProvider } = require("../src/rpcLoggingProvider");
const { isTimeoutError } = require("../src/utils");

const ADDRESS = "0x0000000000000000000000000000000000000001";
const RESULTS = { eth_chainId: "0x10f2c", eth_getBalance: "0x1" };

test("authorized provider detects the network once, through the authorized path", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      seen.push({ method, authorized: req.headers.authorization === "Bearer test-token" });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result: RESULTS[method] }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));

  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new LoggingJsonRpcProvider(ADDRESS, url, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.setAuthTokenGetter(() => "test-token");

  try {
    await provider.getBalance(ADDRESS);
    await provider.getBalance(ADDRESS);

    assert.deepEqual(seen.map((r) => r.method).sort(), ["eth_chainId", "eth_getBalance", "eth_getBalance"]);
    assert.ok(seen.every((r) => r.authorized));
  } finally {
    provider.destroy();
    server.close();
  }
});

test("every call is observed in watchdog_rpc_call_duration_seconds with its outcome", async () => {
  const { register } = require("prom-client");
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (method === "eth_getBalance") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } }));
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: RESULTS[method] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));

  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new LoggingJsonRpcProvider(ADDRESS, url, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.setAuthTokenGetter(() => "test-token");

  // The registry is process-global, so compare against a snapshot taken before the calls.
  const count = async (method, outcome) =>
    (await register.getSingleMetric("watchdog_rpc_call_duration_seconds").get()).values.find(
      (v) => v.metricName.endsWith("_count") && v.labels.method === method && v.labels.outcome === outcome
    )?.value ?? 0;
  const before = { chainId: await count("eth_chainId", "ok"), balance: await count("eth_getBalance", "error") };

  try {
    await assert.rejects(provider.getBalance(ADDRESS), /Internal error/);
    const errors = (await register.getSingleMetric("watchdog_rpc_call_errors_total").get()).values;

    assert.equal(await count("eth_chainId", "ok"), before.chainId + 1);
    assert.equal(await count("eth_getBalance", "error"), before.balance + 1);
    assert.equal(errors.find((v) => v.labels.method === "eth_getBalance")?.labels.code, "-32603");
  } finally {
    provider.destroy();
    server.close();
  }
});

test("authorized calls honour the FetchRequest timeout", async () => {
  const { FetchRequest } = require("ethers");
  const server = http.createServer(() => {
    // never answer
  });
  await new Promise((resolve) => server.listen(0, resolve));

  const request = new FetchRequest(`http://127.0.0.1:${server.address().port}`);
  request.timeout = 200;
  const provider = new LoggingJsonRpcProvider(ADDRESS, request, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.setAuthTokenGetter(() => "test-token");

  const started = Date.now();
  try {
    await assert.rejects(provider.send("eth_blockNumber", []), (error) => {
      assert.ok(isTimeoutError(error), "a request timeout must classify as a timeout, or the step records it as an error");
      return /timeout|aborted/i.test(error.message);
    });
    assert.ok(Date.now() - started < 2000, "request did not fail within the configured timeout");
  } finally {
    provider.destroy();
    server.closeAllConnections();
    server.close();
  }
});

test("waitForTransaction with one confirmation costs one call per poll", async () => {
  const HASH = "0x" + "11".repeat(32);
  const receipt = {
    transactionHash: HASH,
    blockHash: "0x" + "22".repeat(32),
    blockNumber: "0x10",
    transactionIndex: "0x0",
    from: ADDRESS,
    to: ADDRESS,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [],
    logsBloom: "0x" + "00".repeat(256),
    status: "0x1",
    type: "0x2",
  };
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body);
      seen.push(method);
      res.setHeader("content-type", "application/json");
      const result = method === "eth_getTransactionReceipt" ? receipt : RESULTS[method];
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));

  const url = `http://127.0.0.1:${server.address().port}`;
  const provider = new LoggingJsonRpcProvider(ADDRESS, url, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.setAuthTokenGetter(() => "test-token");

  try {
    const got = await provider.waitForTransaction(HASH, 1, 2000);
    assert.equal(got.hash, HASH);
    assert.equal(seen.filter((m) => m === "eth_getTransactionReceipt").length, 1);
  } finally {
    provider.destroy();
    server.close();
  }
});
