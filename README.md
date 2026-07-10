# cursor-usage-mcp

**Purpose: stop the Cursor agent from burning through your request quota.**

On many Cursor plans you get a fixed pool of included requests (e.g. **500 / month**) and then pay
per request out of a budget. Every time the agent stops mid-task to ask you a one-off question,
your answer starts a **new billable turn** — so a chatty agent quietly eats your quota.

This is a **local** MCP server that fixes that. It reads your **live** usage from the same backend
your Cursor dashboard uses, and hands the agent a `conserve` flag. When you're consuming your quota,
a bundled rule makes the agent **conserve requests** by:

- **batching all clarifying questions into a single prompt** (one turn instead of many),
- **preferring sensible defaults** and proceeding instead of stopping to ask,
- **cutting needless confirmation round-trips** ("should I continue?").

### How it works (three pieces)

1. **`login`** (one-time) — opens a browser via Playwright, you log into Cursor, and it captures
   your session cookie + auto-discovers the usage endpoints, storing them at `~/.cursor-usage/`.
2. **`get_usage`** — makes a direct authenticated API call (no browser) and returns your
   included-request usage (e.g. `278/500`), on-demand spend (`$0/$75`), and a `conserve` decision
   computed against a threshold.
3. **`conserve-requests` rule** (installed globally) — tells the agent to call `get_usage` at the
   start of each task and follow the conserve behavior above when the flag is on.

The threshold controls *when* conserving kicks in: `0` (default) = conserve whenever you still have
requests; `80` = only conserve once you've used 80% of the quota. See
[Tuning](#tuning-when-conserve-mode-kicks-in) below.

> **Heads up / caveats**
> - This scrapes an **undocumented internal Cursor endpoint** (the same one your dashboard calls).
>   It can change without notice and may be against Cursor's ToS to script against. Personal,
>   read-only use only.
> - Your **session cookie** is stored locally at `~/.cursor-usage/store.json` (chmod 600) and is
>   never committed. It **expires periodically** — just re-run `login` when that happens.

## How it works

1. **`login`** opens a real Chromium window (via Playwright). You log in to Cursor normally and
   open your usage/dashboard page. While the page loads, the server **sniffs the network**, finds
   the JSON endpoint that returns your usage numbers, and saves both that endpoint and your
   session cookie to `~/.cursor-usage/`.
2. **`get_usage`** replays that request with your stored cookie, parses out `used` / `limit` /
   `usedPct`, and returns a **`conserve`** flag based on your `activationThresholdPct`.
3. A globally-installed rule (`~/.cursor/rules/conserve-requests.mdc`) tells the agent to call
   `get_usage` at the start of each task and follow the conserve policy when the flag is on.

## Setup

```bash
cd cursor-usage-mcp
npm install
npx playwright install chromium   # one-time: downloads the browser Playwright drives
npm run build
```

First-time login (either works):

```bash
# call the `login` tool from inside Cursor once the MCP is loaded (Simply by asking log into cursor-usage)

# — or — standalone CLI flow
npm run login
```

The server is already registered in `~/.cursor/mcp.json` as `cursor-usage`. Restart Cursor (or
reload the MCP) after `npm run build` so it picks up `dist/index.js`.

## Tools

| Tool | What it does |
|------|--------------|
| `get_usage` | Reads usage and returns the conserve decision. Call at task start. Includes included-request count, on-demand spend, plan, **billing-cycle reset + days left**, and a **burn-rate projection** (requests/day → projected total by reset). |
| `usage_breakdown` | This cycle's usage broken down **by model**: cost, request count, and token totals (input/output/cache). Heavier than `get_usage`; call on request. |
| `login` | Browser login + endpoint auto-discovery. Re-run when the session expires. Reports current usage immediately. |
| `logout` | Clears the stored session (cookie + endpoints). `forgetBrowser=true` also wipes the saved browser profile. |
| `set_threshold` | Sets the persisted threshold (0-100). Default **0** = conserve whenever requests remain. Overridden by the `CURSOR_USAGE_THRESHOLD_PCT` env var if set. |
| `status` | Shows whether a session/endpoints are stored, capture time, and stored/env/effective threshold. |

## Tuning when conserve mode kicks in

The threshold is the minimum **used percentage** at which conserve mode activates:

- `0` (default): conserve as long as any requests remain.
- `80`: only conserve once you've used ≥80% of the limit.

There are two ways to set it, and **the env var wins** if both are set:

**1. Env var (recommended — declarative, in `mcp.json`):**

```json
"cursor-usage": {
  "command": "node",
  "args": ["/ABSOLUTE/PATH/TO/cursor-usage-mcp/dist/index.js"],
  "env": {
    "CURSOR_USAGE_THRESHOLD_PCT": "80"
  }
}
```

Change the number and reload the MCP. Accepts `0`–`100`. Leave it as `"0"` (or remove it) for the
default always-conserve behavior. If `CURSOR_USAGE_THRESHOLD_PCT` is set, it **overrides** any value
set via the tool below.

## Verbose mode (usage footer on every message)

Set `CURSOR_USAGE_VERBOSE` to `true` in the `mcp.json` `env` to have the agent append a usage footer
to the end of every message:

```json
"env": { "CURSOR_USAGE_VERBOSE": "true" }
```

Footer format (only the label is bold):

> **Cursor Usage:** 290/500 requests · $0.00/$75.00 _(~as of task start)_

Notes: the numbers reflect the reading from the **start of the task** (not refreshed per message), and
because appending a footer to every message is a model behavior, it may occasionally be missed.
Default is off.

## Threshold, continued

**2. `set_threshold` tool (persisted in `~/.cursor-usage`):**

```
set_threshold { "activationThresholdPct": 80 }
```

Used only when the env var is unset/empty. Run `status` to see `storedThresholdPct`,
`envThresholdPct`, and the resulting `effectiveThresholdPct`.

## How usage is read (no browser at query time)

`get_usage` does **not** open a browser. It makes direct authenticated `GET` requests (with your
stored cookie) to the two reliable dashboard endpoints:

- **`/api/usage`** → included-request count (`gpt-4.numRequests` / `maxRequestUsage`), e.g. `278/500`.
- **`/api/usage-summary`** → `membershipType`, `isUnlimited`, and on-demand spend (`individualUsage.onDemand`, cents → dollars).

The browser (Playwright) is used **only during `login`** to capture your session cookie and
discover these endpoints. The conserve decision is based on the **included-request percentage**
(the "X / 500" number).

**Budget vs. team cap.** The spend line reports your **actual** on-demand budget from
`individualUsage.onDemand.limit` (authoritative for you), and — for context — the team-wide default
per-user cap from `get-hard-limit` (`hardLimitPerUser`). These usually match, but can differ if your
org sets per-user overrides; the tool flags it when they diverge.

`get_usage` always returns the **raw** JSON per source, so if a field ever looks off you can inspect
`raw` and adjust `parseIncludedRequests` / `parseSummary` in `src/usage.ts`.
