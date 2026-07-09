import { hasSession, type CapturedEndpoint, type Store } from "./storage.js";

export interface IncludedRequests {
  used: number;
  limit: number;
  remaining: number;
  pct: number;
}

export interface SpendInfo {
  usedDollars: number;
  /** The individual's actual, effective on-demand budget (authoritative for this user). */
  limitDollars: number | null;
  remainingDollars: number | null;
  /** Percent of the included budget used, if the API reports it. */
  pctUsed?: number;
  /** Team-wide default per-user hard limit (from get-hard-limit); context only. */
  perUserHardLimitDollars?: number | null;
  /** True when the individual's actual budget differs from the team per-user cap. */
  budgetDiffersFromTeamCap?: boolean;
}

export interface BillingCycle {
  start: string;
  end: string;
  daysElapsed: number;
  daysLeft: number;
  cycleLengthDays: number;
}

export interface Pace {
  requestsPerDay: number;
  /** Projected included requests by cycle end at the current rate. */
  projectedRequests: number;
  /** Projected requests as a percentage of the limit. */
  projectedPctOfLimit: number;
  /** True if projected to exceed the included-request limit before reset. */
  projectedToExceed: boolean;
}

export interface UsageReading {
  ok: boolean;
  needsLogin?: boolean;
  error?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  includedRequests?: IncludedRequests;
  spend?: SpendInfo;
  billingCycle?: BillingCycle;
  pace?: Pace;
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

/** Parse /api/usage-summary for membership, unlimited flag, on-demand spend, and cycle dates. */
function parseSummary(json: any): {
  membershipType?: string;
  isUnlimited?: boolean;
  spend?: SpendInfo;
  billingCycleStart?: string;
  billingCycleEnd?: string;
} {
  if (!json || typeof json !== "object") return {};
  const out: {
    membershipType?: string;
    isUnlimited?: boolean;
    spend?: SpendInfo;
    billingCycleStart?: string;
    billingCycleEnd?: string;
  } = {};
  if (typeof json.membershipType === "string") out.membershipType = json.membershipType;
  if (typeof json.isUnlimited === "boolean") out.isUnlimited = json.isUnlimited;
  if (typeof json.billingCycleStart === "string") out.billingCycleStart = json.billingCycleStart;
  if (typeof json.billingCycleEnd === "string") out.billingCycleEnd = json.billingCycleEnd;

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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function computeCycle(start: string, end: string): BillingCycle | undefined {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  const now = Date.now();
  const cycleLengthDays = Math.round((e - s) / MS_PER_DAY);
  const daysElapsed = Math.max(0, Math.round(((now - s) / MS_PER_DAY) * 10) / 10);
  const daysLeft = Math.max(0, Math.round(((e - now) / MS_PER_DAY) * 10) / 10);
  return { start, end, daysElapsed, daysLeft, cycleLengthDays };
}

function computePace(ir: IncludedRequests, cycle: BillingCycle): Pace {
  const elapsed = Math.max(0.5, cycle.daysElapsed); // avoid divide-by-zero early in cycle
  const requestsPerDay = Math.round((ir.used / elapsed) * 10) / 10;
  const projectedRequests = Math.round(requestsPerDay * cycle.cycleLengthDays);
  const projectedPctOfLimit = Math.round((projectedRequests / ir.limit) * 1000) / 10;
  return {
    requestsPerDay,
    projectedRequests,
    projectedPctOfLimit,
    projectedToExceed: projectedRequests > ir.limit,
  };
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

  // Kick off the team per-user hard-limit fetch in parallel (context for the spend line).
  const teamId = getTeamId(store);
  const hardLimitPromise = teamId
    ? fetchJson(
        {
          url: "https://cursor.com/api/dashboard/get-hard-limit",
          method: "POST",
          postData: JSON.stringify({ teamId: Number(teamId) }),
          contentType: "application/json",
        },
        cookie,
      ).catch(() => ({ status: 0 }) as { status: number; json?: any })
    : null;

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
        if (parsed.billingCycleStart && parsed.billingCycleEnd) {
          reading.billingCycle = computeCycle(parsed.billingCycleStart, parsed.billingCycleEnd);
        }
      } else if (!lastError) lastError = `HTTP ${status} from ${summaryEp.url}`;
    } catch (err) {
      if (!lastError) lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 3) Team per-user hard limit — merge into spend as context.
  if (hardLimitPromise) {
    const hl = await hardLimitPromise;
    const perUser = typeof hl.json?.hardLimitPerUser === "number" ? hl.json.hardLimitPerUser : null;
    if (perUser !== null) {
      reading.raw.hardLimit = hl.json;
      if (!reading.sources.includes("get-hard-limit")) reading.sources.push("get-hard-limit");
      if (!reading.spend) {
        reading.spend = { usedDollars: 0, limitDollars: null, remainingDollars: null };
      }
      reading.spend.perUserHardLimitDollars = perUser;
      if (reading.spend.limitDollars !== null) {
        reading.spend.budgetDiffersFromTeamCap = reading.spend.limitDollars !== perUser;
      }
    }
  }

  // Burn-rate projection from included requests + cycle progress.
  if (reading.includedRequests && reading.billingCycle) {
    reading.pace = computePace(reading.includedRequests, reading.billingCycle);
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
    let line = `On-demand spend: $${s.usedDollars.toFixed(2)}/${limit}`;
    if (typeof s.perUserHardLimitDollars === "number") {
      line += ` (team per-user cap: $${s.perUserHardLimitDollars.toFixed(2)}${s.budgetDiffersFromTeamCap ? " — differs from your budget" : ""})`;
    }
    parts.push(line);
  }
  if (r.membershipType) parts.push(`Plan: ${r.membershipType}${r.isUnlimited ? " (unlimited)" : ""}`);
  if (r.billingCycle) {
    const resetDate = new Date(r.billingCycle.end).toISOString().slice(0, 10);
    parts.push(`Resets ${resetDate} (${r.billingCycle.daysLeft}d left)`);
  }
  if (r.pace) {
    const flag = r.pace.projectedToExceed ? " ⚠ over limit" : "";
    parts.push(
      `Pace: ${r.pace.requestsPerDay}/day → ~${r.pace.projectedRequests} by reset (${r.pace.projectedPctOfLimit}%${flag})`,
    );
  }
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

export interface ModelUsage {
  model: string;
  costDollars: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface UsageBreakdown {
  ok: boolean;
  needsLogin?: boolean;
  error?: string;
  teamId?: string;
  models: ModelUsage[];
  totalCostDollars: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
}

/** Extract the numeric team id from the stored cookie or endpoint URLs. */
export function getTeamId(store: Store): string | undefined {
  const fromCookie = store.cookieHeader?.match(/team_id=(\d+)/)?.[1];
  if (fromCookie) return fromCookie;
  for (const ep of store.endpoints) {
    const m = ep.url.match(/teamId=(\d+)/);
    if (m) return m[1];
  }
  return undefined;
}

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
};

/** Per-model cost/token breakdown for the current cycle (get-aggregated-usage-events). */
export async function getUsageBreakdown(store: Store): Promise<UsageBreakdown> {
  const empty: UsageBreakdown = {
    ok: false,
    models: [],
    totalCostDollars: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  };
  if (!hasSession(store)) {
    return { ...empty, needsLogin: true, error: "No session stored. Run the 'login' tool first." };
  }
  const teamId = getTeamId(store);
  if (!teamId) return { ...empty, error: "Could not determine team id from the stored session." };

  const ep: CapturedEndpoint = {
    url: "https://cursor.com/api/dashboard/get-aggregated-usage-events",
    method: "POST",
    postData: JSON.stringify({ teamId: Number(teamId) }),
    contentType: "application/json",
  };
  try {
    const { status, json } = await fetchJson(ep, store.cookieHeader!);
    if (status === 401 || status === 403) {
      return { ...empty, needsLogin: true, error: `Session expired (HTTP ${status}). Re-run 'login'.` };
    }
    if (!json) return { ...empty, error: `HTTP ${status} from ${ep.url}` };

    const models: ModelUsage[] = (Array.isArray(json.aggregations) ? json.aggregations : [])
      .map((a: any) => ({
        model: String(a.modelIntent ?? "unknown"),
        costDollars: Math.round(num(a.totalCents)) / 100,
        requests: num(a.requestCost),
        inputTokens: num(a.inputTokens),
        outputTokens: num(a.outputTokens),
        cacheReadTokens: num(a.cacheReadTokens),
        cacheWriteTokens: num(a.cacheWriteTokens),
      }))
      .sort((x: ModelUsage, y: ModelUsage) => y.costDollars - x.costDollars);

    return {
      ok: true,
      teamId,
      models,
      totalCostDollars: Math.round(num(json.totalCostCents)) / 100,
      totalInputTokens: num(json.totalInputTokens),
      totalOutputTokens: num(json.totalOutputTokens),
      totalCacheReadTokens: num(json.totalCacheReadTokens),
      totalCacheWriteTokens: num(json.totalCacheWriteTokens),
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
