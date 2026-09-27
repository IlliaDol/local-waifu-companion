// Local secret loader for Negev-chan.
//
// Reads .env (same folder, gitignored) and applies it OVER the ambient
// environment on purpose: a globally exported DEEPSEEK_API_KEY (user/system
// env, visible to the scheduled task) must not silently override the key
// pinned to this project. Inside this folder, .env is the source of truth —
// and this override applies ONLY to Negev-chan: no other project imports
// this file, and it never writes anything outside its own process.env.
//
// Import it FIRST in every entry point (bot.js, selftest.js, grader.js):
//   import "./dotenv.js";
// config.js then finds the key through its normal process.env fallbacks and
// the secret itself never needs to live inside any code file.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");

try {
  const text = fs.readFileSync(ENV_FILE, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") {
      process.env[m[1]] = value;
    }
  }
} catch {
  // No .env file: keys must come from the environment (task task/env, shell).
  // Nothing to do - config.js reports a clear error if the key is missing.
}
