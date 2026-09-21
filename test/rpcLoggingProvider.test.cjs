const assert = require("node:assert/strict");
const http = require("node:http");
const { test } = require("node:test");
const { LoggingJsonRpcProvider } = require("../src/rpcLoggingProvider");

const ADDRESS = "0x0000000000000000000000000000000000000001";
const RESULTS = { eth_chainId: "0x10f2c", eth_getBalance: "0x1", eth_getTransactionCount: "0x5" };

test("authorized provider detects the network once instead of before every call", async () => {
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

  const provider = new LoggingJsonRpcProvider(ADDRESS, `http://127.0.0.1:${server.address().port}`, undefined, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  provider.setAuthTokenGetter(() => "test-token");

  try {
    await provider.getBalance(ADDRESS);
    await provider.getTransactionCount(ADDRESS, "latest");
    await provider.getBalance(ADDRESS);

    assert.equal(seen.filter((r) => r.method === "eth_chainId").length, 1);
    assert.deepEqual(
      seen.filter((r) => !r.authorized),
      []
    );
  } finally {
    provider.destroy();
    server.close();
  }
});
