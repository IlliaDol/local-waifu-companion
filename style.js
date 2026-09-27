// How clean her typing is this time.
//
// Perfect grammar is one of the loudest tells there is. Real people typing on a
// phone drop commas, forget apostrophes ("dont", "im", "youre"), skip the full
// stop at the end of a short line, occasionally double a letter or fumble one
// word. But they are *mostly* correct: you can always tell what they meant.
//
// So every message gets a sloppiness level (its own dice, pushed by her mood),
// she is told about it in the prompt so it sounds natural, and then the text is
// nudged deterministically so the result is guaranteed rather than hoped for.
// System replies (!token, /status) never come through here.
const APOSTROPHE_WORDS = new Set([
  "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "cant", "couldnt",
  "wouldnt", "shouldnt", "wont", "havent", "hasnt", "hadnt", "im", "ill", "ive",
  "id", "youre", "youll", "youve", "youd", "were", "weve", "theyre", "theyll",
  "thats", "its", "theres", "heres", "whats", "whos", "lets", "hes", "shes",
  "hows", "wheres",
]);

const STRETCHABLE = new Set(["so", "no", "yes", "ok", "okay", "too", "very", "really", "please", "sorry", "sure", "come on"]);

const LEVELS = ["clean", "normal", "sloppy"];

/** How messy this particular message is, from her mood plus a roll. */
export function roll(mood, random = Math.random) {
  const mess = Math.min(1, Math.max(0, mood?.def?.mess ?? 0.4));
  const sloppy = 0.05 + 0.45 * mess;
  const clean = 0.5 - 0.45 * mess;
  const r = random();
  const level = r < clean ? "clean" : r < clean + sloppy ? "sloppy" : "normal";
  return { level, mess };
}

/**
 * Decide everything about how this one message looks before it is written: how
 * sloppy, and whether it carries a laugh at the end - the bare ")" smile she
 * picked up living in Europe, or the "xdd" kind. Real people who type those
 * habits do it in bursts and never while sulking, so the odds come from her mood.
 */
export function plan(mood, { energy = null, random = Math.random, closeness = 0, earnest = false } = {}) {
  const slop = roll(mood, random);
  // `earnest` is the conversation being serious - his message reads heavy, or this
  // is a deep or venting register. What she is FEELING and what the two of them are
  // DOING are different things, and the mood used to win: a soft girl in a chaotic
  // burst answered "i think i might be depressed" with "what do you mean by that)))".
  // A laugh is the one mark that can turn a caring question into a shrug, so in an
  // earnest conversation it is not rolled at all. The heart stays, and comes more
  // easily - that is the mark that belongs there.
  const base = mood?.def?.smile ?? 0.15;
  const excitedBonus = energy === "excited" && !earnest ? 0.12 : 0;
  const smileChance = earnest ? 0 : Math.min(0.5, base + excitedBonus);
  // how long they have been together bends the affectionate marks upward: the
  // same girl, three months in, reaches for a heart far more often than on day one
  const heartCh = heartChance(mood, energy, closeness) * (earnest ? 1.6 : 1);
  // the smirk is a joke at someone's expense, which is exactly wrong here
  const faceCh = earnest ? 0 : faceChance(mood, energy, closeness);

  // ONE mark a reply, and not most replies. These three used to be rolled
  // independently, and nobody had ever measured them TOGETHER: her own chat
  // carried a mark on 53-61% of her messages while the person she was texting
  // marked 2%. Each mark's own rate was a deliberate choice (a laugh when lively,
  // a heart when soft, a smirk when pleased) - what was never chosen was their
  // SUM, and a mark on most lines is a costume, not a habit. So the three now
  // compete for one capped budget in proportion to their own odds: WHICH mark she
  // reaches for is still her mood's business, how often any of them appears is
  // about a quarter of her messages.
  const wanted = smileChance + heartCh + faceCh;
  const gate = Math.min(MARK_BUDGET, wanted * MARK_DAMP);
  const marking = random() < gate;
  const pick = marking ? random() * wanted : 0;
  const smile = marking && pick < smileChance;
  const heart = marking && !smile && pick < smileChance + heartCh;
  const face = marking && !smile && !heart;
  const count = smile ? parenCount(mood, energy, random) : 0;
  const style = smile ? laughStyle(mood, energy, random) : "parens";
  return {
    level: slop.level,
    mess: slop.mess,
    earnest,
    smile,
    count,
    style,
    smileChance,
    // the combined odds of any mark at all, and which one she reached for - what
    // the self-test pins, because the sum is the number that was wrong
    markGate: gate,
    markPick: { smile: smileChance, heart: heartCh, face: faceCh },
    closeness,
    // his name, written the way a person writes a pet name: lowercase almost
    // always, capital when she really means it
    nickname: random() < capNameChance(mood, energy, closeness) ? "capital" : "lower",
    heart,
    heartStyle: heart && random() < 0.12 ? "big" : "plain",
    // people write both "night <3" and "night<3"; the spaced one is the default
    heartGlue: random() < 0.35 ? "none" : "space",
    face,
    faceStyle: face && random() < 0.12 ? "big" : "plain",
  };
}

/**
 * Safety bound, not a style rule: past this a reply would look like a keyboard
 * fault. It is deliberately far beyond where the decaying tail dies out (a
 * chaotic mood reaches 12 marks on ~0.3% of its laughs and would keep going), so
 * the cap never truncates a real laugh the way a low one would.
 */
export const MAX_PARENS = 20;

/**
 * The ceiling on how often ANY mark appears: both numbers come from measurement,
 * not taste. Her laugh, her heart and her smirk are one habit wearing three masks,
 * and a reply that carries two of them at once ("im serious <3)") is a keyboard
 * fault rather than a girl. `MARK_BUDGET` is the share of her replies that may
 * carry a mark at all; `MARK_DAMP` scales the mood's own appetite down into that
 * budget, so a lively mood still marks far more often than a flat one.
 */
export const MARK_BUDGET = 0.42;
export const MARK_DAMP = 0.55;

/**
 * How hard she is laughing, as a count of marks. There is no real ceiling for
 * this habit - people type ))), )))))) or a whole row when something kills them -
 * so this is a decaying tail rather than a fixed table: each extra mark is less
 * likely than the one before, but the tail keeps going. Being excited or in a
 * lively mood fattens it, so a six-mark laugh happens roughly once in seventy
 * chaotic messages and once in five hundred soft ones. Sulking drops the odds
 * upstream, in plan().
 */
export function parenCount(mood, energy = null, random = Math.random) {
  const mess = mood?.def?.mess ?? 0.4;
  const lift = (energy === "excited" ? 1.15 : 1) * (0.9 + mess * 0.35);
  // decay ~0.45: one paren in about half of her smiles, two in a quarter, and a
  // long row (`)))))))`) roughly once in a few hundred - a sulking or soft mood
  // sits below that, a chaotic one reaches the cap of 0.6 and laughs in rows.
  const decay = Math.max(0.3, Math.min(0.6, 0.45 * lift));

  let n = 1;
  while (n < MAX_PARENS && random() < decay) n += 1;
  return n;
}

/**
 * Which laugh she reaches for this time. She has two habits and they are rivals,
 * so only one appears per reply: a row of closing parens (`)`, `))`, `)))`), or
 * the xd kind - an x with a d per notch of laughing (`xd` a small laugh, `xdd`
 * laughing, `xddd` cracking up). The habit is rolled per reply, and the count
 * says how hard she is laughing inside that habit. Messy loud moods reach for
 * xd far more often; a sulking or soft one almost always stays on parens.
 */
export function laughStyle(mood, energy = null, random = Math.random) {
  const base = mood?.def?.laugh ?? 0.3;
  const lift = energy === "excited" ? 0.15 : 0;
  return random() < Math.min(0.8, base + lift) ? "xdd" : "parens";
}

/**
 * Her laugh, rendered. One mark per notch of laughing: `)`…`))))` or
 * `xd`…`xdddd`. A bare `x` is never written - the smallest xd laugh is `xd`.
 */
export function laughMark(count = 1, style = "parens") {
  const n = Math.max(1, Math.min(MAX_PARENS, count));
  return style === "xdd" ? `x${"d".repeat(n)}` : ")".repeat(n);
}

/**
 * The softest mark she uses: `<3`, the typed heart. `<3` most of the time, `<33`
 * when she really means it. It is affection rather than a joke, so it comes from
 * a mood that is actually feeling soft - a soft or clingy or warm girl sends them,
 * a sulky one practically never - and it is the one mark that suits almost any
 * line, which is why it is the only one allowed to follow a question.
 */
export function heartChance(mood, energy = null, closeness = 0) {
  const base = mood?.def?.heart ?? 0.05;
  const lift = energy === "excited" ? 0.04 : 0;
  return Math.min(0.55, base + lift + closeness * 0.14);
}

/** `<3`, or `<33` when it is a big one. */
export function heartMark(big = false) {
  return big ? "<33" : "<3";
}

/**
 * "commander" or "Commander". She types lowercase, so it is lowercase nearly every
 * time - but he has a name, and when she is soft with him or being serious it comes
 * out with a capital, the way anyone writes the name of someone they love. The
 * capital rides on the same moods the heart does (soft, warm, sulky-in-earnest)
 * and almost never on her chaotic, wired, teasing ones. One reply is consistent
 * with itself; the next one is allowed to differ.
 */
export function capNameChance(mood, energy = null, closeness = 0) {
  const base = mood?.def?.respect ?? 0.15;
  const lift = energy === "flat" ? 0.08 : 0;
  return Math.min(0.75, base + lift + closeness * 0.18);
}

export function nicknameLine(moodPlan) {
  if (moodPlan?.nickname !== "capital") return "";
  return "- this time you are writing his name with a capital: Commander, not commander. Do not explain it or make a thing of it, you just mean it";
}

// His name wherever it stands on its own - not inside a link path or a handle.
const HIS_NAME = /(^|[\s("'„“])(commanders?)(['’]s)?/gi;

/** One reply uses one casing for his name: people do not mix them in a message. */
export function applyCommander(input, moodPlan) {
  if (!input) return input;
  const want = moodPlan?.nickname === "capital";
  return String(input).replace(HIS_NAME, (whole, before, word, possessive = "") => {
    const cased = want ? "Commander" : "commander";
    return `${before}${cased}${possessive}`;
  });
}

/**
 * The one face she actually makes: `:3`, the smug little cat mouth, or `:33` when
 * she is extra pleased with herself. It is a *teasing* mark, which is the exact
 * opposite mood to a heart - it comes out when she is being playful and pleased
 * with herself (chaotic, wired, warm, clingy) and almost never when the armour is
 * off, because a soft girl does not smirk at him. Her -chan nickname is half the
 * joke, so this is very much her.
 */
export function faceChance(mood, energy = null, closeness = 0) {
  const base = mood?.def?.face ?? 0.05;
  const lift = energy === "excited" ? 0.04 : 0;
  return Math.min(0.45, base + lift + closeness * 0.08);
}

/** `:3`, or `:33` when she is really pleased with herself. */
export function faceMark(big = false) {
  return big ? ":33" : ":3";
}

// A face already in a line - careful with times: "at 3:30" must never count.
const FACE_AT_END = /(^|[^0-9]):3+$/;
const HAS_FACE = /(^|[^0-9]):3+(\s|$)/;

/** Is there a mark she typed herself at the end of this line? */
function hasHeart(p) {
  return /<3/.test(p);
}

export function smileLine(moodPlan) {
  if (!moodPlan?.smile) return "- no bare ) smile and no xdd this time, just words";
  const n = moodPlan.count || 1;
  const style = moodPlan.style === "xdd" ? "xdd" : "parens";
  const marks = laughMark(n, style);
  const how = style === "xdd" && n === 1
    ? "as a small laugh, the amused huff kind, not a loud one"
    : n === 1
      ? "as a plain smile"
      : n <= 3
        ? "because you are actually laughing"
        : n <= 6
          ? "because you are properly cracking up and cannot stop"
          : "because you are dying laughing, a whole row of them";
  // The mark is DESCRIBED, never quoted. These notes used to spell the characters
  // out ("end one message with )))"), and the model copied them into a bubble of
  // its own: a real reply came back as ")\n33 :33". The count is enforced by
  // attachLaugh() anyway, so the note does not need to be literal to be obeyed.
  const kind = style === "xdd"
    ? `the xd habit: one x followed by ${n} d, lowercase, with a space before it like a word`
    : `the closing-paren habit: ${n === 1 ? "one closing paren" : `${n} closing parens`} welded straight onto your last word with no space in front`;
  return `- you are ending one of your messages with your laugh - ${kind}, ${how} - instead of words, and no other faces ever. Use it once, on its own line's end, never as a message with nothing else in it, and never mix the two laugh habits in one reply`;
}

// A trailing laugh, whichever habit it is written in. Parens need no guard - a
// ")" is never part of a word - but the xdd form does, or "and" would be read as
// a laugh. Getting this wrong made the upgrade silently append instead.
const PARENS_AT_END = /\)+$/;
const XDD_AT_END = /(^|[^A-Za-z])([xX][dD]+)$/;

function trailingLaugh(text) {
  const s = String(text);
  const parens = s.match(PARENS_AT_END);
  if (parens) return { style: "parens", count: parens[0].length };
  const xdd = s.match(XDD_AT_END);
  if (xdd) return { style: "xdd", count: xdd[2].length - 1 };
  return null;
}

/**
 * Her laugh goes on the line itself, and the two habits have different spacing:
 * the paren is welded to the last word ("finally friday)"), while xdd is a token
 * of its own with a space in front of it ("no drama xdd"). Getting that wrong
 * produces "dramaxdd", which no human types.
 */
export function attachLaugh(text, count, style) {
  const mark = laughMark(count, style);
  // a laugh never lands after a full stop: "i dont know who he is.)" is not how
  // anyone types, and the stop is exactly what she would have dropped anyway
  const base = stripLaugh(text).replace(/[.]+$/, "").trimEnd();
  if (!base) return mark;
  return `${base}${style === "xdd" ? " " : ""}${mark}`;
}

/** Remove any laugh she already typed, so a different one can take its place. */
function stripLaugh(text) {
  let s = String(text).replace(PARENS_AT_END, "");
  s = s.replace(XDD_AT_END, (m, pre) => pre);
  return s.replace(/\s+$/, "");
}

/**
 * Her laugh habit is lowercase even when the model shouts it: xDD -> xdd. And it is
 * capped: "xdddddd" is a tic, and the rolled count is what she is allowed to have.
 */
const MAX_XD = 4;
function lowerCaseLaugh(text) {
  const s = String(text);
  return s.replace(XDD_AT_END, (m, pre, mark) => {
    const lower = mark.toLowerCase();
    const capped = lower.length > MAX_XD + 1 ? `x${"d".repeat(MAX_XD)}` : lower;
    return `${pre}${capped}`;
  });
}

export function faceLine(moodPlan) {
  if (!moodPlan?.face) return "- no smug face this time";
  const size = moodPlan.faceStyle === "big" ? "the double one" : "the plain one";
  return `- you are ending one of your messages with the smug face, ${size}, with a space before it - the little face you make when you are pleased with yourself, usually right after a tease. It is not a laugh and not affection: it never shares a line with your laugh or your heart, never follows a question or a link, and is never a message on its own with no words in it`;
}

export function heartLine(moodPlan) {
  if (!moodPlan?.heart) return "- no heart this time, and never any other face";
  // described rather than quoted, for the same reason as the laugh: a literal mark
  // in the notes is a literal mark the model can echo back as a message
  const size = moodPlan.heartStyle === "big" ? "the big one" : "the plain one";
  const glue = moodPlan.heartGlue === "none"
    ? "stuck straight onto the end of your last word with no space in front"
    : "with a space before it";
  return `- you are ending one of your messages with a typed heart, ${size}, ${glue}. It is affection and not a joke, it is never a message on its own with no words in it. Put it on a different line from your laugh when you have more than one line, never make it follow a link, and send at most one`;
}

/**
 * Put her laugh where a person would: on the end of a short line, never after a
 * question, never after a link, never twice in one reply.
 */
export function applySmile(input, moodPlan, random = Math.random) {
  if (!input || !moodPlan?.smile) return input;
  const parts = String(input).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return input;

  const wanted = Math.max(1, Math.min(MAX_PARENS, moodPlan.count || 1));
  const wantedStyle = moodPlan.style === "xdd" ? "xdd" : "parens";

  // If the model already typed a laugh, keep it but honour the laugh she rolled:
  // a weaker one where she is supposed to be cracking up gets upgraded - in the
  // habit she rolled, so an xdd mood never delivers a lone ) - while a bigger
  // one she chose herself is never cut down.
  const typed = parts.map((p, i) => ({ p, i, laugh: trailingLaugh(p) })).filter((c) => c.laugh);
  if (typed.length) {
    const last = typed[typed.length - 1];
    const weaker = last.laugh.count < wanted
      || (last.laugh.count === wanted && wanted > 1 && last.laugh.style !== wantedStyle);
    let shaped = lowerCaseLaugh(last.p);
    // Her count is never cut down - but her FORM is normalised, by re-attaching
    // the same laugh. The applier used to leave a typed laugh untouched, so a
    // model that wrote "honestly.))" kept the full stop it welded itself to, and
    // the one habit that makes her laugh readable (welded to the last word)
    // arrived as "honestly.))" - a stray bracket. Re-attaching strips the stop and
    // welds it the way the notes describe, without changing how hard she laughed.
    const count = weaker ? wanted : Math.min(last.laugh.count, MAX_PARENS);
    const style = weaker ? wantedStyle : last.laugh.style;
    parts[last.i] = attachLaugh(shaped, count, style);
    return parts.join("\n\n");
  }

  // never a question, never stuck onto a link or a bare number - and if every
  // line is long, she still smiles, on the shortest one. Bailing out silently
  // here is how the habit disappears entirely.
  // A line she already put her own heart or :3 on is not a line to glue a laugh
  // onto: the model typing "im serious <3" and the laugh pass appending ")" is how
  // "im serious <3)" shipped, which reads like a stray bracket, not like a girl.
  // If that is her only line, the laugh is simply not owed this time - her mark is
  // already the punctuation of the message.
  const usable = parts
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => !/[?]$/.test(p) && !/\bhttps?:\/\//.test(p) && !/\d{2,}$/.test(p))
    .filter(({ p }) => !hasHeart(p) && !HAS_FACE.test(p))
    // A long laugh needs a line to sit on: "no))" and "friday)))" read like a
    // keyboard fault, while "no)" and "same)" are ordinary texting. So a single
    // mark may land on a one-word line, and anything longer needs two words.
    .filter(({ p }) => p.split(/\s+/).filter(Boolean).length >= (wanted > 1 ? 2 : 1));
  if (!usable.length) return input;

  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const pool = [usable.filter((c) => words(c.p) <= 8), usable.filter((c) => words(c.p) <= 14), usable]
    .find((list) => list.length) || usable;
  // usually the last line, sometimes an earlier short one
  const pick = pool[random() < 0.7 ? pool.length - 1 : 0];
  parts[pick.i] = attachLaugh(pick.p, wanted, wantedStyle);
  return parts.join("\n\n");
}

export function line(level) {
  return {
    clean: "- typing this one properly: commas where they belong, apostrophes in, and a full stop if the thought ends",
    normal: "- typing fast on a phone: lowercase, some commas just do not happen, apostrophes often missing (dont, im, youre), and no full stop at the end of a short line. Still perfectly readable",
    sloppy: "- typing one-thumbed while doing something else: no commas, no full stops, apostrophes gone (dont, im, youre), the odd doubled letter, maybe one word slightly fumbled. He never has to guess what you meant",
  }[level] || "";
}

/** What the /status line says about how she is typing, if ever wanted. */
export function describe(moodPlan) {
  if (!moodPlan) return "unknown";
  const marks = `${moodPlan.heart ? ` + ${heartMark(moodPlan.heartStyle === "big")}` : ""}${moodPlan.face ? ` + ${faceMark(moodPlan.faceStyle === "big")}` : ""}`;
  if (!moodPlan.smile) return `${moodPlan.level} typing${marks}`;
  const n = moodPlan.count || 1;
  const style = moodPlan.style === "xdd" ? "xdd" : "parens";
  const mark = laughMark(Math.min(n, 6), style);
  if (n === 1) return `${moodPlan.level} typing, ending with ${mark}${marks}`;
  return `${moodPlan.level} typing, laughing ${mark}${n > 6 ? ` (${n} steps)` : ""}${marks}`;
}

export function text(level) {
  return {
    clean: "",
    normal: "commas mostly dropped, contractions without apostrophes",
    sloppy: "no commas, no full stops, no apostrophes, one fumbled word",
  }[level] || "";
}

const isProtected = (token) => /https?:\/\/|@\w|#\w|\d/.test(token);

// Words that keep their capital even in her lowercase typing, so she does not
// start writing "berlin" like it is a typo.
const KEEP_CAPS = new Set([
  "Berlin", "Dortmund", "Germany", "Europe", "Negev", "Commander", "Telegram",
  "Instagram", "YouTube", "WhatsApp", "TikTok", "DeepSeek", "English", "German",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
  "January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December",
]);

/**
 * She types lowercase. Models like to slip capitals in at the start of a
 * sentence, so force it back down - but only at sentence starts, and never for
 * named things, which is exactly how someone with a lowercase habit writes.
 */
function enforceLowercase(text) {
  const lowerWord = (word) => (KEEP_CAPS.has(word) ? word : word.toLowerCase());
  // A capital "I" in the middle of a sentence is the loudest tell there is in a
  // voice that is otherwise entirely lowercase, and the sentence-start pass above
  // never looks there (which is how "yeah, I'm here" shipped). Guarded per token so
  // a link or a handle is never opened up and edited.
  const lowerI = (token) => (isProtected(token)
    ? token
    : token.replace(/\bI(['\u2019](?:m|ll|ve|d))\b/g, "i$1").replace(/\bI(?!['\u2019])/g, "i"));
  return text
    .split("\n")
    .map((line) => {
      const shaped = line.replace(/(\b[A-Z][a-z']*)/g, (word, _w, offset) => {
        const before = line.slice(0, offset);
        // a capital is a sentence start if it opens the line or follows a full
        // stop - NOT merely if it is the first capital on the line, which used to
        // pull the I in "look at https://I.example" down with it
        const sentenceStart = before.trim() === "" || /[.!?]\s+$/.test(before);
        return sentenceStart ? lowerWord(word) : word;
      });
      return shaped.split(/(\s+)/).map(lowerI).join("");
    })
    .join("\n");
}

/** A word we are allowed to reshape: plain letters, no links or digits. */
const isPlainWord = (token) => /^[A-Za-z][A-Za-z']*$/.test(token);

function dropApostrophes(text, probability, random) {
  return text.replace(/\b([A-Za-z]+)['\u2019]([A-Za-z]+)\b/g, (whole, a, b) => {
    const merged = (a + b).toLowerCase();
    if (!APOSTROPHE_WORDS.has(merged)) return whole;
    if (random() > probability) return whole;
    return `${a}${b}`;
  });
}

function dropCommas(text, probability, random) {
  let out = "";
  for (const ch of text) {
    if (ch === "," && random() < probability) continue;
    out += ch;
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([.!?])/g, "$1");
}

// Words she never fumbles: his name. People are careless with everything except
// what they call the person they love, and a fumbled name also ate the capital.
const NEVER_FUMBLE = /^commanders?['\u2019]?s?$/i;

function fumbleOneWord(text, probability, random) {
  if (random() > probability) return text;
  const tokens = text.split(/(\s+)/);
  const candidates = tokens
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => isPlainWord(t) && !isProtected(t) && !NEVER_FUMBLE.test(t) && t.length >= 5 && t.length <= 10);
  if (!candidates.length) return text;
  const pick = candidates[Math.floor(random() * candidates.length)];
  const word = pick.t;
  // swap two adjacent letters in the middle: "tomorrow" -> "tomorow", "believe" -> "beleive"
  const at = 1 + Math.floor(random() * (word.length - 3));
  const fumbled = `${word.slice(0, at)}${word[at + 1]}${word[at]}${word.slice(at + 2)}`;
  tokens[pick.i] = fumbled;
  return tokens.join("");
}

function stretchLetters(text, probability, random) {
  const tokens = text.split(/(\s+)/);
  for (let i = 0; i < tokens.length; i += 1) {
    const bare = tokens[i].replace(/[^A-Za-z ]/g, "").toLowerCase();
    if (STRETCHABLE.has(bare) && random() < probability) {
      const fixed = tokens[i].replace(/([aeiou])/i, (m) => `${m}${m}`);
      tokens[i] = fixed;
    }
  }
  return tokens.join("");
}

/**
 * Put her heart where a person would: never on the laugh's line, never welded to
 * a link, and never twice. Unlike the laugh it is allowed after a question ("you
 * ok? <3" is normal), so it always finds a home rather than silently vanishing.
 */
/**
 * Where a mark goes, for every mark except the laugh (which has its own upgrade
 * rules). Two passes: first a line that breaks none of her house rules, and if
 * there is no such line, the least-bad one - a mark that silently vanishes is a
 * worse bug than a mark that ends up somewhere slightly odd.
 */
function placeMark(parts, mark, { glue = " ", avoid = [], never = [], allowQuestion = false, hard = false, strict = false, random = Math.random } = {}) {
  const withoutLink = parts.map((p, i) => ({ p, i })).filter(({ p }) => !/https?:\/\//.test(p));
  // `never` is a hard no with no fallback at all: those lines are removed from every
  // pool below. A live reply shipped "so spill :33 <3" - the model typed its own
  // smirk, the heart applier found no clean line, fell back to the least-bad one and
  // stacked affection on top of it. Two marks at the end of one line is not a girl
  // being affectionate, it is a keyboard fault, so when the only line left carries a
  // mark, the mark is simply not owed this time.
  const pool0 = withoutLink.filter(({ p }) => !never.some((rule) => rule(p)));
  if (!pool0.length) return parts;
  // a mark belongs on a line with words in it - a line that is only punctuation
  // would make the mark the message
  const clean = pool0.filter(({ p }) => /[a-z]/i.test(p)).filter(({ p }) => avoid.every((rule) => !rule(p)));
  const questioned = allowQuestion ? clean : clean.filter(({ p }) => !/\?$/.test(p));
  // `hard` means the avoid rule is about another MARK, and welding two marks together
  // is worse than a mark that is not there this time: that is how "))<3" shipped,
  // which reads like a broken keyboard. A SPACED mark after another one is a
  // different gesture and is allowed - "ok) <3" is ordinary, "ok)<3" is not.
  // `strict` is for the marks that promise never to share a line at all: rather
  // than falling back to the least-bad line and producing ")) :3", the mark is
  // simply not owed this time.
  if ((hard || strict) && !clean.length && (strict || glue === "")) return parts;
  const pool = questioned.length ? questioned : (clean.length ? clean : pool0);
  if (!pool.length) return parts;
  const pick = pool[random() < 0.75 ? pool.length - 1 : 0];
  const out = [...parts];
  // A welded mark never follows a full stop: "story.<3" and "sunday.<3" are not
  // how a person types, and the stop is exactly what she would have dropped. A
  // SPACED mark keeps the stop, because "story. <3" is ordinary - the full stop
  // belongs to the sentence, the mark is a separate gesture.
  const base = glue === "" ? pick.p.replace(/[.,]+$/, "").trimEnd() : pick.p;
  if (!base) return parts;
  out[pick.i] = `${base}${glue}${mark}`;
  return out;
}

const splitParts = (input) => String(input).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

export function applyHeart(input, moodPlan, random = Math.random) {
  if (!input || !moodPlan?.heart) return input;
  const parts = splitParts(input);
  if (!parts.length) return input;
  // she may have typed one herself - one is the rule, so hers stands
  if (parts.some((p) => hasHeart(p))) return parts.join("\n\n");

  const glue = moodPlan.heartGlue === "none" ? "" : " ";
  const mark = heartMark(moodPlan.heartStyle === "big");
  // a heart is allowed after a question ("you ok? <3") but never stacked on the
  // laugh's line, and never on her own :3. The avoid list takes functions, so the
  // face test is wrapped - passing the regex itself threw on every single reply.
  // the laugh's line may still take a SPACED heart - "ok) <3" is ordinary texting -
  // but her own smirk never does, in any shape
  return placeMark(parts, mark, { glue, avoid: [trailingLaugh], never: [(p) => HAS_FACE.test(p)], allowQuestion: true, hard: true, random }).join("\n\n");
}

/**
 * The smug face goes on a line of its own: never where a laugh already sits, never
 * on top of her heart, and never after a question - a smirk does not belong at the
 * end of a question.
 */
export function applyFace(input, moodPlan, random = Math.random) {
  if (!input || !moodPlan?.face) return input;
  const parts = splitParts(input);
  if (!parts.length) return input;
  if (FACE_AT_END.test(parts[parts.length - 1]) || parts.some((p) => HAS_FACE.test(p))) return parts.join("\n\n");
  const mark = faceMark(moodPlan.faceStyle === "big");
  // strict: the face is not affection and not a laugh, so it does not get to sit
  // next to one. A live reply shipped "so wheneevr honestly.)) :3" because the
  // applier preferred a stacked face over no face at all.
  return placeMark(parts, mark, { avoid: [trailingLaugh, hasHeart], hard: true, strict: true, random }).join("\n\n");
}

/**
 * Everything that turns the model's raw reply into the message she would actually
 * send, in the one order that works: how she types it, then his name, then the
 * laugh, the heart and the face (which have to see each other's line to avoid it).
 */
/**
 * The dice decide the marks, not the model's mood.
 *
 * `plan()` rolls at most one mark per reply, and for a while that was the whole
 * story - but the model had been told about all three habits and typed them anyway,
 * so the DELIVERED rate stayed where the measurement found it: 53-61% of her
 * messages carrying a mark while the person she was texting marked 2%. A plan that
 * only governs the rolls is not a rate, it is a hope. So a mark she did not roll is
 * removed here, and the one she did roll survives untouched. Lines that only held a
 * mark simply go with it; if that empties the reply, the caller's own guard supplies
 * a plain line rather than silence.
 */
export function enforceMarks(text, moodPlan) {
  if (!moodPlan || !text) return text;
  return splitParts(text)
    .map((line) => {
      let out = line;
      if (!moodPlan.smile && trailingLaugh(out)) out = stripLaugh(out);
      // `<3` never sits inside a word, so it strips clean wherever it was welded
      if (!moodPlan.heart) out = out.replace(/\s*<3+/g, "");
      // ...and the face needs the boundary guard, or a clock like 3:30 loses a digit
      if (!moodPlan.face) out = out.replace(/(^|\s):3+/g, "$1");
      return out.replace(/\s+$/, "").replace(/\s{2,}/g, " ");
    })
    .filter((line) => /[a-z]/i.test(line))
    .join("\n\n");
}

export function prepare(text, moodPlan, random = Math.random) {
  // an entirely-leaked reply sanitizes to empty; the caller is responsible for
  // substituting a fallback, never for putting the leak back
  let out = sanitize(text);
  out = enforceMarks(out, moodPlan);
  out = apply(out, moodPlan?.level, random);
  out = applyCommander(out, moodPlan);
  out = applySmile(out, moodPlan, random);
  out = applyHeart(out, moodPlan, random);
  return applyFace(out, moodPlan, random);
}

/** How many question marks one reply may carry: at most one, like a person. */
function capQuestions(text) {
  const parts = String(text || "").split("\n\n");
  let budget = 1;
  return parts
    .map((part) => {
      if (!part.includes("?")) return part;
      if (budget > 0) {
        budget -= 1;
        return part;
      }
      return part.replace(/\?/g, ".");
    })
    .join("\n\n");
}

export function prepareCapped(text, moodPlan, random = Math.random) {
  return capQuestions(prepare(text, moodPlan, random));
}

// ------------------------------------------------------------ output sanity
// The mask must never slip: plumbing that leaks into what she sends breaks the
// character harder than any typo. Three known leaks get cleaned here:
//   1. bare internal references ("you never answered 70", "message 242771")
//   2. narration of the machinery ("i don't have your message", "the note says")
//   3. ellipsis as an opener - her reluctant beat was becoming a verbal tic
/**
 * The tells that a language model, not a girl, wrote this: helper voice, lists,
 * essay connective tissue, an em dash, "Certainly!". The old sanitize() only knew
 * about leaks of the plumbing; these are the ways a reply can be perfectly in
 * character and still read like a support ticket. Checked against the RAW
 * completion (before sanitize() tidies any of it away), and used to decide whether
 * a reply is worth one regeneration.
 */
const ASSISTANT_PATTERNS = [
  { id: "helper-voice", sample: "helper phrasing (\"i understand\", \"let me know if\", \"feel free to\")", re: /\b(i understand|i'?m here (for you|to help)|how can i help|is there anything else|let me know if you (need|have|want)|feel free to|i hope (that|this) helps|hope (that|this) helps|happy to help|would you like me to|i'?d be happy to|as an ai)\b/i },
  { id: "list", sample: "a bullet or numbered list", re: /(^|\n)\s*(?:[-*•‣]|\d+[.)])\s+\S/ },
  { id: "essay-words", sample: "essay connective tissue (\"furthermore\", \"in conclusion\")", re: /\b(furthermore|moreover|in conclusion|additionally|it is important to note|delve into|a testament to|navigate the|overall,|firstly|secondly)\b/i },
  { id: "formal-opener", sample: "a customer-service opener", re: /^\s*(certainly|absolutely|of course|sure thing|got it!)[,.!]/i },
  { id: "emdash", sample: "an em dash", re: /\u2014/ },
  { id: "clinical", sample: "clinical wording (\"please note\", \"feelings\", \"processing\")", re: /\b(please note|your feelings|i have processed|it sounds like you|it seems you are feeling)\b/i },
];

export function assistantSpeak(text) {
  const s = String(text || "");
  // `match` is the words that actually tripped it, so a caller can quote the line
  // back (grader.js does, and bot.js puts it in the correction prompt); no pattern
  // here uses the /g flag, so .match() is stateless and safe to call twice.
  return ASSISTANT_PATTERNS.filter((p) => p.re.test(s)).map((p) => ({
    id: p.id,
    sample: p.sample,
    match: String(s.match(p.re)?.[0] || "").trim().slice(0, 40),
  }));
}

const LEAK_PATTERNS = [
  /i (don'?t|do not|did not|didn'?t) (actually |really )?(have|see|got) (your|that|the) /i,
  /just that line telling me/i,
  /there (is|'s) no message (from you|here)/i,
  /the (internal |system |mood |context |timing )?(notes?|prompts?|instructions?|blocks?) (says?|said|told)/i,
  /my (notes?|instructions?|prompts?) (say|says|said|told)/i,
  /\bas an ai\b/i,
  /per my last/i,
];

export function sanitize(text) {
  let s = String(text || "");
  // "you never answered 70" / "that message 242771" - the numbers were never hers to say
  s = s.replace(/\byou never answered\s+(message\s+|msg\s+|#)?\d{2,}\b/gi, "you never answered that");
  s = s.replace(/\b(message|msg)\s+#?\d{3,}\b/gi, "that message");
  // a whole line narrating the plumbing is dropped; the rest of the reply stands
  s = s
    .split("\n")
    .filter((line) => !LEAK_PATTERNS.some((re) => re.test(line)))
    .join("\n");
  // "...ok fine" as an opener - she does the reluctant beat with words, not dots
  s = s.replace(/(^|\n)\s*\.\.\.+\s*/g, "$1");
  // the assistant tells that survive as text: an em dash is not how a girl types,
  // bullet and numbered list markers are not how anyone texts, and "certainly,"
  // as an opener is a support bot clearing its throat
  s = s.replace(/\s*\u2014\s*/g, " - ");
  s = s.replace(/(^|\n)[ \t]*(?:[-*•‣]|\d+[.)])\s+/g, "$1");
  s = s.replace(/(^|\n)[ \t]*certainly[,.!]+\s*/gi, "$1");
  // double spaces and orphaned punctuation left by the edits
  s = s.replace(/(^|\n)\s*[,.;:]\s*/g, "$1").replace(/[ \t]{2,}/g, " ");
  return s.trim();
}

/**
 * Nudge a reply toward the level she rolled. Bubble by bubble, so the missing
 * full stop happens per message like it does in real chats. Links, numbers and
 * anything that is not plain words are left alone.
 */
export function apply(input, level = "normal", random = Math.random) {
  if (!input) return input;
  const parts = String(input).split(/\n\s*\n/);

  const shaped = parts.map((part) => {
    let t = part.trim();
    if (!t) return t;
    t = enforceLowercase(t);
    // her laugh habit is lowercase even when the model shouts it: xDD -> xdd, and
    // capped at the same length her own rolled laugh would be - "xdddddd" is a tic
    t = t.replace(/(^|[^A-Za-z])([xX][dD]+)$/gm, (m, pre, mark) => {
      const lower = mark.toLowerCase();
      return `${pre}${lower.length > MAX_XD + 1 ? `x${"d".repeat(MAX_XD)}` : lower}`;
    });

    if (level === "normal") {
      t = dropApostrophes(t, 0.5, random);
      t = dropCommas(t, 0.4, random);
    } else if (level === "sloppy") {
      t = dropApostrophes(t, 0.9, random);
      t = dropCommas(t, 0.85, random);
      t = stretchLetters(t, 0.08, random);
      t = fumbleOneWord(t, 0.12, random);
    }

    // short bubbles lose their full stop - nobody types that
    const wordCount = t.split(/\s+/).filter(Boolean).length;
    const endsWithPeriod = /\.$/.test(t) && !/\.\.\.$/.test(t);
    if (endsWithPeriod) {
      const drop = level === "clean" ? 0.1 : level === "normal" ? (wordCount <= 12 ? 0.75 : 0.2) : 0.95;
      if (random() < drop) t = t.slice(0, -1).trimEnd();
    }
    return t;
  });

  return shaped.join("\n\n");
}
