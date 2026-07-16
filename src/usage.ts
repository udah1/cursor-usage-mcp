import {
  type CapturedEndpoint,
  type Store,
  loadCacheFile,
  saveCacheFile,
} from "./storage.js";
import { readLocalSession } from "./token.js";

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
  /** How the session was obtained: "local-token" (state.vscdb) or "login" (stored cookie). */
  authSource?: "local-token" | "login";
  /** Raw JSON per source so the agent can inspect if needed. */
  raw: Record<string, unknown>;
  /** True when this reading was served from cache rather than a fresh fetch. */
  cached?: boolean;
  /** ISO timestamp of the underlying fetch (== now for fresh reads, older for cached). */
  fetchedAt?: string;
}

export interface ConserveDecision extends UsageReading {
  activationThresholdPct: number;
  conserve: boolean;
  /**
   * Included-request quota is used up (0 left / ≥100%). On corporate/team plans
   * this just means usage moved to on-demand, which the org covers — the user
   * doesn't pay out of pocket. Callers should notify the user ONCE and then
   * continue normally (no approval, no extra conserving — there's nothing left
   * to conserve).
   */
  exhausted: boolean;
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

/** Max time to wait for a single dashboard request before giving up. */
const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(
  ep: CapturedEndpoint,
  cookieHeader: string,
): Promise<{ status: number; json?: any }> {
  const headers: Record<string, string> = { ...COMMON_HEADERS, Cookie: cookieHeader };
  const init: RequestInit = {
    method: ep.method,
    headers,
    // Fail fast instead of hanging get_usage at the start of every task if the
    // dashboard endpoint stalls. status 0 signals "no response" to callers.
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  if (ep.method.toUpperCase() === "POST") {
    headers["Content-Type"] = ep.contentType ?? "application/json";
    init.body = ep.postData ?? "{}";
  }
  try {
    const res = await fetch(ep.url, init);
    if (!res.ok) return { status: res.status };
    try {
      return { status: res.status, json: await res.json() };
    } catch {
      return { status: res.status };
    }
  } catch {
    // Timeout / network error: treat as "no response" so upstream falls back.
    return { status: 0 };
  }
}

/** The raw legacy request bucket that Cursor's dashboard reads as `usage["gpt-4"]`. */
export interface LegacyRequestBucket {
  numRequests?: number;
  maxRequestUsage?: number;
}

/**
 * Extract the legacy request bucket from the /api/usage model map.
 *
 * Cursor's own dashboard does NOT iterate the model map — it hardcodes the
 * `"gpt-4"` entry (its minified code literally names it `legacyGpt4Usage:
 * G["gpt-4"]`). We mirror that: prefer the `"gpt-4"` key, and only if it's
 * missing fall back to the quota-bearing bucket with the largest limit (a
 * stable safety net if Cursor ever renames the legacy key).
 */
export function parseLegacyBucket(json: any): LegacyRequestBucket | undefined {
  if (!json || typeof json !== "object") return undefined;
  const gpt4 = json["gpt-4"];
  if (gpt4 && typeof gpt4 === "object" && typeof gpt4.numRequests === "number") {
    return { numRequests: gpt4.numRequests, maxRequestUsage: gpt4.maxRequestUsage };
  }
  let best: LegacyRequestBucket | undefined;
  let bestLimit = 0;
  for (const value of Object.values<any>(json)) {
    if (value && typeof value === "object" && typeof value.numRequests === "number") {
      const limit = typeof value.maxRequestUsage === "number" ? value.maxRequestUsage : 0;
      if (limit > bestLimit) {
        bestLimit = limit;
        best = { numRequests: value.numRequests, maxRequestUsage: value.maxRequestUsage };
      }
    }
  }
  return best;
}

/**
 * Cursor converts included on-plan spend (in cents) to a request count at a flat
 * rate. Mirrors the dashboard helper `getRequestCountFromSpendCents`, which is
 * literally `e > 0 ? Math.ceil(e / 4) : 0` (≈ 4 cents per request).
 */
export function getRequestCountFromSpendCents(cents: unknown): number {
  return typeof cents === "number" && cents > 0 ? Math.ceil(cents / 4) : 0;
}

/**
 * Compute included-request usage exactly the way Cursor's dashboard does
 * (see the deobfuscated `computeIncludedRequests` in the dashboard bundle):
 *
 *   used  = team ? (spendCents>0 ? ceil(cents/4) : legacy.numRequests) : legacy.numRequests
 *   limit = team ? 500 * requestQuotaPerSeat : legacy.maxRequestUsage
 *
 * Any missing team signal falls back to the legacy `gpt-4` bucket, so individual
 * accounts and teams whose seat quota we couldn't fetch still get a correct
 * "X / limit". Returns undefined only when there's nothing usable at all.
 */
export function computeIncludedRequests(params: {
  legacy?: LegacyRequestBucket;
  isTeam?: boolean;
  planUsedCents?: number;
  requestQuotaPerSeat?: number;
}): IncludedRequests | undefined {
  const { legacy, isTeam, planUsedCents, requestQuotaPerSeat } = params;
  const usedFromSpend =
    typeof planUsedCents === "number" && planUsedCents > 0
      ? getRequestCountFromSpendCents(planUsedCents)
      : undefined;

  const used = isTeam ? usedFromSpend ?? legacy?.numRequests : legacy?.numRequests;
  const limit =
    isTeam && typeof requestQuotaPerSeat === "number"
      ? 500 * requestQuotaPerSeat
      : legacy?.maxRequestUsage;

  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return undefined;
  return {
    used,
    limit,
    // Cursor caps the *displayed* used at the limit; we keep the true used but
    // never report negative remaining.
    remaining: Math.max(0, limit - used),
    pct: Math.round((used / limit) * 1000) / 10,
  };
}

/** Pull requestQuotaPerSeat for the active team from the /api/dashboard/teams response. */
export function parseRequestQuotaPerSeat(json: any, teamId?: string): number | undefined {
  if (!json || typeof json !== "object") return undefined;
  const teams: any[] = Array.isArray(json.teams) ? json.teams : [];
  const match =
    (teamId ? teams.find((t) => String(t?.id) === String(teamId)) : undefined) ?? teams[0];
  const q = match?.requestQuotaPerSeat ?? match?.request_quota_per_seat;
  return typeof q === "number" && Number.isFinite(q) ? q : undefined;
}

export function centsToDollars(cents: unknown): number | null {
  return typeof cents === "number" ? Math.round((cents / 100) * 100) / 100 : null;
}

interface ParsedSummary {
  membershipType?: string;
  isUnlimited?: boolean;
  spend?: SpendInfo;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  /** True when this account is billed as part of a team (limitType === "team"). */
  isTeam?: boolean;
  /** On-plan included spend in cents; Cursor derives team request counts from this. */
  planUsedCents?: number;
}

/** Parse /api/usage-summary for membership, unlimited flag, on-demand spend, and cycle dates. */
export function parseSummary(json: any): ParsedSummary {
  if (!json || typeof json !== "object") return {};
  const out: ParsedSummary = {};
  if (typeof json.membershipType === "string") out.membershipType = json.membershipType;
  if (typeof json.isUnlimited === "boolean") out.isUnlimited = json.isUnlimited;
  if (typeof json.billingCycleStart === "string") out.billingCycleStart = json.billingCycleStart;
  if (typeof json.billingCycleEnd === "string") out.billingCycleEnd = json.billingCycleEnd;
  if (json.limitType === "team") out.isTeam = true;

  const onDemand = json?.individualUsage?.onDemand;
  const plan = json?.individualUsage?.plan;
  if (typeof plan?.used === "number") out.planUsedCents = plan.used;
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

export function computeCycle(start: string, end: string): BillingCycle | undefined {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;
  const now = Date.now();
  const cycleLengthDays = Math.round((e - s) / MS_PER_DAY);
  const daysElapsed = Math.max(0, Math.round(((now - s) / MS_PER_DAY) * 10) / 10);
  const daysLeft = Math.max(0, Math.round(((e - now) / MS_PER_DAY) * 10) / 10);
  return { start, end, daysElapsed, daysLeft, cycleLengthDays };
}

export function computePace(ir: IncludedRequests, cycle: BillingCycle): Pace {
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

/** Pull the `?user=` value out of a stored usage endpoint URL (login-path fallback). */
function userSubFromEndpoints(store: Store): string | undefined {
  for (const e of store.endpoints) {
    const m = e.url.match(/[?&]user=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  }
  return undefined;
}

export async function getUsage(store: Store): Promise<UsageReading> {
  // Prefer Cursor's own local token (no browser); fall back to a stored login.
  const local = await readLocalSession();
  const cookie = local?.cookie ?? store.cookieHeader;
  if (!cookie) {
    return {
      ok: false,
      needsLogin: true,
      error:
        "No Cursor session found. Open Cursor logged in on this machine, or run the 'login' tool.",
      sources: [],
      raw: {},
    };
  }

  const reading: UsageReading = {
    ok: false,
    sources: [],
    authSource: local ? "local-token" : "login",
    raw: {},
  };
  let sawAuthError = false;
  let lastError = "";
  let legacy: LegacyRequestBucket | undefined;
  let summaryParsed: ParsedSummary | undefined;

  const teamId = local?.teamId ?? getTeamId(store);
  const userSub = local?.userSub ?? userSubFromEndpoints(store);

  // Kick off team-scoped fetches in parallel: the per-user hard limit (spend
  // context) and the teams list (for requestQuotaPerSeat, which drives the real
  // included-request limit for team accounts).
  const teamRequest = (url: string) =>
    fetchJson(
      {
        url,
        method: "POST",
        postData: JSON.stringify(url.includes("/teams") ? { activeOnly: false } : { teamId: Number(teamId) }),
        contentType: "application/json",
      },
      cookie,
    ).catch(() => ({ status: 0 }) as { status: number; json?: any });
  const hardLimitPromise = teamId
    ? teamRequest("https://cursor.com/api/dashboard/get-hard-limit")
    : null;
  const teamsPromise = teamId ? teamRequest("https://cursor.com/api/dashboard/teams") : null;

  // 1) Included-request usage (the "X / 500" number). We only extract the raw
  //    legacy bucket here; the final number is computed below once we also know
  //    whether this is a team account and its per-seat quota. The endpoint is
  //    canonical when we know the user id; otherwise we replay the stored one.
  const usageUrl = userSub
    ? `https://cursor.com/api/usage?user=${encodeURIComponent(userSub)}`
    : store.endpoints.find((e) => isModelUsageEndpoint(e.url) && e.method === "GET")?.url;
  if (usageUrl) {
    try {
      const { status, json } = await fetchJson({ url: usageUrl, method: "GET" }, cookie);
      if (status === 401 || status === 403) sawAuthError = true;
      else if (json) {
        legacy = parseLegacyBucket(json);
        reading.raw.usage = json;
        reading.sources.push(usageUrl);
      } else lastError = `HTTP ${status} from ${usageUrl}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // 2) Summary (membership + on-demand spend/budget + team flag + plan spend).
  const summaryEp = { url: "https://cursor.com/api/usage-summary", method: "GET" };
  {
    try {
      const { status, json } = await fetchJson(summaryEp, cookie);
      if (status === 401 || status === 403) sawAuthError = true;
      else if (json) {
        summaryParsed = parseSummary(json);
        reading.raw.summary = json;
        reading.sources.push(summaryEp.url);
        reading.membershipType = summaryParsed.membershipType;
        reading.isUnlimited = summaryParsed.isUnlimited;
        reading.spend = summaryParsed.spend;
        if (summaryParsed.billingCycleStart && summaryParsed.billingCycleEnd) {
          reading.billingCycle = computeCycle(
            summaryParsed.billingCycleStart,
            summaryParsed.billingCycleEnd,
          );
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

  // 4) requestQuotaPerSeat from the teams list (team accounts only).
  let requestQuotaPerSeat: number | undefined;
  if (teamsPromise) {
    const t = await teamsPromise;
    if (t.json) {
      requestQuotaPerSeat = parseRequestQuotaPerSeat(t.json, teamId);
      if (requestQuotaPerSeat !== undefined && !reading.sources.includes("teams")) {
        reading.sources.push("teams");
      }
    }
  }

  // Compute included requests the way the dashboard does, falling back to the
  // raw legacy bucket when team signals are unavailable.
  const isTeam = summaryParsed?.isTeam ?? Boolean(teamId);
  reading.includedRequests =
    computeIncludedRequests({
      legacy,
      isTeam,
      planUsedCents: summaryParsed?.planUsedCents,
      requestQuotaPerSeat,
    }) ??
    (legacy && typeof legacy.numRequests === "number" && typeof legacy.maxRequestUsage === "number"
      ? computeIncludedRequests({ legacy, isTeam: false })
      : undefined);

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

/**
 * Whether a reading represents an exhausted included-request quota (0 left).
 * Exhaustion can't reverse within a billing cycle (used only rises), which is what
 * makes caching safe until the cycle resets.
 */
export function readingExhausted(r: UsageReading): boolean {
  if (!r.ok || r.isUnlimited) return false;
  const ir = r.includedRequests;
  if (ir) return ir.remaining <= 0;
  const pct = r.spend?.pctUsed;
  return typeof pct === "number" && pct >= 100;
}

interface UsageCache {
  fetchedAt: string;
  /** billingCycleEnd ISO, so the cache auto-invalidates when the cycle resets. */
  cycleEnd?: string;
  reading: UsageReading;
}

/** Safety-net TTL for the exhausted state: re-check at most once/day even before reset. */
const EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * get_usage with caching. Once the included quota is exhausted, the decision can't
 * change until the cycle resets, so we serve the cached reading (avoiding a network
 * call on every task) until either the billing cycle end passes or the daily TTL
 * elapses. Below the limit we always fetch fresh, since crossing the threshold matters.
 *
 * The cache is shared with the background footer refresher, so whichever runs first
 * warms it for the other. Pass force=true to bypass the cache.
 */
export async function getUsageCached(
  store: Store,
  opts?: { force?: boolean },
): Promise<UsageReading> {
  if (!opts?.force) {
    const cache = loadCacheFile<UsageCache>();
    if (cache && cache.reading?.ok && readingExhausted(cache.reading)) {
      const now = Date.now();
      const cycleLive = cache.cycleEnd ? now < new Date(cache.cycleEnd).getTime() : false;
      const fresh = now - new Date(cache.fetchedAt).getTime() < EXHAUSTED_TTL_MS;
      if (cycleLive && fresh) {
        return { ...cache.reading, cached: true, fetchedAt: cache.fetchedAt };
      }
    }
  }
  const fetchedAt = new Date().toISOString();
  const reading = await getUsage(store);
  reading.fetchedAt = fetchedAt;
  // Only persist successful reads; keep a bad read from masking a good cache.
  if (reading.ok) {
    saveCacheFile({ fetchedAt, cycleEnd: reading.billingCycle?.end, reading } satisfies UsageCache);
  }
  return reading;
}

export function buildSummary(r: UsageReading): string {
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
    exhausted: false,
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

  // Exhausted = no included requests left. On a corporate/team plan the user
  // doesn't pay out of pocket, so there's nothing left to conserve: turn conserve
  // OFF and just flag it so the caller notifies the user once, then continues.
  const ir = reading.includedRequests;
  base.exhausted = readingExhausted(reading);
  if (base.exhausted) {
    base.conserve = false;
    const spend = reading.spend
      ? ` On-demand so far: $${reading.spend.usedDollars.toFixed(2)}${
          reading.spend.limitDollars !== null ? `/$${reading.spend.limitDollars.toFixed(2)}` : ""
        }.`
      : "";
    base.reason =
      `Included requests used up (${pct}%, ${ir?.remaining ?? 0} left).${spend} ` +
      `Now on on-demand (covered by the org — not the user's own money). ` +
      `No approval or extra conserving needed: just tell the user ONCE that the 500 are used up and ` +
      `you've moved to on-demand, then continue normally.`;
    return base;
  }

  base.conserve = pct >= thresholdPct;
  base.reason = `Used ${pct}% (threshold ${thresholdPct}%) => ${base.conserve ? "CONSERVE" : "normal"}.`;
  return base;
}

/** Verbose-mode footer, rendered as a fenced code block. */
export function buildFooter(r: UsageReading): string {
  const fence = "```";
  if (!r.ok) return `${fence}\nCursor Usage: unavailable (run login)\n${fence}`;
  const bits: string[] = [];
  if (r.includedRequests) {
    bits.push(`${r.includedRequests.used}/${r.includedRequests.limit} requests`);
  }
  if (r.spend) {
    bits.push(
      r.spend.limitDollars !== null
        ? `$${r.spend.usedDollars.toFixed(2)}/$${r.spend.limitDollars.toFixed(2)}`
        : `$${r.spend.usedDollars.toFixed(2)} spent`,
    );
  }
  // Reflect the underlying fetch time (older when served from cache) so the
  // stamp stays honest instead of implying every message is a live read.
  const stamp = r.fetchedAt ? new Date(r.fetchedAt) : new Date();
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  return `${fence}\nCursor Usage: ${bits.join(" · ")} (as of ${hh}:${mm})\n${fence}`;
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

/**
 * Extract the numeric team id from the stored session. Checked in order:
 * the cookie (`team_id=`), each endpoint URL (`teamId=`), and finally each
 * endpoint's captured POST body (many dashboard endpoints send `teamId` there
 * rather than in the URL, e.g. get-aggregated-usage-events).
 */
export function getTeamId(store: Store): string | undefined {
  const fromCookie = store.cookieHeader?.match(/team_id=(\d+)/)?.[1];
  if (fromCookie) return fromCookie;
  for (const ep of store.endpoints) {
    const fromUrl = ep.url.match(/teamId=(\d+)/)?.[1];
    if (fromUrl) return fromUrl;
  }
  for (const ep of store.endpoints) {
    if (!ep.postData) continue;
    // Prefer structured parsing; fall back to a regex for non-JSON bodies.
    try {
      const parsed = JSON.parse(ep.postData);
      const id = parsed?.teamId ?? parsed?.team_id;
      if (typeof id === "number" && Number.isFinite(id)) return String(id);
      if (typeof id === "string" && /^\d+$/.test(id)) return id;
    } catch {
      // not JSON; regex fallback below
    }
    const m = ep.postData.match(/"?team_?[Ii]d"?\s*[:=]\s*"?(\d+)"?/);
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
  const local = await readLocalSession();
  const cookie = local?.cookie ?? store.cookieHeader;
  if (!cookie) {
    return {
      ...empty,
      needsLogin: true,
      error: "No Cursor session found. Open Cursor logged in, or run the 'login' tool.",
    };
  }
  const teamId = local?.teamId ?? getTeamId(store);
  if (!teamId) return { ...empty, error: "Could not determine team id for this account." };

  const ep: CapturedEndpoint = {
    url: "https://cursor.com/api/dashboard/get-aggregated-usage-events",
    method: "POST",
    postData: JSON.stringify({ teamId: Number(teamId) }),
    contentType: "application/json",
  };
  try {
    const { status, json } = await fetchJson(ep, cookie);
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
