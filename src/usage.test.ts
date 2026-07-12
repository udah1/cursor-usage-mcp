import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLegacyBucket,
  computeIncludedRequests,
  getRequestCountFromSpendCents,
  parseRequestQuotaPerSeat,
  parseSummary,
  centsToDollars,
  computeCycle,
  computePace,
  buildSummary,
  buildFooter,
  decideConserve,
  getTeamId,
  type UsageReading,
} from "./usage.js";
import type { Store } from "./storage.js";

function store(partial: Partial<Store> = {}): Store {
  return { endpoints: [], activationThresholdPct: 0, verbose: false, followup: false, ...partial };
}

test("parseLegacyBucket reads the hardcoded gpt-4 entry like the dashboard", () => {
  const b = parseLegacyBucket({
    "gpt-4": { numRequests: 382, maxRequestUsage: 500 },
    "gpt-5": { numRequests: 9, maxRequestUsage: 9999 },
    startOfMonth: "2026-07-01T00:00:00.000Z",
  });
  assert.deepEqual(b, { numRequests: 382, maxRequestUsage: 500 }, "gpt-4 wins even if another bucket has a bigger quota");
});

test("parseLegacyBucket falls back to the largest bucket when gpt-4 is missing", () => {
  const b = parseLegacyBucket({
    small: { numRequests: 10, maxRequestUsage: 500 },
    big: { numRequests: 5, maxRequestUsage: 1000 },
  });
  assert.deepEqual(b, { numRequests: 5, maxRequestUsage: 1000 });
  assert.equal(parseLegacyBucket(null), undefined);
  assert.equal(parseLegacyBucket("nope"), undefined);
});

test("getRequestCountFromSpendCents mirrors ceil(cents/4)", () => {
  assert.equal(getRequestCountFromSpendCents(0), 0);
  assert.equal(getRequestCountFromSpendCents(-5), 0);
  assert.equal(getRequestCountFromSpendCents(4), 1);
  assert.equal(getRequestCountFromSpendCents(5), 2);
  assert.equal(getRequestCountFromSpendCents(1600), 400);
  assert.equal(getRequestCountFromSpendCents("100" as unknown), 0, "non-number => 0");
});

test("computeIncludedRequests: individual account uses the legacy bucket", () => {
  const ir = computeIncludedRequests({
    legacy: { numRequests: 382, maxRequestUsage: 500 },
    isTeam: false,
  });
  assert.deepEqual(ir, { used: 382, limit: 500, remaining: 118, pct: 76.4 });
});

test("computeIncludedRequests: team with zero plan spend falls back to legacy numRequests, limit = 500*seat", () => {
  const ir = computeIncludedRequests({
    legacy: { numRequests: 386, maxRequestUsage: 500 },
    isTeam: true,
    planUsedCents: 0,
    requestQuotaPerSeat: 1,
  });
  assert.deepEqual(ir, { used: 386, limit: 500, remaining: 114, pct: 77.2 });
});

test("computeIncludedRequests: team with plan spend derives used from cents (ceil/4)", () => {
  const ir = computeIncludedRequests({
    legacy: { numRequests: 999, maxRequestUsage: 500 },
    isTeam: true,
    planUsedCents: 1600, // -> 400 requests, beats legacy numRequests
    requestQuotaPerSeat: 2, // -> limit 1000
  });
  assert.deepEqual(ir, { used: 400, limit: 1000, remaining: 600, pct: 40 });
});

test("computeIncludedRequests: team without seat quota falls back to legacy maxRequestUsage", () => {
  const ir = computeIncludedRequests({
    legacy: { numRequests: 300, maxRequestUsage: 500 },
    isTeam: true,
    planUsedCents: 0,
  });
  assert.equal(ir?.limit, 500);
  assert.equal(ir?.used, 300);
});

test("computeIncludedRequests: undefined when nothing usable", () => {
  assert.equal(computeIncludedRequests({}), undefined);
  assert.equal(computeIncludedRequests({ legacy: { numRequests: 5 } }), undefined, "no limit");
});

test("parseRequestQuotaPerSeat picks the matching team, else the first", () => {
  const json = { teams: [{ id: 7, requestQuotaPerSeat: 3 }, { id: 42, requestQuotaPerSeat: 1 }] };
  assert.equal(parseRequestQuotaPerSeat(json, "42"), 1);
  assert.equal(parseRequestQuotaPerSeat(json), 3, "no id => first team");
  assert.equal(parseRequestQuotaPerSeat({ teams: [{ id: 1, request_quota_per_seat: 5 }] }), 5, "snake_case");
  assert.equal(parseRequestQuotaPerSeat({}), undefined);
  assert.equal(parseRequestQuotaPerSeat(null), undefined);
});

test("centsToDollars rounds to cents and rejects non-numbers", () => {
  assert.equal(centsToDollars(12345), 123.45);
  assert.equal(centsToDollars(0), 0);
  assert.equal(centsToDollars("100"), null);
  assert.equal(centsToDollars(undefined), null);
});

test("parseSummary extracts spend, membership, cycle, team flag and plan spend", () => {
  const s = parseSummary({
    membershipType: "enterprise",
    isUnlimited: false,
    limitType: "team",
    billingCycleStart: "2026-07-01T00:00:00.000Z",
    billingCycleEnd: "2026-08-01T00:00:00.000Z",
    individualUsage: {
      plan: { used: 0, totalPercentUsed: 19.14 },
      onDemand: { used: 0, limit: 7500, remaining: 7500 },
    },
  });
  assert.equal(s.membershipType, "enterprise");
  assert.equal(s.isUnlimited, false);
  assert.equal(s.isTeam, true);
  assert.equal(s.planUsedCents, 0);
  assert.equal(s.spend?.usedDollars, 0);
  assert.equal(s.spend?.limitDollars, 75);
  assert.equal(s.spend?.pctUsed, 19.1);
});

test("computeCycle returns undefined for invalid ranges", () => {
  assert.equal(computeCycle("bad", "also-bad"), undefined);
  assert.equal(
    computeCycle("2026-08-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z"),
    undefined,
    "end before start",
  );
  const c = computeCycle("2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  assert.equal(c?.cycleLengthDays, 31);
});

test("computePace flags projected overage", () => {
  const cycle = {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    daysElapsed: 11.8,
    daysLeft: 19.2,
    cycleLengthDays: 31,
  };
  const pace = computePace({ used: 382, limit: 500, remaining: 118, pct: 76.4 }, cycle);
  assert.ok(pace.requestsPerDay > 30 && pace.requestsPerDay < 34);
  assert.equal(pace.projectedToExceed, true);
  assert.ok(pace.projectedRequests > 500);
});

test("computePace avoids divide-by-zero at cycle start", () => {
  const cycle = {
    start: "2026-07-01T00:00:00.000Z",
    end: "2026-08-01T00:00:00.000Z",
    daysElapsed: 0,
    daysLeft: 31,
    cycleLengthDays: 31,
  };
  const pace = computePace({ used: 10, limit: 500, remaining: 490, pct: 2 }, cycle);
  assert.ok(Number.isFinite(pace.requestsPerDay));
});

test("decideConserve conserves at/above threshold and not below", () => {
  const reading: UsageReading = {
    ok: true,
    includedRequests: { used: 400, limit: 500, remaining: 100, pct: 80 },
    sources: [],
    raw: {},
  };
  assert.equal(decideConserve(reading, 0).conserve, true);
  assert.equal(decideConserve(reading, 80).conserve, true, "equal to threshold conserves");
  assert.equal(decideConserve(reading, 90).conserve, false);
});

test("decideConserve never conserves on unlimited plans", () => {
  const reading: UsageReading = { ok: true, isUnlimited: true, sources: [], raw: {} };
  assert.equal(decideConserve(reading, 0).conserve, false);
});

test("decideConserve fails safe when usage is unknown", () => {
  const failed: UsageReading = { ok: false, needsLogin: true, sources: [], raw: {} };
  assert.equal(decideConserve(failed, 0).conserve, true, "threshold 0 => conserve by default");
  assert.equal(decideConserve(failed, 50).conserve, false, "non-zero threshold => don't conserve");
});

test("buildFooter renders a fenced usage block", () => {
  const reading: UsageReading = {
    ok: true,
    includedRequests: { used: 382, limit: 500, remaining: 118, pct: 76.4 },
    spend: { usedDollars: 0, limitDollars: 75, remainingDollars: 75 },
    sources: [],
    raw: {},
  };
  const footer = buildFooter(reading);
  assert.match(footer, /Cursor Usage: 382\/500 requests · \$0\.00\/\$75\.00/);
  assert.match(buildFooter({ ok: false, sources: [], raw: {} }), /unavailable/);
});

test("buildSummary joins the parts it has", () => {
  const summary = buildSummary({
    ok: true,
    membershipType: "enterprise",
    includedRequests: { used: 382, limit: 500, remaining: 118, pct: 76.4 },
    sources: [],
    raw: {},
  });
  assert.match(summary, /Included requests: 382\/500/);
  assert.match(summary, /Plan: enterprise/);
});

test("getTeamId reads cookie, url, then post body", () => {
  assert.equal(getTeamId(store({ cookieHeader: "a=1; team_id=42; b=2" })), "42");
  assert.equal(
    getTeamId(store({ endpoints: [{ url: "https://x/api?teamId=7", method: "GET" }] })),
    "7",
  );
  assert.equal(
    getTeamId(
      store({
        endpoints: [
          { url: "https://x/api/dashboard/get-aggregated-usage-events", method: "POST", postData: JSON.stringify({ teamId: 99 }) },
        ],
      }),
    ),
    "99",
  );
  assert.equal(getTeamId(store()), undefined);
});
