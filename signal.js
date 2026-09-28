// Reading HIM.
//
// mood.js owns what SHE is feeling. This module owns what he just sent and what
// state he is in, which is the half of a conversation the first version barely
// looked at: seven keyword checks and nothing else. A girlfriend who notices you
// have gone monosyllabic, who hears that you are venting rather than joking, who
// answers the actual question you asked - that is most of what "she talks like a
// person" means, and none of it needed a bigger model.
//
// Everything in here is pure: text in, plain object out. No model calls, no
// imports beyond the clock, so the whole layer is testable and free.
import { nowBerlin } from "./util.js";

// Same stopword sense as memory.js/persona.js: "how are you" is not a topic.
const STOP = new Set(
  "the a an and or but of to in on at is are was were be am i you he she it my your me we they us for with about that this these those so just not no do does did done have has had will would can could should what how when where who why ok okay yeah hey hey hi hm hmm like really very much more most some any got get go goes going went know think thinks said says say thing things today tonight tomorrow yesterday because bit lot way now then there here one two isnt wasnt dont didnt im ill ive youve youre thats its".split(" "),
);

export function words(text) {
  return String(text || "").toLowerCase().match(/[a-z0-9']{2,}/g) || [];
}

/** Words that carry meaning - the ones a reply has to come back to. */
export function contentWords(text) {
  return words(text).filter((w) => w.length >= 3 && !STOP.has(w));
}

// ------------------------------------------------------------------ signals
const RE = {
  serious: /\b(down|depress\w*|sad|lonely|anxious|scared|exhausted|burnt out|burned out|hate (my|this|the)|want to quit|stressed|stress|wiped out)\b|\b(long|rough|hard|tough|shitty) (day|week|month|shift|one)\b|\btoday was (long|rough|hard|tough)\b/,
  affectionate: /\b(miss you|missed you|love you|luv u|thinking about you|thinking of you|want you|come over|i cant stop thinking)\b|<3/,
  explained: /\b(sorry|my bad|i apologise|i apologize|forgive me)\b|didnt mean|did not mean|was at work|off work|been at|at the gym|had a shift|was busy|just got (home|back|off)/,
  funny: /\b(lol|lmao|haha+|xd|funny|joke|hilarious|im dying)\b/,
  brb: /\b(give me some time|ill text you|i'll text you|text you when|be right back|brb|gonna rest|going to rest|im resting|i'm resting|take a nap|taking a nap|busy for a bit|back in a (bit|few|while|hour)|back later|see you later|talk later|catch you later|heading out|going out now)\b/,
  refusal: /\b(fuc?k?\s?off|fuc+k* of+f*|f off|piss off|get lost|leave me alone|stop asking|quit asking|i said (no|stop)|i dont wanna|don'?t wanna (answer|talk about)|dont want to (answer|talk about)|i'm not (answering|talking about)|not answering that|none of your business|drop it|let it go|dont worry about it|do not worry about it|why do you (care|keep asking)|no comment|skip that|next question|i'll pass|i will pass)\b/,
  invited: /\b(ask me|you can ask|go ahead and ask|you may ask|feel free to ask|i'll tell you|i will tell you|wanna hear|guess what|you can ask me)\b/,
  // he is getting something off his chest rather than chatting: complaints and
  // unfairness, usually long, usually not a question
  venting: /\b(so annoying|annoyed|annoying|pissed|fed up|sick of|tired of|cant stand|can't stand|hate (him|her|them|it|work|my job)|unfair|ridiculous|stupid|useless|nobody (listens|does)|why does (he|she|it|everyone)|drama|argued|argument|fight with)\b/,
  flirty: /\b(come over|stay the night|youre cute|you look|hot|cute|babe|baby|kiss|tease me|wish you were here|in bed|shower)\b/,
  goodnight: /\b(good ?night|gn\b|going to (sleep|bed)|off to bed|heading to bed|sleep well|talk tomorrow|night night)\b/,
  // one-word answers, drip-fed: the loudest "something is off" there is
  dryOnly: /^(k+|ok(ay)?|hm+|hmm+|mhm|yeah|yea|yep|yup|no|nope|np|sure|fine|cool|nice|lol|haha+|lmao|idk|meh|same|nothing|whatever|true|right)[.!?\s]*$/,
  // he is putting her right about something she got wrong. A person says "my bad,
  // you said tuesday" once and moves on - the machine behaviour is defending the
  // wrong version, or apologising for three messages
  correction: /\b(thats not what i said|that is not what i said|not what i said|not what i meant|i meant\b|i never said|i didnt say|i did not say|you got (it|that) wrong|youre wrong about|no[,.]? i said\b|correct(ion)?:|actually,? i said|it was (monday|tuesday|wednesday|thursday|friday|saturday|sunday),? not)/,
  // data science / stats / ML / the tooling around them - her own field, and the
  // one topic where she answers from her own head instead of the web reader
  dataScience: /\b(data\s*science|data\s*analytics|dataset|data\s*set|statistic\w*|\bstats\b|probability|bayesian|regression|classification|clustering|k-?means|machine\s*learning|deep\s*learning|neural\s*net\w*|\bcnn\b|\brnn\b|transformer\w*|gradient\s*descent|backprop\w*|overfit\w*|underfit\w*|cross-?validation|hyperparameter\w*|feature\s*(engineering|selection)|confusion\s*matrix|precision.{0,3}recall|\bauc\b|\broc\b|p-?value|p-?hack\w*|hypothesis\s*test\w*|confound\w*|causal\w*|correlation|sampling\s*bias|selection\s*bias|class\s*imbalance|distribution\s*shift|(data|target)\s*leakage|train.?test\s*split|\bpandas\b|\bnumpy\b|scipy|matplotlib|seaborn|plotly|tidyverse|ggplot\w*|\bRStudio\b|scikit-?learn|\bsklearn\b|\bxgboost\b|\blightgbm\b|\bpytorch\b|\btensorflow\b|\bkeras\b|\bmlops\b|data\s*pipeline\w*|\betl\b|\bsql\b|postgres\w*|dataframe|data\s*wrangling|\balgorithm\w*|data\s*structure\w*|pointer\w*|memory\s*management|time\s*complexity|big-?o\s*notation|z-?score|standard\s*deviation|\bvariance\b|central\s*limit|confidence\s*interval|linear\s*algebra|eigenvalue\w*|matrix\w*|calculus|loss\s*function|\bepochs?\b|batch\s*size|learning\s*rate|model\s*(evaluation|monitoring|deployment)|a\/b\s*test\w*|experiment\s*design|\bnlp\b|spacy|word\s*vector\w*|named\s*entity|time\s*series|forecast\w*|arima|prophet|large\s*language\s*model\w*|\bllms?\b|fine-?tun\w*|retrieval\s*augmented|\brag\b|embedding\w*|agent\w*|reinforcement\s*learning|\bhadoop\b|\bspark\b|\bkafka\b|\bflink\b|distributed\s*system\w*|\baws\b|\bgcp\b|\bazure\b|bigquery|snowflake|\bdbt\b|airflow|docker|kubernetes|fastapi|mlflow|\bdvc\b|tableau|power\s*bi|excel|dashboard\w*|business\s*metric\w*|\bkpi\b|warehouse\s*model\w*|star\s*schema|observability|ci\/cd|git|terminal|responsible\s*ai|fairness|ethics|portfolio|interview|my\s+course\w*|coursework|assignment\w*|homework|\bproblem\s+set\b|\bthesis\b|dissertation|\blecture\w*|semester|\bprofessor\b|\bexam\w*|midterm|\buni\b|university|\bstud(y|ies|ied|ying)\b|bachelor\w*|master'?s\s+(degree|program\w*)|degree\s+program\w*|study\s+group|revision\s+session)\b/,
};

/**
 * What he just sent. Superset of the old mood.readSignal: everything that was
 * there still is (mood.react reads it), plus the states that make her sound like
 * she is paying attention - dry, excited, venting, asking, flirty, goodnight.
 */
export function readHis(text) {
  const t = String(text || "").toLowerCase();
  const w = words(t);
  const has = (re) => re.test(t);
  const asking = questionIn(text) !== null;
  return {
    serious: has(RE.serious),
    affectionate: has(RE.affectionate),
    explained: has(RE.explained),
    funny: has(RE.funny),
    brb: has(RE.brb),
    refusal: has(RE.refusal),
    invited: has(RE.invited),
    correction: has(RE.correction),
    venting: has(RE.venting) && !has(RE.serious),
    flirty: has(RE.flirty) && !has(RE.serious),
    goodnight: has(RE.goodnight),
    dataScience: has(RE.dataScience),
    asking,
    // three words or fewer on its own, or a message made entirely of yeah/k/fine
    dry: w.length <= 3 || RE.dryOnly.test(t.trim()),
    excited: has(/!{2,}/) ? true : has(/!/) && w.length >= 8,
    // he wrote something with actual substance: the length of her reply should
    // be able to follow it
    long: w.length >= 45,
    words: w.length,
  };
}

/**
 * The real routing decision for a message - not just a note in a prompt string.
 * Data-science topics answer from her internal knowledge and never enter the
 * web reader, so links cannot leak snippets or spend a web-read quota.
 */
export function topicMode(text) {
  return readHis(text).dataScience
    ? { topic: "data_science", webAllowed: false, knowledgeSource: "internal" }
    : { topic: "general", webAllowed: true, knowledgeSource: "mixed" };
}

// -------------------------------------------------------------- his question
// the knock-at-the-door questions: answered by replying at all
const PRESENCE = new Set(["around", "up", "there", "awake", "home", "about", "free", "here", "alive", "back", "busy"]);

/**
 * The question he is actually waiting on: the last line carrying a `?`, reduced
 * to the words a reply would have to come back to. Returns null when there is
 * nothing to check - "you ok?" and "wyd?" are all function words, and inventing
 * an obligation out of those would make her answer a question nobody asked.
 */
export function questionIn(text) {
  const lines = String(text || "").split(/\n+/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes("?")) continue;
    // only the sentence that ends in the question mark
    const m = line.match(/([^?]*\?)\s*$/);
    const q = (m ? m[1] : line).trim();
    const cw = contentWords(q);
    if (!cw.length) return null;
    // "you around?" / "you up?" / "you awake?" are not a question with an answer,
    // they are a knock. The reply IS the answer, so there is nothing to check and
    // nothing to fail - "im here" answers it completely, and treating it as an
    // obligation would buy a wasted regeneration on every good-morning text.
    if (cw.every((w) => PRESENCE.has(w))) return null;
    // "how was X" / "did X happen" - answered by an evaluation of X, even when
    // she never reuses his word for it (see answered())
    const evaluative = /\b(how|was|were|is|are|did|does|any|much)\b/i.test(q);
    // a question asking for a value ("what was X", "who is Y", "where did you") is
    // answered by giving it, which may look nothing like the question
    const asksForValue = /^\s*(what|who|where|when|which|whose)\b/i.test(q) || /\b(what|who|where|when|which)\b[^?]*\b(know|think|remember|say|tell|call|name)\b/i.test(q);
    // a question that can be answered with yes or no, which is most of them
    const yesNo = /^\s*(is|are|was|were|do|does|did|have|has|had|can|could|will|would|should|shall|any|ever)\b/i.test(q);
    return { text: q.slice(0, 160), words: cw.slice(0, 8), evaluative, asksForValue, yesNo };
  }
  return null;
}

/**
 * Did she answer it? Deliberately loose - one shared word (or a shared stem, so
 * "shift"/"shifts" counts) is enough, because the point is to catch a reply that
 * ignored him completely and talked about her own day instead, not to grade her.
 *
 * The second path matters as much: "how was the warehouse tonight?" is answered
 * by "night shift was fine" - she gave him the evaluation he asked for without
 * repeating his noun, and flagging that would buy a wasted regeneration on almost
 * every question he ever asks.
 */
const EVALUATION = /\b(fine|good|bad|ok|okay|better|worse|cool|nice|tired|busy|quiet|weird|hard|rough|long|short|stress\w*|love\w*|hate\w*|bor\w*|fun|blah|exhaust\w*|killed|dead|same as always|not much)\b/;

export function answered(question, reply) {
  if (!question || !question.words?.length) return true;
  const body = String(reply || "");
  const rw = new Set(words(body));
  // stems catch plural and tense drift (shift/shifts, called/call), and the small
  // irregular map catches the ones stemming cannot: "what did i tell you" answered
  // by "you TOLD me" is a complete answer, and it used to be flagged as ignored -
  // which bought a wasted regeneration on a reply that was already right.
  const stems = new Set([...rw].map((w) => w.slice(0, 4)));
  for (const w of question.words) {
    if (rw.has(w)) return true;
    if (w.length >= 4 && stems.has(w.slice(0, 4))) return true;
    // tell/told, say/said, get/got: the same answer in another tense
    if (VERB_FORMS[w] && VERB_FORMS[w].some((form) => rw.has(form))) return true;
  }
  // an evaluation answers "how was X" - but NOT a question that is asking her to
  // recall something, or every reply containing the word "tired" would pass
  // "what did i tell you my cat is called"
  if (question.evaluative && !question.asksForValue && EVALUATION.test(body)) return true;
  // a yes/no question answered by "no not yet, i kept putting it off" is answered:
  // the polarity is the answer, and it is how people actually reply to one
  if (question.yesNo && YES_NO.test(body.trim())) return true;
  // A presence question is answered by the smallest reply there is. "heyy, are you
  // still here?" -> "im here. was half asleep with my phone on my face" is a
  // complete answer that shares no content word with the question, and it was
  // flagged as ignored - which buys a regeneration on a reply that was already
  // right, and the second draft is the one that gets worse.
  if (ASKS_IF_HERE.test(String(question.text || "")) && ANSWERS_PRESENCE.test(body)) return true;
  // A question asking for a value is answered by *giving* it, which can look
  // nothing like the question: "what did i tell you my cat is called" -> "momo. you
  // told me momo." shares nothing and is perfect.
  //
  // The guard is strict, and deliberately so - an earlier version of this rule was
  // "any short reply counts", which also passed "ugh i had the worst day at work
  // today, my manager was awful": a reply that ignores him completely. So a fact
  // answer has to be genuinely short AND carry something that was not already in
  // his question. Otherwise this check stops catching the one thing it is for.
  if (question.asksForValue && words(body).length <= 8) {
    const his = new Set(question.words);
    if (contentWords(body).some((w) => !his.has(w))) return true;
  }
  return false;
}

const YES_NO = /^(yes|yeah|yep|yup|no|nope|nah|not|never|sort of|kind of|kinda|mostly|maybe|probably|course|obviously|sure|didn'?t|havent|haven'?t|dont|don'?t)\b/i;

/** "are you still there" - the question that is about her being present at all. */
const ASKS_IF_HERE = /\b(still (there|here|around|up|awake|about)|are you (there|here|around|up|awake|asleep)|you (there|here|around|awake|asleep)\b|still with me)\b/i;
/** ...and the answer to it, in any of the shapes people use for one. */
const ANSWERS_PRESENCE = /\b(i'?m|im|yeah|yes|yep|here|there|around|awake|asleep|online|no|nope|nah|sorry)\b/i;

// enough irregular pairs that "what did i tell you" and "how did you get on" are
// not read as unanswered (the question's form on the left, any form on the right)
const VERB_FORMS = {
  tell: ["told", "telling", "tells"], say: ["said", "saying", "says"], ask: ["asked", "asking"],
  get: ["got", "getting"], go: ["went", "going", "gone"], come: ["came", "coming"],
  see: ["saw", "seeing", "seen"], eat: ["ate", "eating", "eaten"], think: ["thought", "thinking"],
  buy: ["bought", "buying"], find: ["found", "finding"], give: ["gave", "giving", "given"],
  know: ["knew", "known", "knowing"], take: ["took", "taking", "taken"], make: ["made", "making"],
  have: ["had", "having"], feel: ["felt", "feeling"], meet: ["met", "meeting"],
  leave: ["left", "leaving"], bring: ["brought", "bringing"], send: ["sent", "sending"],
  read: ["reading"], speak: ["spoke", "speaking", "spoken"], hear: ["heard", "hearing"],
  hurry: ["hurried"], call: ["called", "calling"], remember: ["remembered", "remembers", "mention", "mentioned"],
};

// ------------------------------------------------------------- his own state
/**
 * The shape of his side of the last dozen turns: how much he is writing, whether
 * he has gone short with her, and whether something he asked is still hanging.
 */
// "wait what", "oh no", "hm", "same" - a reaction IS a reply, and it often shares
// nothing at all with his wording. That is why overlap alone can never be the test.
const REACTS = /^(wait|what\b|no way|non?o+|oh\b|oh no|hm+|huh|really|same|dude|damn|seriously|what the|stop|omg|lol|lmao|haha|ok\b|okay|yeah|yea|yep|true|fair|rude|excuse me|cant|haha|nice|oof|yikes|jesus|god)/i;

/**
 * Did she answer the message or the mood?
 *
 * The failure this exists for, from a live probe: he wrote "the radiator thing got
 * worse. the whole flat sounds like a train station now" and she answered "you live
 * in dortmund right? i keep forgetting. how long have you been there" - ignoring
 * what he said, and asking about a fact she has known for months. `answered()` only
 * covers direct questions, and the grader's continuity dimension had a score but no
 * teeth in the reply path, so the tell reached him.
 *
 * It has to be narrow, because the false positive is worse than the miss: a real
 * reaction shares no wording on purpose, and a two-word beat cannot carry a topic
 * change. So it fires only when his message carried real content (5+ meaning words),
 * her reply was long enough to have referenced him (5+ meaning words) and did not
 * open as a reaction, and not one meaning word is shared between them.
 */
export function talksPast(his, her) {
  const mine = contentWords(his);
  if (mine.length < 5) return false;
  const hers = String(her || "").trim();
  if (!hers) return false;
  const reply = contentWords(hers);
  if (reply.length < 5) return false;
  if (REACTS.test(hers)) return false;
  const shared = new Set(mine);
  return !reply.some((w) => shared.has(w));
}

/**
 * Is this "fact about him" only something SHE said?
 *
 * The fact pass reads the last thirty turns, each tagged HIM or YOU, and asked it
 * for durable facts about him. In a live session her own invention went in and came
 * back out as a fact about his life: the sandbox's stored list literally read
 * `"his sister is called Mara"`, from her line *"you said your sister was called
 * Mara"* - and every later turn asked about a sister who does not exist. A prompt
 * rule asking for provenance helps and is not a guarantee; this is the guarantee.
 *
 * The word "sister" was in his own lines, so a rule that only asks "did any of this
 * come from him?" waves the invented NAME through on the back of a real noun. So
 * every word that carries meaning has to be his, and the words the extractor uses
 * to phrase a fact at all ("named", "called", "works", "lives") do not count as
 * evidence either way. Short words are ignored because they cannot distinguish
 * anything: "cat" is in the fact `has a cat` and proves nothing on its own.
 *
 * The first version of this required EVERY meaning word to be his, and measurement
 * killed it: on a realistic excerpt it threw away three of four true facts, because
 * the model paraphrases ("shipped the thing" becomes "shipped a release") and a
 * paraphrase is not a lie. What is actually dangerous is narrower than "a word she
 * said", and it is two things:
 *
 *   1. a NAME she introduced - her invention of "his sister is called Mara" rode in
 *      on the back of the word "sister", which he had really said. A capitalised
 *      word in her own lowercase typing is a name, and a name he never gave her is
 *      the fact she can never be corrected out of.
 *   2. an AGREEMENT she invented - "we agreed i would call him at eleven" is the
 *      other thing she cannot know and he cannot argue with.
 *
 * Both are checked against his own lines only, both leave ordinary paraphrases alone,
 * and the demo (`node playground/facts.js`) prints either verdict per proposed fact.
 */
const FACT_BOILER = new Set([
  "named", "called", "name", "names", "works", "working", "lives", "living", "likes",
  "loves", "hobby", "hobbies", "favourite", "favorite", "really", "often", "sometimes",
  "still", "also", "about", "thing", "things", "there", "their", "which", "because",
]);
const AGREEMENT = /\b(agreed|agreement|promised|promise|decided|settled|arranged|we said|told me to|asked me to)\b/i;

const decisive = (fact) =>
  contentWords(String(fact || "").toLowerCase()).filter((w) => w.length >= 4 && !FACT_BOILER.has(w));

function hisText(excerpt) {
  return String(excerpt || "")
    .split("\n")
    .filter((l) => /^\s*HIM:/i.test(l))
    .join(" ")
    .toLowerCase();
}

function herLines(excerpt) {
  return String(excerpt || "")
    .split("\n")
    .filter((l) => /^\s*YOU:/i.test(l))
    .map((l) => l.replace(/^\s*YOU:\s*/i, ""));
}

/** A name in the fact that she introduced and he never said. */
export function inventedNameOnly(fact, excerpt) {
  const his = hisText(excerpt);
  const own = decisive(fact);
  if (!own.length) return false;
  const lines = herLines(excerpt);
  return own.some((w) => {
    if (his.includes(w)) return false;
    return lines.some((line) => {
      const cap = `${w[0].toUpperCase()}${w.slice(1)}`;
      // capitalised somewhere that is not just the start of a sentence: her typing is
      // lowercase, so "you said your sister was called Mara" is a name and not a word
      return new RegExp(`[^.!?\\s]\\s${cap}\\b`).test(line) || new RegExp(`^${cap}\\b`).test(line.trim());
    });
  });
}

/** An agreement she claims they made, with no agreement anywhere in his lines. */
export function inventedAgreement(fact, excerpt) {
  const f = String(fact || "");
  if (!AGREEMENT.test(f)) return false;
  const his = hisText(excerpt);
  const own = decisive(f);
  if (!own.length) return false;
  return own.some((w) => !his.includes(w));
}

/** Both halves, for the one call site in the fact pass. */
export function herClaimOnly(fact, excerpt) {
  return inventedNameOnly(fact, excerpt) || inventedAgreement(fact, excerpt);
}

export function engagement(history = [], { turns = 14 } = {}) {
  const slice = (history || []).slice(-turns);
  const his = slice.filter((h) => h && h.r === "u");
  const counts = his.map((h) => words(h.t).length);
  let dryStreak = 0;
  for (let i = his.length - 1; i >= 0; i -= 1) {
    if (counts[i] <= 3) dryStreak += 1;
    else break;
  }
  const total = counts.reduce((a, b) => a + b, 0);
  // a question of his that is still open: his messages since her last reply
  let pending = null;
  for (let i = slice.length - 1; i >= 0; i -= 1) {
    const h = slice[i];
    if (!h || h.r !== "u") break;
    const q = questionIn(h.t);
    if (q) pending = q; // the oldest one in that run is the one still waiting
  }
  const media = his.filter((h) => /^\[(photo|video|voice|audio|animation|round video|sticker|file)/i.test(h.t)).length;
  return {
    turns: his.length,
    avgWords: his.length ? Math.round(total / his.length) : null,
    dryStreak,
    total,
    long: total >= 150,
    media,
    pending,
  };
}

// ------------------------------------------------------------------- register
/**
 * What this CONVERSATION is, as opposed to how she feels. Her mood lasts hours
 * and belongs to her day; a register lasts a few of his messages and belongs to
 * the thing you two are doing right now. Venting, deep, banter, logistics and
 * flirting each demand different manners - joking through a real conversation is
 * the single most machine-like thing a chat partner can do.
 */
export const TONES = {
  deep: {
    label: "a real conversation",
    msgs: [5, 8],
    how: "this is not banter, he is telling you something that matters. Slower, fewer jokes, no teasing about the thing itself, and be honest back instead of performing",
  },
  venting: {
    label: "him letting off steam",
    msgs: [4, 7],
    how: "he needs to be heard, not fixed. No advice unless he asks for it, no turning it into a story about your day, no bright-siding it. Short reactions that show you are following, one real question at most",
  },
  logistics: {
    label: "making plans",
    msgs: [3, 5],
    how: "this is about times and places. Be concrete and quick - yes, no, when - and leave the flirting paragraphs for later",
  },
  flirty: {
    label: "the two of you flirting",
    msgs: [4, 6],
    how: "he is playing. Play back: warm, a little suggestive, quick comebacks, and never soppy",
  },
  banter: {
    label: "you two fooling around",
    msgs: [4, 8],
    how: "this is a bit. Tease him, one-up him, keep it short and fast, and do not get sincere in the middle of it",
  },
};

function classify(signal, text, eng) {
  // his own hold and his own no are handled elsewhere and must not become a
  // register of their own
  if (signal.refusal || signal.brb || signal.goodnight) return null;
  if (signal.serious) return "deep";
  if (signal.venting) return "venting";
  // making plans, not asking how his evening went: needs a planning shape, not just
  // the word "tonight" in it
  if (signal.asking && /(what time|which day|what day|are you (free|around|home|coming)|when (are|do|can|will|should)|shall (i|we)|plans? for|pick me up|meet (me|up)|do you want to (come|meet)|are we (still )?(on|meeting))/i.test(String(text || ""))) return "logistics";
  if (signal.flirty || signal.affectionate) return "flirty";
  if (signal.funny) return "banter";
  void eng;
  return null;
}

/**
 * The register for this exchange, and how much of it is left. A register that is
 * still alive survives his next message (people do not change subject every
 * line), but every message of his spends one of its turns, so nothing sticks for
 * an hour the way a mood can.
 */
export function nextTone({ signal = {}, text = "", engagement: eng = null, previous = null, msgs = 1, random = Math.random } = {}) {
  // he told her to back off, or that he is stepping away: whatever they were
  // doing, they are not doing it any more
  if (signal.refusal || signal.brb) {
    return { key: null, left: 0, since: Date.now(), changed: Boolean(previous?.key) };
  }
  const want = classify(signal, text, eng);
  if (want) {
    const def = TONES[want];
    const span = def.msgs[1] - def.msgs[0];
    const left = def.msgs[0] + Math.floor(random() * (span + 1));
    return { key: want, left, since: Date.now(), changed: previous?.key !== want };
  }
  if (previous?.key && (previous.left || 0) > msgs) {
    return { ...previous, left: previous.left - msgs, changed: false };
  }
  if (previous?.key) return { key: null, left: 0, since: Date.now(), changed: true };
  return previous ? { ...previous, changed: false } : { key: null, left: 0, changed: false };
}

// ------------------------------------------------------- when he is actually up
// Her day is entirely her own invention; she never noticed when he is around.
// This is a 24-bucket histogram of his local hours, decayed slowly so it learns
// weeks rather than last night, and it stays a bias - a girlfriend who texts at
// the exact same clock time every day is a cron job.
export function noteActivity(state, at = Date.now()) {
  if (!state) return;
  const saved = Array.isArray(state.hisHours) ? state.hisHours : [];
  const hours = Array.from({ length: 24 }, (_, i) => Number(saved[i] || 0) * 0.97);
  hours[nowBerlin(new Date(at)).hour] += 1;
  state.hisHours = hours.map((n) => Math.round(n * 10) / 10);
}

/** How likely he is to be awake and answering around that hour, 0..1. */
export function hisWindowScore(state, t = nowBerlin()) {
  const hours = state?.hisHours;
  if (!Array.isArray(hours) || hours.length < 24) return 0;
  const at = (h) => hours[((h % 24) + 24) % 24] || 0;
  const near = at(t.hour) + 0.5 * (at(t.hour - 1) + at(t.hour + 1));
  const max = Math.max(...hours, 0);
  return max > 0 ? Math.min(1, near / (max * 1.2)) : 0;
}

/**
 * The minutes-of-day where he actually answers, inside her waking hours. Empty
 * until there is real signal - a few messages are not a habit.
 */
export function hotHours(state, { from = 8 * 60, to = 23 * 60, limit = 4 } = {}) {
  const hours = state?.hisHours;
  if (!Array.isArray(hours) || hours.length < 24) return [];
  if (hours.reduce((a, b) => a + b, 0) < 8) return [];
  return hours
    .map((n, h) => ({ n, min: h * 60 }))
    .filter((x) => x.min >= from && x.min <= to && x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((x) => x.min);
}

/** One line for /status. */
export function describe(state, t = nowBerlin()) {
  const hot = hotHours(state, { limit: 3 });
  const when = hot.length
    ? `he usually writes around ${hot.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:00`).join(", ")}`
    : "not enough of his messages yet to know his hours";
  const score = Math.round(hisWindowScore(state, t) * 100);
  return `${when} (right now: ${score}% likely he is around)`;
}
