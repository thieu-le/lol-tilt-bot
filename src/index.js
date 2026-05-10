// Entry point. Boot order:
//   1. Validate env (config.js throws on missing vars at import time).
//   2. Initialize the JSON store.
//   3. Log into Discord and start polling.
// Graceful shutdown on SIGINT/SIGTERM stops the poller, drops the WS
// connection, and exits cleanly so we don't leave dangling timers.

import * as storage from './storage.js';
import { start, shutdown } from './bot.js';
import { logger } from './logger.js';

async function main() {
  await storage.init();
  await start();
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err.stack ?? err.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal}, shutting down…`);
  try {
    await shutdown();
  } catch (err) {
    logger.error(`Shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

// Surface any rejected promises so they aren't swallowed silently.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason?.stack ?? reason}`);
});
