import "dotenv/config";
import winston from "winston";

import { acquireAndHoldLeaseOrExit } from "./leaseLock";
import { setupLogger } from "./logger";
import { runWatchdog } from "./main";

async function main(): Promise<void> {
  setupLogger(process.env.NODE_ENV, process.env.LOG_LEVEL);
  await acquireAndHoldLeaseOrExit();
  await runWatchdog();
}

main().catch((error) => {
  winston.error("Fatal startup error", error);
  process.exit(1);
});
