#!/usr/bin/env node
// Installs the flag-aware postToolUse reminder hook into ~/.cursor so it works
// whether this package is run from a local clone or via npx. Idempotent: replaces
// any previous cursor-usage* reminder hook entry.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from "node:fs";

const CURSOR_DIR = join(homedir(), ".cursor");
const HOOKS_DIR = join(CURSOR_DIR, "hooks");
const HOOKS_JSON = join(CURSOR_DIR, "hooks.json");
const HOOK_NAME = "cursor-usage-optimizer-reminder.sh";
const HOOK_PATH = join(HOOKS_DIR, HOOK_NAME);
const HOOK_REL = `./hooks/${HOOK_NAME}`;

/** The shipped canonical hook script (files: ["hooks", ...]) is the single source of truth. */
function packagedHookPath(): string {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  return join(pkgRoot, "hooks", HOOK_NAME);
}

interface HookEntry {
  command: string;
  timeout?: number;
  [k: string]: unknown;
}
interface HooksConfig {
  version?: number;
  hooks?: { postToolUse?: HookEntry[]; [k: string]: unknown };
  [k: string]: unknown;
}

function loadHooksConfig(): HooksConfig {
  if (!existsSync(HOOKS_JSON)) return { version: 1, hooks: {} };
  try {
    return JSON.parse(readFileSync(HOOKS_JSON, "utf8")) as HooksConfig;
  } catch {
    return { version: 1, hooks: {} };
  }
}

function main(): void {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const src = packagedHookPath();
  if (!existsSync(src)) {
    process.stderr.write(`Could not find the packaged hook script at ${src}\n`);
    process.exit(1);
  }
  copyFileSync(src, HOOK_PATH);
  try {
    chmodSync(HOOK_PATH, 0o755);
  } catch {
    /* ignore */
  }

  const cfg = loadHooksConfig();
  cfg.version = cfg.version ?? 1;
  cfg.hooks = cfg.hooks ?? {};
  const list: HookEntry[] = Array.isArray(cfg.hooks.postToolUse) ? cfg.hooks.postToolUse : [];

  // Drop any previous cursor-usage* reminder entries so we don't double-inject.
  const cleaned = list.filter((e) => {
    const c = typeof e?.command === "string" ? e.command : "";
    return !(/cursor-usage/i.test(c) && /reminder/i.test(c));
  });
  cleaned.push({ command: HOOK_REL, timeout: 5 });
  cfg.hooks.postToolUse = cleaned;

  writeFileSync(HOOKS_JSON, JSON.stringify(cfg, null, 2));

  process.stdout.write(
    `Installed reminder hook:\n  script: ${HOOK_PATH}\n  hooks.json: ${HOOKS_JSON} (postToolUse -> ${HOOK_REL})\n` +
      `Reload Cursor (or it will pick the hook up on the next session) to activate.\n`,
  );
}

main();
