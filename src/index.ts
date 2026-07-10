#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadStore,
  saveStore,
  hasSession,
  effectiveThreshold,
  clearSession,
  isVerbose,
} from "./storage.js";
import { getUsage, decideConserve, getUsageBreakdown, buildFooter } from "./usage.js";
import { runLogin } from "./login.js";

const SERVER_INSTRUCTIONS = `cursor-usage: reads the current user's Cursor usage/spend from the dashboard's
authenticated backend and tells you whether to conserve requests.

REQUEST-CONSERVING POLICY (apply whenever the conserve flag from get_usage is true):
- Batch ALL clarifying questions into a SINGLE questions/options prompt instead of stopping
  repeatedly. Each separate user turn costs usage; one consolidated prompt costs far less.
- Prefer sensible defaults and proceed, rather than asking. Only ask when a choice is genuinely
  blocking or when an action is destructive/irreversible.
- Front-load everything you need at the start of a task in one questions block.
- Avoid unnecessary confirmation round-trips ("should I continue?"). Just continue.

When the conserve flag is false, behave normally.

If get_usage reports needsLogin, tell the user to run the 'login' tool (or 'npm run login').`;

const server = new McpServer(
  { name: "cursor-usage", version: "0.1.0" },
  { instructions: SERVER_INSTRUCTIONS },
);

server.registerTool(
  "get_usage",
  {
    title: "Get Cursor usage + conserve decision",
    description:
      "Call this at the START of a task. Reads the user's current Cursor usage/spend and returns a " +
      "conserve flag. If conserve is true, batch all clarifying questions into ONE questions/options " +
      "prompt, prefer sensible defaults, and avoid confirmation round-trips to save requests. If false, " +
      "behave normally. If needsLogin is true, ask the user to run the 'login' tool.",
    inputSchema: {},
  },
  async () => {
    const store = loadStore();
    const reading = await getUsage(store);
    const decision = decideConserve(reading, effectiveThreshold(store));
    const mode = decision.conserve
      ? "CONSERVE MODE ON — batch questions into one prompt, prefer defaults, cut round-trips."
      : "Conserve mode off — behave normally.";
    const verbose = isVerbose(store);
    const footer = verbose ? buildFooter(reading) : undefined;
    let text = `${decision.summary}\n${mode}\n${decision.reason}`;
    if (verbose && footer) {
      text += `\n\nVERBOSE MODE ON — end EVERY message you send this task with this exact line:\n${footer}`;
    }
    return {
      content: [
        { type: "text", text },
        { type: "text", text: JSON.stringify({ ...decision, verbose, footer }, null, 2) },
      ],
    };
  },
);

server.registerTool(
  "login",
  {
    title: "Log in to Cursor and capture usage endpoint",
    description:
      "Opens a real browser window. Log in to Cursor and open your usage/dashboard page. The tool " +
      "auto-discovers the usage endpoint and stores your session cookie locally (~/.cursor-usage). " +
      "Re-run this whenever get_usage reports the session expired.",
    inputSchema: {
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(600)
        .optional()
        .describe("How long to wait for login + endpoint discovery. Default 240."),
    },
  },
  async ({ timeoutSeconds }) => {
    const logs: string[] = [];
    const result = await runLogin({
      timeoutMs: (timeoutSeconds ?? 240) * 1000,
      log: (m) => logs.push(m),
    });

    // Immediately report current usage so the user sees it right after login.
    let usageText = "";
    if (result.cookieCaptured && result.endpointsFound > 0) {
      const store = loadStore();
      const reading = await getUsage(store);
      const decision = decideConserve(reading, effectiveThreshold(store));
      const mode = decision.conserve ? "CONSERVE MODE ON" : "Conserve mode off";
      usageText = `\n\nCurrent usage: ${decision.summary}\n${mode} — ${decision.reason}`;
    }

    return {
      content: [
        {
          type: "text",
          text:
            `Login finished. cookieCaptured=${result.cookieCaptured}, endpointsFound=${result.endpointsFound}.\n` +
            logs.join("\n") +
            usageText,
        },
        { type: "text", text: JSON.stringify(result.topEndpoints, null, 2) },
      ],
    };
  },
);

server.registerTool(
  "usage_breakdown",
  {
    title: "Per-model cost & token breakdown",
    description:
      "Shows this billing cycle's usage broken down by model: cost, request count, and token totals " +
      "(input/output/cache). Use when the user asks what's costing them or which models they use most. " +
      "Heavier than get_usage, so call it on request rather than every task.",
    inputSchema: {},
  },
  async () => {
    const store = loadStore();
    const b = await getUsageBreakdown(store);
    if (!b.ok) {
      return {
        content: [
          { type: "text", text: b.needsLogin ? "Login required — run the 'login' tool." : `Could not load breakdown: ${b.error}` },
        ],
      };
    }
    const lines = b.models.map(
      (m) =>
        `  ${m.model}: $${m.costDollars.toFixed(2)} · ${m.requests} req · ` +
        `${(m.inputTokens / 1e6).toFixed(2)}M in / ${(m.outputTokens / 1e6).toFixed(2)}M out / ${(m.cacheReadTokens / 1e6).toFixed(1)}M cache-read`,
    );
    const text =
      `Usage this cycle — total $${b.totalCostDollars.toFixed(2)} across ${b.models.length} model(s):\n` +
      lines.join("\n") +
      `\nTokens: ${(b.totalInputTokens / 1e6).toFixed(2)}M input, ${(b.totalOutputTokens / 1e6).toFixed(2)}M output, ${(b.totalCacheReadTokens / 1e6).toFixed(1)}M cache-read.`;
    return { content: [{ type: "text", text }, { type: "text", text: JSON.stringify(b, null, 2) }] };
  },
);

server.registerTool(
  "logout",
  {
    title: "Log out (clear stored session)",
    description:
      "Clears the stored session cookie and discovered endpoints so get_usage reports needsLogin. " +
      "Set forgetBrowser=true to also wipe the saved browser profile (forces a full re-login next time). " +
      "Threshold config is preserved.",
    inputSchema: {
      forgetBrowser: z
        .boolean()
        .optional()
        .describe("Also delete the saved Playwright browser profile. Default false."),
    },
  },
  async ({ forgetBrowser }) => {
    const { clearedBrowser } = clearSession(Boolean(forgetBrowser));
    return {
      content: [
        {
          type: "text",
          text: `Logged out — cleared stored session${clearedBrowser ? " and browser profile" : ""}. Run 'login' to reconnect.`,
        },
      ],
    };
  },
);

server.registerTool(
  "set_threshold",
  {
    title: "Set conserve activation threshold",
    description:
      "Set the minimum usage percentage (0-100) at which conserve mode activates. Default 0 means " +
      "conserve whenever a reading succeeds and requests remain. Set e.g. 80 to only conserve near the limit.",
    inputSchema: {
      activationThresholdPct: z.number().min(0).max(100),
    },
  },
  async ({ activationThresholdPct }) => {
    const store = loadStore();
    store.activationThresholdPct = activationThresholdPct;
    saveStore(store);
    return {
      content: [{ type: "text", text: `activationThresholdPct set to ${activationThresholdPct}.` }],
    };
  },
);

server.registerTool(
  "set_verbose",
  {
    title: "Enable/disable the per-message usage footer",
    description:
      "Persists verbose mode: when on, get_usage returns a footer the agent appends to every message " +
      "(**Cursor Usage:** X/limit requests · $used/$limit). Overridden by the CURSOR_USAGE_VERBOSE env var if set.",
    inputSchema: {
      verbose: z.boolean(),
    },
  },
  async ({ verbose }) => {
    const store = loadStore();
    store.verbose = verbose;
    saveStore(store);
    const envSet = typeof process.env.CURSOR_USAGE_VERBOSE === "string" && process.env.CURSOR_USAGE_VERBOSE.trim() !== "";
    return {
      content: [
        {
          type: "text",
          text:
            `Verbose mode persisted as ${verbose}.` +
            (envSet
              ? ` NOTE: CURSOR_USAGE_VERBOSE env is set and OVERRIDES this — effective verbose = ${isVerbose(store)}.`
              : ""),
        },
      ],
    };
  },
);

server.registerTool(
  "status",
  {
    title: "Show cursor-usage configuration status",
    description: "Reports whether a session/endpoints are stored, when they were captured, and the current threshold.",
    inputSchema: {},
  },
  async () => {
    const store = loadStore();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              hasSession: hasSession(store),
              capturedAt: store.capturedAt ?? null,
              endpointCount: store.endpoints.length,
              endpoints: store.endpoints.map((e) => `${e.method} ${e.url}`),
              storedThresholdPct: store.activationThresholdPct,
              envThresholdPct: process.env.CURSOR_USAGE_THRESHOLD_PCT ?? null,
              effectiveThresholdPct: effectiveThreshold(store),
              storedVerbose: store.verbose,
              envVerbose: process.env.CURSOR_USAGE_VERBOSE ?? null,
              effectiveVerbose: isVerbose(store),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout — it's the MCP transport. Diagnostics go to stderr.
  process.stderr.write("cursor-usage MCP server started.\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
