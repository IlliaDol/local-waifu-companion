// Keep-alive runner for Negev-chan.
//
// Spawns bot.js and restarts it 5 seconds after any crash. This lives in Node
// on purpose: batch files and detached PowerShell launchers lose the child
// process when they exit, while a node parent stays put and can be tested.
//
// Exit code 3 from the bot means "another instance already owns the lock", so the
// runner stops instead of fighting it.
//
// Start her with:  node runner.js      (or start.bat / the NegevChan task)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const RESTART_DELAY_MS = 5000;
const DIR = process.cwd();
const LOG = path.join(DIR, "data", "negev.log");

function note(line) {
  const stamp = new Date().toISOString();
  const text = `${stamp} [runner] ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, text);
  } catch { /* ignore */ }
  process.stdout.write(text);
}

function spawnBot() {
  // Absolute path on purpose: the supervisor identifies our bot by its full
  // command line, so a bare "bot.js" would be invisible to that check.
  const child = spawn(process.execPath, [path.join(DIR, "bot.js")], {
    cwd: DIR,
    windowsHide: true,
    stdio: "ignore",
  });

  child.on("error", (err) => {
    note(`failed to start bot.js: ${err.message} - retrying in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(spawnBot, RESTART_DELAY_MS);
  });

  child.on("exit", (code, signal) => {
    if (code === 3) {
      note("another instance owns the lock - runner standing down");
      process.exit(0);
    }
    const why = signal ? `signal ${signal}` : `exit code ${code}`;
    note(`bot stopped (${why}) - restarting in ${RESTART_DELAY_MS / 1000}s`);
    setTimeout(spawnBot, RESTART_DELAY_MS);
  });

  const stop = () => {
    try { child.kill("SIGTERM"); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

note(`supervising bot.js in ${DIR}`);
spawnBot();
