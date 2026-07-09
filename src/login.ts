import { chromium, type BrowserContext } from "playwright";
import { BROWSER_DIR, loadStore, saveStore, type CapturedEndpoint } from "./storage.js";

/**
 * Keywords that strongly suggest a JSON response carries usage/spend/quota data.
 * We score each candidate response by how many of these appear in its body so we
 * can auto-discover the right dashboard endpoint without hardcoding it.
 */
const USAGE_KEYWORDS = [
  "usage",
  "spend",
  "cents",
  "membershiptype",
  "hardlimit",
  "numrequests",
  "requestscosts",
  "gpt-4",
  "premium",
  "quota",
  "budget",
  "maxrequestusage",
  "limit",
  "requests",
];

const DASHBOARD_URL = "https://cursor.com/dashboard";

function scoreBody(body: string): { score: number; keys: string[] } {
  const lower = body.toLowerCase();
  let score = 0;
  for (const kw of USAGE_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  let keys: string[] = [];
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") keys = Object.keys(parsed).slice(0, 40);
  } catch {
    // Not JSON at the top level; ignore.
  }
  return { score, keys };
}

function isCursorApi(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname.endsWith("cursor.com") &&
      (u.pathname.includes("/api/") || u.pathname.includes("/dashboard/"))
    );
  } catch {
    return false;
  }
}

export interface LoginResult {
  endpointsFound: number;
  topEndpoints: CapturedEndpoint[];
  cookieCaptured: boolean;
}

export async function runLogin(opts: {
  timeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<LoginResult> {
  const timeoutMs = opts.timeoutMs ?? 4 * 60 * 1000;
  const log = opts.log ?? (() => {});

  log("Launching browser. Log in to Cursor if prompted, then open your usage/dashboard page.");

  const context: BrowserContext = await chromium.launchPersistentContext(BROWSER_DIR, {
    headless: false,
    viewport: { width: 1200, height: 900 },
  });

  let closed = false;
  context.on("close", () => {
    closed = true;
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Snapshot cookies continuously so we still have them if the user closes the
  // window manually (once the context is gone we can no longer read them).
  let cookieHeader = "";
  const snapshotCookies = async () => {
    if (closed) return;
    try {
      const cookies = await context.cookies();
      const cursorCookies = cookies.filter((c) => c.domain.includes("cursor.com"));
      if (cursorCookies.length > 0) {
        cookieHeader = cursorCookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch {
      // context likely closing; keep the last snapshot.
    }
  };

  const candidates = new Map<string, CapturedEndpoint & { score: number }>();

  context.on("response", async (response) => {
    try {
      const req = response.request();
      const url = response.url();
      if (!isCursorApi(url)) return;
      const ct = (response.headers()["content-type"] ?? "").toLowerCase();
      if (!ct.includes("json")) return;
      if (!response.ok()) return;

      const body = await response.text();
      const { score, keys } = scoreBody(body);
      if (score < 2) return;

      const existing = candidates.get(url);
      if (!existing || score > existing.score) {
        candidates.set(url, {
          url,
          method: req.method(),
          postData: req.postData() ?? undefined,
          contentType: (req.headers()["content-type"] ?? undefined) || undefined,
          sampleResponseKeys: keys,
          score,
        });
        log(`Discovered candidate usage endpoint (score ${score}): ${req.method()} ${url}`);
      }
    } catch {
      // Best-effort sniffing; ignore per-response errors.
    }
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" }).catch(() => {});

  // Wait until we have a confident candidate, the user closes the window, or we time out.
  const start = Date.now();
  let strong = false;
  while (Date.now() - start < timeoutMs && !closed) {
    await snapshotCookies();
    const best = [...candidates.values()].sort((a, b) => b.score - a.score)[0];
    if (best && best.score >= 4) {
      strong = true;
      // Give it a couple extra seconds in case a better endpoint loads.
      await sleep(2500);
      await snapshotCookies();
      break;
    }
    await sleep(1000);
  }

  // Final snapshot in case cookies landed right before we exit the loop.
  await snapshotCookies();

  const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);
  const topEndpoints: CapturedEndpoint[] = sorted.slice(0, 5).map((c) => ({
    url: c.url,
    method: c.method,
    postData: c.postData,
    contentType: c.contentType,
    sampleResponseKeys: c.sampleResponseKeys,
  }));

  const store = loadStore();
  if (cookieHeader) store.cookieHeader = cookieHeader;
  if (topEndpoints.length > 0) store.endpoints = topEndpoints;
  store.capturedAt = new Date().toISOString();
  saveStore(store);

  if (!closed) {
    await context.close().catch(() => {});
  }

  log(
    strong
      ? `Login complete. Saved ${topEndpoints.length} endpoint(s) and session cookie.`
      : closed
        ? `Browser was closed. Saved ${topEndpoints.length} candidate endpoint(s); cookieCaptured=${Boolean(cookieHeader)}.`
        : `Timed out waiting for a strong usage endpoint. Saved ${topEndpoints.length} candidate(s) and cookie (may be incomplete).`,
  );

  return {
    endpointsFound: topEndpoints.length,
    topEndpoints,
    cookieCaptured: Boolean(cookieHeader),
  };
}
