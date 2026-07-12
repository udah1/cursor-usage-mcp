import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { effectiveThreshold, isVerbose, isFollowup, hasSession, type Store } from "./storage.js";

function store(partial: Partial<Store> = {}): Store {
  return { endpoints: [], activationThresholdPct: 0, verbose: false, followup: false, ...partial };
}

const ENV_KEYS = [
  "CURSOR_USAGE_THRESHOLD_PCT",
  "CURSOR_USAGE_VERBOSE",
  "CURSOR_USAGE_FOLLOWUP",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("effectiveThreshold prefers a valid env value over the store", () => {
  assert.equal(effectiveThreshold(store({ activationThresholdPct: 10 })), 10);
  process.env.CURSOR_USAGE_THRESHOLD_PCT = "80";
  assert.equal(effectiveThreshold(store({ activationThresholdPct: 10 })), 80);
});

test("effectiveThreshold ignores out-of-range/garbage env and falls back to store", () => {
  process.env.CURSOR_USAGE_THRESHOLD_PCT = "150";
  assert.equal(effectiveThreshold(store({ activationThresholdPct: 25 })), 25);
  process.env.CURSOR_USAGE_THRESHOLD_PCT = "abc";
  assert.equal(effectiveThreshold(store({ activationThresholdPct: 25 })), 25);
  process.env.CURSOR_USAGE_THRESHOLD_PCT = "   ";
  assert.equal(effectiveThreshold(store({ activationThresholdPct: 25 })), 25);
});

test("isVerbose / isFollowup: env truthy strings override, else use store", () => {
  assert.equal(isVerbose(store({ verbose: false })), false);
  assert.equal(isVerbose(store({ verbose: true })), true);
  for (const v of ["1", "true", "yes", "on", "TRUE"]) {
    process.env.CURSOR_USAGE_VERBOSE = v;
    assert.equal(isVerbose(store({ verbose: false })), true, `env ${v} forces on`);
  }
  process.env.CURSOR_USAGE_VERBOSE = "false";
  assert.equal(isVerbose(store({ verbose: true })), false, "env false forces off");

  process.env.CURSOR_USAGE_FOLLOWUP = "on";
  assert.equal(isFollowup(store({ followup: false })), true);
  process.env.CURSOR_USAGE_FOLLOWUP = "0";
  assert.equal(isFollowup(store({ followup: true })), false);
});

test("hasSession requires both a cookie and at least one endpoint", () => {
  assert.equal(hasSession(store()), false);
  assert.equal(hasSession(store({ cookieHeader: "a=1" })), false);
  assert.equal(
    hasSession(store({ cookieHeader: "a=1", endpoints: [{ url: "https://x", method: "GET" }] })),
    true,
  );
});
