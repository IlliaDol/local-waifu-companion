// What would the fact pass actually remember?
//
// The fact pass is the one place where something she said can become a fact about
// HIM, and a live sandbox session is where that went wrong: its stored list ended up
// containing "his sister is called Mara", a name that existed only in her own line
// "you said your sister was called Mara". The prompt asks for provenance and the
// filter in signal.js enforces it, so this script exists to show which of the two is
// doing the work - run it against a poisoned excerpt and watch the model still
// propose the invented fact while the filter throws it away.
//
// It reads an excerpt and writes NOTHING: no memory, no state, no history.
//
//   node playground/facts.js                    # a poisoned excerpt built in
//   node playground/facts.js excerpt.txt        # HIM:/YOU: lines, one per line
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { factsPrompt } from "../persona.js";
import { herClaimOnly } from "../signal.js";
import { llm } from "../deepseek.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const BUILT_IN = [
  "HIM: work was fine, i shipped the thing on friday and nobody complained yet",
  "YOU: thats my developer. told you it was fine",
  "HIM: my sister anna is driving me insane this week",
  "YOU: wait anna? you said your sister was called Mara",
  "YOU: and we agreed i would call you at eleven, dont pretend",
  "HIM: i never said eleven. anyway i am tired, long day",
].join("\n");

const file = process.argv[2];
const excerpt = file ? fs.readFileSync(path.isAbsolute(file) ? file : path.join(HERE, file), "utf8").trim() : BUILT_IN;

console.log(`--- excerpt (${excerpt.split("\n").length} line(s)) ---\n${excerpt}\n`);
console.log("--- asking the real fact pass ---");

const out = await llm(
  [{ role: "system", content: factsPrompt }, { role: "user", content: excerpt }],
  { maxTokens: 320, temperature: 0.2 },
);

const start = out.indexOf("{");
const end = out.lastIndexOf("}");
if (start < 0 || end <= start) {
  console.error("no json came back:\n", out.slice(0, 400));
  process.exit(1);
}
const obj = JSON.parse(out.slice(start, end + 1));

const rows = [
  ...(obj.facts || []).map((f) => ["facts (about him)", f]),
  ...(obj.ours || []).map((o) => ["ours (shared)", o]),
  ...(obj.canon || []).map((c) => ["canon (her own, unfiltered by design)", c]),
];

for (const [group, entry] of rows) {
  const sourced = group.startsWith("canon") ? true : !herClaimOnly(entry, excerpt);
  console.log(`  ${sourced ? "KEEP  " : "DROP  "} [${group}] ${entry}`);
}
if (!rows.length) console.log("  (nothing proposed)");

const mine = rows.filter(([g]) => !g.startsWith("canon"));
const after = mine.filter(([, e]) => !herClaimOnly(e, excerpt));
console.log(
  `\nproposed about him or the two of them: ${mine.length} | kept after the provenance filter: ${after.length}` +
    (mine.length === after.length ? "  (the model was right this time - the filter is the guarantee, not the fix)" : "  (the filter is what stopped it)"),
);

// The model behaves most of the time, so the filter's own two rules are shown on
// fixed sample facts as well: the demo should never read as "nothing to see here".
console.log("\n--- the filter's own two rules, on fixed samples (no api call) ---");
for (const fact of [
  "his sister is called mara",
  "we agreed i would call him at eleven",
  "has a sister named anna",
  "works as a developer",
]) {
  const drop = herClaimOnly(fact, excerpt);
  console.log(`  ${drop ? "DROP  " : "KEEP  "} "${fact}"`);
}
