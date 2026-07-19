// Daily "is there a newer version?" check against the GitHub repo.
//
// The repo has no releases/tags, so a "new version" == new commits on origin/master
// that the local checkout doesn't have. We detect this with GitHub's compare API
// (compare <localSha>...master) — no `git fetch`, read-only, and fully fail-open
// (offline / proxy / rate-limit just means "no update surfaced").
//
// The network call runs at most once/day and only from a background context
// (reminder-cli / a fire-and-forget kick from get_usage), so it never adds latency
// to the agent. get_usage itself only READS the cached state file.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { STORE_DIR } from "./storage.js";

const REPO = "udah1/cursor-usage-mcp";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6000;
const UPDATE_FILE = join(STORE_DIR, "update.json");

export interface UpdateState {
  /** ISO of the last network check (drives the once/day throttle). */
  lastCheckedAt?: string;
  /** Local HEAD sha at last check. */
  localSha?: string;
  /** Remote origin/master HEAD sha at last check. */
  latestSha?: string;
  /** How many commits origin/master is ahead of local (updates available). */
  aheadBy?: number;
  /** The remote sha the user chose to skip — suppresses prompting until a newer one. */
  dismissedSha?: string;
}

export interface UpdateStatus {
  available: boolean;
  aheadBy: number;
  localSha?: string;
  latestSha?: string;
  repoDir: string;
  /** Copy/paste-ready commands the agent should give the user to update. */
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
    // best-effort; the check is an optimization
  }
}

/** Resolve the repo root (dist/.. or the CURSOR_USAGE_MCP_DIR override). */
export function repoDir(): string {
  const override = process.env.CURSOR_USAGE_MCP_DIR;
  if (override && override.trim() !== "") return override;
  const here = dirname(fileURLToPath(import.meta.url)); // .../dist
  return join(here, "..");
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
    // not a git checkout / unreadable
  }
  return undefined;
}

/**
 * Perform the daily network check if due (or if force). Never throws. Updates
 * update.json with the latest ahead-by count and remote sha.
 */
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
  const localSha = readLocalSha(repoDir());
  // Always stamp the check time so a failure still respects the daily throttle.
  const next: UpdateState = { ...state, lastCheckedAt: new Date().toISOString(), localSha };
  if (!localSha) {
    saveState(next);
    return;
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/compare/${localSha}...master`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "cursor-usage-mcp" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const j = (await res.json()) as {
        ahead_by?: number;
        commits?: Array<{ sha?: string }>;
      };
      const aheadBy = typeof j.ahead_by === "number" ? j.ahead_by : 0;
      next.aheadBy = aheadBy;
      next.latestSha =
        aheadBy > 0 && Array.isArray(j.commits) && j.commits.length
          ? j.commits[j.commits.length - 1].sha
          : localSha;
    }
    // Non-2xx (e.g. 404 when local sha isn't on the remote, or rate limit): fail open.
  } catch {
    // offline / timeout / proxy: fail open
  }
  saveState(next);
}

/** Read-only status for get_usage/status. Never hits the network. */
export function getUpdateStatus(): UpdateStatus {
  const state = loadState();
  const aheadBy = state.aheadBy ?? 0;
  const latestSha = state.latestSha;
  const dismissed = Boolean(latestSha && state.dismissedSha && state.dismissedSha === latestSha);
  const available = aheadBy > 0 && Boolean(latestSha) && !dismissed;
  const dir = repoDir();
  const howToUpdate =
    `Run in a terminal: cd "${dir}" && git pull && npm run build — then reload the ` +
    `cursor-usage MCP (Settings → MCP → toggle it off/on) so the new dist/ is picked up.`;
  return {
    available,
    aheadBy,
    localSha: state.localSha,
    latestSha,
    repoDir: dir,
    howToUpdate,
  };
}

/** Record that the user skipped the current version; won't prompt again until a newer one. */
export function dismissUpdate(): { dismissedSha?: string } {
  const state = loadState();
  if (state.latestSha) {
    state.dismissedSha = state.latestSha;
    saveState(state);
  }
  return { dismissedSha: state.dismissedSha };
}
