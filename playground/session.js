// The playground: a locked room to actually talk to her.
//
// Why this exists: every other way of testing her either costs you your real
// memory (running the bot for real) or tests a guess about her (the synthetic
// scenarios). This runs the REAL pipeline, on the REAL model, against REAL
// messages - inside a throwaway copy of the bot with its own data folder, so your
// chat, your state.json and your history are never touched. Nothing is sent to
// Telegram either: the whole session runs in dry-run mode.
//
//   node playground/session.js probes             # the trap texts, in order
//   node playground/session.js file script.txt    # HIM: lines from a file
//   node playground/session.js say "you up?"      # one message, right now
//   node playground/session.js probes --cap 0.5   # and stop before spending $0.50
//
// How memory works here, and why it is safe:
//
//   * `playground/run/`  a fresh copy of the .js files, made on every run, so the
//                        session always exercises the code as it is right now
//   * `playground/data/` the conversation so far, as a plain readable text file
//                        (`HIM:` / `YOU:`). The harness replays it into her history
//                        before the session starts, which is how she remembers
//                        what was said in earlier sessions
//   * nothing under the project's own `data/` is read or written, ever
//
// Because the memory is a text file, you can read it, edit it, `rm` it, or diff
// it - which is a much better guarantee than a promise that nothing was written.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PROBES, TRUST_PROBES, QUALITY_PROBES } from "./probes.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUN = path.join(HERE, "run");
const DATA = path.join(HERE, "data");
const OUT = path.join(HERE, "out");
const BUDGET_FILE = path.join(DATA, "budget.json");

// what she actually costs per reply, measured (see the README): $0.00014 off-peak,
// $0.00028 at peak, and a regeneration roughly doubles one message. The estimate
// is deliberately pessimistic - it is a cap, not a forecast.
const ESTIMATE_PER_MESSAGE = 0.0004;

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? fallback : argv[at + 1] ?? true;
};
const has = (name) => argv.includes(`--${name}`);

function budget() {
  try { return JSON.parse(fs.readFileSync(BUDGET_FILE, "utf8")); } catch { return { spent: 0, sessions: 0 }; }
}
function record(entry) {
  const b = budget();
  const next = {
    spent: Number((b.spent + entry.cost).toFixed(6)),
    sessions: (b.sessions || 0) + 1,
    lastAt: new Date().toISOString(),
    lastLabel: entry.label,
  };
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** A fresh copy of the bot, so a session can never run stale code. */
function stage() {
  fs.rmSync(RUN, { recursive: true, force: true });
  fs.mkdirSync(path.join(RUN, "data"), { recursive: true });
  const copied = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.endsWith(".js") || f === "selftest.js") continue;
    fs.copyFileSync(path.join(ROOT, f), path.join(RUN, f));
    copied.push(f);
  }
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(RUN, "package.json"));
  return copied;
}

/** The sandbox's memory, seeded. Never the real one. */
function seed(copied, session) {
  const seedScript = path.join(RUN, "seed.mjs");
  const replay = session.turns
    .filter((t) => t.text)
    .map((t) => `mem.pushHistory(${t.r === "a" ? '"assistant"' : '"user"'}, ${JSON.stringify(t.text)});`)
    .join("\n");
  fs.writeFileSync(seedScript, [
    'import * as mem from "./memory.js";',
    'mem.bindOwner(7, "Commander");',
    "mem.addFacts([",
    '  "works as a developer, often at night",',
    '  "has a cat named Momo",',
    '  "lives in Dortmund",',
    '  "his sister is called Mara",',
    "]);",
    // an existing relationship, not day one: otherwise every session starts with
    // her still performing, and the thing being tested is the wrong girl
    "mem.state.boundAt = Date.now() - 40 * 86400000;",
    "mem.state.userMsgCount = 300;",
    "mem.state.mediaCount = 20;",
    "mem.state.factsSeenAt = 300;",
    replay,
    "mem.save();",
  ].join("\n"));
  return run(RUN, "node", ["seed.mjs"], {}).then(() => fs.rmSync(seedScript, { force: true }));
}

function run(cwd, cmd, args, env) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("error", (err) => finish({ code: -1, out: out + String(err?.message || err) }));
    child.on("close", (code) => finish({ code, out }));
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: -1, out: out + "\n[playground] the session ran longer than five minutes and was stopped" });
    }, 5 * 60 * 1000);
  });
}

const COST = /- cost: \$([0-9.]+)/g;
const costOf = (log) => [...String(log).matchAll(COST)].reduce((a, m) => a + Number(m[1]), 0);

/** `[hh:mm] YOU: bubble` per delivered message, back into turns for the memory file. */
function turnsFrom(text) {
  const turns = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^(?:\[[^\]]*\]\s*)?(HIM|YOU):\s*(.+)$/);
    if (!m) continue;
    const r = m[1] === "YOU" ? "a" : "u";
    const prev = turns[turns.length - 1];
    // consecutive bubbles are the same turn for the memory file, but the raw
    // transcript keeps them apart - that is what makes bubbles gradeable
    if (prev && prev.r === r && prev.bubbles.length && prev.bubbles[prev.bubbles.length - 1] === m[2]) {
      prev.bubbles.push(m[2]);
    } else {
      turns.push({ r, text: m[2].trim(), bubbles: [m[2].trim()] });
    }
  }
  return turns;
}

function readMemory(name) {
  const file = path.join(DATA, `${name}.txt`);
  if (!fs.existsSync(file)) return { turns: [], file };
  return { turns: turnsFrom(fs.readFileSync(file, "utf8")), file };
}

function writeMemory(name, transcript) {
  const file = path.join(DATA, `${name}.txt`);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\s*$/, "\n") : "";
  fs.appendFileSync(file, transcript.replace(/\s*$/, "\n"));
  return file;
}

async function main() {
  const cap = Number(flag("cap", 0.5));
  const keepGoing = has("continue");
  const name = String(flag("session", "probes"));

  const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "probes";
  let lines = [];
  let label = mode;

  let chosen = [];
  if (mode === "probes") {
    chosen = PROBES;
    lines = chosen.map((p) => p.text);
    label = "probes (the trap texts)";
  } else if (mode === "quality") {
    chosen = QUALITY_PROBES;
    lines = chosen.map((p) => p.text);
    label = "quality probes (is she alive, not just correct)";
  } else if (mode === "trust") {
    chosen = TRUST_PROBES;
    lines = chosen.map((p) => p.text);
    label = "trust probes (does she invent a shared past)";
  } else if (mode === "file") {
    const file = argv[1];
    if (!file || !fs.existsSync(file)) {
      console.error(`no such script file: ${file}`);
      process.exit(1);
    }
    lines = fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*(?:HIM|YOU)\s*:\s*/i, "").trim())
      .filter((l) => l && !l.startsWith("#"));
    label = path.basename(file);
  } else if (mode === "say") {
    // everything that is not a flag or a flag's value is the message: `say` takes
    // free text, so --dump and --cap must not end up inside what he "said"
    const words = [];
    for (let i = 1; i < argv.length; i += 1) {
      const a = argv[i];
      if (a.startsWith("--")) {
        if (["--session", "--cap", "--n"].includes(a)) i += 1;
        continue;
      }
      words.push(a);
    }
    lines = [words.join(" ")].filter(Boolean);
    label = "one message";
  } else {
    console.error("usage: node playground/session.js probes | trust | quality | file <script> | say \"<message>\" [--dump] [--cap 0.5]");
    process.exit(1);
  }

  if (!lines.length) {
    console.error("nothing to say");
    process.exit(1);
  }

  // what each message is aiming at, printed before the run so the transcript reads
  // as evidence rather than as a chat log
  if (chosen.length) {
    console.log("\nwhat these are designed to catch:");
    for (const p of chosen) console.log(`  ${p.id.padEnd(18)} ${p.catches}`);
  }

  // the cap is checked before the session, so a runaway script cannot burn through
  // it: the estimate is deliberately high and the actual is reconciled after
  const b = budget();
  const estimate = lines.length * ESTIMATE_PER_MESSAGE;
  if (b.spent + estimate > cap) {
    console.error(`that would need about $${estimate.toFixed(4)} and $${b.spent.toFixed(4)} of your $${cap.toFixed(2)} cap is already spent.`);
    console.error("raise it with --cap, or delete playground/data/budget.json to start counting again.");
    process.exit(1);
  }

  const conversation = readMemory(name);
  if (conversation.turns.length && !keepGoing) {
    console.log(`(this session continues "${name}" - ${conversation.turns.length} line(s) of memory already there.)`);
  }
  if (!conversation.turns.length && mode === "say") {
    console.log("(fresh memory for this session)");
  }

  const copied = stage();
  await seed(copied, conversation);

  const transcript = path.join(RUN, "transcript.txt");
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`\n--- talking to her: ${label} (${lines.length} message(s), own memory, nothing sent) ---`);
  const res = await run(RUN, "node", ["bot.js"], {
    NEGEV_DRY_RUN: "1",
    NEGEV_DRY_IGNORE_LOCK: "1",
    NEGEV_DRY_SCRIPT: lines.join(" || "),
    NEGEV_DRY_TRANSCRIPT: transcript,
    // --dump prints the internal notes that actually reached the model, which is
    // the only way to tell "she made that up" from "we told her to say it"
    ...(has("dump") ? { NEGEV_DRY_DUMP: "1" } : {}),
  });

  // her side of this session, and what it cost
  const said = turnsFrom(fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8") : "");
  const cost = costOf(res.out);
  const after = record({ cost, label });

  // the transcript is appended to the memory file, so the next session continues
  const spoken = (fs.existsSync(transcript) ? fs.readFileSync(transcript, "utf8") : "")
    .replace(/^\[[^\]]*\]\s*/gm, "");
  fs.writeFileSync(path.join(OUT, `${path.basename(name)}.log`), res.out);
  if (spoken.trim()) writeMemory(name, spoken);
  else console.log("\n(she said nothing at all this session - that is itself a finding, and the log says why)");

  console.log(`\n--- what she said (${said.filter((t) => t.r === "a").length} bubble(s)) ---`);
  for (const t of said) {
    const who = t.r === "a" ? "her" : "him";
    console.log(`${who.padEnd(3)} | ${t.text}`);
  }
  if (chosen.length) {
    // the same list again, so a judgement can be made against intent rather than
    // against what happens to read well
    console.log("\n--- and what each one was for ---");
    for (const p of chosen) console.log(`  ${p.id.padEnd(18)} ${p.person}`);
  }
  console.log(`\n--- cost ---`);
  console.log(`this session: $${cost.toFixed(6)} | counted so far: $${after.spent.toFixed(6)} of the $${cap.toFixed(2)} cap`);
  console.log(`raw log: ${path.relative(ROOT, path.join(OUT, `${path.basename(name)}.log`))}`);
  console.log(`memory:  ${path.relative(ROOT, conversation.file)} (plain text - read it, edit it, delete it)`);
  console.log(`grade it: node grader.js ${path.relative(ROOT, transcript)}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("playground crashed:", err?.stack || err);
  process.exit(1);
});
