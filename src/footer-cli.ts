#!/usr/bin/env node
// Standalone CLI that prints the current verbose-mode footer to stdout.
// Used by the reminder hook to refresh a cached, near-live footer in the
// background (non-blocking), so the agent's footer reflects live usage
// instead of the value captured at task start.
import { loadStore } from "./storage.js";
import { getUsage, buildFooter } from "./usage.js";

async function main(): Promise<void> {
  const store = loadStore();
  const reading = await getUsage(store);
  process.stdout.write(buildFooter(reading) + "\n");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
