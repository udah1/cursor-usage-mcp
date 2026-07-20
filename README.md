# cursor-usage-optimizer

[![npm version](https://img.shields.io/npm/v/cursor-usage-optimizer?logo=npm&label=npm&color=cb3837)](https://www.npmjs.com/package/cursor-usage-optimizer)
[![GitHub stars](https://img.shields.io/github/stars/udah1/cursor-usage-mcp?logo=github&label=stars)](https://github.com/udah1/cursor-usage-mcp/stargazers)
[![License: MIT](https://img.shields.io/npm/l/cursor-usage-optimizer?label=license&color=blue)](./LICENSE)
[![Built for Cursor](https://img.shields.io/badge/built%20for-Cursor-000000?logo=cursor&logoColor=white)](https://cursor.com)

[![npm downloads](https://img.shields.io/npm/dm/cursor-usage-optimizer?logo=npm&label=downloads&color=cb3837)](https://www.npmjs.com/package/cursor-usage-optimizer)
[![node](https://img.shields.io/node/v/cursor-usage-optimizer?logo=node.js&logoColor=white&color=339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Release](https://img.shields.io/github/actions/workflow/status/udah1/cursor-usage-mcp/release.yml?logo=githubactions&logoColor=white&label=publish)](https://github.com/udah1/cursor-usage-mcp/actions/workflows/release.yml)

**Purpose: stop the Cursor agent from burning through your request quota.**

On many Cursor plans you get a fixed pool of included requests (e.g. **500 / month**) and then pay
per request out of a budget. Every time the agent stops mid-task to ask you a one-off question,
your answer starts a **new billable turn** — so a chatty agent quietly eats your quota.

This is a **local** MCP server that fixes that. It reads your **live** usage from the same backend
your Cursor dashboard uses, and hands the agent a `conserve` flag. When you're consuming your quota,
a bundled rule makes the agent **conserve requests** by:

- **routing questions through Cursor's questions/options UI** (asking is free) instead of open-ended
  "stop and wait" prompts — so it still asks what it needs, without burning a request. Note: only the
  *question* is free; **doing the work still consumes your quota**,
- **batching multiple questions into a single options prompt** (one turn instead of many),
- **only defaulting silently when the choice is trivial** or you didn't answer,
- **cutting needless confirmation round-trips** ("should I continue?").

When your included quota is **used up**, `get_usage` returns `exhausted: true`. On a corporate/team
plan (usage moves to on-demand, covered by the org — not out of your pocket) this is **internal info
for the agent only**: it **silently continues normally** — no approval prompts, no more conserving, and
crucially **no "you're out of requests" reminders or usage/spend numbers volunteered** to you (that's
transparent). The only place usage surfaces is the **verbose footer**, and only when verbose is on.

**Usage cache.** Once exhausted, the decision can't change until the billing cycle resets (used only
goes up), so `get_usage` **serves a cached reading** instead of hitting the network on every task —
turning a ~1s call into a ~10ms read. The cache lives in `~/.cursor-usage/cache.json`, auto-invalidates
at the cycle's `billingCycleEnd` (from the API), and refreshes at most once/day as a safety net. Below
the limit it always fetches fresh (crossing the threshold matters). Verbose isn't affected — the footer
has its own non-blocking background refresher that shares the same cache. Pass `refresh: true` to
`get_usage`, or `login`/`logout`, to force a fresh read.

### How it works (three pieces)

1. **Auth (zero-setup by default)** — `get_usage` reconstructs your dashboard session from the token
   Cursor already stores locally, so on most machines there's **nothing to log in to**. A browser
   `login` flow exists only as a fallback. See [Authentication](#authentication) below.
2. **`get_usage`** — makes a direct authenticated API call (no browser) and returns your
   included-request usage (e.g. `278/500`), on-demand spend (`$0/$75`), and a `conserve` decision
   computed against a threshold.
3. **`conserve-requests` rule** (installed globally) — tells the agent to call `get_usage` at the
   start of each task and follow the conserve behavior above when the flag is on.

The threshold controls *when* conserving kicks in: `0` (default) = conserve whenever you still have
requests; `80` = only conserve once you've used 80% of the quota. See
[Tuning](#tuning-when-conserve-mode-kicks-in) below.

> **Heads up / caveats**
> - This calls **undocumented internal Cursor endpoints** (the same ones your dashboard calls).
>   They can change without notice and may be against Cursor's ToS to script against. Personal,
>   read-only use only.
> - The default auth path reads Cursor's local token **read-only** and never stores it. The optional
>   `login` fallback stores a session cookie at `~/.cursor-usage/store.json` (chmod 600, never
>   committed) that expires periodically — re-run `login` when that happens.

## Setup

### Install via npm (recommended)

No clone, no build. Add it to `~/.cursor/mcp.json` and let `npx` fetch it:

```json
{
  "mcpServers": {
    "cursor-usage": {
      "command": "npx",
      "args": ["-y", "cursor-usage-optimizer"],
      "env": {
        "CURSOR_USAGE_THRESHOLD_PCT": "0",
        "CURSOR_USAGE_VERBOSE": "false",
        "CURSOR_USAGE_FOLLOWUP": "false"
      }
    }
  }
}
```

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite`). Reload Cursor — with the default
local-token auth there's **no login step**, just call `get_usage`.

Optionally install the flag-aware self-check hook (adds a `postToolUse` entry to `~/.cursor/hooks.json`):

```bash
npx -y -p cursor-usage-optimizer cursor-usage-optimizer-install-hook
```

### From source (contributors)

```bash
git clone https://github.com/udah1/cursor-usage-mcp && cd cursor-usage-mcp
npm install
npx playwright install chromium   # optional: only needed for the browser `login` fallback
npm run build
```

Then point `mcp.json` at the local build (`"command": "node", "args": ["/ABS/PATH/dist/index.js"]`)
and set `CURSOR_USAGE_MCP_DIR` to the repo path so the hook uses your local build. Restart Cursor (or
reload the MCP) after `npm run build`.

## Authentication

By default the server needs **no login**. Cursor keeps its own auth in
`…/Cursor/User/globalStorage/state.vscdb` (a SQLite key/value store) under
`ItemTable → cursorAuth/accessToken` — a JWT whose `sub` claim is your user id. The dashboard's
session cookie has a fixed shape:

```
WorkosCursorSessionToken=<userSub>::<accessToken>
```

where `userSub` is the JWT `sub` with any `auth0|` prefix stripped. `get_usage` reads that file
read-only (via Node's built-in `node:sqlite`), rebuilds the exact cookie the browser would send, and
also picks up your `teamId` from `cursorAuth/cachedTeam`. Nothing is written and the token is never
stored. Because the token rotates, it's re-read on every call.

**Cross-platform.** The `state.vscdb` location is derived from the OS:

| OS | Path |
|----|------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Cursor/User/globalStorage/state.vscdb` |

Override with `CURSOR_STATE_DB=/abs/path/state.vscdb` for non-standard installs.

**When the local path can't be used** — the server automatically falls back to the browser `login`
flow. This happens if: the MCP runs on a **different machine** than Cursor (no local DB), the file
isn't readable, `node:sqlite` is unavailable (Node < 22.5), or you set `CURSOR_USAGE_FORCE_LOGIN=1`.

Browser `login` fallback (either works):

```bash
# call the `login` tool from inside Cursor (just ask it to "log into cursor-usage")

# — or — standalone CLI flow
npm run login
```

`login` opens a real Chromium window (Playwright), sniffs the network to discover the usage
endpoints, and saves them plus your session cookie to `~/.cursor-usage/`. Run `status` any time to
see which auth source is active (`local-token` vs `login`).

## For the installing agent — do this right after setup

> **Agent instructions.** If you are an AI agent that just installed or set up this MCP for the
> user, run one final step before you finish: **tell the user which flags/modes are available and
> ask whether they want to change any.** Ask through **Cursor's questions/options UI** (the same
> free-to-answer prompt this MCP is built around) — not an open-ended text question. If the MCP is
> already loaded, call `status` first so you can show the user their **current effective values**.

Present these three configurable flags with their current values and let the user pick which (if
any) to change in a single options prompt:

| Flag | Tool | Env override | Default | What it controls |
|------|------|--------------|---------|------------------|
| **Conserve threshold** | `set_threshold` | `CURSOR_USAGE_THRESHOLD_PCT` | `0` (always conserve) | The used-% at which conserve mode turns on. `0` = conserve whenever requests remain; `80` = only near the limit. |
| **Verbose** | `set_verbose` | `CURSOR_USAGE_VERBOSE` | off | Append a `Cursor Usage: X/limit · $used/$limit` footer to every message. |
| **Follow-up** | `set_followup` | `CURSOR_USAGE_FOLLOWUP` | off | End each task with a brief "anything else?" question via the options UI. |

Suggested options to offer: *"Leave defaults"*, *"Raise conserve threshold (e.g. 80%)"*,
*"Enable verbose footer"*, *"Enable follow-up questions"* — plus room for a custom answer. Apply the
chosen changes with the matching `set_*` tool, then confirm the new effective values with `status`.
(Env vars in `mcp.json` override the `set_*` tools — mention this if the user's choice is being
overridden by an env value.)

## Applying changes to existing chats

**New chats** pick up the rule and MCP automatically — nothing to do.

For a chat that was **already open** before you installed/updated this:

1. **Reload the MCP once** (Settings → MCP → toggle `cursor-usage` off/on). This restarts the shared
   server, so every chat — including open ones — sees the latest code and tools on its next turn.
2. **Nudge the existing chat** so it starts behaving immediately (rules are re-read per turn, but an
   explicit nudge guarantees it):

   ```
   From now on follow the conserve-requests rule: call the cursor-usage get_usage tool,
   report my current usage, and if conserve is on — ask via the questions UI (not open prompts),
   batch questions, and only default on trivial choices.
   If verbose is on, end every message with the footer.
   ```

## Version updates (daily check)

The server checks **once a day**, in the background, whether a newer version exists. It auto-detects
how it was installed:

- **npm install** (no `.git`): compares the installed version against the `latest` dist-tag on the
  [npm registry](https://www.npmjs.com/package/cursor-usage-optimizer).
- **git checkout** (`.git` present): compares local `HEAD` against `origin/master` via GitHub's
  compare API (no `git fetch`).

Both are **fully fail-open** (offline / proxy / rate-limit simply surfaces nothing) and run from the
background reminder refresher (plus a non-blocking kick from `get_usage`), so they never add latency.

When an update is available, `get_usage` returns `update.available: true` and the agent asks you
**once**, via the options UI, whether to update. If you **skip**, `dismiss_update` records that version
so you're **not asked again until an even newer version** appears (not daily). If you **accept**, the
agent gives you the right commands for your install (reload the MCP so `npx` fetches `@latest`, or
`git pull && npm run build` for a clone). State lives in `~/.cursor-usage/update.json`. Run
`check_update` any time to check immediately.

## Reminder hook (flag-aware self-check)

`hooks/cursor-usage-optimizer-reminder.sh` is an optional `postToolUse` hook that periodically
re-injects a short self-check so long chats keep following the rules. Install it with:

```bash
npx -y -p cursor-usage-optimizer cursor-usage-optimizer-install-hook
```

This copies the script to `~/.cursor/hooks/` and adds the `postToolUse` entry to
`~/.cursor/hooks.json` (replacing any older cursor-usage reminder entry). The installed hook works
for **both** install modes: if `CURSOR_USAGE_MCP_DIR` points at a built local clone it uses that,
otherwise it refreshes via `npx -y -p cursor-usage-optimizer cursor-usage-optimizer-reminder`.

It's **flag-aware**: `reminder-cli` builds the text from the *current* state, so it only mentions
modes that are actually active — e.g. once the quota is **exhausted** it drops the CONSERVE nudge
(nothing left to conserve), and it omits FOLLOW-UP unless follow-up mode is on. The refresh runs
detached (non-blocking) and shares the usage cache.

Because the hook launches the CLIs **without** the MCP's `env`, the MCP **syncs the effective config**
(env-aware `verbose`/`followup`/`threshold`) into `~/.cursor-usage/store.json` on startup, so the
hook-run CLIs read the same settings you configured via `mcp.json`.

## Tools

| Tool | What it does |
|------|--------------|
| `get_usage` | Reads usage and returns the conserve decision + an **`exhausted`** flag (included quota used up → on-demand, corp-covered; the agent silently continues, no reminders/numbers). Call at task start. Includes included-request count, on-demand spend, plan, **billing-cycle reset + days left**, and a **burn-rate projection** (requests/day → projected total by reset). |
| `usage_breakdown` | This cycle's usage broken down **by model**: cost, request count, and token totals (input/output/cache). Heavier than `get_usage`; call on request. |
| `login` | **Fallback** browser login + endpoint auto-discovery (only needed when the local-token path can't be used). Reports current usage immediately. |
| `logout` | Clears the stored `login` session (cookie + endpoints). Does not affect the local-token path. `forgetBrowser=true` also wipes the saved browser profile. |
| `set_threshold` | Sets the persisted threshold (0-100). Default **0** = conserve whenever requests remain. Overridden by the `CURSOR_USAGE_THRESHOLD_PCT` env var if set. |
| `set_verbose` | Enables/disables the per-message usage footer (persisted). Overridden by the `CURSOR_USAGE_VERBOSE` env var if set. |
| `set_followup` | Enables/disables the end-of-task "anything else?" follow-up question (persisted, default off). Overridden by the `CURSOR_USAGE_FOLLOWUP` env var if set. |
| `check_update` | Forces an immediate check against GitHub for a newer version (bypasses the once/day throttle) and reports how to update. |
| `dismiss_update` | Records that the user declined the current available update, so it isn't surfaced again until a newer version lands. |
| `status` | Shows the active **auth source** (`local-token` vs `login`) and local-token details (state.vscdb path, teamId, token expiry), whether a login session is stored, capture time, and stored/env/effective threshold, verbose, and follow-up settings. |

## Tuning when conserve mode kicks in

The threshold is the minimum **used percentage** at which conserve mode activates:

- `0` (default): conserve as long as any requests remain.
- `80`: only conserve once you've used ≥80% of the limit.

There are two ways to set it, and **the env var wins** if both are set:

**1. Env var (recommended — declarative, in `mcp.json`):**

```json
"cursor-usage": {
  "command": "npx",
  "args": ["-y", "cursor-usage-optimizer"],
  "env": {
    "CURSOR_USAGE_THRESHOLD_PCT": "80"
  }
}
```

(For a local clone, use `"command": "node", "args": ["/ABS/PATH/dist/index.js"]` instead.)

Change the number and reload the MCP. Accepts `0`–`100`. Leave it as `"0"` (or remove it) for the
default always-conserve behavior. If `CURSOR_USAGE_THRESHOLD_PCT` is set, it **overrides** any value
set via the tool below.

## Verbose mode (usage footer on every message)

Set `CURSOR_USAGE_VERBOSE` to `true` in the `mcp.json` `env` to have the agent append a usage footer
to the end of every message:

```json
"env": { "CURSOR_USAGE_VERBOSE": "true" }
```

Footer format (rendered as a fenced code block):

```
Cursor Usage: 290/500 requests · $0.00/$75.00 (~as of task start)
```

You can also toggle it at runtime without editing `mcp.json` via the **`set_verbose`** tool
(persisted in `~/.cursor-usage`). The `CURSOR_USAGE_VERBOSE` env var, if set, **overrides** the tool
value — remove it from `mcp.json` to control verbose purely via `set_verbose`.

Notes: the numbers reflect the reading from the **start of the task** (not refreshed per message), and
because appending a footer to every message is a model behavior, it may occasionally be missed.
Default is off.

## Follow-up mode (end-of-task "anything else?" question)

Independent of conserve/verbose. When on, `get_usage` tells the agent to **end each task with a brief
follow-up question through Cursor's questions/options UI** — e.g. "Anything else?" with a "No, we're
done" option plus room for an open answer (a more specific question when it fits). Because answering
that UI is free, you almost always get a prompt you can respond to and keep the session going without
spending an extra request to re-engage.

Enable via env in `mcp.json`:

```json
"env": { "CURSOR_USAGE_FOLLOWUP": "true" }
```

Or toggle at runtime with the **`set_followup`** tool (persisted in `~/.cursor-usage`). The
`CURSOR_USAGE_FOLLOWUP` env var, if set, **overrides** the tool value. **Default is off.**

## Threshold, continued

**2. `set_threshold` tool (persisted in `~/.cursor-usage`):**

```
set_threshold { "activationThresholdPct": 80 }
```

Used only when the env var is unset/empty. Run `status` to see `storedThresholdPct`,
`envThresholdPct`, and the resulting `effectiveThresholdPct`.

## How usage is read (no browser at query time)

`get_usage` does **not** open a browser. It makes direct authenticated requests (with the cookie
from the [local token](#authentication), or the stored `login` cookie) to the dashboard endpoints:

- **`/api/usage?user=<sub>`** → included-request count (`gpt-4.numRequests` / `maxRequestUsage`), e.g. `278/500`.
- **`/api/usage-summary`** → `membershipType`, `isUnlimited`, `limitType`, on-plan spend (`individualUsage.plan.used`), and on-demand spend (`individualUsage.onDemand`, cents → dollars).
- **`/api/dashboard/teams`** (team accounts) → `requestQuotaPerSeat`.
- **`/api/dashboard/get-hard-limit`** (team accounts) → per-user `$` cap for context.

The browser (Playwright) is used **only during the `login` fallback**. The conserve decision is
based on the **included-request percentage** (the "X / 500" number).

**Budget vs. team cap.** The spend line reports your **actual** on-demand budget from
`individualUsage.onDemand.limit` (authoritative for you), and — for context — the team-wide default
per-user cap from `get-hard-limit` (`hardLimitPerUser`). These usually match, but can differ if your
org sets per-user overrides; the tool flags it when they diverge.

**Team accounts.** For team-billed accounts the included-request math mirrors Cursor's dashboard
exactly: the limit is `500 × requestQuotaPerSeat` (fetched from `/api/dashboard/teams`) and the used
count comes from on-plan spend (`ceil(planUsedCents / 4)`), falling back to the legacy `gpt-4`
bucket when spend is `0` or the seat quota can't be read. Individual accounts just use the legacy
`gpt-4` bucket directly.

`get_usage` always returns the **raw** JSON per source, so if a field ever looks off you can inspect
`raw` and adjust `parseLegacyBucket` / `computeIncludedRequests` / `parseSummary` in `src/usage.ts`.

## Releasing (maintainers)

Publishing to npm is automated via GitHub Actions (`.github/workflows/release.yml`) and triggered by
a version tag:

```bash
npm version patch      # bumps package.json + creates a vX.Y.Z tag (use minor/major as needed)
git push --follow-tags # pushes the commit and the tag → CI publishes to npm
```

The workflow runs `npm ci && npm run build`, verifies the tag matches `package.json`'s version, then
`npm publish --access public`.

**Auth = npm Trusted Publishing (OIDC) — no token/secret.** The workflow authenticates with GitHub's
OIDC token (`id-token: write`); provenance is generated automatically. One-time setup on npmjs.com:
package → **Settings → Publishing access → Trusted Publisher → GitHub Actions**, and enter:

| Field | Value |
|-------|-------|
| Organization or user | `udah1` |
| Repository | `cursor-usage-mcp` |
| Workflow filename | `release.yml` |
| Environment | *(leave blank)* |

(The workflow upgrades npm to `@latest` in CI because Trusted Publishing needs npm ≥ 11.5.1.)
