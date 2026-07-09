import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * All persistent state lives in ~/.cursor-usage so it survives across projects
 * and is never written into any git repo.
 */
export const STORE_DIR = join(homedir(), ".cursor-usage");
export const BROWSER_DIR = join(STORE_DIR, "browser");
const STORE_FILE = join(STORE_DIR, "store.json");

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
}

const DEFAULT_STORE: Store = {
  endpoints: [],
  activationThresholdPct: 0,
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
