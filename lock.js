// Single-instance lock that survives hard crashes correctly.
//
// A heartbeat timestamp cannot tell "alive" from "force-killed 20 seconds ago" -
// a killed process leaves a fresh-looking file behind, and the next instance then
// refuses to start. So the real lock is a bound TCP port on 127.0.0.1: the OS
// releases it the instant the process dies, whatever kills it.
//
//   * first instance binds 127.0.0.1:47631 and answers probes with a magic line
//   * another instance probes the port, sees the magic, and exits with code 3
//   * a stale lock file (crashed process) fails the probe, so the port is taken over
//
// data/bot.lock is still written every 30 seconds (pid + port + timestamp) so the
// Windows supervisor can see at a glance whether she is alive.
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "./config.js";
import { log, logErr } from "./util.js";

const PORT_CANDIDATES = [47631, 47632, 47633];
const MAGIC = "NEGEV-CHAN";
const LOCK_FILE = path.join(PATHS.data, "bot.lock");

let server = null;
let heartbeat = null;
let ownedPort = null;

function readLockFile() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

function probeOnce(port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk) => finish(String(chunk).includes(MAGIC)));
    socket.on("error", () => finish(false));
    socket.on("timeout", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

/**
 * One slow answer must not be read as "that port is somebody else's". If it is,
 * this instance decides every lock port is taken by a stranger, runs WITHOUT the
 * singleton, and starts polling - two bots on one token, which is the endless 409
 * "terminated by other getUpdates request" fight. A second try is cheap at
 * startup and removes the false negative that let that happen.
 */
async function probe(port) {
  if (await probeOnce(port, 900)) return true;
  return probeOnce(port, 1500);
}

function tryListen(port) {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      socket.end(`${MAGIC}\n`);
    });
    srv.once("error", () => {
      try { srv.close(); } catch { /* ignore */ }
      resolve(null);
    });
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

function writeHeartbeat() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, port: ownedPort, ts: Date.now() }));
  } catch { /* ignore */ }
}

/** Returns true when this process owns the singleton; exits with 3 when another copy runs. */
export async function acquireLock() {
  fs.mkdirSync(PATHS.data, { recursive: true });

  const existing = readLockFile();
  const candidates = [...new Set([existing?.port, ...PORT_CANDIDATES].filter(Boolean))];

  for (const port of candidates) {
    const srv = await tryListen(port);
    if (srv) {
      server = srv;
      ownedPort = port;
      writeHeartbeat();
      heartbeat = setInterval(writeHeartbeat, 30_000);
      heartbeat.unref?.();
      log(`[lock] singleton held on 127.0.0.1:${port}`);
      return true;
    }

    if (await probe(port)) {
      logErr(`[lock] another Negev is alive on 127.0.0.1:${port} - exiting`);
      process.exit(3);
    }
  }

  logErr("[lock] every lock port is taken by something else - running without the singleton");
  return false;
}

export function releaseLock() {
  clearInterval(heartbeat);
  heartbeat = null;
  try { server?.close(); } catch { /* ignore */ }
  const lock = readLockFile();
  if (!lock || lock.pid === process.pid) {
    try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
}

export function lockStatus() {
  return { port: ownedPort, pid: process.pid };
}
