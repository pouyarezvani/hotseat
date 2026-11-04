# Agent Guard (small) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a repeat of 2026-11-03 (one chat's 20 nested Opus helpers burned a whole weekly limit overnight) with the least code to maintain.

**Architecture:** One new file, `src/core/guard.ts`, used in two places: a `hotseat guard hook` command that Claude Code runs before every `Agent`/`Task` call, and Hotseat's existing per-minute automatic pass (`tick`), which gains a spending brake. Everything else is configuration: one Codex setting, two macOS power settings, and a rewritten rule. No T3 internals, no process freezing, no Swift changes.

**Tech Stack:** Bun + TypeScript, `bun test`, Biome.

**Spec:** this plan's Design section, decided in conversation on 2026-11-04. It replaces a larger design (reviewed in three review-flint rounds) that the user rejected as too much to maintain.

## Design

### What caused the loss, and what stops each part

| Cause (verified) | Stopped by | Maintenance |
|---|---|---|
| The Mac slept on battery and dark-woke 51 times; each wake re-sent every helper's context uncached (50 of 58 points) | macOS settings: no Power Nap or TCP keepalive on battery, so a closed lid really sleeps; never idle-sleep on power, so overnight work on power keeps running | none |
| Helpers started helpers: 8 became 21 | Hook refuses `Agent`/`Task` from inside a helper | one small file |
| 20 helpers at once | Hook refuses a 6th running helper in a chat | same file |
| Codex helpers | Codex's own `agents.max_concurrent_threads_per_session = 5` | none |
| Auto-switch would hand a runaway the next account | Brake: when a provider burns ≥ 25 weekly points in 60 minutes (the heaviest normal hours in the last month ran about 16–22), Hotseat stops switching that provider and the hook refuses new helpers, so the damage stops at one account | same file |

The Mac Studio is always on, so only the hook, the Codex cap and the brake matter there; a MacBook used as a T3 client is unaffected.

### Accepted limits (deliberate, to keep this small)

- T3 `delegate_task` children and Codex-started delegation are capped by the rule, not by code; the brake bounds any runaway to one account.
- A helper whose transcript has been silent for 30 minutes stops counting (Claude Code marks finished helpers itself; the 30 minutes only covers crashes).
- The brake does not pause running agents; it stops new helpers and stops switching, and it clears itself once spending calms down.
- A weekly reset inside the brake window is ignored for that window (no false trip; at worst a later trip).
- If anything in the hook fails, it allows the call and logs one line.

## Global Constraints

- Bun only; no narration comments (house rules).
- Settings, exactly: `guardChatAgents: 5` (1–20), `brakePoints: 25` (0–100, 0 turns the brake off and clears any brake), `brakeMinutes: 60` (10–180).
- Files: state in `~/.hotseat/guard.json` behind `~/.hotseat/locks/guard.lock`; log in `~/.hotseat/logs/guard.log`.
- The hook runs before `migrateVault()` in `src/cli.ts` and must finish in under 150 ms.
- Nothing is committed until the user says so; the code changes get a review-flint round before the first commit (house rule).

## Review Focus

1. Several `Agent` calls in one message must not all pass. Test `parallel calls never exceed the chat limit`.
2. A finished or crashed helper must not hold a slot forever. Tests `finished helpers do not count`, `silent helpers stop counting after 30 minutes`.
3. A brake trip must not be overtaken by a switch already in progress. Test `a switch decided before the brake does not land`.
4. An account switch or weekly reset must not look like spending. Tests `switching accounts is not burn`, `a weekly reset is not burn`.
5. A broken input must never block an agent. Test `fails open on garbage`.

---

### Task 1: Settings

**Files:** Modify `src/core/settings.ts` (`Settings`, `DEFAULTS`, `BOUNDS`); Test `test/settings.test.ts`

- [ ] **Step 1: Failing tests:** `guard defaults` (`5`, `8`, `60`); `guard bounds clamp` (`{ guardChatAgents: 0, brakeMinutes: 5, brakePoints: 500 }` → `1`, `10`, `100`).
- [ ] **Step 2:** `bun test test/settings.test.ts` → FAIL.
- [ ] **Step 3:** Add the three keys with doc comments, defaults and bounds.
- [ ] **Step 4:** `bun test test/settings.test.ts` → PASS.

### Task 2: `src/core/guard.ts` — hook, burn and brake

**Files:** Create `src/core/guard.ts`; Modify `src/cli.ts`; Test `test/guard.test.ts`

**Interfaces:**
```ts
export interface GuardState {
  version: 1;
  reservations: { sessionId: string; toolUseId: string; at: number }[];
  samples: { t: number; provider: ProviderId; accountId: string; percent: number; resetsAt?: string }[];
  brakes: Partial<Record<ProviderId, { at: number; points: number }>>;
}
export async function loadGuard(): Promise<GuardState>                       // missing or garbled → empty
export async function updateGuard<T>(change: (s: GuardState) => T): Promise<T>   // acquireLock(hotseatHome(), 5_000, 'guard.lock') + writeJsonAtomic(guardPath)
export async function runningHelpers(sessionId: string, transcriptPath: string, now: number): Promise<{ count: number; toolUseIds: Set<string> }>
export async function runHook(stdin: string, now?: number): Promise<string>   // '' allows; otherwise the deny JSON
export function burnPoints(samples: GuardState['samples'], provider: ProviderId, since: number, now: number): number
export async function applyBrake(state: State, settings: Settings, now: number): Promise<TickReport[]>
export async function resumeBrake(provider: ProviderId | 'all'): Promise<ProviderId[]>
export function guardPath(): string   // <hotseat home>/guard.json
```

**Hook rules** (`runHook`), for `tool_name` `Agent` or `Task` only; any other tool → `''` without touching state:
1. `agent_id` present (the caller is a helper) → deny: `Hotseat limit: helpers may not start their own helpers. Do this piece yourself.`
2. `brakes.claude` set → deny: `Hotseat brake is on: Claude used {points} points of its weekly limit in {brakeMinutes} minutes. New helpers are paused; tell the user.`
3. Inside `updateGuard`: drop reservations older than 120 s or whose `toolUseId` now appears in a helper record; `count = runningHelpers(...).count + this session's remaining reservations`; if `count >= guardChatAgents` → deny: `Hotseat limit: this chat already has {count} helpers running (limit {limit}). Do this piece yourself, or wait for one to finish and then start the next. Do not retry in a loop.`; else add `{ sessionId, toolUseId, at: now }` and allow.
4. Deny output: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`, exit 0.
5. Any thrown error → `''` and one line `<ISO time> hook error: <message>` appended to `~/.hotseat/logs/guard.log`.

**Helper records** (verified with Claude Code 2.1.318): `<dirname(transcript_path)>/<session_id>/subagents/agent-<id>.meta.json` beside `agent-<id>.jsonl`. A record is written at launch without `finished` and gains `"finished": true` when the helper ends; it carries `toolUseId`. `runningHelpers` counts records without `finished: true` whose `.jsonl` (or the meta, if there is no `.jsonl` yet) was modified within the last 30 minutes.

**Burn** (`burnPoints`): per account, take its samples with `since <= t <= now` in time order and sum `max(0, b.percent − a.percent)` over consecutive pairs whose `resetsAt` are both missing or within 1 hour of each other; sum over the provider's accounts.

**Brake** (`applyBrake`), called from `tick`:
- Under `updateGuard`: append one sample per account that has a window labelled `week` and a `usage.fetchedAt` newer than that account's last sample (`t = Date.parse(fetchedAt)`); drop samples older than 3 hours.
- For each provider with accounts, `points = burnPoints(samples, provider, now − brakeMinutes·60_000, now)`. Not braked and `brakePoints > 0` and `points >= brakePoints` → set `brakes[provider] = { at: now, points }`. Braked and `points < brakePoints / 2` and at least `brakeMinutes` since `at` → delete the brake (it clears itself once spending calms down).
- Return, for each braked provider, a report `{ provider, outcome: 'blocked', detail }` with detail: `brake: {Provider} used {points} points of its weekly limit in {brakeMinutes} minutes, so Hotseat stopped switching its accounts and new helpers are refused. It clears itself when spending calms down, or run "hotseat guard resume".` (`points` rounded to 1 decimal, fixed at trip time so the menu bar's notice shows once.)

**CLI** (`src/cli.ts` `main`): before `await migrateVault()`, `guard hook` reads stdin, writes `runHook(...)`, returns 0. Also `hotseat guard status` (prints active brakes and each provider's burn over the last `brakeMinutes`) and `hotseat guard resume [claude|codex|all]` (deletes the brakes). Help lines in `src/ui/help.ts`.

- [ ] **Step 1: Failing tests** (`withHome`, fixture helper folders under a temp dir):
  - `ignores other tools` — `Bash` → `''`, no `guard.json`.
  - `helpers may not start helpers` — payload with `agent_id` → deny with that reason.
  - `allows the fifth and refuses the sixth` — 4 running records → `''`; 5 → deny containing `limit 5`.
  - `finished helpers do not count` — 5 records with `finished: true` → `''`.
  - `silent helpers stop counting after 30 minutes` — 5 unfinished, `.jsonl` 31 minutes old → `''`.
  - `parallel calls never exceed the chat limit` — 3 running; 6 `runHook` calls with distinct `tool_use_id` via `Promise.all` → exactly 2 `''`.
  - `a reservation ends when its helper appears` — after an allowed call, add a record with that `toolUseId` → count does not double.
  - `refuses while braked` — `brakes.claude` set → deny with the brake reason.
  - `fails open on garbage` — stdin `not json` → `''`, one `guard.log` line.
  - `last night trips at 12:35 AM` — one account: 42 @ 12:01, 43 @ 12:05, 45 @ 12:24, 48 @ 12:31, 50 @ 12:35 (same `resetsAt`) → `burnPoints` over 11:35–12:35 = `8`.
  - `a normal busy hour does not` — 25 @ 11:53, 26 @ 12:26, 27 @ 12:54, window 11:54–12:54 → `1` (only the in-window pair counts).
  - `switching accounts is not burn` — A 50 → 52, B first seen at 30 then 31 → `3`.
  - `a weekly reset is not burn` — 99 then 1 with `resetsAt` 7 days later, then 3 → `2`.
  - `trips, reports, and clears itself` — `applyBrake` with 8 points → `brakes.claude` and one `blocked` report starting `brake:`; later state where the last 60 minutes burned 1 point and 60 minutes have passed → brake gone, no report.
- [ ] **Step 2:** `bun test test/guard.test.ts` → FAIL.
- [ ] **Step 3:** Implement `src/core/guard.ts`; wire `src/cli.ts` and `src/ui/help.ts`.
- [ ] **Step 4:** `bun test test/guard.test.ts` → PASS.

### Task 3: Brake in the automatic pass

**Files:** Modify `src/core/auto.ts` (`tick`, lines 263–416); Test `test/guard.test.ts`

- [ ] **Step 1: Failing tests:**
  - `a braked provider does not switch` — in-use account at 98%, `brakes.claude` set → the `brake:` report, no `switched`, `history.jsonl` unchanged.
  - `a switch decided before the brake does not land` — `tick` with in-use 98% and a test hook `beforeSwitchLock` that sets `brakes.claude` → no `switched`, installed credential unchanged.
- [ ] **Step 2:** `bun test test/guard.test.ts` → FAIL.
- [ ] **Step 3:** In `tick`, after `collectState`: `reports.push(...await applyBrake(state, settings, now))`, and remember the braked providers. In the switching loop: `continue` early for a braked provider; call `options.beforeSwitchLock?.()` just before `holdSwitch(providerId)`; right after taking `holdSwitch`, `if ((await loadGuard()).brakes[providerId]) continue;` (the `finally` releases the lock).
- [ ] **Step 4:** `bun test` → PASS; `bun run typecheck` → clean; `bun run lint` → clean.

### Task 4: Install and configure

**Files:** `README.md`, `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.agents/AGENTS.md`

- [ ] **Step 1: README:** a short "Guard" section: the hook, the three settings (`hotseat config set guardChatAgents 5`), the brake and `hotseat guard resume`.
- [ ] **Step 2: Build:** `bun run build` (`~/.local/bin/hotseat` already links `dist/hotseat`); restart the menu bar app with `hotseat menubar` so its passes use the new binary. Time the hook: `echo '{"tool_name":"Agent","session_id":"x","transcript_path":"/tmp/x.jsonl","tool_use_id":"t"}' | /usr/bin/time -p dist/hotseat guard hook` → empty output, `real` under 0.15.
- [ ] **Step 3: Claude hook:** back up `~/.claude/settings.json`, then add to `hooks.PreToolUse` with a JSON-aware edit that keeps every existing entry:
  ```json
  { "matcher": "^(Agent|Task)$", "hooks": [{ "type": "command", "command": "/Users/pouyarezvani/.local/bin/hotseat guard hook", "timeout": 10 }] }
  ```
- [ ] **Step 4: Codex cap:** append to `~/.codex/config.toml` (`~/.agents/sync.sh` rewrites only `[mcp_servers.*]`):
  ```toml
  [agents]
  max_concurrent_threads_per_session = 5
  ```
  Check: `codex doctor` reports `config … loaded`.
- [ ] **Step 5: Rule:** replace the `~/.agents/AGENTS.md` section "Pausing means stop everything first (HARD RULE)" (heading and paragraph) with:
  ```markdown
  ## Agent limits (HARD RULE)

  **Going to sleep, stepping away or closing the laptop is not a request to stop: keep working unless I say pause or stop. When I say pause or stop, stop every helper, delegated task and job you started, and confirm each one is stopped.** Never claim background work will stop on its own.

  - **At most 5 helpers per chat at once, and helpers never start their own.** Hotseat's hook enforces this for Claude's `Agent` tool and Codex caps its own helpers at 5; count T3 delegated tasks toward the same 5 yourself. A refused call means do that piece yourself or wait for a helper to finish; never retry in a loop. Plan big jobs in waves of at most 5.
  - **Hotseat's brake** stops account switching and new helpers when a provider burns 8 points of its weekly limit within an hour. If you hit it, tell me.
  - **The limits live in `~/.hotseat/settings.json`** (`hotseat config`); change them there and nowhere else.
  ```
- [ ] **Step 6: macOS power (the user runs these once; they need the password):**
  ```bash
  sudo pmset -b powernap 0 tcpkeepalive 0   # on battery a closed lid really sleeps: no background wake-ups
  sudo pmset -c sleep 0                     # on power the Mac never idle-sleeps, so overnight work keeps going
  ```
  Check: `pmset -g custom` shows `powernap 0` and `tcpkeepalive 0` under Battery Power and `sleep 0` under AC Power. (On battery with TCP keepalive off, Find My cannot reach a sleeping Mac.)
- [ ] **Step 7: Live check** (Haiku, a few cents): a scratch git repo whose `.claude/settings.json` runs `HOTSEAT_HOME=<tmp> /Users/pouyarezvani/.local/bin/hotseat guard hook`, with `<tmp>/settings.json` holding `{"version":1,"guardChatAgents":1}`; `claude -p --model claude-haiku-5-5 --allowedTools "Agent,Bash,Task"` asked to start one helper that starts another, then a second top-level helper → the nested call is refused with the "may not start their own helpers" reason and the second top-level helper with the `limit 1` reason.
- [ ] **Step 8: Hand back:** tests, typecheck, lint, build, timing and live-check output; the review-flint round on the code before any commit; commit only when the user says so.

## Final review fixes and additions (2026-11-04)

Review-flint round 4 (final) declined with 2 Major and 4 Minor findings; the user asked for no further rounds. Each is fixed here and supersedes the text above where they differ.

| id | finding | fix |
|---|---|---|
| R4-1 Major | `SendMessage` resumes finished helpers without the hook | Matcher becomes `^(Agent\|Task\|SendMessage)$`. A `SendMessage` whose `to` names a helper record of this session (`agent-<to>.meta.json`) that is `finished` is an admission and goes through the same checks (refused outright from inside a helper); any other `SendMessage` is allowed untouched. A `to` the hook cannot resolve is allowed (fail open). |
| R4-2 Major | a brake published during an activation does not stop it | Publishing a **new** brake first takes `holdSwitch(provider)` (lock order: switch lock, then `guard.lock`), so it waits for any switch in progress; the recheck right after `holdSwitch` in `tick` stays. Test: a trip started while a switch holds the lock lands only after it, and no activation starts after it. |
| R4-3 Minor | `brakePoints = 0` cannot clear a brake | `brakePoints === 0` deletes every brake. Test. |
| R4-4 Minor | 3-hour sample retention shorter than allowed windows | `brakeMinutes` capped at 180, matching the 3-hour retention. |
| R4-5 Minor | 5-second lock wait vs the hook budget | The hook waits at most 1,000 ms for `guard.lock`, then allows and logs. 150 ms stays the uncontended target. Test: a held lock → the hook allows within ~1.1 s and logs `hook-lock-timeout`. |
| R4-6 Minor | live check needs a running first helper | Live check: the first helper runs in the background with `sleep 90`; the second request is refused while it runs; after it finishes, a new request is allowed. |

**Threshold (user feedback):** the default is 25 points in 60 minutes, not 8. Last month's heaviest normal hours were about 16–22 points (estimated from transcripts at about $20 per point; measured 9 points in the hour to 8:57 AM on 2026-11-04). The brake is a last resort for extreme runaways; the caps and the power settings are what stop a repeat of 2026-11-03.

**Logs (user request):** new `src/core/log.ts` with `logEvent(kind: string, data: Record<string, unknown>): Promise<void>` appending one JSON line `{ at, kind, ...data }` to `~/.hotseat/logs/YYYY-MM-DD.jsonl` (local date) and, at most once a day per process, deleting log files older than 30 days. Events: `hook-allow`, `hook-deny`, `hook-error`, `hook-lock-timeout`, `brake-trip`, `brake-clear`, `brake-resume`, and every switch (logged from `recordSwitch` in `src/core/history.ts`). `hotseat logs [--days N] [--json]` prints them (default 1 day). The hook's errors go to this log instead of `guard.log`. Tests: an event lands in today's file; a 31-day-old file is purged and a 29-day-old one kept.

**T3 (user request):** T3's Claude and Codex agents read the same global rule file (`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` are links to `~/.agents/AGENTS.md`), so the new rule reaches every T3 agent, and T3's Claude sessions run the user-level hooks in `~/.claude/settings.json`, so the cap applies inside T3 too. Nothing T3-specific is built.
