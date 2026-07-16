#!/usr/bin/env node
// Standalone CLI that prints the current verbose-mode footer to stdout.
// Used by the reminder hook to refresh a cached, near-live footer in the
// background (non-blocking), so the agent's footer reflects live usage
// instead of the value captured at task start.
import { loadStore } from "./storage.js";
import { getUsageCached, buildFooter } from "./usage.js";

async function main(): Promise<void> {
  const store = loadStore();
  // Shared cache with get_usage: while exhausted this serves the cached reading
  // (and refreshes it at most daily / on cycle reset); below the limit it fetches
  // fresh each run, warming the cache for the next get_usage call.
  const reading = await getUsageCached(store);
  process.stdout.write(buildFooter(reading) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
