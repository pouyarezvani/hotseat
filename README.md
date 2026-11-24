<p align="center">
  <img src="macos/Icon/icon.png" alt="The Hotseat icon: three stacked layers, the top one lit" width="128">
</p>

# hotseat

Keep several Claude Code, Codex, Grok and Antigravity accounts on one machine
and move between them without signing in and out. A menu bar app shows how much
of each limit is left and which free limit resets each account holds, and
hotseat can switch for you before the account you are using runs out.

macOS. MIT licensed.

```
Claude  ────────────────────────────────────────────────
1 to switch to

 ● 1  you@example.com  max
   ├ 5h     ███████████▊░░  84%  1h 11m
   ├ week   ██████████░░░░  72%  3d 2h
   ╰ Fable  █████████████▏  94%  3d 2h

 ○ 2  work@example.com  max
   ├ 5h     ░░░░░░░░░░░░░░   0%
   ├ week   ░░░░░░░░░░░░░░   0%  5d 9h
   ╰ Fable  ░░░░░░░░░░░░░░   0%  5d 9h
```

## Install

Requires macOS 14 or later on Apple silicon. Either build it yourself or
download the latest build.

### Build it yourself

Requires [Bun](https://bun.sh).

```sh
git clone https://github.com/pouyarezvani/hotseat.git
cd hotseat
bun install
bun run build                 # builds the hotseat binary into dist/
mkdir -p ~/.local/bin && ln -sf "$PWD/dist/hotseat" ~/.local/bin/hotseat

bash macos/build.sh           # builds the menu bar app into macos/build/
hotseat menubar               # opens it
hotseat menubar install       # and starts it whenever you log in
```

An app built this way runs the `hotseat` built beside it in `dist/`, so
`bun run build` is enough to update what the menu bar runs. To update, pull and
run both builds again.

### Download

1. Download [Hotseat.dmg](https://github.com/pouyarezvani/hotseat/releases/latest/download/Hotseat.dmg).
   Every push to `main` builds a new one, so this link always gives the latest.
2. Open it and drag **Hotseat** onto **Applications**.
3. Open Hotseat from Applications. The app is not notarized by Apple yet, so the
   first time macOS says it cannot check it: open **System Settings > Privacy &
   Security**, scroll to Hotseat, and click **Open Anyway**. Each new download
   asks once more.

The downloaded app carries its own `hotseat` command and links it into
`~/.local/bin` the first time it opens, so a terminal, Claude Code's status line
and its hooks run the same version as the menu bar. A Mac as it comes does not
look in `~/.local/bin` for commands; if `hotseat` is not found in a terminal,
add it to your shell:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```
 It puts one there only where
there is none, or where a link points to nothing or to another copy of the app;
a link to a build of your own, and any file, are left as they are. To
update, download the DMG again and replace the app. `bash scripts/package-dmg.sh`
builds the same DMG locally into `dist/`.

## Adding accounts

```sh
hotseat add
```

It asks which service, opens your browser, and you sign in. The account joins
the list. `hotseat add claude` or `hotseat add codex` instead saves the account
that service is signed in to right now, with no browser.

**Accounts you are signed in to are found by themselves.** On each check,
hotseat adds the account any service is signed in to on this Mac, if that
service has none saved. Removing a service's last account stops hotseat looking
for it, so it does not come straight back; `hotseat add <service>` turns it on
again, and `autoDetectProviders` lists the services looked for.

Antigravity and Grok work the same way as Claude and Codex: several accounts
each, switched by hand or automatically, with each login renewed and put back
where the agent keeps it. They stay out of the menu bar text unless you put them
there (`titleProviders`), and always appear in the dropdown. Two things differ,
because of how Antigravity itself works: it signs in only from inside its own
app, so another account is added by signing in to it there and running
`hotseat add antigravity`; and it keeps one login for every terminal, so
`hotseat run` cannot start it as a second account.

**Nothing is ever signed out.** Adding a second account does not disturb the one
you are using. Each sign-in runs against its own scratch directory, so the
credential it produces is captured without touching the live one. For Codex this
also matters for a second reason: its own sign-in revokes whatever token is
already stored, so signing in normally would break the account you already had.

Accounts added this way carry the same permissions as signing in to the agent
directly, which is what lets hotseat read their usage.

## Switching

```sh
hotseat switch claude 2     # by number, email, or a name you gave it
hotseat best claude         # switch now, the way automatic switching would
hotseat rotate claude       # the next one in order
hotseat next claude         # the next one that still has room
```

Clicking an account in the menu does the same thing.

**A choice you make by hand is respected.** Whatever was already over its
limit on the account you picked does not count as a reason to move you off it
again: you saw it and chose it anyway. Everything else still does, so a limit
that fills up after you switch will move you, and a login that stops working
always will. The forgiveness lasts until that window resets or you switch
again.

**A Claude switch lands immediately**, including in a session that is already
open, because Claude Code re-reads its credential as it works. **A Codex switch
needs a restart**: a running Codex session is pinned to the account it started
with, and refuses to reload when the account changes. hotseat tells you when
sessions are still open on the old account.

## Switching automatically

This is what the app is for, so it is always on. While the menu bar app is
running, every refresh is also a switching pass. If you would rather not run
the menu bar app, `hotseat auto` runs the same loop in a terminal, and
`hotseat auto --once` does one pass for a cron job.

There is one rule. When a limit on the account in use reaches the threshold
(90% unless you change it), hotseat moves to **the account whose weekly quota
resets soonest among those that still have room**. That spends the quota that
would otherwise expire unused, rather than burning down a fresh account first.

Which limits count is up to you. The 5-hour and weekly limits always do. A
model's own weekly limit, such as Fable's, counts only if you say so, with
`hotseat config set autoModelLimits fable` (or `all`), or from the menu bar's
Settings. Count the models you use; an uncounted one is still shown, just not
acted on.

Two things keep it from thrashing:

- A **cooldown** after each switch, skipped when the account is genuinely spent.
- An account needs **at least 5% left** to be worth moving to, so a switch never
  lands somewhere that is about to run out.

If the service refuses the login in use three reads in a row, hotseat treats
it as gone and switches away from it. A busy service, an outage, or a token
that expired while nothing was running do not count: hotseat waits as long
as it was asked to, refreshes an expired token itself when no agent is
running, and leaves one to a running agent. An account whose saved login is
refused is never switched to, and is marked on the board until you sign in
to it again. Each service is judged on its own: switching Claude never
touches Codex.

The menu bar app shows a notification when it switches, when it could not,
and when every account is out of room.

## Forecast, history and service status

Every good reading is kept for a week. From it hotseat works out, for each
limit, when it will be full at the pace it has been filling: the last hour and a
half for a limit that resets within six hours, the last twelve hours otherwise.
Each bar in the dropdown has a tick where the limit would be if it were used
evenly until it resets: fill past the tick means it is being used faster than
the clock. Hover over a bar for the numbers, and for the forecast whenever the
last few hours' pace would fill the limit before it resets. An account's options in the dropdown draw each limit's last week as a
line.

hotseat also reads each service's public status page every five minutes
(status.claude.com for Claude Code, status.openai.com for Codex) and says so
beside the service when the page reports trouble. OpenAI's page has no entry for
the Codex CLI, so Codex is given the page as a whole, with the open incidents
named.

## Free limit resets

Claude and Codex sometimes grant an account free resets of its limits. hotseat
lists the ones each account holds under its limits, in the dropdown and on the
board: how many it has, what each one clears, in the same names as the limits
above it, and when it expires, with the days left: "expires Dec 1 (9 days)". On
its last day it shows the hours left instead. Hover over one in the dropdown for the full expiry time, how the
service describes it, and why it cannot be used right now, when it cannot.

- **Claude** lists resets in the same usage answer hotseat already reads, so they
  cost no extra request. The service lists them only to a client that names
  itself as a recent Claude Code, so hotseat names the version installed on this
  Mac. A Fable reset also gives back what Fable used of the week, and says so.
- **Codex** reports how many reset credits an account has with its usage, and
  lists them with a request of its own. hotseat makes that request only when the
  number changes, when one of them has expired, or once the list is six hours
  old.
- **Grok** and **Antigravity** have no resets of this kind.

Click a reset in the dropdown to use it. hotseat asks first, naming the account
and what will start over, because a used reset cannot be given back. From a
terminal, `hotseat use-reset <service> <account> [reset-id...]` does the same,
using the first one that can be used now, or the first of those named;
`hotseat status --json` lists each reset with its id, and every id under `ids`
when several resets that read the same share a line. A reset is used only if
the account was last seen to hold it and it can be used now, and one use runs
at a time. If a use is sent and no answer comes back, hotseat says it may have
happened and uses nothing else on that account until it has read the account
again; asking for the same reset before then sends the same request, which the
service treats as the same use. hotseat never uses a reset on its own, and
switching does not count on them. Each use is in `hotseat logs`.

## Keeping agents from running away

Two guards stop one chat from burning a whole week of limits.

**A helper limit.** Install the hook once and Claude Code asks hotseat before
every `Agent`, `Task` or `SendMessage` call:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "^(Agent|Task|SendMessage)$",
  "hooks": [{ "type": "command", "command": "hotseat guard hook", "timeout": 10 }] } ] } }
```

in `~/.claude/settings.json`. A chat may run at most `guardChatAgents` (5)
helpers at once, and a helper may never start its own. A refused call tells
the agent to do that piece itself or wait. If the hook itself fails it lets
the call through, so it can never stop your work. For Codex, set
`max_concurrent_threads_per_session = 5` under `[agents]` in
`~/.codex/config.toml`.

**A spending brake.** Every automatic pass records each account's weekly
percentage. If a service burns `brakePoints` (25) points within
`brakeMinutes` (60), hotseat stops switching that service's accounts, so a
runaway cannot move on to the next one, and the hook refuses new helpers.
Work already running is not touched. The brake clears itself once spending
calms down; `hotseat guard resume` clears it at once, and `brakePoints 0`
turns it off. `hotseat guard` shows the recent burn.

**One log.** `hotseat logs [--days N]` shows everything hotseat did, in one
timeline: switches, brake trips and clears, and every helper the hook allowed
or refused. `hotseat logs --switches` shows only switches, which is what the
menu bar's recent switches read. One file per day in `~/.hotseat/logs`, kept
30 days; an older `history.jsonl` is moved into it once.

## Two accounts at the same time

```sh
hotseat run claude 3             # open Claude Code as account 3, in this terminal only
hotseat run codex 2 -- codex resume
hotseat run claude 3 -- claude -p "hello"
```

Every other terminal, and the editor extension, stay on the shared login. The
agent is pointed at a folder of its own under `~/.hotseat/sessions`, which
links to your everyday setup (settings, instructions, skills, commands, agents,
hooks, plugins, MCP servers) and keeps that account's own login and chat
history. A token the session refreshes is saved back when it ends, and a
switch always installs the freshest copy, so nothing goes stale. Claude's
connector logins (MCP sign-ins) the session renews are handed back to every
other terminal when it ends too, because a renewal ends the token they still
hold. Running the
account that is already in use just runs the command on the shared login.

### A different account per folder

```sh
hotseat map claude 2 ~/work      # this folder and everything under it uses account 2
hotseat map                      # list the rules
cd ~/work && hotseat run claude  # opens Claude Code as account 2
```

Rules apply to a folder and everything beneath it, so setting one on a project
root covers the whole project.

## Commands

### Look

| Command | |
| --- | --- |
| `hotseat status` | every account and how full each limit is |
| `hotseat list` | one line per account |
| `hotseat title` | one-line summary, for a shell prompt |
| `hotseat statusline [service]` | one line for an agent's status bar, read from the last board with no request made |
| `hotseat statusline install` | show that line in Claude Code's status bar, if it has none set |
| `hotseat logs [--days N]` | everything hotseat did: switches, brakes, refused helpers (kept 30 days) |
| `hotseat logs --switches` | recent switches only |
| `hotseat guard` | the helper limit, recent burn and whether the brake is on |
| `hotseat guard resume [service]` | clear the brake now |
| `hotseat refresh` | read every account again now |

Add `--json` to `status`, `title` or `history` for machine-readable output.

### Switch

| Command | |
| --- | --- |
| `hotseat switch <service> <account>` | switch to a specific account |
| `hotseat best <service>` | switch now, to the account that resets soonest with room left |
| `hotseat rotate <service>` | switch to the next in order |
| `hotseat next <service>` | switch to the next one with room |
| `hotseat auto [--once]` | keep switching as limits fill up |

### Accounts

| Command | |
| --- | --- |
| `hotseat add` | sign in to another account and add it |
| `hotseat add <service>` | add the account signed in right now |
| `hotseat add-token claude [token]` | add a Claude account from a setup token (fewer permissions) |
| `hotseat save <service>` | re-save the login signed in right now |
| `hotseat signin <service> <account>` | sign in to it again through the browser, when its login stops working |
| `hotseat remove <service> <account>` | forget it and delete its saved login |
| `hotseat disable <service> <account>` | skip it when switching automatically |
| `hotseat enable <service> <account>` | include it again |
| `hotseat rename <service> <account> <name>` | give it a short name |
| `hotseat use-reset <service> <account> [reset-id...]` | spend one of its free limit resets |
| `hotseat move <service> <account> <number>` | change its number |
| `hotseat swap <service> <a> <b>` | exchange two accounts' numbers |
| `hotseat map <service> <account> [folder]` | use that account in a folder |
| `hotseat unmap [folder]` | remove that rule |
| `hotseat run <service> [account] [-- <command>]` | run as that account in this terminal only |

A service is `claude`, `codex`, `antigravity` or `grok`. An account is its number, its email,
or the name you gave it.

### Settings and data

| Command | |
| --- | --- |
| `hotseat config` | show every setting |
| `hotseat config set <key> <value>` | change one |
| `hotseat config reset <key>` | put one back to its default |
| `hotseat export <file>` | write accounts and logins to a file |
| `hotseat import <file>` | read them back in |
| `hotseat purge --yes` | delete everything hotseat stores |

An export contains live logins. Keep it private and delete it when done.

## Settings

| Key | Default | |
| --- | --- | --- |
| `titleCompact` | `false` | shrink the menu bar button to each service's mark and one number |
| `titleShowAccount` | `true` | show the account name in the title |
| `titlePercentage` | `all` | `all`, `worst`, or `none` |
| `titleShowModelLimits` | `true` | include per-model weekly limits |
| `titleShortenEmail` | `true` | show the part before the @ |
| `titleProviders` | `claude,codex` | which services the menu bar text names; one always stays |
| `autoDetectProviders` | every service | which services hotseat adds by itself when it finds one signed in |
| `autoThresholdPercent` | `90` | switch once a limit reaches this |
| `autoThresholdFiveHour` | `0` | a limit of its own for the 5-hour window, or 0 for the general one |
| `autoThresholdWeekly` | `0` | a limit of its own for the weekly window, or 0 for the general one |
| `autoModelLimits` | empty | model limits that count too: names, or `all` |
| `autoCooldownSeconds` | `300` | minimum gap between switches |
| `autoUnhealthyTicks` | `3` | failed reads in a row before switching away |
| `autoIntervalSeconds` | `120` | seconds between checks for `hotseat auto` |
| `autoProviders` | every service | which services to switch |
| `barWidth` | `14` | meter width in the terminal |

Values are bounded, because a bad one breaks something concrete.

## How it works

hotseat stores each account's login itself and installs one of them as the live
credential when you switch.

- **Claude** keeps its credential in the macOS Keychain. That one entry also
  holds your connector logins, which belong to the machine rather than to an
  account, so a switch replaces only the account's own keys and leaves the rest
  in place.
- **Codex** keeps its credential in a file under its home directory.
- **Grok** keeps its login in `~/.grok/auth.json`. Renewing it gives a new token
  for the next renewal and ends the old one, so hotseat saves a renewed login
  before it uses it, as it does for Codex.
- **Antigravity** keeps its login in one Keychain item. Renewing it gives a new
  access token and leaves the token that renews it as it was. The sign-in client
  the renewal needs is read from the installed `agy` program and remembered in
  `~/.hotseat/antigravity.json` until that program changes.

Usage comes from the same endpoints each agent uses for its own display, read
with each account's own credential. Every account is polled, not only the one in
use, because an account with no reading cannot be compared against another.

How often is not a setting. Each endpoint allows roughly thirty reads an hour
per account, so hotseat spends that where it matters: the account in use is
read every minute while it is near the threshold and climbing, every three
minutes otherwise, and the others every five. A failed read keeps the last good
numbers on screen, marked, until that window resets.

Between those reads, the account in use follows the agent's own numbers.
Claude Code keeps the reading behind its usage banner in its config file and
refreshes it as it works, so whenever that reading is newer than hotseat's,
hotseat shows it. It matches on the account the reading belongs to, so a
reading left over from before a switch is ignored, and it costs no request.

Everything hotseat stores lives in `~/.hotseat`, owner-readable only:

```
~/.hotseat
├── accounts.json     every account, its saved login, and which is in use
├── settings.json     your settings
├── state.json        the last board, which the menu bar watches
├── usage.json        cached readings
├── usage-history.json  each limit's readings over the last week
├── service-status.json what each service's status page last said
├── statusline.json   the last board, for `hotseat statusline` to read
├── antigravity.json  the sign-in client Antigravity's login is renewed with
├── guard.json        the helper reservations, readings and brakes
├── logs/             one file per day: switches, brakes, helper decisions (30 days)
├── auto-state.json   what the last automatic switch left behind
├── mappings.json     folder rules
└── sessions/         one folder per account run on its own, with its history
```

### Editing the files by hand

Both `accounts.json` and `settings.json` are yours to edit. The menu bar's
Settings has an item for each that opens it in Cursor or VS Code, whichever
is installed. `settings.json`
holds only the keys you have changed; `hotseat config` lists every key with
its allowed values.

`accounts.json` is the one place accounts and their logins live. An entry
needs only a service and an email; hotseat fills in the rest and writes the
file back. A Claude login can be given as a setup token string:

```json
{
	"version": 1,
	"accounts": [
		{ "provider": "claude", "email": "you@example.com", "login": "sk-ant-oat01-..." },
		{ "provider": "codex", "email": "you@example.com" }
	],
	"active": {}
}
```

Delete an entry to forget that account. An entry hotseat cannot read is left
exactly as written and reported by `hotseat status` and `hotseat list`.
hotseat rewrites this file whenever a token is refreshed or an account is
switched, so make an edit and save it rather than keeping it open for long.
The file holds live logins: keep it to yourself.

## Relaunching the menu bar app

If you quit it:

```sh
hotseat menubar            # open it again
hotseat menubar install    # and start it whenever you log in
hotseat menubar status     # is it running, is it set to start at login
hotseat menubar stop       # close it
hotseat menubar uninstall  # stop it starting at login
```

## Development

```sh
bun test              # the test suite
bun run typecheck
bun run lint
bun run build         # the CLI binary
bash macos/build.sh   # the menu bar app, including its own checks
```

Tests cover what each command does to disk, the switching policy across every
branch, the terminal layout, and the contract between the menu and the CLI.
That last one exists because the menu talks to the CLI by name: a test reads
every command the menu invokes, every setting it writes and every value it
offers, and fails if any of them is something the CLI would reject.

The dropdown is the app's own window rather than a system menu. The menu bar
build runs its own checks against the real views: it draws every page of the
dropdown off-screen and confirms each one drew its content and is as tall as
that content, because an empty or clipped window is only visible on screen. Set
`HOTSEAT_RENDER_OUT` to a folder to have those pages saved there as pictures.

## License

MIT. See [LICENSE](LICENSE).

The Claude, OpenAI, Antigravity and Grok marks in `macos/Logos` belong to
Anthropic, OpenAI, Google and xAI. They appear in the compact menu bar title and the dropdown
only to say which service a number belongs to.
