import { Counter, Gauge } from "prom-client";
import { writeHeapSnapshot } from "v8";
import winston from "winston";

const memRss = new Gauge({ name: "watchdog_diag_mem_rss_bytes", help: "Process resident set size in bytes" });
const memHeapUsed = new Gauge({ name: "watchdog_diag_mem_heap_used_bytes", help: "V8 heap used in bytes" });
const memHeapTotal = new Gauge({ name: "watchdog_diag_mem_heap_total_bytes", help: "V8 heap total in bytes" });
const memExternal = new Gauge({
  name: "watchdog_diag_mem_external_bytes",
  help: "External memory (e.g. Buffers) in bytes",
});
const memArrayBuffers = new Gauge({
  name: "watchdog_diag_mem_array_buffers_bytes",
  help: "ArrayBuffer memory in bytes",
});

const activeHandles = new Gauge({
  name: "watchdog_diag_active_handles",
  help: "Count of active resources (timers, sockets, etc.) by type — grows when async work isn't being cleaned up",
  labelNames: ["type"],
});

const rpcCalls = new Counter({
  name: "watchdog_diag_rpc_calls_total",
  help: "JSON-RPC calls broken down by method — disproportionate growth of one method (e.g. eth_getTransactionByHash) suggests ghost pollers",
  labelNames: ["method"],
});

const rpcInflight = new Gauge({
  name: "watchdog_diag_rpc_inflight",
  help: "JSON-RPC calls currently in flight on the logging provider",
});

let inflightCount = 0;

export function recordRpcStart(method: string): void {
  rpcCalls.inc({ method });
  inflightCount++;
  rpcInflight.set(inflightCount);
}

export function recordRpcEnd(): void {
  inflightCount = Math.max(0, inflightCount - 1);
  rpcInflight.set(inflightCount);
}

const RSS_CEILING_BYTES = +(process.env.MAX_RSS_BYTES ?? 0);

function snapshot(): void {
  const mem = process.memoryUsage();
  memRss.set(mem.rss);
  memHeapUsed.set(mem.heapUsed);
  memHeapTotal.set(mem.heapTotal);
  memExternal.set(mem.external);
  memArrayBuffers.set(mem.arrayBuffers);

  if (RSS_CEILING_BYTES > 0 && mem.rss > RSS_CEILING_BYTES) {
    winston.error(`RSS ${mem.rss} exceeded MAX_RSS_BYTES=${RSS_CEILING_BYTES}, exiting for orchestrator restart`);
    process.exit(1);
  }

  const handles = process.getActiveResourcesInfo();
  const byType: Record<string, number> = {};
  for (const t of handles) {
    byType[t] = (byType[t] ?? 0) + 1;
  }
  activeHandles.reset();
  for (const [type, count] of Object.entries(byType)) {
    activeHandles.set({ type }, count);
  }

  winston.info("diagnostics", {
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    externalMb: Math.round(mem.external / 1024 / 1024),
    activeHandles: handles.length,
    handlesByType: byType,
    rpcInflight: inflightCount,
  });
}

export function startDiagnosticsLoop(intervalMs: number): void {
  snapshot();
  const timer = setInterval(snapshot, intervalMs);
  timer.unref();
}

export function installHeapSnapshotHandler(): void {
  process.on("SIGUSR2", () => {
    const filename = `/tmp/watchdog-heap-${Date.now()}.heapsnapshot`;
    try {
      winston.info(`Writing heap snapshot to ${filename} (this can take several seconds and blocks the event loop)`);
      writeHeapSnapshot(filename);
      winston.info(`Heap snapshot written: ${filename}`);
    } catch (err) {
      winston.error("Failed to write heap snapshot", err);
    }
  });
}
