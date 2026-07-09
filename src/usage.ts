import { loadStore, hasSession, type CapturedEndpoint, type Store } from "./storage.js";

export interface UsageReading {
  ok: boolean;
  needsLogin?: boolean;
  error?: string;
  /** Endpoint that produced the reading. */
  source?: string;
  /** Best-effort parsed usage. */
  used?: number;
  limit?: number;
  usedPct?: number;
  requestsRemaining?: number;
  /** Raw JSON so the agent can interpret if parsing is imperfect. */
  raw?: unknown;
}

export interface ConserveDecision extends UsageReading {
  activationThresholdPct: number;
  conserve: boolean;
  reason: string;
}

async function replay(ep: CapturedEndpoint, cookieHeader: string): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: "application/json",
    Referer: "https://cursor.com/dashboard",
    Origin: "https://cursor.com",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  };
  const init: RequestInit = { method: ep.method, headers };
  if (ep.method.toUpperCase() === "POST") {
    headers["Content-Type"] = ep.contentType ?? "application/json";
    init.body = ep.postData ?? "{}";
  }
  return fetch(ep.url, init);
}

/**
 * Classic Cursor usage shape: { "gpt-4": { numRequests, maxRequestUsage }, ... }.
 * Returns used/limit taken from the entry with the largest quota.
 */
function parseModelUsageMap(json: any): { used: number; limit: number } | null {
  if (!json || typeof json !== "object") return null;
  let best: { used: number; limit: number } | null = null;
  for (const value of Object.values<any>(json)) {
    if (value && typeof value === "object" && typeof value.numRequests === "number") {
      const limit =
        typeof value.maxRequestUsage === "number" ? value.maxRequestUsage : Number.NaN;
      if (!Number.isNaN(limit)) {
        if (!best || limit > best.limit) best = { used: value.numRequests, limit };
      }
    }
  }
  return best;
}

/** Generic fallback: walk the object looking for used-ish and limit-ish numbers. */
function parseGeneric(json: any): { used?: number; limit?: number } {
  let used: number | undefined;
  let limit: number | undefined;
  const usedKey = /(numrequests|used|consumed|spendcents|currentusage|requestscosts)/i;
  const limitKey = /(maxrequest|hardlimit|limit|quota|included|max)/i;

  const walk = (obj: any, depth: number) => {
    if (!obj || typeof obj !== "object" || depth > 4) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "number") {
        if (used === undefined && usedKey.test(k)) used = v;
        else if (limit === undefined && limitKey.test(k)) limit = v;
      } else if (v && typeof v === "object") {
        walk(v, depth + 1);
      }
    }
  };
  walk(json, 0);
  return { used, limit };
}

function interpret(raw: unknown, source: string): UsageReading {
  const modelParse = parseModelUsageMap(raw);
  let used: number | undefined;
  let limit: number | undefined;
  if (modelParse) {
    used = modelParse.used;
    limit = modelParse.limit;
  } else {
    const g = parseGeneric(raw);
    used = g.used;
    limit = g.limit;
  }

  const reading: UsageReading = { ok: true, source, raw };
  if (typeof used === "number") reading.used = used;
  if (typeof limit === "number") reading.limit = limit;
  if (typeof used === "number" && typeof limit === "number" && limit > 0) {
    reading.usedPct = Math.round((used / limit) * 1000) / 10;
    reading.requestsRemaining = Math.max(0, limit - used);
  }
  return reading;
}

export async function getUsage(store: Store): Promise<UsageReading> {
  if (!hasSession(store)) {
    return { ok: false, needsLogin: true, error: "No session/endpoints stored. Run login first." };
  }
  let lastError = "No endpoints returned usable data.";
  for (const ep of store.endpoints) {
    try {
      const res = await replay(ep, store.cookieHeader!);
      if (res.status === 401 || res.status === 403) {
        return { ok: false, needsLogin: true, error: `Session expired (HTTP ${res.status}). Re-run login.` };
      }
      if (!res.ok) {
        lastError = `HTTP ${res.status} from ${ep.url}`;
        continue;
      }
      const json = await res.json();
      return interpret(json, ep.url);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: lastError };
}

export function decideConserve(reading: UsageReading, thresholdPct: number): ConserveDecision {
  const base: ConserveDecision = {
    ...reading,
    activationThresholdPct: thresholdPct,
    conserve: false,
    reason: "",
  };

  if (!reading.ok) {
    // Fail safe: if we can't read usage but the user asked to conserve from 0%,
    // default to conserving so we don't accidentally burn requests.
    base.conserve = thresholdPct === 0;
    base.reason = reading.needsLogin
      ? "Usage unknown (login required). " +
        (base.conserve ? "Conserving by default (threshold 0)." : "Not conserving.")
      : `Usage read failed: ${reading.error}. ` +
        (base.conserve ? "Conserving by default (threshold 0)." : "Not conserving.");
    return base;
  }

  if (typeof reading.usedPct !== "number") {
    base.conserve = thresholdPct === 0;
    base.reason =
      "Usage returned but percentage could not be computed from the response. " +
      (base.conserve ? "Conserving by default (threshold 0)." : "Not conserving.") +
      " See raw for details.";
    return base;
  }

  const remaining = reading.requestsRemaining ?? Number.POSITIVE_INFINITY;
  const requestsAvailable = remaining > 0 && reading.usedPct < 100;

  base.conserve = requestsAvailable && reading.usedPct >= thresholdPct;
  base.reason = requestsAvailable
    ? `Used ${reading.usedPct}% (>= threshold ${thresholdPct}% => ${base.conserve ? "conserve" : "normal"}). ${reading.requestsRemaining ?? "?"} requests remaining.`
    : `No requests remaining (used ${reading.usedPct}%). Conserve flag off (nothing left to conserve).`;
  return base;
}
