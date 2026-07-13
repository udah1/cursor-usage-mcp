import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * A session reconstructed from Cursor's own local auth, with no browser login.
 *
 * Cursor stores its auth in `state.vscdb` (a SQLite key/value store) under
 * `ItemTable`. The `cursorAuth/accessToken` value is a JWT whose `sub` claim is
 * the user id. The dashboard's session cookie has a fixed shape:
 *   WorkosCursorSessionToken=<userSub>::<accessToken>
 * where `userSub` is the JWT `sub` with any `auth0|` provider prefix stripped.
 * So any process on the same machine that can read that file can talk to the
 * dashboard API without a login popup.
 */
export interface LocalSession {
  cookie: string;
  /** The JWT `sub` with the provider prefix stripped, e.g. "user_01...". */
  userSub: string;
  /** Numeric team id from `cursorAuth/cachedTeam`, when present. */
  teamId?: string;
  /** JWT `exp` (unix seconds), when present — the token rotates. */
  expEpoch?: number;
  /** Path of the state.vscdb the session was read from. */
  dbPath: string;
}

function isTruthyEnv(v: string | undefined): boolean {
  return typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Candidate `state.vscdb` locations, most-specific first. `CURSOR_STATE_DB`
 * overrides everything (for non-standard installs). Otherwise the path is
 * derived per OS the same way VS Code / Electron lays out `globalStorage`.
 */
export function stateDbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string[] {
  const out: string[] = [];
  const override = env.CURSOR_STATE_DB?.trim();
  if (override) out.push(override);

  const rel = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (platform === "darwin") {
    out.push(join(home, "Library", "Application Support", ...rel));
  } else if (platform === "win32") {
    const appData = env.APPDATA || join(home, "AppData", "Roaming");
    out.push(join(appData, ...rel));
  } else {
    const cfg = env.XDG_CONFIG_HOME || join(home, ".config");
    out.push(join(cfg, ...rel));
  }
  return out;
}

/** First candidate `state.vscdb` that exists on disk, if any. */
export function findStateDb(): string | undefined {
  return stateDbCandidates().find((p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  });
}

/** Decode a JWT's payload (no signature verification) and pull `sub` / `exp`. */
export function decodeJwt(token: string): { sub?: string; exp?: number } | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      sub: typeof payload.sub === "string" ? payload.sub : undefined,
      exp: typeof payload.exp === "number" ? payload.exp : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Strip a provider prefix like `auth0|` from a JWT `sub` to get the bare user id. */
export function normalizeSub(sub: string): string {
  return sub.includes("|") ? (sub.split("|").pop() ?? sub) : sub;
}

/** Build the dashboard session cookie the browser would send. */
export function buildWorkosCookie(userSub: string, accessToken: string): string {
  return `WorkosCursorSessionToken=${userSub}::${accessToken}`;
}

/** Extract a team id from the parsed `cursorAuth/cachedTeam` JSON, if any. */
export function teamIdFromCachedTeam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw);
    const id = o?.teamId ?? o?.id ?? o?.team?.id;
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
    if (typeof id === "string" && /^\d+$/.test(id)) return id;
  } catch {
    // not JSON; ignore
  }
  return undefined;
}

/**
 * Reconstruct a dashboard session from Cursor's local token store, or return
 * undefined if it can't (no DB, no `node:sqlite`, no token, or login forced via
 * CURSOR_USAGE_FORCE_LOGIN). Read-only; never writes and never stores the token.
 */
export async function readLocalSession(): Promise<LocalSession | undefined> {
  if (isTruthyEnv(process.env.CURSOR_USAGE_FORCE_LOGIN)) return undefined;
  const dbPath = findStateDb();
  if (!dbPath) return undefined;

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    // node:sqlite unavailable (Node < 22.5) — caller falls back to login.
    return undefined;
  }

  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const get = (key: string): string | undefined => {
      const row = db!.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as
        | { value: unknown }
        | undefined;
      if (!row) return undefined;
      let v: unknown = row.value;
      if (Buffer.isBuffer(v)) v = v.toString("utf8");
      if (typeof v !== "string") return undefined;
      return v.trim().replace(/^"|"$/g, "");
    };

    const token = get("cursorAuth/accessToken");
    if (!token) return undefined;
    const decoded = decodeJwt(token);
    if (!decoded?.sub) return undefined;

    const userSub = normalizeSub(decoded.sub);
    return {
      cookie: buildWorkosCookie(userSub, token),
      userSub,
      teamId: teamIdFromCachedTeam(get("cursorAuth/cachedTeam")),
      expEpoch: decoded.exp,
      dbPath,
    };
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}
