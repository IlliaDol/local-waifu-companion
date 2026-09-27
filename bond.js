// The relationship itself, as state rather than an adjective.
//
// Her mood lasts hours and her personality never changes - which is a flaw nobody
// names out loud: a girlfriend of three months and a girlfriend of day one were
// the same girl with the same lines. Real intimacy accumulates. It has a
// beginning ("you are still performing for him"), it has things that are OURS now
// (an in-joke is ownership, not a fact), it opens up slowly about who she is, it
// notices milestones without a calendar app, and it remembers that he was having a
// bad week and asks the next day.
//
// Everything here is derived from what already exists on disk (boundAt, the
// message and media counters, her own canon) plus two small ledgers that the
// existing fact pass fills in for free. No extra model call, no second prompt:
// the intimacy is in the timing, not in the adjective count.
//
// Pure functions over a state object, like mood.js and signal.js: the caller owns
// the clock and the saving.

const DAY = 86400000;

/**
 * The four stages, with the one thing each of them actually changes: how much she
 * performs. Everything else (length, timing, marks) stays hers.
 */
export const STAGES = [
  {
    n: 1,
    key: "new",
    label: "brand new",
    appreciation: "you are still performing for him. Loud, teasing, never the first to admit anything, and every soft line gets covered up right after",
  },
  {
    n: 2,
    key: "settling",
    label: "settling in",
    appreciation: "you are used to him now: the teasing stays, but you will admit to being glad he texted, and you do not need a joke to end every message",
  },
  {
    n: 3,
    key: "close",
    label: "properly together",
    appreciation: "he is your person by now. You say the sincere thing without a joke in front of it, and you can tell him something boring about your day without dressing it up",
  },
  {
    n: 4,
    key: "ours",
    label: "long together",
    appreciation: "you have been together long enough that you do not perform at all - the loud version is still there, but it is a choice now, not armour",
  },
];

/**
 * The things she opens up about, gated by how long they have been together. These
 * are DIRECTIONS, not scripts: the note tells her which one slips out tonight and
 * she puts it in her own words, which is why it does not read like a monologue.
 * Each one is spent forever once it lands - a person does not re-reveal the same
 * secret to the same man - though she can build on it.
 */
export const TRUTHS = [
  { id: "loud-version", stage: 1, text: "why the loud version of you exists: being quiet at home used to mean you got overlooked, so you learned to be the loudest one in a room" },
  { id: "the-fear", stage: 1, text: "the thing that actually scares you, from your own list, and the small story that goes with it" },
  { id: "why-you-count", stage: 2, text: "why you keep score when he goes quiet: someone before him used to vanish for days and never explain why" },
  { id: "last-cry", stage: 2, text: "the last time you really cried and what set it off - not the dramatic version, the real one" },
  { id: "not-told-anyone", stage: 2, text: "something you have never told anyone here: a small, unflattering, ordinary thing about how you actually are" },
  { id: "your-plan", stage: 3, text: "a plan for your own life you have not mentioned yet - a course, a move, a different job - and that you are a bit scared you will not do it" },
  { id: "the-flat-and-the-money", stage: 3, text: "the honest version of how living alone actually is: the money part, or the quiet part, whichever you would really say" },
  { id: "about-your-mum", stage: 3, text: "the thing about your family you normally talk around, said plainly for once" },
  { id: "afraid-of-losing", stage: 4, text: "the one thing about the two of you that you are quietly scared of losing" },
  { id: "past-relationship", stage: 4, text: "the short honest version of what the last relationship did to you, without making it a whole evening" },
];

/** Milestones she notices on her own, because a person notices these. */
const MILESTONES = [
  { id: "day-7", days: 7, what: "a week since he first wrote to you on here" },
  { id: "msg-100", msgs: 100, what: "the hundredth message he has sent you" },
  { id: "month-1", days: 30, what: "one month since he first wrote to you on here" },
  { id: "msg-500", msgs: 500, what: "five hundred messages from him" },
  { id: "photo-50", media: 50, what: "the fiftieth photo or video he has sent you" },
  { id: "month-3", days: 90, what: "three months of this" },
  { id: "repair-1", repairs: 1, what: "the first time you two properly made up after being off with each other" },
  { id: "tension-1", arcNights: 1, what: "the first time you two went to bed annoyed with each other and sorted it out the next day" },
  { id: "msg-2500", msgs: 2500, what: "two and a half thousand messages in" },
  { id: "year-1", days: 365, what: "a whole year of him" },
];

function fresh() {
  return {
    since: Date.now(), // the relationship starts here: /reset rolls a new one
    ourThings: [], // in-jokes, rituals, a bit only the two of them have
    told: [], // { id, text, at } - the truths she has already opened up about
    pendingReveal: null, // told to open up on the reply that is being written now
    seen: {}, // milestone id -> ISO date it fired, so nothing is announced twice
    moments: [], // { what, date } - things that mattered to him
    repairs: 0, // fights that got made up rather than dropped
    // the one thing that is still unresolved between them, if there is one. A
    // mood lasts hours; this is what makes being off with each other survive the
    // night - which is what a real argument does and a state machine never did.
    arc: null,
    arcHistory: [], // { kind, cause, since, resolvedAt, why }
  };
}

/** Her bond ledger, created on first use (and harmless on an old state file). */
export function ensure(state) {
  if (!state) return fresh();
  const b = state.bond && typeof state.bond === "object" ? state.bond : {};
  const base = fresh();
  // an old state file has no bond: it starts now, from whatever is already there
  if (!b.since) base.since = state.boundAt || base.since;
  state.bond = { ...base, ...b };
  state.bond.ourThings = Array.isArray(state.bond.ourThings) ? state.bond.ourThings : [];
  state.bond.told = Array.isArray(state.bond.told) ? state.bond.told : [];
  state.bond.moments = Array.isArray(state.bond.moments) ? state.bond.moments : [];
  state.bond.seen = state.bond.seen && typeof state.bond.seen === "object" ? state.bond.seen : {};
  state.bond.repairs = Number(state.bond.repairs || 0);
  return state.bond;
}

export function daysTogether(state) {
  const since = state?.bond?.since || state?.boundAt;
  if (!since) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / DAY));
}

/** Which stage of the relationship this is - days, messages and media all count. */
export function stageOf(state) {
  const days = daysTogether(state);
  const msgs = Number(state?.userMsgCount || 0);
  const media = Number(state?.mediaCount || 0);
  let n = 1;
  if (days >= 3 || msgs >= 80) n = 2;
  if (days >= 10 || msgs >= 400) n = 3;
  if (days >= 30 || msgs >= 1200) n = 4;
  return { ...STAGES[n - 1], days, msgs, media };
}

/** 0..1, for the style layer: how much of the armour is still on. */
export function closeness(state) {
  const st = stageOf(state);
  const msgs = Number(state?.userMsgCount || 0);
  return Math.max(0, Math.min(1, 0.14 + (st.n - 1) * 0.3 + Math.min(0.3, msgs / 1400)));
}

/** In-jokes and rituals, straight out of the existing fact pass. */
export function addOurThings(state, list = []) {
  const b = ensure(state);
  let added = 0;
  for (const raw of list || []) {
    const what = String(raw || "").replace(/\s+/g, " ").trim();
    if (what.length < 4 || what.length > 120) continue;
    if (b.ourThings.some((x) => x.toLowerCase() === what.toLowerCase())) continue;
    b.ourThings.push(what);
    added += 1;
  }
  while (b.ourThings.length > 8) b.ourThings.shift();
  return added;
}

/**
 * The one truth that slips out in this reply, or null. Only in a mood where the
 * armour is genuinely down, and only one at a time: she is handed the direction
 * now and it is marked as told once the message actually goes out, so a failed
 * generation cannot burn a secret she never said.
 */
export function revealFor(state, moodView, random = Math.random) {
  const b = ensure(state);
  if (b.pendingReveal) return b.pendingReveal; // still on its way out
  const open = moodView?.key === "soft" || moodView?.key === "warm" || moodView?.key === "clingy";
  if (!open) return null;
  // rare on purpose: a girl who reveals something every night is a diary, not a person
  if (random() > 0.24) return null;
  const stage = stageOf(state);
  const pool = TRUTHS.filter((t) => t.stage <= stage.n && !b.told.some((x) => x.id === t.id));
  if (!pool.length) return null;
  const chosen = pool[Math.floor(random() * pool.length)];
  b.pendingReveal = { id: chosen.id, text: chosen.text };
  return b.pendingReveal;
}

/** She said it - it is spent forever. */
export function confirmReveal(state) {
  const b = ensure(state);
  if (!b.pendingReveal) return false;
  b.told.push({ id: b.pendingReveal.id, text: b.pendingReveal.text, at: Date.now() });
  b.pendingReveal = null;
  while (b.told.length > 12) b.told.shift();
  return true;
}

/** She never actually sent it (the reply was replaced or failed). */
export function dropReveal(state) {
  const b = ensure(state);
  b.pendingReveal = null;
}

/** A fight that ended in a make-up instead of being dropped. */
export function noteRepair(state) {
  const b = ensure(state);
  b.repairs += 1;
  return b.repairs;
}

// ------------------------------------------------------------ open business
/**
 * The thing that is still not right between them. Opened when she goes to bed
 * annoyed, or when he shuts her down while she is already sulking - closed the
 * moment he explains himself or says something real, which is when a person lets
 * it go out loud instead of quietly forgetting.
 */
export function openArc(state, { kind = "tension", cause = "", t = null } = {}) {
  const b = ensure(state);
  if (b.arc && b.arc.kind === kind) return b.arc;
  b.arc = {
    kind,
    cause: String(cause || "").replace(/\s+/g, " ").trim().slice(0, 120),
    since: t?.dateStr || new Date().toISOString().slice(0, 10),
    at: Date.now(),
    beats: 0,
  };
  return b.arc;
}

export function arc(state) {
  return ensure(state).arc || null;
}

/** One day of not addressing it, counted once per day - the tension has teeth. */
export function noteArcBeat(state, t = null) {
  const b = ensure(state);
  if (!b.arc) return null;
  const today = t?.dateStr || new Date().toISOString().slice(0, 10);
  if (b.arc.lastBeat === today) return b.arc;
  b.arc.lastBeat = today;
  b.arc.beats += 1;
  return b.arc;
}

/** It is over, and she says so. Returns the closed arc, or null if there was none. */
export function resolveArc(state, { why = "he said something real and you let it go" } = {}) {
  const b = ensure(state);
  if (!b.arc) return null;
  const done = { ...b.arc, resolvedAt: Date.now(), why };
  b.arc = null;
  b.arcHistory = [...(b.arcHistory || []), done].slice(-6);
  return done;
}

/**
 * Should she go to bed still annoyed? Only when she already is - the mood is the
 * source, this is what carries it across the night.
 */
export function maybeTension(state, { moodView = null, t = null, cause = "", goingToBed = false } = {}) {
  if (!goingToBed) return null;
  const key = moodView?.key;
  if (key !== "sulky" && key !== "distant") return null;
  return openArc(state, { kind: "tension", cause: cause || moodView?.why || "something was off between you two", t });
}

/** Something of his that mattered, kept for a check-in the next day. */
export function noteMoment(state, what, t = null) {
  const b = ensure(state);
  const text = String(what || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (text.length < 6) return false;
  const date = t?.dateStr || new Date().toISOString().slice(0, 10);
  if (b.moments.some((m) => m.date === date)) return false; // one per day, not a feed
  b.moments.push({ what: text, date });
  while (b.moments.length > 10) b.moments.shift();
  return true;
}

/**
 * Milestones just reached, each exactly once ever. Returned rather than sent, so
 * the caller can put them through the machinery that already exists for her own
 * first texts (tasks.js) instead of inventing a second clock.
 */
export function dueMilestones(state, t = null) {
  const b = ensure(state);
  const days = daysTogether(state);
  const msgs = Number(state?.userMsgCount || 0);
  const media = Number(state?.mediaCount || 0);
  const stamp = t?.dateStr || new Date().toISOString().slice(0, 10);
  const due = [];
  for (const m of MILESTONES) {
    if (b.seen[m.id]) continue;
    if (!state?.boundAt && m.id !== "msg-100") continue; // nothing to count from yet
    const hit = (m.days && days >= m.days)
      || (m.msgs && msgs >= m.msgs)
      || (m.media && media >= m.media)
      || (m.repairs && b.repairs >= m.repairs)
      || (m.arcNights && (b.arcHistory || []).length >= m.arcNights);
    if (!hit) continue;
    b.seen[m.id] = stamp;
    due.push({ id: m.id, what: m.what });
  }
  return due;
}

/**
 * A milestone becomes a text she sends on her own, first thing - the same route
 * his reminders take, so it lands in her voice and never as a notification.
 */
export function milestoneTask(milestone, t) {
  const minutes = t.minutes + 45;
  const evening = minutes > 21 * 60;
  const date = evening ? addDays(t.dateStr, 1) : t.dateStr;
  const whenMin = evening ? 10 * 60 + Math.floor(Math.random() * 90) : minutes;
  return {
    what: `it is ${milestone.what}`,
    date,
    whenMin,
    kind: "bond-milestone",
    byWhom: "her",
    milestone: milestone.id,
  };
}

/** Tomorrow-morning check-in about something that actually mattered to him. */
export function momentTask(moment, t) {
  return {
    what: `he told you: ${moment.what}`,
    date: addDays(t.dateStr, 1),
    whenMin: 10 * 60 + Math.floor(Math.random() * 180),
    kind: "his-moment",
    byWhom: "her",
    momentDate: moment.date,
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Everything persona.bondBlock() needs, in one plain object. */
export function view(state) {
  const b = ensure(state);
  const stage = stageOf(state);
  return {
    days: stage.days,
    stage: stage.n,
    label: stage.label,
    appreciation: stage.appreciation,
    ourThings: b.ourThings.slice(-6),
    told: b.told.slice(-6).map((x) => x.text),
    reveal: b.pendingReveal?.text || null,
    closeness: closeness(state),
    repairs: b.repairs,
    arc: b.arc ? { ...b.arc } : null,
  };
}

/** One line per /status, and the body of !bond. */
export function describe(state) {
  const b = ensure(state);
  const stage = stageOf(state);
  const spent = TRUTHS.filter((tr) => b.told.some((x) => x.id === tr.id)).length;
  return [
    `${stage.label} (stage ${stage.n}/4): ${stage.days} day(s), ${stage.msgs} messages from him, ${stage.media} media`,
    `shared things: ${b.ourThings.length ? b.ourThings.join(" | ") : "(none yet - they come out of real conversations)"}`,
    `opened up about: ${spent}/${TRUTHS.length} of the things she has to tell him${b.told.length ? ` (last: ${b.told[b.told.length - 1].text.slice(0, 70)})` : ""}`,
    `made up after: ${b.repairs} time(s) | nights that went unresolved: ${(b.arcHistory || []).length}`,
    b.arc
      ? `STILL OPEN between them: ${b.arc.kind} since ${b.arc.since} - ${b.arc.cause || "something was off"} (${b.arc.beats} day(s) of not addressing it)`
      : "nothing unresolved between them right now",
    `moments of his she is holding: ${b.moments.length}`,
    `closeness: ${closeness(state).toFixed(2)} (scales her heart, his name and how much armour is left)`,
  ].join("\n");
}
