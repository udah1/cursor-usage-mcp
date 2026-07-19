#!/usr/bin/env node
// Prints the FLAG-AWARE self-check reminder (the postToolUse hook's
// additional_context) to stdout. Only modes that are actually active are
// included, so once the quota is exhausted (conserve turns off) or follow-up is
// off, those instructions are NOT injected — preventing the agent from
// over-asking or tacking on "anything else?" when it shouldn't.
//
// Uses the shared usage cache (getUsageCached), so while exhausted this is a
// ~10ms read, and it runs detached from the hook (non-blocking).
import { loadStore, isVerbose, isFollowup, effectiveThreshold } from "./storage.js";
import { getUsageCached, decideConserve, buildFooter } from "./usage.js";

async function main(): Promise<void> {
  const store = loadStore();
  const reading = await getUsageCached(store);
  const decision = decideConserve(reading, effectiveThreshold(store));
  const verbose = isVerbose(store);
  const followup = isFollowup(store);

  const lines: string[] = [];

  // Conserve only matters while included requests remain. Once exhausted it is
  // off and internal — do NOT nudge the agent to keep asking via the options UI.
  if (decision.conserve && !decision.exhausted) {
    lines.push(
      "CONSERVE — ask real questions through the options/questions UI (free), batch them into one prompt, and skip needless confirmation round-trips.",
    );
  }

  if (followup) {
    lines.push('FOLLOW-UP — end the task with a brief "anything else?" options question.');
  }

  // Verbose footer goes last so it's easy to copy to the end of the message.
  if (verbose) {
    lines.push(
      "VERBOSE — end EVERY message with this exact footer block (auto-refreshed in the background, so use THIS one, not an older one):\n" +
        buildFooter(reading),
    );
  }

  if (lines.length === 0) return; // nothing active -> inject nothing
  process.stdout.write(
    "[cursor-usage self-check] Keep following the cursor-usage rules for this task: " +
      lines.join(" "),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
