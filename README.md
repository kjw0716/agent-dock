<p align="center">
  <img src="assets/icon-256.png" width="112" alt="Agent Dock logo">
</p>

<h1 align="center">Agent Dock</h1>

<p align="center">
  <strong>Is your coding agent working, waiting for you, or done?</strong><br>
  A small always-on-top window that answers it at a glance, for 27 agents.
</p>

<p align="center">
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?logo=windows&logoColor=white" alt="Windows 10 and 11"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron 33"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white" alt="Node 20 or newer"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0 license"></a>
  <img src="https://img.shields.io/badge/agents-27-8A63D2" alt="27 agents">
  <img src="https://img.shields.io/badge/tests-passing-3DDC97" alt="Tests passing">
  <img src="https://img.shields.io/badge/read--only-unless%20you%20opt%20in-F2B705" alt="Read-only unless you turn on the Claude plugin">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#supported-agents">Supported agents</a> ·
  <a href="#how-it-works">How it works</a>
</p>

<p align="center">
  <img src="docs/hero.png" alt="Agent Dock in three sizes: icons only, the standard panel, and the wide panel with every session" width="900">
</p>

You start a task in Claude Code, another in Codex, a third in OpenCode, then go back to your own work.
Agent Dock sits on the edge of your screen and shows, for every agent, one of three states:

| State | Meaning | What you see |
| --- | --- | --- |
| **Working** | The agent is busy | Its bot bobs and blinks inside a spinning blue ring |
| **Waiting** | It needs an answer or an approval from you | A larger bot in a pulsing amber ring |
| **Done** | It finished its turn | A calm bot with a green check |

Nothing to configure first. It only reads files your agents already write. The dock itself stays this small; a button at its top left switches to **Statistics**.

## Features

- **One bot per agent.** 27 hand-drawn mascots, each with its own shape and colour.
- **Resizes with its content.** Drag the left or right edge: the layout changes with the width, from icons only to a full panel with per-state counts. The height always follows the content, so nothing is cut off and there is no empty space.
- **Click a row to open it.** The window grows to show that agent's sessions. Close the rows and it returns to exactly the previous size and position. Agent rows and session lines light up under the mouse, so you can see what a click will hit.
- **A raised hand with a count.** The corner of an agent's mascot shows a hand and how many of its sessions are waiting for you; the tray tooltip shows the total.
- **Unread.** When a Claude or Codex session finishes a turn while the dock is watching, its green ring and check **blink** until you click its row. For the other agents, which are read from file activity, it blinks only when activity that lasted at least 30 seconds stops; that means "activity stopped", not "finished". A Codex turn that goes quiet for 30 minutes and then finishes is not flagged. If something else of that agent is still working, a small blinking green dot marks the mascot instead. The tray tooltip counts unread sessions.
- **A short summary of what finished.** For Claude and Codex, a finished turn that you have not looked at shows its last message (about three lines) in a green card. Choose **Open chat**, **No reply** (dismiss it), or, for Claude, type a follow-up right there and send it as your next message (it uses the optional Claude plugin, like answering a question).
- **Open the chat from the dock.** A click can jump to the session's chat: for sessions of the Claude desktop app (through the app's own `claude://code/continue` link; terminal sessions have no desktop chat) and OpenCode (its window comes forward). It is a switch in Settings; a row with one session opens its chat directly, and if it cannot be opened the row expands as usual. A row with several sessions expands, and a click on one of its sessions opens it.
- **Per-state counts.** `Working 2 · Waiting 1 · Done 5` for every agent.
- **Pick your agents.** Settings lists every supported agent, installed ones first, with a switch for each.
- **English and 中文.** English is the default; switch in Settings.
- **Answer from the dock.** A question Claude's desktop app is waiting on shows up with its buttons and a text field; click, and the answer goes into that session (optional Claude plugin, off by default).
- **Read-only by default.** It never edits an agent's configuration and sends nothing anywhere unless you turn on Phone (below); only the optional Claude plugin, which you turn on yourself, adds one plugin to Claude.
- **Statistics.** The button at the top left of the dock (or Statistics in the tray menu) turns the whole window into a statistics view; the same button, or Esc, brings the dock back at its old size and position. It shows a timeline of when each agent was working and when it waited for you (recorded while the dock runs), tokens per day by agent, model or project, and a table of sessions with tokens, estimated cost and context size, from what Claude Code, Codex, OpenCode (any model or provider it ran) and Grok already write. Kilo Code, MiMo Code, Gemini CLI, Qwen Code, Pi, Oh My Pi and Kimi are read from the formats their source code defines but have not been tested against real data of those agents (Kimi records no model name, so it shows as `kimi`). The cost is the pay-as-you-go list price of those tokens, not what you were billed; for a model that is not in the price table the cost the agent itself reported is used (OpenCode, Grok, Kilo, MiMo Code, Pi and Oh My Pi report one; a reported 0 is shown as $0, which is right for a local model but is also what some agents write for a model they have no price for), otherwise it is listed as unpriced, and you can add a price in `prices.json`. OpenCode's numbers need the optional `better-sqlite3` build (see Supported agents); the other agents either store no token counts locally (Cursor), only per-session totals (Copilot, Hermes), a compressed log (DeepSeek), or a format that is not documented well enough to read safely (Droid, Goose, Cline, Roo): they only appear in the timeline.
- **Desktop shortcut** with a global start key (`Ctrl+Alt+H`).

## Download

Get `Agent-Dock-Setup-<version>.exe` from the [latest release](https://github.com/kjw0716/agent-dock/releases/latest) and run it. It installs for the current user (no admin rights) and adds a Start menu shortcut. The installer is not code-signed, so Windows SmartScreen may show "Windows protected your PC": choose **More info** > **Run anyway**.

## Run from source

You need Windows 10 or 11, [Node.js](https://nodejs.org/) 20 or newer and Git. (The screenshot script `scripts/shoot.js` needs Node 22 or newer.)

```powershell
git clone https://github.com/kjw0716/agent-dock.git
cd agent-dock
npm install
npm start
```

Create the Desktop and Start menu shortcuts (it can then be started with <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd>):

```powershell
npm run shortcut
```

Try it without any agent running:

```powershell
npm run demo
```

To start at login, turn on **Launch at login** in Settings.

## Screenshots

<p align="center">
  <img src="docs/states.png" alt="Claude waiting, Codex working, OpenCode done" width="420">
  &nbsp;&nbsp;
  <img src="docs/settings.png" alt="Settings: a switch for every agent, always on top, launch at login, language" width="300">
</p>

<p align="center">
  <img src="docs/mascots.png" alt="All 27 mascots in the working, waiting and done states" width="860">
</p>

## Using it

| Do this | What happens |
| --- | --- |
| Click an agent's row | Marks what it finished as read (the green stops blinking), and the window grows and shows that agent's sessions. Click again (or close the last open row) to go back |
| Click the expand button in the top bar | Opens or closes every row at once |
| Drag the left or right edge | Changes the width and the layout; height follows the content |
| Drag the top bar | Moves the window |
| Click the sliders button | Settings: which agents, always on top, launch at login, language, reset, quit |
| Right-click, or the tray icon | Reset position and size, quit |

Layouts by width: **icons only** → **icon and status** → **row** → **row with per-state counts** → **every session expanded**.

## Supported agents

Claude Code and Codex have dedicated readers. All other agents share one reader that looks at the files they keep.

| Agent | Where the state comes from | Waiting | Checked on a real machine |
| --- | --- | :---: | --- |
| **Claude Code** | `~/.claude/sessions/<pid>.json` (`busy`, `waiting`, `idle`) | ✓ | working, waiting and done |
| **Codex** | the newest `~/.codex/sessions/**/rollout-*.jsonl` | ✓ (approvals and questions) | working and done; waiting only in unit tests |
| **OpenCode** | `session_v2` in `~/.local/share/opencode/opencode.db` (busy / idle / viewed marks, read-only), plus the app process | – | working, done and unread checked against the OpenCode desktop app 2.3; needs the optional `better-sqlite3` build for Electron (fetched by `npm install`), otherwise it falls back to a file-activity guess |
| Kilo Code · MiMo Code · Cursor · GitHub Copilot · Gemini CLI · Antigravity · Grok · DeepSeek · Kimi · Pi · Oh My Pi · OpenClaw · Hermes · Factory Droid · TRAE · Qoder · ZCode · CodeBuddy · WorkBuddy · Qwen Code · Devin · Cline · Roo Code · Goose | each agent's session folder or database, paths taken from the agent-hud-open discovery tables | – | not yet |

*Waiting* needs an agent that exposes it. Only Claude Code and Codex do, so every other agent shows Working or Done.
Paths marked "not yet" are untested here. If one is wrong, it is one line in [`agents.js`](agents.js).

## Answer from the dock

When Claude's desktop app ends a turn with a question box (a next-step box, or an offer to start a new session), that question appears in the dock with its buttons and a text field. Click an answer or type your own: it is sent to that session as your next message.

<p align="center">
  <img src="docs/states.png" alt="A question from Claude in the dock, with two answer buttons and a text field" width="380">
</p>

This needs a small Claude Code plugin that delivers the message into the session. It is **off by default**: turn on **Claude plugin** at the top of Settings, and the dock runs Claude's own CLI for you:

```powershell
claude plugin marketplace add ~/.agent-dock/claude-plugin
claude plugin install agent-dock@agent-dock --scope user
```

Turn the switch off to remove it again (`claude plugin uninstall` and `claude plugin marketplace remove`). Nothing else in your Claude settings is changed, and other plugins, including the original Agent HUD's, are left alone.

- **What the plugin does:** every 5 seconds it writes a note saying "this session can take an answer" into `~/.agent-dock/channel/sessions/`; every second it looks in `~/.agent-dock/channel/prompts/<session>/` for an answer you clicked, and submits it as your next message once the session is idle. It touches nothing else.
- **Already-open sessions:** a session that started before the install has not loaded the plugin. The card says so; start a new session to answer there.
- **Safety:** an answer goes only to the session that asked. If the question closes before the plugin has picked the answer up (a second or so), the dock withdraws it; once picked up it is submitted as soon as the session is idle, so typing in Claude at that same moment could deliver both. Answers lapse after two minutes, only one answer per question is accepted, and text starting with `/`, `!` or `#` is refused, as are control characters. Anyone who can write to `~/.agent-dock/channel` could send messages into your Claude sessions, so keep that folder private (it lives in your user profile).
- **What is verified:** the whole round trip (check-in, answer, delivery as the user's message) works in headless Claude Code sessions loaded with the plugin, and installing and removing it works against a scratch Claude configuration. In the Claude desktop app, every open session loaded the plugin and checked in under the same session id the dock reads; a click-to-answer round trip inside the desktop app itself has not been tested yet.
- **Not covered yet:** Claude's tool-permission prompts and the multiple-choice AskUserQuestion tool still have to be answered in Claude.

## How it works

- **Questions:** for a Claude session that is idle, the dock reads the end of its transcript; a next-step box or session offer after your last real message means it is waiting for you, and its question and buttons are shown. Only the parsed tool call is used, never other transcript text.
- **Claude Code** keeps a registry file per running process. Agent Dock reads its `status`, drops entries whose process is gone, and maps `busy → Working`, `waiting → Waiting`, `idle → Done`.
- **Codex** writes one JSON line per event. Agent Dock reads the tail of the newest session files: `task_started` is Working, `task_complete` or `turn_aborted` is Done, an unanswered question or approval is Waiting. A working turn that has been silent for 30 minutes counts as Done; a pending question or approval stays Waiting.
- **Everyone else:** session files written in the last 12 seconds mean Working. An open app, or activity in the last 6 hours, means Done. Anything older is hidden.
- The list of running programs comes from `tasklist`, refreshed every 5 seconds and never on the UI thread.

Claude's `waiting` field is not a documented interface and may change between Claude Code versions.

## Your data

- Nothing leaves your computer unless you turn on Phone: then a phone you paired can read what the dock shows (agent states, session names, a question or finished reply) through Tailscale, with the optional Chats switch also the full text of your recent Claude Code and Codex conversations (see Phone), and, if you turn on notifications, pushes with the agent name and state go to the phone through its browser vendor's push service (or to your Bark address). Without Phone there are no network requests.
- Nothing in an agent's own configuration is changed. The one exception is the optional Claude plugin, installed only when you turn its switch on (see above).
- Agent Dock writes to `~/.agent-dock/`: `config.json` (position, width, enabled agents, language) and `state.json` (the last state it showed, without any question text), plus `channel/` and `claude-plugin/` once you turn on the Claude plugin. While it runs the dock also writes `history/` (one line per state change: agent, session id, session name, state, time), starting with the first launch. Opening Statistics adds `usage-index.json` (token counts per day, model and project folder; per-session totals, titles and working folder; the path and read position of every transcript it has read) and, if you create it, `prices.json`. No message text is stored there. Counts of transcripts that Claude Code has since deleted are kept; if an existing transcript is rewritten, the index is rebuilt from what is still on disk.
- Without the Chats switch, agent messages are not read for display except where you see them (with it, conversations are read from the agents' own transcript files when a phone opens them, see Phone): the session name (or the project folder name), event types and timestamps, a question Claude is waiting on (its question, summary and buttons), and the last message of a finished Claude or Codex turn that you have not looked at. These texts stay in memory; none of them is written to disk.

## Phone

Off by default (Settings → Phone access). A small web server inside the dock listens on `127.0.0.1` only; a phone reaches it through **Tailscale** (`tailscale serve`: HTTPS inside your own tailnet, never the public internet; the dock never uses `funnel`). You need Tailscale on the computer and the phone, signed in to the same account, and HTTPS certificates enabled for the tailnet (Tailscale admin console → DNS).

1. Settings → Phone access → on. If Tailscale is ready, press **Publish to phone**.
2. Press **Pair a phone** and scan the QR code with the phone camera (a one-time code, valid 2 minutes). Add the page to the home screen.
3. One list of every conversation, newest first, each with its agent's logo and state (waiting for you, working, done); tap one to open it. Filter by agent with the chips on top, **Load more** goes further back. A question Claude is waiting on appears right in the list (and above the message box inside the conversation): answer it, send a follow-up or dismiss it (Claude with the plugin only, like the dock itself). Other agents can be watched, not answered.
4. Optional notifications, two ways (either or both). **On the phone page** press the bell: from then on that phone gets a notification when an agent waits for you or finishes, and tapping it opens that conversation. This is standard Web Push (no extra app, no address to paste): on an iPhone (iOS 16.4 or later) add the page to the Home Screen and open it from there first; on Android the browser works as it is (Chrome needs Google's push service, which phones without Google services do not have). The message text is only the agent's name and what happened ("Claude · Waiting for you"), never a question, a reply or a session title; it is encrypted for that phone and travels through the browser vendor's push service (Apple, Google or Mozilla), which sees that a message exists and which phone it is for. The key pair that signs the pushes is made on this computer (`~/.agent-dock/push-keys.json`) and the push service only learns this project's public address from it. Revoking a phone removes its subscription, and notifications work even when the phone's Tailscale is off (only opening the page needs it). **Or Bark:** paste your [Bark](https://github.com/Finb/Bark) address in Settings; the same short text, plus a link made of your tailnet address and the conversation's id, goes through the Bark server in the address (`api.day.app` unless you run your own), a third party. At most 6 notifications a minute are sent either way.
5. Optional, off by default: **Chats from the phone** (Settings → Phone access → Chats). The list then holds your recent Claude Code, Codex, OpenCode and Grok conversations; open one to read the whole conversation (your messages, the replies and one line per tool call) and keep writing in it, or press **New** (top right) to pick an agent and start one in a folder you added on this computer (Add folder). Claude, Codex and OpenCode can be written to; Grok is history only for now (its headless mode could not be verified here). For every message you can pick the model and the thinking level from the lists this computer offers (Claude: Fable, Opus, Sonnet, Haiku and its effort levels; Codex: the models and levels from your Codex install; OpenCode: the `provider/model` list from `opencode-cli models` and its `medium` / `high` variants). Each message runs a headless `claude -p`, `codex exec` or `opencode-cli run --standalone` on this computer, resuming the same conversation (at most 4 at once, one hour each) and Stop ends it.
   - **Permissions.** By default a Claude chat gets only the file tools (read, edit, write, search: no commands, no MCP servers), a Codex chat runs in Codex's read-only sandbox, an OpenCode chat runs its read-only `plan` agent with the folder's own `opencode.json` and plugins switched off, and conversations stay inside the folders you added. The separate switch **Full permissions (no prompts)** removes all of that: a chat can then do anything the agent can do on this computer, in any folder, and nothing asks first. It exists only on this computer (the phone cannot turn it on) and turns itself off when Chats is switched off. Turn it on only if you trust every paired phone, because a paired phone can then run anything as you.
   - **A conversation that is open on this computer** (a live Claude process with that id, or a transcript changed in the last 3 minutes) is not written to by the dock at the same time: a message then continues in a copy (Claude: `--fork-session`; Codex: `codex exec fork`) and the phone switches to it. Because Codex and OpenCode show no process, every Codex or OpenCode conversation the dock did not start itself is continued in a copy the first time (`--fork`); after that the copy is continued in place for as long as the dock runs. Your own finished phone turns do not count as someone else writing.
   - **Privacy.** Chats send the full text of conversations, tool call lines included, to every paired phone, and tool output can contain keys or personal data. Reading needs the Tailscale HTTPS address like every other action. OpenCode conversations are read from its database (read-only), Grok ones from `~/.grok/sessions`. Without full permissions Claude runs in restricted mode (it ignores settings files and cannot write settings or git configuration) Codex cannot write at all, and OpenCode's plan agent is read-only, but a Claude chat can still change ordinary files inside the allowed folder, including scripts you may run later: add only folders you are comfortable with. The phone also sees the names and full paths of the allowed folders. "Stay inside the folders" is about where a chat works, not a promise that an agent cannot read elsewhere: OpenCode's plan agent may still read other files and fetch web pages, so text planted in a folder you added could try to make it send something out; keep untrusted content out of the folders you add.
   - Only the newest conversations are listed (Codex: the last 90 days). A conversation is continued in the folder its transcript says it was started in.

How it is protected: every request needs a device token made by pairing (only a hash is stored in `~/.agent-dock/phone.json`); the token is bound to the Tailscale login it first used (checked whenever `tailscale serve` supplies the login header); the `Host` header must be this computer's tailnet name or the loopback address with the dock's port (this blocks other web pages, including DNS-rebinding ones, from reaching the server); anything that changes something (answer, dismiss, send, start or stop) and every conversation read is refused unless it arrived through `tailscale serve` with a matching `Origin`; a code works once and wrong guesses are rate limited. The phone names a conversation only by an opaque id that the dock looks up in its own index of transcripts: a file path or a working directory from the phone is never used, models and effort levels are only accepted from the computer's lists, and the page puts transcript text into the screen as plain text. You can revoke one phone or all of them in Settings. Publishing takes over HTTPS port 443 of this computer's tailnet name (the dock refuses if something else already uses it, and never uses `funnel`); turning Phone access off stops the server and unpublishes the address, but if the dock quits or crashes while it is on, the published address stays until you run `tailscale serve --https=443 off` or start the dock again and turn it off. Not built yet: approving tool permissions from the phone (a chat with Full permissions off cannot ask; it simply cannot do those things).

## Configuration

| Setting | How |
| --- | --- |
| Agents, always on top, launch at login, language | Settings (sliders button) |
| Data folder | environment variable `AGENT_DOCK_DATA` |
| Save a screenshot whenever the set of states changes | environment variable `AGENT_DOCK_SHOT_DIR` |
| Phone access, chats, Bark address, allowed folders | Settings → Phone access (stored as `phone` and `bark` in `config.json`) |
| Demo data | `npm run demo` |

## Development

```powershell
npm test                                   # reducers and readers, with an injected clock and file system
npx electron scripts/render-svg.js assets/logo.svg assets/icon-512.png 512   # render the logo (needs Electron, not plain node)
```

```text
main.js        window, tray, resize, settings, polling
sources.js     Claude Code and Codex readers, per-agent summary
agents.js      the other 25 agents: paths, programs, working/done rules
index.html     the whole interface: 27 mascots, layouts, settings, English and Chinese
preload.js     the few calls the page may make
scripts/       logo rendering, screenshots, shortcut creation
test/          node:test suites
```

## Roadmap

- Verify more agents' paths on real machines, and report Waiting where an agent exposes it.
- Answer Claude's tool-permission prompts and AskUserQuestion questions from the dock.
- Optional sound or toast when an agent starts waiting for you.

## Credits and license

The layout idea, the one-bot-per-agent concept and the table of where agents keep their files come from
[jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open) (Apache-2.0), which is a much larger project
for macOS, Windows and Linux with quotas, approvals, a phone app and more. This project is a small Windows-only take on its
simplest mode, written from scratch; no code or image assets were copied. See [NOTICE](NOTICE).

Agent names and colours belong to their owners. The mascots are original drawings, not official logos.

Licensed under the [Apache License 2.0](LICENSE).

<sub>Suggested GitHub topics: `windows` `electron` `desktop-widget` `hud` `ai-agents` `coding-agents` `claude-code` `codex` `opencode` `cursor` `gemini-cli` `github-copilot` `developer-tools`</sub>
