#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadStore, saveStore, hasSession } from "./storage.js";
import { getUsage, decideConserve } from "./usage.js";
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
    const decision = decideConserve(reading, store.activationThresholdPct);
    const mode = decision.conserve
      ? "CONSERVE MODE ON — batch questions into one prompt, prefer defaults, cut round-trips."
      : "Conserve mode off — behave normally.";
    return {
      content: [
        { type: "text", text: `${decision.summary}\n${mode}\n${decision.reason}` },
        { type: "text", text: JSON.stringify(decision, null, 2) },
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
      const decision = decideConserve(reading, store.activationThresholdPct);
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
              activationThresholdPct: store.activationThresholdPct,
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
