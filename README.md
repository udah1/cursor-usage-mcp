# cursor-usage-mcp

A **local** MCP server that reads your current Cursor usage/spend from the dashboard's
authenticated backend and tells the agent when to **conserve requests** — by batching clarifying
questions into a single prompt, preferring defaults, and cutting confirmation round-trips.

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
npm run login          # standalone CLI flow
# — or — call the `login` tool from inside Cursor once the MCP is loaded
```

The server is already registered in `~/.cursor/mcp.json` as `cursor-usage`. Restart Cursor (or
reload the MCP) after `npm run build` so it picks up `dist/index.js`.

## Tools

| Tool | What it does |
|------|--------------|
| `get_usage` | Reads usage and returns the conserve decision. Call at task start. |
| `login` | Browser login + endpoint auto-discovery. Re-run when the session expires. |
| `set_threshold` | Sets `activationThresholdPct` (0-100). Default **0** = conserve whenever requests remain. |
| `status` | Shows whether a session/endpoints are stored, capture time, and current threshold. |

## Tuning when conserve mode kicks in

- `activationThresholdPct = 0` (default): conserve as long as any requests remain.
- `activationThresholdPct = 80`: only conserve once you've used ≥80% of the limit.

```
set_threshold { "activationThresholdPct": 80 }
```

## How usage is read (no browser at query time)

`get_usage` does **not** open a browser. It makes direct authenticated `GET` requests (with your
stored cookie) to the two reliable dashboard endpoints:

- **`/api/usage`** → included-request count (`gpt-4.numRequests` / `maxRequestUsage`), e.g. `278/500`.
- **`/api/usage-summary`** → `membershipType`, `isUnlimited`, and on-demand spend (`individualUsage.onDemand`, cents → dollars).

The browser (Playwright) is used **only during `login`** to capture your session cookie and
discover these endpoints. The conserve decision is based on the **included-request percentage**
(the "X / 500" number). The team-spend `POST` endpoints are intentionally ignored — they require a
CSRF origin, are team-wide, and previously caused a units bug (spend-cents vs dollar-limit).

`get_usage` always returns the **raw** JSON per source, so if a field ever looks off you can inspect
`raw` and adjust `parseIncludedRequests` / `parseSummary` in `src/usage.ts`.
