import { hasSession, type CapturedEndpoint, type Store } from "./storage.js";

export interface IncludedRequests {
  used: number;
  limit: number;
  remaining: number;
  pct: number;
}

export interface SpendInfo {
  usedDollars: number;
  limitDollars: number | null;
  remainingDollars: number | null;
  /** Percent of the included budget used, if the API reports it. */
  pctUsed?: number;
}

export interface UsageReading {
  ok: boolean;
  needsLogin?: boolean;
  error?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  includedRequests?: IncludedRequests;
  spend?: SpendInfo;
  /** Endpoints that produced data. */
  sources: string[];
  /** Raw JSON per source so the agent can inspect if needed. */
  raw: Record<string, unknown>;
}

export interface ConserveDecision extends UsageReading {
  activationThresholdPct: number;
  conserve: boolean;
  reason: string;
  /** One-line human summary of the reading. */
  summary: string;
}

const COMMON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  Referer: "https://cursor.com/dashboard",
  Origin: "https://cursor.com",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

function isModelUsageEndpoint(url: string): boolean {
  // Matches https://cursor.com/api/usage and https://cursor.com/api/usage?user=...
  // but NOT /api/usage-summary.
  return /\/api\/usage(\?|$)/.test(url);
}

function isSummaryEndpoint(url: string): boolean {
  return url.includes("/api/usage-summary");
}

async function fetchJson(
  ep: CapturedEndpoint,
  cookieHeader: string,
): Promise<{ status: number; json?: any }> {
  const headers: Record<string, string> = { ...COMMON_HEADERS, Cookie: cookieHeader };
  const init: RequestInit = { method: ep.method, headers };
  if (ep.method.toUpperCase() === "POST") {
    headers["Content-Type"] = ep.contentType ?? "application/json";
    init.body = ep.postData ?? "{}";
  }
  const res = await fetch(ep.url, init);
  if (!res.ok) return { status: res.status };
  try {
    return { status: res.status, json: await res.json() };
  } catch {
    return { status: res.status };
  }
}

/**
 * Parse the /api/usage model map. Included-request usage is reported per model;
 * we take the entry with the largest quota (the plan's included-request limit).
 */
function parseIncludedRequests(json: any): IncludedRequests | undefined {
  if (!json || typeof json !== "object") return undefined;
  let best: IncludedRequests | undefined;
  for (const value of Object.values<any>(json)) {
    if (value && typeof value === "object" && typeof value.numRequests === "number") {
      const limit = typeof value.maxRequestUsage === "number" ? value.maxRequestUsage : null;
      if (limit && limit > 0) {
        const used = value.numRequests;
        const candidate: IncludedRequests = {
          used,
          limit,
          remaining: Math.max(0, limit - used),
          pct: Math.round((used / limit) * 1000) / 10,
        };
        if (!best || candidate.limit > best.limit) best = candidate;
      }
    }
  }
  return best;
}

function centsToDollars(cents: unknown): number | null {
  return typeof cents === "number" ? Math.round((cents / 100) * 100) / 100 : null;
}

/** Parse /api/usage-summary for membership, unlimited flag, and on-demand spend. */
function parseSummary(json: any): {
  membershipType?: string;
  isUnlimited?: boolean;
  spend?: SpendInfo;
} {
  if (!json || typeof json !== "object") return {};
  const out: { membershipType?: string; isUnlimited?: boolean; spend?: SpendInfo } = {};
  if (typeof json.membershipType === "string") out.membershipType = json.membershipType;
  if (typeof json.isUnlimited === "boolean") out.isUnlimited = json.isUnlimited;

  const onDemand = json?.individualUsage?.onDemand;
  const plan = json?.individualUsage?.plan;
  if (onDemand && typeof onDemand === "object") {
    const usedDollars = centsToDollars(onDemand.used) ?? 0;
    const limitDollars = centsToDollars(onDemand.limit);
    const remainingDollars = centsToDollars(onDemand.remaining);
    out.spend = {
      usedDollars,
      limitDollars,
      remainingDollars,
      pctUsed:
        typeof plan?.totalPercentUsed === "number"
          ? Math.round(plan.totalPercentUsed * 10) / 10
          : undefined,
    };
  }
  return out;
}

export async function getUsage(store: Store): Promise<UsageReading> {
  if (!hasSession(store)) {
    return {
      ok: false,
      needsLogin: true,
      error: "No session/endpoints stored. Run the 'login' tool first.",
      sources: [],
      raw: {},
    };
  }

  const cookie = store.cookieHeader!;
  const reading: UsageReading = { ok: false, sources: [], raw: {} };
  let sawAuthError = false;
  let lastError = "";

  // 1) Included-request usage (the "X / 500" number).
  const usageEp = store.endpoints.find((e) => isModelUsageEndpoint(e.url) && e.method === "GET");
  if (usageEp) {
    try {
      const { status, json } = await fetchJson(usageEp, cookie);
      if (status === 401 || status === 403) sawAuthError = true;
      else if (json) {
        const parsed = parseIncludedRequests(json);
        reading.raw.usage = json;
        reading.sources.push(usageEp.url);
        if (parsed) reading.includedRequests = parsed;
      } else lastError = `HTTP ${status} from ${usageEp.url}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 2) Summary (membership + on-demand spend/budget).
  const summaryEp = store.endpoints.find((e) => isSummaryEndpoint(e.url) && e.method === "GET");
  if (summaryEp) {
    try {
      const { status, json } = await fetchJson(summaryEp, cookie);
      if (status === 401 || status === 403) sawAuthError = true;
      else if (json) {
        const parsed = parseSummary(json);
        reading.raw.summary = json;
        reading.sources.push(summaryEp.url);
        reading.membershipType = parsed.membershipType;
        reading.isUnlimited = parsed.isUnlimited;
        reading.spend = parsed.spend;
      } else if (!lastError) lastError = `HTTP ${status} from ${summaryEp.url}`;
    } catch (err) {
      if (!lastError) lastError = err instanceof Error ? err.message : String(err);
    }
  }

  if (reading.includedRequests || reading.spend) {
    reading.ok = true;
    return reading;
  }

  if (sawAuthError) {
    return {
      ok: false,
      needsLogin: true,
      error: "Session expired (HTTP 401/403). Re-run the 'login' tool.",
      sources: reading.sources,
      raw: reading.raw,
    };
  }
  return {
    ok: false,
    error: lastError || "Could not read usage from any known endpoint.",
    sources: reading.sources,
    raw: reading.raw,
  };
}

function buildSummary(r: UsageReading): string {
  const parts: string[] = [];
  if (r.includedRequests) {
    const ir = r.includedRequests;
    parts.push(`Included requests: ${ir.used}/${ir.limit} (${ir.pct}%), ${ir.remaining} left`);
  }
  if (r.spend) {
    const s = r.spend;
    const limit = s.limitDollars === null ? "unlimited" : `$${s.limitDollars.toFixed(2)}`;
    parts.push(`On-demand spend: $${s.usedDollars.toFixed(2)}/${limit}`);
  }
  if (r.membershipType) parts.push(`Plan: ${r.membershipType}${r.isUnlimited ? " (unlimited)" : ""}`);
  return parts.join(" | ") || "No usage data parsed.";
}

export function decideConserve(reading: UsageReading, thresholdPct: number): ConserveDecision {
  const base: ConserveDecision = {
    ...reading,
    activationThresholdPct: thresholdPct,
    conserve: false,
    reason: "",
    summary: buildSummary(reading),
  };

  if (!reading.ok) {
    // Fail safe: when usage is unknown and the user wants conserving from 0%, conserve.
    base.conserve = thresholdPct === 0;
    base.reason = reading.needsLogin
      ? `Usage unknown (login required). ${base.conserve ? "Conserving by default (threshold 0)." : "Not conserving."}`
      : `Usage read failed: ${reading.error}. ${base.conserve ? "Conserving by default (threshold 0)." : "Not conserving."}`;
    return base;
  }

  if (reading.isUnlimited) {
    base.conserve = false;
    base.reason = "Plan is unlimited — no need to conserve.";
    return base;
  }

  // Base the decision on included-request usage (the "500 requests" the user tracks).
  const pct = reading.includedRequests?.pct ?? reading.spend?.pctUsed;
  if (typeof pct !== "number") {
    base.conserve = thresholdPct === 0;
    base.reason = `Usage read but no percentage available. ${base.conserve ? "Conserving by default (threshold 0)." : "Not conserving."}`;
    return base;
  }

  base.conserve = pct >= thresholdPct;
  base.reason = `Used ${pct}% (threshold ${thresholdPct}%) => ${base.conserve ? "CONSERVE" : "normal"}.`;
  return base;
}
