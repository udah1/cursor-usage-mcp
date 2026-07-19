// Daily "is there a newer version?" check. Two modes, auto-detected:
//
//  - npm install (no .git): compare the installed package version against the
//    `latest` dist-tag on the npm registry. This is the normal path for users who
//    installed via npx.
//  - git checkout (.git present): compare local HEAD against origin/master via
//    GitHub's compare API (no `git fetch`). This is the path for contributors.
//
// Fully fail-open (offline / proxy / rate-limit surfaces nothing) and network runs
// at most once/day from a background context, so it never adds latency. get_usage
// only READS the cached state.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { STORE_DIR } from "./storage.js";

const PKG_NAME = "cursor-usage-optimizer";
const GH_REPO = "udah1/cursor-usage-mcp";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const UPDATE_FILE = join(STORE_DIR, "update.json");

export type UpdateMode = "npm" | "git";

export interface UpdateState {
  lastCheckedAt?: string;
  mode?: UpdateMode;
  /** Installed identifier: version (npm) or HEAD sha (git). */
  local?: string;
  /** Latest identifier: registry `latest` version (npm) or origin/master sha (git). */
  latest?: string;
  /** Commits behind (git mode only). */
  aheadBy?: number;
  /** The `latest` value the user chose to skip — suppresses prompting until a newer one. */
  dismissed?: string;
}

export interface UpdateStatus {
  available: boolean;
  mode: UpdateMode;
  local?: string;
  latest?: string;
  aheadBy: number;
  repoDir: string;
  howToUpdate: string;
}

function loadState(): UpdateState {
  if (!existsSync(UPDATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(UPDATE_FILE, "utf8")) as UpdateState;
  } catch {
    return {};
  }
}

function saveState(state: UpdateState): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(UPDATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
}

/** Repo/package root (dist/.. or the CURSOR_USAGE_MCP_DIR override). */
export function repoDir(): string {
  const override = process.env.CURSOR_USAGE_MCP_DIR;
  if (override && override.trim() !== "") return override;
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

function detectMode(dir: string): UpdateMode {
  return existsSync(join(dir, ".git")) ? "git" : "npm";
}

function readLocalVersion(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** Read local HEAD sha straight from .git (no `git` spawn). Handles loose + packed refs. */
function readLocalSha(dir: string): string | undefined {
  try {
    const head = readFileSync(join(dir, ".git", "HEAD"), "utf8").trim();
    const m = head.match(/^ref:\s*(.+)$/);
    if (!m) return /^[0-9a-f]{7,40}$/i.test(head) ? head : undefined;
    const ref = m[1];
    const loose = join(dir, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = join(dir, ".git", "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        if (!line || line.startsWith("#") || line.startsWith("^")) continue;
        const [sha, r] = line.split(" ");
        if (r === ref) return sha;
      }
    }
  } catch {
    /* not a git checkout */
  }
  return undefined;
}

/** Compare dotted semver (ignores build/prerelease). Returns 1 if a>b, -1 if a<b, 0 equal. */
function cmpVersion(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": PKG_NAME },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Perform the daily network check if due (or force). Never throws. */
export async function maybeCheckForUpdate(opts?: { force?: boolean }): Promise<void> {
  const state = loadState();
  const now = Date.now();
  if (
    !opts?.force &&
    state.lastCheckedAt &&
    now - Date.parse(state.lastCheckedAt) < CHECK_INTERVAL_MS
  ) {
    return;
  }
  const dir = repoDir();
  const mode = detectMode(dir);
  const next: UpdateState = { ...state, mode, lastCheckedAt: new Date().toISOString() };

  if (mode === "npm") {
    const local = readLocalVersion(dir);
    next.local = local;
    next.aheadBy = undefined;
    if (local) {
      const j = await fetchJson(`https://registry.npmjs.org/${PKG_NAME}/latest`);
      const latest = typeof j?.version === "string" ? j.version : undefined;
      if (latest) next.latest = latest;
    }
  } else {
    const local = readLocalSha(dir);
    next.local = local;
    if (local) {
      const j = await fetchJson(`https://api.github.com/repos/${GH_REPO}/compare/${local}...master`);
      if (j) {
        const aheadBy = typeof j.ahead_by === "number" ? j.ahead_by : 0;
        next.aheadBy = aheadBy;
        next.latest =
          aheadBy > 0 && Array.isArray(j.commits) && j.commits.length
            ? j.commits[j.commits.length - 1].sha
            : local;
      }
    }
  }
  saveState(next);
}

/** Read-only status for get_usage/status. Never hits the network. */
export function getUpdateStatus(): UpdateStatus {
  const state = loadState();
  const dir = repoDir();
  const mode: UpdateMode = state.mode ?? detectMode(dir);
  const local = state.local;
  const latest = state.latest;
  const dismissed = Boolean(latest && state.dismissed && state.dismissed === latest);

  let available = false;
  let aheadBy = 0;
  if (mode === "npm") {
    available = Boolean(local && latest && cmpVersion(latest, local) > 0) && !dismissed;
  } else {
    aheadBy = state.aheadBy ?? 0;
    available = aheadBy > 0 && Boolean(latest) && !dismissed;
  }

  const howToUpdate =
    mode === "npm"
      ? `Reload the cursor-usage MCP (Settings → MCP → toggle off/on) — npx will fetch ` +
        `${PKG_NAME}@latest (${latest ?? "newer"}). If it's globally installed instead, run ` +
        `npm i -g ${PKG_NAME}@latest first.`
      : `Run in a terminal: cd "${dir}" && git pull && npm run build — then reload the ` +
        `cursor-usage MCP so the new dist/ is picked up.`;

  return { available, mode, local, latest, aheadBy, repoDir: dir, howToUpdate };
}

/** Record that the user skipped the current version; won't prompt again until a newer one. */
export function dismissUpdate(): { dismissed?: string } {
  const state = loadState();
  if (state.latest) {
    state.dismissed = state.latest;
    saveState(state);
  }
  return { dismissed: state.dismissed };
}
