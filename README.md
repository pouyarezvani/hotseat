# hotseat

Keep several Claude Code and Codex accounts on one machine and move between them
without signing in and out. A menu bar app shows how much of each limit is left,
and hotseat can switch for you before the account you are using runs out.

macOS. MIT licensed.

```
Claude  ────────────────────────────────────────────────
2 of 3 ready

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

Requires [Bun](https://bun.sh) and macOS.

```sh
git clone https://github.com/pouyarezvani/hotseat.git
cd hotseat
bun install
bun run build                 # builds the hotseat binary into dist/
ln -sf "$PWD/dist/hotseat" ~/.local/bin/hotseat

bash macos/build.sh           # builds the menu bar app
open macos/build/Hotseat.app
```

## Adding accounts

```sh
hotseat add
```

It asks which service, opens your browser, and you sign in. The account joins
the list.

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
hotseat best claude         # whichever account has the most left
hotseat rotate claude       # the next one in order
hotseat next claude         # the next one that still has room
```

Clicking an account in the menu does the same thing.

**A Claude switch lands immediately**, including in a session that is already
open, because Claude Code re-reads its credential as it works. **A Codex switch
needs a restart**: a running Codex session is pinned to the account it started
with, and refuses to reload when the account changes. hotseat tells you when
sessions are still open on the old account.

## Switching automatically

```sh
hotseat config set autoEnabled true
hotseat auto                # watches and switches; Ctrl-C to stop
hotseat auto --once         # one check, for a cron job or a launch agent
```

When the account in use crosses the threshold, hotseat moves to **the account
whose quota resets soonest among those with real room left**. That spends the
quota that would otherwise expire unused, rather than burning down a fresh
account first. Switch it with `hotseat config set autoStrategy most-left` if you
would rather always jump to the emptiest account.

Three things keep it from thrashing:

- A **cooldown** after each switch, skipped when the account is genuinely spent.
- A **margin**: a candidate has to beat the current account by a real amount.
- An account needs **at least 5% left** to be worth moving to, so a switch never
  lands somewhere that is about to run out.

Each service is judged on its own. Switching Claude never touches Codex.

## A different account per project

```sh
hotseat map claude 2 ~/work      # this folder and everything under it uses account 2
hotseat map                      # list the rules
hotseat run claude -- claude     # run with this folder's account
hotseat run claude 3 -- claude   # or name one outright
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
| `hotseat history` | recent switches |

Add `--json` to `status`, `title` or `history` for machine-readable output.

### Switch

| Command | |
| --- | --- |
| `hotseat switch <service> <account>` | switch to a specific account |
| `hotseat best <service>` | switch to the one with the most left |
| `hotseat rotate <service>` | switch to the next in order |
| `hotseat next <service>` | switch to the next one with room |
| `hotseat auto [--once]` | keep switching as limits fill up |

### Accounts

| Command | |
| --- | --- |
| `hotseat add [service]` | sign in and add an account |
| `hotseat save <service>` | re-save the login signed in right now |
| `hotseat remove <service> <account>` | forget it and delete its saved login |
| `hotseat disable <service> <account>` | skip it when switching automatically |
| `hotseat enable <service> <account>` | include it again |
| `hotseat rename <service> <account> <name>` | give it a short name |
| `hotseat move <service> <account> <number>` | change its number |
| `hotseat swap <service> <a> <b>` | exchange two accounts' numbers |

A service is `claude` or `codex`. An account is its number, its email, or the
name you gave it.

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
| `titleCompact` | `false` | shrink the menu bar button |
| `titleShowAccount` | `true` | show the account name in the title |
| `titlePercentage` | `all` | `all`, `worst`, or `none` |
| `titleShowModelLimits` | `true` | include per-model weekly limits |
| `titleShortenEmail` | `true` | show the part before the @ |
| `autoEnabled` | `false` | switch automatically |
| `autoThresholdPercent` | `90` | switch once a window passes this |
| `autoIntervalSeconds` | `120` | seconds between checks |
| `autoCooldownSeconds` | `300` | minimum gap between switches |
| `autoHysteresisPercent` | `10` | how much better a candidate must be |
| `autoStrategy` | `soonest-reset` | or `most-left` |
| `autoProviders` | `claude,codex` | which services to switch |
| `refreshIntervalSeconds` | `180` | how long a reading is reused |
| `barWidth` | `14` | meter width in the terminal |

Values are bounded, because a bad one breaks something concrete. Reading faster
than once a minute walks into the usage endpoints' own rate limits.

## How it works

hotseat stores each account's login itself and installs one of them as the live
credential when you switch.

- **Claude** keeps its credential in the macOS Keychain. That one entry also
  holds your connector logins, which belong to the machine rather than to an
  account, so a switch replaces only the account's own keys and leaves the rest
  in place.
- **Codex** keeps its credential in a file under its home directory.

Usage comes from the same endpoints each agent uses for its own display, read
with each account's own credential. Every account is polled, not only the one in
use, because an account with no reading cannot be compared against another.
Readings are cached for a few minutes and refreshed in the background.

Everything hotseat stores lives in `~/.hotseat`, owner-readable only:

```
~/.hotseat
├── accounts.json     which accounts exist, and which is in use
├── settings.json     your settings
├── state.json        the last board, which the menu bar watches
├── usage.json        cached readings
├── history.jsonl     a line per switch
└── vault/            one saved login per account
```

## Development

```sh
bun test              # the test suite
bun run typecheck
bun run lint
bun run build         # the CLI binary
bash macos/build.sh   # the menu bar app, including a render check
```

The menu bar build runs a rendering check that draws a highlighted account row
off-screen and confirms its content survived. A highlight added as a subview
paints over the row, which looks correct in code and is only visible on screen.

## License

MIT. See [LICENSE](LICENSE).
