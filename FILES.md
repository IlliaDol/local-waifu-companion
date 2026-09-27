# Negev-chan — what everything does

A private Telegram AI girlfriend bot. Node 20+, zero npm dependencies, one fixed
model (`deepseek-v4-flash`, thinking permanently off). She texts like a person:
she has moods, sleeps, has her own day, remembers you, and the relationship grows.

## Core

| File | What it does |
|---|---|
| `bot.js` | The whole bot: polls Telegram, reads your messages, builds her prompt, sends replies in 1–3 bubbles with human timing. Also `/status`, `/reset`, `/remember`, `!token` etc. |
| `panel.js` + `bot-internals.js` | Her localhost control panel (127.0.0.1:8765): live status, spend, memory viewer, character editor, affection dial, quiet mode, log tail, operator chat. |
| `settings.js` | Live runtime settings (`data/settings.json`): her name/city/extra character notes, hobbies, affection level, proactive slots, quiet mode, token cap — applied without a restart. |
| `persona.js` | Her brain: character sheet, system prompt, style rules, canned lines, prompts for diary / proactive texts / fact extraction. |
| `config.js` | All settings: model, timing, pipeline, photos, voice, schedule. Copy `config.example.js` — the real one is gitignored (secrets). |
| `deepseek.js` | DeepSeek API client — one non-thinking vision model, network retries, usage reporting. |
| `util.js` | Small shared helpers, Berlin-time clock, logging to `data/negev.log`. |
| `dotenv.js` | Loads `.env` (secrets never live in source). |
| `memory.js` | Her memory, all in `./data`: owner binding (first chat claims the bot forever), chat history, facts about you, promises, summary, day stats. |

## Being a person

| File | What it does |
|---|---|
| `mood.js` | One mood at a time (warm / clingy / tired / sulky / soft / chaotic…) for a few hours; bends her speed, length, warmth. Your messages can shift it. |
| `sleep.js` | Her nightly sleep window, rolled once a day and kept in state; messages at night wait for morning. |
| `timing.js` | When she answers: instant / a few minutes / later / never-silently-dropped. No reply faster than a person would. |
| `signal.js` | Reads **you** for free: monosyllabic? venting? asked a question? excited? Also learns the hours you actually reply in. |
| `style.js` | Imperfect typing: sloppiness levels, lowercase, her marks — bare `)`, `xd`, `<3`, `:3` — at human rates, emoji and assistant-speak stripped. |
| `identity.js` | Fixed facts of her life (favourites, hobbies, places) so her story stays consistent. |
| `weather.js` | Real Dortmund weather from open-meteo, so "got soaked walking to the gym" checks out. |
| `bond.js` | The relationship as state: stages (new → long together), shared in-jokes, her secrets that slip out once, milestones, fights that get repaired. |
| `proactive.js` | Her own life: morning diary, 6–9 spontaneous texts a day, busy windows with one real reply after, one dramatic double text if ignored. |
| `tasks.js` | Reminders and check-ins: "remind me at 6" → she texts at 6; a pinned fact with a day → she asks about it that day. |
| `reactions.js` | The ❤ channel both ways: she sees your reactions and sometimes answers a message with just a heart. |
| `photos.js` | Sends pictures **you** drop into `data/her-photos/`, captioned fresh each time; never invents images. |
| `voice.js` | Optional local TTS voice notes (piper/espeak + opus). Off by default. |

## Understanding what you send

| File | What it does |
|---|---|
| `media.js` | Photos go straight to the vision model; video/voice run through the local whisper + Tesseract pipeline (speech transcript, on-screen text, music labelling). |
| `links.js` | Reads X/Twitter, Reddit, YouTube, Instagram, TikTok and any web page you send. |
| `data-science.js` | Lets her teach from your data-science roadmap files (drop them in `roadmaps/`), indexed locally so it stays cheap. |

## Money & quality

| File | What it does |
|---|---|
| `usage.js` | Cost ledger per reply from real API usage; `!token` / `!tokenall` print exactly what she spends. |
| `grader.js` | Scores any transcript on 11 "does this read like a person" dimensions, free and local; also the regression gate. |
| `selftest.js` | Offline test suite for all of the above (moods, timing, typing, pipeline, uploads…). |
| `playground/` | Sandboxed sessions with their own memory and a spend cap — talk to her without touching your real chat. |

## Keeping her alive

| File | What it does |
|---|---|
| `lock.js` | Single instance via a bound TCP port — a second copy just exits. |
| `runner.js` | Keep-alive loop: restarts `bot.js` 5 s after a crash. |
| `start.bat` / `start.sh` | Launchers (Windows / Linux-macOS). |
| `negev.cmd` | The one-click entry point: starts her if needed, then opens the control panel in the browser. Replaces the old start/stop/status shortcut set. |
| `install-online.ps1` / `install-online.sh` | One-file installers: Node 20+ if missing, project download, key prompts, config, first start. |
| `install-24-7.bat/.ps1`, `uninstall-24-7.*` | Register/remove the `NegevChan` scheduled task for 24/7 on this PC. |
| `negev-supervisor.ps1`, `negev-hidden.vbs` | The watchdog the task runs; hidden windowless launcher. |
| `status.bat` | Is she alive? + last log lines. |
| `stop-negev.bat/.ps1`, `start-negev.bat` | Turn her off (stays off) and back on. |
| `negev.service` | systemd unit for hosting on a Linux VPS at `/opt/negev`. |
| `githooks/` | pre-commit / pre-push guards so secrets can never be committed. |

## Her data (`data/`)

`state.json` (facts, diary, schedule, mood, costs), `history.json` (recent chat),
`her-photos/` (pictures of her life you gave her), `negev.log` (rotated at 1 MB).
Everything stays on your disk; only Telegram and DeepSeek ever see network traffic.
