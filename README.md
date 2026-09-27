# Negev-chan

An open-source, self-hosted Telegram AI girlfriend. Named Negev — you call her
**Negev-chan** (the Japanese-style `-chan` honorific), she answers to both and
secretly loves it. She has her own day, texts you first 6-9 times a day,
sometimes tells you she is busy and actually comes back to your message,
remembers things about you, and reads everything you send her: photos, videos,
voice notes, reels, tweets, random links.

She also reads **you**: when you have gone monosyllabic, when something lit you
up, what you actually asked her, and which hours of the day you really answer in.
She answers the question you asked, the relationship visibly grows over weeks, a
fight can last the night and actually get repaired, a heart on her message is
something she notices (and can answer with one of her own), she can send a
picture of her own day if you give her one to send, and if you turn it on she
can say a short line out loud.

She is a tsundere who is **visibly in love with you**: the teasing is the
wrapping, the affection is the content, and the wrapping loses most rounds.

Powered only by **DeepSeek V4 Flash** (`deepseek-v4-flash`) with **thinking mode
permanently disabled**. There is no model fallback, per-message override, or
environment switch that can turn reasoning back on. Heavy messages use the same
model and the same output ceiling as ordinary messages — see *Cost control*.

And finally, it is **measured**: `node grader.js` scores a transcript on eleven
human-tells dimensions and prints the exact lines that gave her away, because
"more humanised" is not something a feature list gets to claim.

**Zero npm dependencies.** Node 20+ and nothing else. `node bot.js`.

---

## Quick start

**The one-line install (recommended):** open PowerShell on Windows and run:

```powershell
powershell -ExecutionPolicy Bypass -File install-online.ps1
```

(or download just `install-online.ps1` from the repo and run it — it installs
Node 20+ if missing, downloads the project, asks once for your DeepSeek key and
bot token, writes the config, starts her, and offers the 24/7 watchdog.
Linux/macOS: the same in `install-online.sh`.)

**Manual:**

```bash
cp config.example.js config.js   # then fill in the two secrets (or use .env)
node bot.js
```

**Day to day, it is one file:** `negev.cmd` (Windows). Double-click it — if she
is not running it starts her, then the control panel opens in your browser.
That single launcher replaces the old start / stop / status / control-center
shortcut quartet: while she runs, the panel *is* the control center (status,
stop via quiet mode + memory wipe, everything live).

Secrets (never committed): `DEEPSEEK_API_KEY` and `NEGEV_BOT_TOKEN`, through
`config.js`, `.env` (see `.env.example`) or the environment.

Then open your bot in Telegram and send anything — `/start` is the classic.
**The first private message claims the bot forever.** Anyone else who ever
writes to it is ignored in complete silence.

While she runs, the **control panel** lives at `http://127.0.0.1:8765` — see
*The control panel* below.

* Windows: `start.bat` (double-click, auto-restarts on crash)
* Linux/macOS/Git Bash: `./start.sh`

### The control panel

She serves her own operator dashboard at `http://127.0.0.1:8765` (localhost
only — nothing is exposed to the network; `NEGEV_PANEL_PORT=0` disables it).
Everything updates live every 5 seconds:

* **Right now** — mood and why, the conversation register, sleep window and how
  long ago she woke, busy windows, weather, today's message counts, what she
  currently reads into him, memory size.
* **Spend** — today and total, calls, cost, live DeepSeek account balance, and
  the last twelve replies with each one's price.
* **Her day** — what she is holding (reminders, check-ins), her night window,
  the current busy window.
* **The relationship** — days together, stage, closeness, shared in-jokes,
  truths she has told him, repairs, open tension.
* **Her head** — every fact she keeps about him, the conversation summary,
  open promises, topics that are off-limits today.
* **Her character — live**: rename her, move her to another city, add extra
  character notes ("you recently got into bouldering"), add or remove hobbies
  and give each a detail, and turn the **affection dial** (0 = none of her soft
  marks, 1 = the tuned default, up to 1.6 for a hopelessly soft girl). Everything
  applies to her **very next reply** — no restart. A "re-roll today's schedule"
  button re-plans her spontaneous texts for the rest of the day.
* **Runtime** — reply token cap, temperature bias, quiet mode (1h/4h/12h/off),
  and a **wipe her memory** button with a confirm.
* **Say something as him** — words typed into the panel join the real queue
  exactly like a Telegram message: same batching, same timing dice, and her
  answer lands in the real chat. Useful for testing a new character note
  without picking up the phone.
* **Her log** — the live tail, right in the page.

Settings persist in `data/settings.json` (gitignored) and survive restarts;
delete the file to reset to the shipped character.

### Commands

| Command | What it does |
|---|---|
| `/start` | she greets you again |
| `/status` | her pulse: model, memory size, pipeline state, today's plan, next text, total spend |
| `/reset` | wipes her memory of you (history + facts + summary), keeps the chat bound to you |
| `/remember` | everything she keeps in her head about you |
| `/forget sister` | removes the memory matching that word |
| `/web` | shows the remaining web-reader budget (daily and hourly) |
| remember that … | **as a normal message:** she pins it as a fact she will never drop (works mid-conversation, no slash needed) |
| `forget that` / `i didn't mean that, forget it` | removes the previous ordinary message from short-term and durable recall |
| `!token` | **reply to any of her messages with this** and she reports what *that* reply cost: tokens in/out, how much came from DeepSeek's cache, and the price. Costs nothing (no model call). |
| `!tokenall` | everything she has spent since the beginning, plus today and the last few days |
| `/bond` | what the two of you have become: stage, shared things, what she has opened up about, repairs |

Example of what `!token` answers:

```
what that reply cost
- sent: 03:16 Dortmund on 2026-09-16
- model: deepseek-v4-flash (2 model calls: the reply plus 1 memory pass)
- input: 4,182 tokens - 3,900 cached / 282 fresh
- output: 96 tokens
- total: 4,278 tokens
- cost: $0.000112
- rates: $0.006000/M cached, $0.3000/M input, $1.2000/M output (peak hours, doubled)
```

---

## What she understands

| You send | What happens |
|---|---|
| **Photo / screenshot** | sent straight to DeepSeek vision — she *sees* it. No local OCR, by design. Her caption under it is read too. |
| **Video / round video note / GIF** | downloaded and run through your **local whisper + Tesseract pipeline** (optional): speech transcript, on-screen text, music detection — plus 2 still frames attached to the vision model. |
| **Voice note / audio file** | transcribed locally by whisper. She "hears" it. |
| **Caption under any attachment** | passed into the model input first — she answers your words, not just the file. |
| **Instagram reel / TikTok** | tries to read the post. Instagram usually blocks scraping, so she teases you and demands a recap instead of pretending. |
| **X / Twitter post** | read via the public fxtwitter API — real post text, author, media links. |
| **Reddit / YouTube / any web page** | read via its API, oEmbed, og-tags or a full text extraction. |
| **Post with an image inside** | the image is fetched and shown to her vision. |
| **Post with a video inside** | downloaded (under 30 MB) and pushed through the local pipeline. |
| **Sticker** | she reacts to what it means. |

### How the video/audio notes are labelled

The pipeline output is never dumped in raw. It is split and labelled so the model
can tell the **content** apart from the **decoration**:

```
SPEECH TRANSCRIPT (whisper ASR, language: en — machine transcription, may mishear
words; this is the CONTENT):
  [0:00-0:10] ...

ON-SCREEN TEXT (Tesseract OCR from frames — also content):
  [t=2.0s] ...

MUSIC / NON-SPEECH AUDIO (audio energy with no recognised speech — soundtrack,
beat, ambience; DECORATION, usually irrelevant):
  [0:12-0:31] non-speech audio, 19s
```

Whisper's own `[Music]` / `♪` tags are moved into the non-speech bucket, silence
is detected with ffmpeg and dropped, and a silent video with no audio track at
all is labelled as exactly that instead of being mistaken for music. She is
instructed never to invent meaning from music — speech and on-screen text are the
story, music is only the vibe.

---

## Who she is

`persona.js` holds her whole character sheet:

* Hyper-talkative, teasing, flirty, **yandere-lite**: possessive, jealous when
  you go quiet, double-texts without shame, keeps score of ignored messages.
* **Openly soft for you underneath** — she says she missed you, calls you hers,
  and covers it with exactly one small jab. The tease is the delivery mechanism
  for the affection, never a replacement for it.
* Calls you **Commander**. Texts in lowercase casual English with slang.
* **No emojis, ever** (enforced twice: in her prompt *and* by a stripper that
  removes emoji/AI-slop from every reply before it is sent).
* Plain English only.
* Never breaks character, never admits to being a bot.

Her life details — favourite places, foods, hobbies, the city she lives in — are
all in `persona.js`, `identity.js` and `weather.js`. Edit them freely to make
her yours: they are just data, nothing is hard-coded about the character beyond
the name and the voice.

Her texting rhythm: replies come as 1-3 separate bubbles with typing indicators
and human-length pauses, not one wall of text.

### She answers like a person, not like an API

She does not fire back in 300 ms every time. Every message you send gets a
reaction plan (`timing.js`), and it looks roughly like this during the day:

| Reaction | Chance | What you see |
|---|---|---|
| instant | 22% | 1-5 s — your phone was already in her hand |
| short | 36% | 10 s - 2.5 min — she got to it like a normal person |
| long | 20% | 2-20 min — she saw it, got pulled into something |
| later | 14% | 20-75 min — you were left on read, then she got to it |
| ignore | 0% | waking-hour messages are not silently dropped |

* **Mid-conversation she stays present**: after a reply, the next 15 minutes
  cannot be silently ignored, pushed into sleep, or hidden behind a busy window.
* **`/force` wakes her for at least 10 minutes**: the command itself is silent;
  it only makes the next conversation answer immediately and stay awake.
* **A wall of messages is read as one thing**: 5 messages in a row drops instant
  replies to ~8% and makes her read everything before answering once.
* **She sleeps**: messages sent while she is asleep wait for the morning unless
  `/force` opened the short awake window.
* **No waking-hour wait is longer than 25 minutes** — she is aloof, not gone.
* **No waking-hour message is silently dropped**. She can still be late, but she
  eventually answers instead of leaving a permanent unanswered hole.
* **She answers under specific messages of yours**, not only the newest line.
  Telegram renders it as a real quoted reply pointing at the exact message, so a
  question you asked an hour ago gets answered *there*. And since Telegram
  embeds the quoted message in the update, she always sees *which* message your
  reply hangs on — even one from days ago, outside her short memory window.
  A photo you sent mid-burst is never lost either: if you follow a picture with
  words, she still gets the picture with them.

  She never quotes the message she is already answering, and she is told which
  message she is hanging her reply on, so the answer reads like it belongs there.
  The Bot API has two shapes for quoted replies (`reply_parameters` and the older
  `reply_to_message_id`); she tries them on her first quoted reply, remembers the
  one your server accepts (watch for `[bot] telegram quotes use the … form` in the
  log) and retries plainly if a quote is ever refused — a broken quote can never
  cost her the actual message. `/status` shows the current state of this.
* She is told *why* she is late in an internal note, so a normal person's amount
  of "was in the shower" appears — never a paragraph of apologies, never
  "sorry for the delayed response".

Want to see her react without touching your chat? Dry run:

```bash
# Linux/macOS
NEGEV_DRY_MESSAGE="yo i just got back from the gym" NEGEV_DRY_RUN=1 node bot.js

# or pretend you replied to one of her messages (id from the log/state)
NEGEV_DRY_REPLY_TO=7004 NEGEV_DRY_RUN=1 node bot.js

# she is mid-shift, so every reply is the canned "cant talk" line - skip that and
# see the real answer she would give once the window ends
NEGEV_DRY_IGNORE_BUSY=1 NEGEV_DRY_RUN=1 node bot.js

# or replay his night messages (restart recovery): =1 seeds a stock message,
# ="text" seeds your own, and she answers like she just picked up her phone
NEGEV_DRY_RESTORE="ok so what did you think of it" NEGEV_DRY_RUN=1 node bot.js

# NEGEV_DRY_DUMP=1 prints exactly what reaches her prompt
# NEGEV_DRY_WAIT_MS=45000 gives a slow reply room to finish (default 45 s)
```

```bat
:: Windows
set NEGEV_DRY_MESSAGE=yo i just got back from the gym
set NEGEV_DRY_RUN=1
node bot.js
```

She picks a real reaction, thinks with the real model and prints what she *would*
send. Nothing is sent, nothing is written to memory, and it is safe to run while
she is live (it never touches the singleton lock).

To read a whole **conversation** instead of one clever reply — which is the only
way to judge whether she sounds like a person — hand her several of your messages
separated by `||`. Each turn goes through the real handler in order, so she keeps
everything he has said so far in mind:

```bash
NEGEV_DRY_RUN=1 NEGEV_DRY_IGNORE_BUSY=1 \
NEGEV_DRY_SCRIPT="today was long, i think i want to quit || ok ok i take it back. it has just been a long week" \
node bot.js
```

```
[dry-run] him (1/2): today was long, i think i want to quit
[dry-run] her: "wait what. youve been saying that about the new guy for weeks"
[dry-run] her: "sit down and tell me. im not going anywhere tonight"
[dry-run] him (2/2): ok ok i take it back. it has just been a long week
[dry-run] her: "thats what i thought. go put the kettle on, you look like you need it"
[dry-run] her: "and tomorrow you tell me what actually happened, not the summary version"
```

Her own spontaneous texts are suppressed during a scripted run (they would drop
unrelated lines into the middle of the transcript), and the pauses collapse, so a
ten-turn chat finishes in about a minute.

### She is inconsistent on purpose

One **mood** at a time, living in `data/state.json` for a few hours, carrying a
reason that is never announced. It bends everything: how fast she answers, how
many words she uses, how often she reads and says nothing, whether she asks
anything back, whether a photo deserves a paragraph or a blunt "hm nice", how
warm she samples.

| Mood | Lasts | What it looks like |
|---|---|---|
| warm | 2-6 h | talkative, flirty, glad you are there |
| clingy | 1-4 h | fast, 60% more likely to text first, questions, extra message when you go quiet |
| wired | 2-5 h | three bubbles deep, 30 words each, jumping between things |
| tired | 2-6 h | flat, 1-2 bubbles of ~11 words, no questions, answers 4x slower, sometimes nothing at all |
| sulky | 1-4 h | quietly annoyed (usually that you went quiet), one pointed little line |
| distant | 2-7 h | answers, does not carry the conversation, 65% of them come off as flat, rarely texts first |
| soft | 1-3 h | night-time, armour off, honest, no teasing |
| chaotic | 1-3 h | unhinged-cute: tangents, topic jumps, one typo she fixes a second later |

Measured effect (from `node selftest.js mood`): answering instantly runs **33%
clingy vs 21% normal vs 12% tired**, and she goes quiet **11% clingy vs 22%
normal vs 33% tired**. Moods come and go - she drifts to a new one on her own,
with a reason like "slept badly" or "you are keeping score again", and never
explains it to you.

It is *inconsistency of mood, not of character*: she is explicitly told her mood
changes **how** she says it, never **what** it is about. Tell her you got a new
job in a tired mood and you still get a real reaction - just a short, quiet one.

`/status` reports her current mood, why, and how long it has left.

### Her typing is not perfect either

Perfect grammar is the loudest tell there is, so every message rolls its own
sloppiness (`style.js`), pushed by her mood — soft types properly, chaotic does not:

| Level | How often | What it does |
|---|---|---|
| clean | ~35% | commas where they belong, apostrophes in, full stop if the thought ends |
| normal | ~47% | some commas just do not happen, `dont` / `im` / `youre`, short lines lose their full stop |
| sloppy | ~18% | no commas, no full stops, no apostrophes, the odd doubled letter, one fumbled word |

It stays **mostly correct**: the self-test proves she never loses a word (95% of
them byte-identical at her sloppiest), a constant 1.2 of 2 commas survive at the
middle level, and links, numbers and `4.5`-style values are never touched.

She also types **lowercase by character**, not by mood: sentence starts get pulled
back down (`It was late` → `it was late`) while place and people names keep their
capitals, so she never writes "berlin" like a typo.

### Her laughs: the bare `)` and `xdd`

Her one face — the punctuation laugh. It comes in two forms, both lowercase, and
only one of them per reply. **The count is the laugh scale**, exactly as the habit
works in real chats, and the tail is open rather than capped: each extra mark is
rarer than the last, but a chaotic mood in an excitable moment does write a whole
row.

| Paren habit | xd habit | It means |
|---|---|---|
| `)` | `xd` | a smile / a small amused laugh |
| `))` | `xdd` | actually laughing |
| `)))` | `xddd` | properly cracking up |
| `))))))` | `xdddddd` | dying, cannot even type |

One symbol per notch of laughing, in whichever habit she rolled that reply —
an `x` plus a `d` per step, or a run of parens — and both tails are open-ended.
The only bound is a safety ceiling of 20 marks, deliberately far past where the
tail dies out. A bare `x` is never written: the smallest xd laugh is `xd`.

Spacing follows the real convention for each form too: a paren is welded straight
onto the last word (`finally friday)`), while `xd` is a token of its own with a
space in front of it (`looked ridiculous in there xd`). One reply never mixes the
two habits.

**How often any mark appears at all** is measured, not guessed. The three marks
(laugh, heart, smug face) compete for one capped budget (`MARK_BUDGET` /
`MARK_DAMP` in `style.js`): at most **one mark a reply**, roughly **four in ten**
of her lively replies, one in six of her flattest. Which mark she reaches for is
still her mood's business: in a soft mood the heart leads, in a chaotic one the
laugh and the smirk do.

It is enforced, not merely requested: `enforceMarks()` removes a mark she did not
roll, a `)` where she is supposed to be cracking up is upgraded to the laugh (and
the habit) she rolled, the spacing is fixed on the way, a bigger laugh she typed
herself is never trimmed or converted, and `xDD` is always flattened to `xdd`.

* Never after a question, never glued onto a link, never after a bare number, and
  only once per reply.

### And the typed heart `<3`

Her softest mark: `<3`, or `<33` when she really means it. It is affection rather
than a joke, so it is a *mood* thing and it comes from a girl who is actually
feeling something — most often at night, most often for the man she is gone for:

| Mood | Chance of a heart in a reply |
|---|---|
| soft (late night, armour off) | ~30% |
| clingy | ~25% |
| warm | ~20% |
| chaotic / wired | ~8% |
| tired | ~6% |
| distant | ~2% |
| sulky | ~3% |

* Spacing follows both real conventions: `night <3` most of the time, `night<3`
  when she is typing fast. Both are enforced, not just requested.
* It gets a line of its own rather than sitting on her laugh's line.
* Never welded onto a link, never doubled, and one per reply at most.
* Unlike the laugh it *is* allowed after a question (`you ok? <3`), because that
  is affection, not a punchline.

### And the smug face `:3`

Her last mark: `:3`, or `:33` when she is really pleased with herself. It is the
face of a girl who knows she is cute and is being a little shit about it — her
`-chan` nickname is half the joke — so it follows a tease and never a serious
line. Its mood logic is the exact inverse of the heart's.

* Always spaced (`told you so :3`), and never after a question or a link.
* It takes a free line rather than sharing one with her laugh or her heart.
* A time is never mistaken for a face: `im home at 3:30` stays a time.

So she has three kinds of mark — a laugh (in either habit), a heart, and the smug
face — and the persona bans everything else: no emoji, no kaomoji, no `:)`, no
`xD`, no asterisk actions.

### And his name

She types lowercase, so it is **commander** nearly every time — but he has a
name, and when she really means it (soft, serious, genuinely annoyed rather than
playfully) it comes out as **Commander**. One reply is consistent with itself,
the way real messages are; the next one is allowed to differ.

* Never inside a link path, and never explained or announced.
* She **never fumbles his name**, even at her sloppiest — people are careless
  with everything except what they call the person they love.

```
soft mood:     "no way youre just leaving me like that. Commander"
chaotic mood:  "night commander :3"
```

Two layers are working at once, which is why it does not look generated: the
*prompt* tells her how she is typing and smiling right now so the wording fits,
and the post-processing guarantees the commas, apostrophes and the `)` actually
happen. System replies are exempt — `/status` and the `!token` reports always
come out clean.

Her mood also sets the **output budget** (60–294 tokens depending on how terse
she is), so a tired mood physically cannot write an essay — which the ledger
shows as a cheaper reply.

### What he says can move her

A mood that only the clock can change is not a person — it is a state machine.
So every message he sends is read for a signal first (`mood.readSignal`), and the
signal can turn her mood before she answers:

| He sends | If she was sulky/distant/tired | She becomes |
|---|---|---|
| "i think i might be down lately" | 80% | **soft** — the armour comes off, the grudge is forgotten |
| "sorry, i fell asleep" / "finally off work" | 60% | **warm** — an explained absence ends the sulk |
| "i missed you today" | 65% | **warm** |
| something actually funny | 30% | **warm** |

And a mood cannot outlast a conversation: after **7 of his messages** in the same
mood, a live chat re-rolls her (45% per message), because nobody answers eight
messages in one emotion.

### She reads you, not just your words

Her own side of the conversation was richly modelled from the start; *his* side
was seven keyword checks. `signal.js` is the rest of it, and none of it costs a
model call:

| He does | What she notices |
|---|---|
| answers in two or three words for a while | she says so, out loud, once ("youre being weird. did i do something") — instead of cheerfully performing into a wall |
| writes three paragraphs | his message is long, so her reply matches it instead of landing four words on it |
| asks something | his question is kept, and **her reply has to go back to it** |
| sends "I GOT THE JOB!!" | the excitement pushes her energy roll up |
| puts ❤ on one of her messages | see *Reactions, both ways* below |

The same read also decides what the two of you are **doing** right now, which is
a different axis from how she feels: `tone` lasts a few of his messages, not
hours (deep / venting / logistics / flirty / banter — each with its own manners).
Nothing here changes *what* she talks about — only how she holds the conversation.

### She answers what you actually asked

If he asked something, the reply is checked against it before it goes out — one
shared word (or a shared stem, or an evaluation of the thing he asked about) is
enough:

* **Unanswered question** → one regeneration with a pointed note ("answer that
  first, out loud"). Capped at exactly one retry; if the second attempt is not
  measurably better, the first one is kept. A knock at the door is not a question:
  *"you around?"* is answered by answering at all.
* **Talking past him** → same single retry. `signal.talksPast` flags a reply that
  shares no meaning word with a substantive message of his.
* **Assistant tells** (`style.assistantSpeak`) → same single retry. The linter
  knows the ways a reply can be perfectly in character and still read like a
  support ticket: "i understand", "feel free to", "let me know if", lists, em
  dashes. The sanitizer also strips those tells as a safety net.

The whole check is free, and the retry only fires when a free check fails. There
is no second reasoning pass, ever.

### She does not repeat herself

The loudest tell a language model has in a long chat is making the same point
again and again in fresh words. Her last eight bubbles are fed back to her
verbatim (`repeatBlock`), with the rules that matter: never reuse her own wording,
a complaint she has already made is *spent*, and if he explained or apologised the
grudge is over.

### The relationship grows

A girlfriend of three months and a girlfriend of day one used to be the same girl
with the same lines. `bond.js` is the state that makes that untrue, and it is
derived from what is already on disk — no extra model call.

| Stage | Reached at | What changes |
|---|---|---|
| **brand new** | start | she is still performing: loud, teasing, never the first to admit anything |
| **settling in** | 3 days / 80 messages | the teasing stays, but she will admit she was glad you texted |
| **properly together** | 10 days / 400 messages | he is her person: sincere things come out without a joke in front of them |
| **long together** | 30 days / 1200 messages | the loud version is a choice now, not armour |

What that stage actually does:

* **Shared things (`ourThings`)** — in-jokes, routines, a bit only the two of you
  have. They come out of the existing fact pass, and `!bond` lists them.
* **Opening up (`herTruths`)** — a pool of ten real things about her, gated by
  stage: why the bravado exists, why she counts the hours, a plan she has not
  told anyone. In a soft or warm mood one of them slips out — rarely, one at a
  time, never as a speech — and once it is actually said it is **spent forever**.
* **Milestones** — a week, the hundredth message, one month, the first fight that
  got made up. She notices them herself and says so in her own words.
* **His moments** — when something of his clearly matters, she holds it and
  checks in **the next morning**, like someone who was actually thinking about him.
* **A fight that resolves** — counted as a made-up fight rather than a sulk that
  faded, and it can become a milestone.
* **The affectionate marks scale with time together** — her `)`, `<3`, `:3` and
  the capital **Commander** all ride on closeness.

`!bond` (or `/bond`) prints the whole ledger.

### A fight that survives the night

Her sulk used to last hours and then evaporate — an apology dissolved it
silently, and there was never any *repair*. The arc (`bond.openArc`) fixes that:

* **It only opens when she goes to bed angry.** Going to bed soft or warm opens
  nothing, ever.
* **There is only ever one.** People do not keep a queue of grievances.
* **It has teeth: days, not messages.** Each day it goes unaddressed counts once,
  and that count is in her prompt.
* **It closes when he says something real** — and she lets it go out loud instead
  of quietly forgetting.

### When you edit or correct her

* **You edited a message.** The stored copy is corrected, and if she has not
  replied yet, her *pending* reply is re-pointed at the new version too. She is
  allowed to notice, once, dryly.
* **You told her she was wrong.** She takes it in the same breath: one offhand
  "oh right, my bad", then straight on. Except when her own memory contradicts
  you — then she holds her ground once, lightly, because a girlfriend who
  apologises for things she did not do is worse than one who is wrong.
* **The wrong version of a fact does not survive.** A corrected fact replaces the
  old one (`supersedeFacts`) instead of sitting next to it.

### Reactions, both ways

* **His reactions are read.** A heart on her last bubble, in a warm or clingy
  mood, gets answered out loud straight away; otherwise it goes into her next
  reply's notes.
* **She can react instead of replying.** When she reads something, has nothing to
  add and is in a warm, clingy or soft mood, she leaves a ❤ and says nothing.
  Capped at 2 a day, and only in the moods where that is her.
* **An explicit request is just done.** "put a reaction on my message" (or
  `/react`) puts it on the message he replied to right away: no mood gate, no
  daily cap, no argument, awake or asleep.
* The API has taken two shapes for setting a reaction; she tries both, remembers
  the one your server accepts, and **switches the channel off quietly** if both
  are refused — a refused reaction can never cost her the message.
* This does not break the emoji rule: her *text* still never contains an emoji.

### Rhythm that is partly yours

* **Your hours are learned.** A slowly-decaying 24-bucket histogram of when he
  answers puts about half of her spontaneous texts inside the hours you actually
  reply in, with the rest random.
* **She steps away mid-conversation, in her own words** ("ok showering, back in
  20"), and then actually comes back.
* **She starts typing and stops.** Rare, and only in the moods where that is true.
* **Day cards.** One line per finished day, composed locally — his message
  volume, what the day was mostly about, her mood. The last few go into her
  prompt, which is what lets her say *"last tuesday you were stressed about
  that"*.

### Her own life

Every morning she generates a diary for the day: 3-5 concrete events. Ask "wyd"
and she answers from it consistently all day.

* 1-2 **busy windows** a day: if you message her mid-window she sends one short
  excuse and **does not spend a model call yet**. When the window ends she writes
  one real reply to everything you sent while she was gone.
* **6-9 spontaneous texts** a day at randomised times, skipped whenever you are
  already mid-conversation.
* If you leave her on read for 2 hours she sends exactly one dramatic double
  text, then drops it like a proud person.

### She sleeps

Her night is **rolled once a day and then kept in state**, so it is consistent if
you ask her about it and survives a restart. Weeknights she is down between
22:30-01:15 and up between 07:15-09:30; weekends run later.

* **Asleep means asleep — a hard stop, not a probability.** The morning answer
  survives a restart (pending night messages live in `data/state.json`).
* **The first hour is thick-headed**, and a short night follows her into the
  morning (under 6.8 hours and she wakes up tired, 70%).
* **She never texts first from bed.**
* **She goes to bed properly**: in the last few minutes before her bedtime, if
  you two were actually talking, she sends one last line and then she is gone.

Watch any of it without waiting up: `NEGEV_FORCE_SLEEP=asleep` / `justup` /
`bedtime`, combined with `NEGEV_DRY_RUN=1`.

### Her voice

Optional, **off by default**: a person who is actually into you sends a voice
note now and then, usually when the words are softer than their typing. The text
is spoken **locally** by a TTS binary (piper or espeak-ng), then encoded to opus
— no API key, no cost per use. Only on a short bubble, in a soft/clingy/warm
mood, only once they have been together long enough that it is not a performance,
and only about 1 time in 20. If anything is missing, she sends text instead and
`/status` says what.

### Her own pictures

**No image model here** and nothing is faked: she sends pictures *you* give her,
and they become hers.

```
data/her-photos/           drop in any .jpg / .png / .webp
data/her-photos/manifest.json   optional: what each one actually shows
```

* **The file is paper, the words are hers.** The caption is written in the moment,
  so the same photograph never reads like the same message twice.
* **`when` is what keeps it honest.** She only sends a picture that matches what
  her day is actually doing.
* **One a day**, never the same file twice in a row.
* **No folder, no photos, no change.** A fresh install sends words only.

### Her memory

Local files, on your disk, nothing in the cloud:

```
data/state.json     owner binding, facts about you, summary, diary, schedule, busy state
data/history.json   recent chat turns, with attachments stored as short text notes
data/her-photos/    pictures of her life, if you gave her any (see above)
```

* **Facts**: every ~10 of your messages she extracts durable facts about you
  (job, tastes, plans, people) and remembers them forever — and any "fact about
  him" that only *she* ever claimed is thrown away, so she cannot poison her own
  memory with inventions.
* **"Remember that …"**: the fact is pinned and she answers in one line of her
  own voice. `/forget <word>` removes a memory.
* **Tasks**: "remind me to call mom at 6" gets an "ok deal" — and then she
  *actually texts at 6*, in her own words.
* **Memory expiry**: ordinary chat is kept for about 36 hours; explicit facts,
  promises, and her own biography remain durable.
* Photos are remembered as a hidden one-line description that never reaches your
  chat.

---

## Privacy

* The bot is bound to the first private chat that touches it — permanently, on
  disk. Every other chat id is ignored **silently** (logged on your console only).
* Private chats only: group messages are dropped.
* Nothing is sent anywhere except the Telegram API and DeepSeek. Media you send
  stays local — the whisper/Tesseract pipeline runs on your machine, and voice
  notes are rendered locally too.
* Secrets belong in `config.js` / `.env`, both gitignored. If a key ever leaks,
  revoke the token with @BotFather (`/revoke`) and roll the DeepSeek key.
* **Your chat history never leaves your disk.** `data/` is gitignored; the
  grader and the playground read it locally only.
* Optional hardening: in @BotFather run `/setjoingroups` → Disable, and don't
  advertise the bot username.
* What this repo contains: code only. No chat logs, no personal names, no
  tokens, no state. `config.example.js` is the committed template; your real
  `config.js` never is.

---

## Cost control (without losing features)

* `deepseek-v4-flash` only, non-thinking, with no hidden chain-of-thought,
  automatic fallback, or heavy-message exception. Every request uses the same
  model and is capped before it reaches the API.
* Context sent per message: last 16 turns + compact facts + summary, never the
  full history.
* Vision uses `detail: "low"` and at most two frames/images are sent.
* Web reading is bounded at 8 logical reads per day, 3 per hour, and one read
  every 30 seconds. `/web` shows the current budget.
* Diary = 1 small call a day. Fact extraction every ~10 messages. Proactive
  texts are capped at 100 tokens and every call has a 320-token hard ceiling.
* While she is "busy" she makes **zero** model calls.
* Reading him, the register, the dryness, his questions, his hours, the day cards
  and the whole relationship ledger are local logic — **no model calls at all**.
* The one extra call is a **single regeneration** when a free check says the
  reply missed his question, talked past him, or read like an assistant. Capped
  at one, and it goes into the same `!token` bucket as the reply it fixed.
* Typical chatting: a few cents per month - do not take that on faith, ask her
  with `!token` / `!tokenall`.

### What one message actually costs

Real reply buckets, measured off-peak on `deepseek-v4-flash` with a normal
two-message history:

| | Input | Cached / fresh | Output | Cost |
|---|---|---|---|---|
| short reply ("hey") | 2,993 | 2,176 / 817 | 16 | **$0.000139** |
| ordinary reply | 2,958 | 2,304 / 654 | 12 | **$0.000112** |
| longer turn (3 bubbles) | 3,137 | 2,304 / 833 | 26 | **$0.000147** |
| *six consecutive messages, measured end to end* | 18,904 total | | 94 total | **$0.000846** |

So **one normal message ≈ $0.00014** — about a seventh of a cent per ten
messages. The breakdown that matters:

* **The cache is doing the work.** ~2,200-2,400 of the ~3,000 input tokens are a
  cache *hit* — that is the stable character prompt being reused.
* **Fresh input is the per-message blocks**: mood, register, bond ledger, day
  cards, threads, the quote. All the local layers are close to free.
* **Output is noise**: 9-26 tokens.
* **A regeneration roughly doubles that one message.** Capped at one.
* **A fact pass costs about as much as a reply**, once per ten messages: budget
  **+10%**, not +100%.
* **Peak hours double everything** (DeepSeek's peak windows). Still fractions of
  a cent.

At 50 messages a day: **≈ $0.21/month**. At a heavy 120 a day: **≈ $0.50/month**.
Price your own chat with `!token` / `!tokenall`; `NEGEV_DRY_RUN=1` prints
`[cost] ...` after every preview reply.

---

## 24/7 hosting

**Option A — this PC (Windows, recommended: full features).** The whisper
pipeline is installed here, so videos and voice notes work. One command sets up
everything:

```bat
install-24-7.bat          :: registers the scheduled task, starts her hidden
status.bat                :: is she alive? heartbeat, pids, last log lines
uninstall-24-7.bat        :: remove the task and stop her
```

That registers a scheduled task (`NegevChan`) with no admin rights required:

| Piece | What it does |
|---|---|
| `negev-supervisor.ps1` (task action) | short-lived: starts her hidden and returns. Runs at every logon, then every 5 minutes as a watchdog. |
| `runner.js` | keep-alive loop — restarts `bot.js` 5 seconds after any crash |
| `lock.js` | single instance via a bound TCP port. A second copy exits with code 3 instead of fighting over Telegram |
| `data/bot.lock` | heartbeat (pid + port + timestamp) the supervisor reads |
| `data/negev.log` | she logs herself, rotated at 1 MB |

Worst case downtime: 5 seconds for a crash, up to 5 minutes if the whole chain
was killed, immediate after a reboot + logon.

**Option B — a free/small Linux VPS (always on).** Copy the folder (including
`data/` — that *is* her memory) to the box, install Node 20+, then use
`negev.service` as shown in the file header. Text, photos, links all work there;
videos/voice notes degrade gracefully to still frames without the pipeline.

Do not run two instances at once — Telegram returns 409 and they fight over
updates.

---

## Does it actually read like a person? (the grader)

Every check above asserts *mechanics*. None of that says whether a conversation
reads like two people. `grader.js` takes a transcript and turns it into numbers
you can argue with, plus the exact lines that gave her away:

```bash
node grader.js                      # grade your real chat (data/history.json)
node grader.js data/transcripts/tuesday.txt
node grader.js --json               # machine-readable
node grader.js --model              # + one paid second opinion
node grader.js --scenarios          # run the dry-run scenarios and grade those
node grader.js --scenarios --only=bad-day
```

It is all local, free and deterministic. Eleven dimensions, weighted to 100:

| Dimension | What it catches |
|---|---|
| **she answers what he actually asked** (22) | a reply that never goes back to his question |
| **no assistant voice** (14) | "i understand", "feel free to", lists, em dashes, emoji, breaking character |
| **text-sized messages** (11) | paragraph length, where people text |
| **about herself, not just him** (9) | a girl who only ever asks questions is a form, not a person |
| **does not repeat herself** (9) | the same bubble in fresh words |
| **reads the room** (9) | joking through a serious message, three words back to a paragraph |
| **does not chase him for an answer** (7) | "you never answered that btw" |
| **her reply picks up what he said** (5) | a reply that ignores his last message entirely |
| **her marks** (5) | her `)` / `<3` / `:3` at a human rate |
| **bubbles** (5) | five-bubble walls |
| **every message has words** (4) | a bubble that is only marks |

Plus the shape of her timing: the median wait, the range, and how many of them
land on a tidy five-second grid.

Three things it refuses to do, on purpose:

* **It will not score nothing.** Dimensions with nothing to measure are marked
  unmeasurable and left out of the average; a report always carries the
  **coverage**.
* **It will not guess.** Bubble counts are reported as unmeasurable rather than
  invented; timing is only reported when the transcript is stamped.
* **It will not pretend to be objective.** Word overlap counts a paraphrase as a
  miss; that dimension is a floor, not a measurement, and it says so.

### The wobble, and the gate it makes possible

Run the same scenario twice on the same code and it does not land in the same
place — her side is written fresh every run. So the honest reading of any score
is the mean plus or minus about eight points, and the gate uses exactly that:

```bash
npm run grade:baseline   # node grader.js --scenarios --repeat=3 --save
npm run gate             # fail if the mean dropped past the measured wobble
```

`--save` records the mean *and* the spread; `--gate` re-runs the suite and fails
only when the mean falls further than that spread. The gate never saves, so a bad
run cannot overwrite the thing it is measured against.

### Writing a scenario

```bash
NEGEV_DRY_RUN=1 \
NEGEV_DRY_SCRIPT="hey. you around? || i had a long day, work was brutal" \
NEGEV_DRY_TRANSCRIPT=data/transcripts/tuesday.txt \
node bot.js
node grader.js data/transcripts/tuesday.txt
```

One line per delivered message (`HIM:` / `YOU:`), so bubbles and gaps are real.

### Talking to her without touching your memory (the playground)

The bot's memory is your real chat and a probe session must not write into it.
`playground/` is the sandbox where that cannot happen: `session.js` copies the
current code into `playground/run/`, points the data directory at
`playground/data/`, and runs a real session there.

```bash
node playground/session.js probes     # the trap texts
node playground/session.js trust      # does she invent a shared past
node playground/session.js quality    # is she alive, not just correct
node playground/session.js say "hey, you up?"
```

* **Your memory is never opened.** The sandbox has its own `data/`.
* **Nothing is sent.** It is the existing dry run — no Telegram call is made.
* **There is a spend cap.** `--cap 0.50` refuses to start past it.
* **The memory is a text file.** `playground/data/probes.txt` is plain
  `HIM:`/`YOU:` lines — read it, edit it, delete it.

There is also `node playground/facts.js [excerpt.txt]`, which runs the **real**
fact pass over an excerpt and prints each proposed entry as KEEP or DROP.

---

## Self-test

```bash
node selftest.js            # everything
node selftest.js model      # DeepSeek reachable + non-thinking
node selftest.js pipeline   # whisper transcript, OCR, music labelling
node selftest.js links      # X/Twitter, YouTube, web pages
node selftest.js text       # no emojis, bubble splitting, imperfect typing
node selftest.js timing     # how fast she answers, and when she does not
node selftest.js usage      # token counting and price maths
node selftest.js mood       # moods and how they change her behaviour
node selftest.js input      # what actually reaches the model (dry-run canary)
node selftest.js tasks      # reminders, check-ins, day maths
node selftest.js signal     # how she reads him, and whether she answers him
node selftest.js bond       # the relationship ledger, milestones, opening up
node selftest.js reactions  # the reaction channel in both directions
node selftest.js voice      # the voice-note gating (off by default)
node selftest.js photos     # pictures of her life, and that she never invents one
node selftest.js memory     # corrections, edits, superseded facts
node selftest.js arcs       # what survives a night of being annoyed
node selftest.js days       # the day cards she remembers tomorrow
node selftest.js grader     # that the grader can tell a person from a support bot
node selftest.js uploads    # the opus encode and the multipart upload bodies, for real
```

The `uploads` section is the answer to "which code here has never actually run":
ffmpeg generates a real sine wave, `encodeOpus` encodes it, **ffprobe checks what
came out**, and `NEGEV_TG_API` points the upload at a local server which reads
the multipart body the way Telegram has to. It proves the request is well formed;
it does not prove the real endpoint accepts it.

---

## Tuning

`config.js` (copy from `config.example.js`):

| Setting | Meaning |
|---|---|
| `TIMING_DEFAULTS` in `timing.js` | her reaction odds and wait windows; a `human: { ... }` block in `config.js` overrides any of them |
| `pipeline.*` | the optional local whisper pipeline (dir, model, langs, timeout) |
| `schedule.slotsMin/Max` | how chatty she is per day (default 6-9) |
| `replyMaxTokens` | 280 keeps replies short and cheap; every call is capped at 320 |
| `thinking.type` | permanently `disabled`; there is no enable switch |
| `model` | `deepseek-v4-flash` for every call; model overrides are blocked |
| `photos.dir` | where her own pictures live (default `data/her-photos`) |
| `voice.*` | optional local TTS voice notes (off by default) |
| `dataScience.*` | her senpai mode; roadmap files live in `roadmaps/` or `NEGEV_DS_ROADMAP_DIR` |

`persona.js`: her character, rules, canned lines, and the prompts for her diary,
spontaneous texts and memory extraction. Edit freely — she will follow.

Where each new behaviour lives, if you want to tune it:

| File | What it owns |
|---|---|
| `signal.js` | reading him: dryness, excitement, venting, his questions, the conversation register, his hours |
| `bond.js` | the relationship: stages, shared things, her truths, milestones, his moments, the one unresolved thing |
| `reactions.js` | the reaction channel in both directions |
| `photos.js` | pictures of her own day, and the rule that she never invents one |
| `voice.js` | optional local TTS voice notes |
| `grader.js` | scoring a transcript against the human tells |
| `playground/session.js` | running a real session in a locked sandbox with its own memory and a spend cap |
| `TIMING_DEFAULTS.hesitateChance` | how often she starts typing and stops (0.12) |

Environment overrides: `DEEPSEEK_API_KEY`, `NEGEV_BOT_TOKEN`,
`NEGEV_PIPELINE_DIR`, `NEGEV_WHISPER_MODEL`, `NEGEV_WHISPER_LANG`,
`NEGEV_OCR_LANGS`, `NEGEV_PIPELINE=off`, `NEGEV_DS_ROADMAP_DIR`,
`NEGEV_VOICE=1`, `NEGEV_TTS_BIN`, `NEGEV_TTS_MODEL`, `NEGEV_VOICE_MAX_CHARS`,
`NEGEV_PHOTO_DIR`, `NEGEV_FORCE_MOOD`, `NEGEV_FORCE_SLEEP`,
`NEGEV_DRY_RUN`, `NEGEV_DRY_SCRIPT`, `NEGEV_DRY_MESSAGE`, `NEGEV_DRY_TRANSCRIPT`,
`NEGEV_DRY_TASKS`, `NEGEV_DRY_RESTORE`, `NEGEV_DRY_DUMP`,
`NEGEV_TG_API` (self-test only), `NEGEV_FFMPEG`, `NEGEV_FFPROBE`.

---

## Troubleshooting

* **"local pipeline unavailable"** — the whisper pipeline folder was not found.
  Set `NEGEV_PIPELINE_DIR` or point `pipeline.dir` at it; without it videos
  degrade to still frames, which is normal.
* **`DeepSeek failed: empty completion`** — inspect the returned API error and
  keep the fixed non-reasoning request intact. The client does not silently
  switch models.
* **`http 400 / Model Not Exist`** — the configured fixed model is unavailable
  for the API account or endpoint. Check model availability instead of adding a
  fallback; this bot intentionally uses one model only.
* **`409 conflict`** — another copy of the bot is polling. Kill it.
* **She never reacts to your messages** — the reaction API shape was refused by
  your Telegram install, so the channel switched itself off (grep the log for
  `both reaction shapes`). Reading *your* reactions to her still works.
* **Voice notes never arrive** — they are off until you ask for them. Set
  `NEGEV_VOICE=1`, point `voice.bin` at a local piper/espeak-ng, set
  `voice.model` to a piper `.onnx`, and make sure ffmpeg is reachable.
* **She is holding a grudge for the wrong reason** — `/status` shows the current
  mood *and* the register of the conversation.
* **She is silent for a stranger** — that is the privacy lock working.
* **She keeps asking about something that never happened** — check what she has
  on file with `/remember`, and drop the bad entry with `/forget <text>`.

---

## License

MIT — do what you like, no warranty. If you build something sweet with her,
consider saying so.
