import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

/**
 * All persistent state lives in ~/.cursor-usage so it survives across projects
 * and is never written into any git repo.
 */
export const STORE_DIR = join(homedir(), ".cursor-usage");
export const BROWSER_DIR = join(STORE_DIR, "browser");
const STORE_FILE = join(STORE_DIR, "store.json");
/**
 * Volatile usage cache, kept SEPARATE from store.json so the settings/session file
 * isn't rewritten on every reading. Shared by get_usage and the background footer
 * refresher so a single fetch serves both.
 */
export const CACHE_FILE = join(STORE_DIR, "cache.json");

export interface CapturedEndpoint {
  /** Full request URL that returned usage/spend data. */
  url: string;
  method: string;
  /** Raw request body for POST endpoints, if any. */
  postData?: string;
  /** Content-Type of the original request, so we can replay it faithfully. */
  contentType?: string;
  /** Keys seen at the top level of the JSON response (for diagnostics). */
  sampleResponseKeys?: string[];
}

export interface Store {
  /** Cookie header string (name=value; name2=value2) captured at login. */
  cookieHeader?: string;
  /** ISO timestamp of the last successful login. */
  capturedAt?: string;
  /** Candidate endpoints discovered during login, best-first. */
  endpoints: CapturedEndpoint[];
  /**
   * Minimum usage percentage (0-100) at which conserve mode activates.
   * Default 0 => conserve whenever a usage reading succeeds and requests remain.
   */
  activationThresholdPct: number;
  /** Persisted verbose mode (append usage footer to every message). Default false. */
  verbose: boolean;
  /** Persisted follow-up mode (end each task with a "anything else?" options question). Default false. */
  followup: boolean;
}

const DEFAULT_STORE: Store = {
  endpoints: [],
  activationThresholdPct: 0,
  verbose: false,
  followup: false,
};

function ensureDir(): void {
  if (!existsSync(STORE_DIR)) {
    mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadStore(): Store {
  ensureDir();
  if (!existsSync(STORE_FILE)) return { ...DEFAULT_STORE };
  try {
    const raw = readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Store>;
    return {
      ...DEFAULT_STORE,
      ...parsed,
      endpoints: parsed.endpoints ?? [],
    };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

export function saveStore(store: Store): void {
  ensureDir();
  // 0600 so only the current user can read the session cookie.
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

export function hasSession(store: Store): boolean {
  return Boolean(store.cookieHeader && store.endpoints.length > 0);
}

/** Read the volatile usage cache. Returns null if absent or unparseable. */
export function loadCacheFile<T>(): T | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Write the volatile usage cache (best-effort; never throws). */
export function saveCacheFile(data: unknown): void {
  try {
    ensureDir();
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch {
    // Caching is an optimization; ignore write failures.
  }
}

/** Remove the volatile usage cache (e.g. on login/logout). */
export function clearCacheFile(): void {
  try {
    if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE, { force: true });
  } catch {
    // ignore
  }
}

/**
 * Clear the stored session (cookie + discovered endpoints), keeping the threshold config.
 * Optionally also wipe the saved Playwright browser profile so the next login is a full re-auth.
 */
export function clearSession(alsoBrowser: boolean): { clearedBrowser: boolean } {
  const store = loadStore();
  store.cookieHeader = undefined;
  store.endpoints = [];
  store.capturedAt = undefined;
  saveStore(store);
  // A stale reading must not survive a logout.
  clearCacheFile();
  let clearedBrowser = false;
  if (alsoBrowser && existsSync(BROWSER_DIR)) {
    rmSync(BROWSER_DIR, { recursive: true, force: true });
    clearedBrowser = true;
  }
  return { clearedBrowser };
}

/**
 * Effective activation threshold. The CURSOR_USAGE_THRESHOLD_PCT env var (settable in
 * mcp.json) takes precedence over the value persisted by the set_threshold tool, so users
 * can configure it declaratively without a tool call. Falls back to the stored value.
 */
export function effectiveThreshold(store: Store): number {
  const raw = process.env.CURSOR_USAGE_THRESHOLD_PCT;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return store.activationThresholdPct;
}

/**
 * Effective verbose mode. The CURSOR_USAGE_VERBOSE env var takes precedence (and can force off,
 * e.g. "false"/"0"); otherwise the value persisted by set_verbose is used. Default off.
 */
export function isVerbose(store: Store): boolean {
  const raw = process.env.CURSOR_USAGE_VERBOSE;
  if (typeof raw === "string" && raw.trim() !== "") {
    return /^(1|true|yes|on)$/i.test(raw.trim());
  }
  return store.verbose;
}

/**
 * Effective follow-up mode. CURSOR_USAGE_FOLLOWUP env takes precedence (can force off); otherwise
 * the value persisted by set_followup is used. Default off.
 */
export function isFollowup(store: Store): boolean {
  const raw = process.env.CURSOR_USAGE_FOLLOWUP;
  if (typeof raw === "string" && raw.trim() !== "") {
    return /^(1|true|yes|on)$/i.test(raw.trim());
  }
  return store.followup;
}
