# hotseat

Keep several Claude Code and Codex accounts on one machine and move between them
without signing in and out. A menu bar app shows how much of each limit is left,
and hotseat can switch for you before the account you are using runs out.

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

Requires [Bun](https://bun.sh) and macOS.

```sh
git clone https://github.com/pouyarezvani/hotseat.git
cd hotseat
bun install
bun run build                 # builds the hotseat binary into dist/
ln -sf "$PWD/dist/hotseat" ~/.local/bin/hotseat

bash macos/build.sh           # builds the menu bar app
hotseat menubar               # opens it
hotseat menubar install       # and starts it whenever you log in
```

## Adding accounts

```sh
hotseat add
```

It asks which service, opens your browser, and you sign in. The account joins
the list. `hotseat add claude` or `hotseat add codex` instead saves the account
that service is signed in to right now, with no browser.

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

If the login in use stops answering for three checks in a row, hotseat treats
it as gone and switches away from it. Each service is judged on its own:
switching Claude never touches Codex.

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
| `hotseat remove <service> <account>` | forget it and delete its saved login |
| `hotseat disable <service> <account>` | skip it when switching automatically |
| `hotseat enable <service> <account>` | include it again |
| `hotseat rename <service> <account> <name>` | give it a short name |
| `hotseat move <service> <account> <number>` | change its number |
| `hotseat swap <service> <a> <b>` | exchange two accounts' numbers |
| `hotseat map <service> <account> [folder]` | use that account in a folder |
| `hotseat unmap [folder]` | remove that rule |
| `hotseat run <service> [account] -- <command>` | run a command on the folder's account |

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
| `titleCompact` | `false` | shrink the menu bar button to each service's mark and one number |
| `titleShowAccount` | `true` | show the account name in the title |
| `titlePercentage` | `all` | `all`, `worst`, or `none` |
| `titleShowModelLimits` | `true` | include per-model weekly limits |
| `titleShortenEmail` | `true` | show the part before the @ |
| `autoThresholdPercent` | `90` | switch once a limit reaches this |
| `autoModelLimits` | empty | model limits that count too: names, or `all` |
| `autoCooldownSeconds` | `300` | minimum gap between switches |
| `autoUnhealthyTicks` | `3` | failed reads in a row before switching away |
| `autoIntervalSeconds` | `120` | seconds between checks for `hotseat auto` |
| `autoProviders` | `claude,codex` | which services to switch |
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

Usage comes from the same endpoints each agent uses for its own display, read
with each account's own credential. Every account is polled, not only the one in
use, because an account with no reading cannot be compared against another.

How often is not a setting. Each endpoint allows roughly thirty reads an hour
per account, so hotseat spends that where it matters: the account in use is
read every minute while it is near the threshold and climbing, every three
minutes otherwise, and the others every five. A failed read keeps the last good
numbers on screen, marked, until that window resets.

Everything hotseat stores lives in `~/.hotseat`, owner-readable only:

```
~/.hotseat
├── accounts.json     every account, its saved login, and which is in use
├── settings.json     your settings
├── state.json        the last board, which the menu bar watches
├── usage.json        cached readings
├── history.jsonl     a line per switch
├── auto-state.json   what the last automatic switch left behind
└── mappings.json     folder rules
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

The menu bar build runs its own checks against the real views. One renders a
highlighted account row off-screen and confirms its content survived, because a
highlight added as a subview paints over the row and that is only visible on
screen. Another clicks a row and confirms the row's own handler ran: reaching
for the menu item's action instead crashes, since giving an item a submenu makes
AppKit replace that action with an internal one.

## License

MIT. See [LICENSE](LICENSE).

The Claude and OpenAI marks in `macos/Logos` belong to Anthropic and OpenAI.
They appear in the compact menu bar title only to say which service a number
belongs to.
