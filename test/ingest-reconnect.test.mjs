// Reconnect / liveness tests for src/ingest.mjs.
//
// These reproduce the 2026-09-02 production failure (all relay sockets
// closed -> Node event loop drained -> clean exit 0 -> systemd
// Restart=on-failure did nothing -> stale cache for 16h) and prove
// each fix. Runs the REAL ingest code path with a fake local relay,
// an injected importer (no ndb), an injected identity (no
// omostrich-ctl), and fast timers. `node --test test/`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIngest, backoffDelay, DEFAULTS } from "../src/ingest.mjs";
import { startFakeRelay } from "./fake-relay.mjs";

const PUBKEY = "ab".repeat(32);
const IDENTITY = { pubkeyHex: PUBKEY, npub: "npub1test" };
const here = path.dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, { timeoutMs = 5000, everyMs = 25, what = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return;
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
}

// Fast clock so the whole file runs in seconds, same code path as prod.
const FAST = {
  flushIntervalMs: 50,
  backfillTimeoutMs: 1000,
  backoffBaseMs: 40,
  backoffMaxMs: 200,
  heartbeatMs: 100,
  pingIntervalMs: 0, // ping path tested separately
  pongTimeoutMs: 50,
  allDownExitMs: 0,
  resubscribeOverlapSec: 600,
  noSignalHandlers: true,
};

function collector() {
  const lines = [];
  const imported = [];
  return {
    lines,
    imported,
    log: (m) => lines.push(m),
    importer: (batch) => imported.push(...batch),
    has: (re) => lines.some((l) => re.test(l)),
    count: (re) => lines.filter((l) => re.test(l)).length,
  };
}

test("backoff is exponential, jittered, and bounded", () => {
  const o = { backoffBaseMs: 100, backoffMaxMs: 1000 };
  assert.equal(backoffDelay(0, o, () => 1), 100);
  assert.equal(backoffDelay(1, o, () => 1), 200);
  assert.equal(backoffDelay(2, o, () => 1), 400);
  assert.equal(backoffDelay(3, o, () => 1), 800);
  assert.equal(backoffDelay(4, o, () => 1), 1000, "capped at max");
  assert.equal(backoffDelay(50, o, () => 1), 1000, "huge attempt still capped, no overflow");
  assert.equal(backoffDelay(2, o, () => 0), 200, "min jitter is 50% of exp, never 0");
  for (let i = 0; i < 200; i++) {
    const d = backoffDelay(3, o);
    assert.ok(d >= 400 && d <= 800, `jittered ${d} within [400,800]`);
  }
  assert.ok(DEFAULTS.backoffMaxMs >= 60_000, "prod cap is at least a minute");
});

test("relay socket dropped -> reconnects, re-subscribes with since, keeps ingesting", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  const h = await runIngest({ ...FAST, relays: [relay.url], identity: IDENTITY, log: c.log, importer: c.importer });
  try {
    await waitFor(() => c.imported.length >= 1, { what: "initial backfill import" });
    assert.equal(relay.reqs.length, 1);
    assert.equal(relay.reqs[0].filters[0].since, undefined, "first REQ has no since");
    assert.equal(h.stats().connected, 1);

    // --- the production failure: relay slams the socket shut ---
    relay.killAllClients();
    await waitFor(() => c.has(/relay closed \(/), { what: "close logged" });
    await waitFor(() => c.has(/reconnect scheduled .*attempt 1 in \d+ms/), { what: "reconnect scheduled log" });
    await waitFor(() => relay.reqs.length >= 2, { what: "re-subscribe after reconnect" });
    await waitFor(() => c.has(/^reconnected: .*reconnect #1/), { what: "reconnected log" });

    const re = relay.reqs[1];
    assert.equal(re.subId, "omostrich-db-ingest");
    assert.ok(Number.isFinite(re.filters[0].since), "re-subscribe carries a since");
    const nowSec = Math.floor(Date.now() / 1000);
    assert.ok(re.filters[0].since <= nowSec - 500, "since is backdated by overlap window");

    // continued ingest after reconnect: the fake relay emits a fresh
    // event per REQ, so a second import must land
    await waitFor(() => c.imported.length >= 2, { what: "post-reconnect import" });
    assert.equal(h.stats().connected, 1);
    assert.equal(h.stats().relays[0].reconnects, 1);
    assert.equal(h.stats().relays[0].closes, 1);
    assert.ok(c.has(/^ALL 1 relay\(s\) disconnected/), "all-down logged when the only relay dropped");
    assert.ok(c.has(/connectivity restored \(1\/1 connected\)/), "restoration logged");
  } finally {
    h.stop();
    await relay.close();
  }
});

test("one dead relay does not stop the others or the process", async () => {
  const good = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  // port 1 on localhost: nothing listens, connect fails immediately (ECONNREFUSED)
  const dead = "ws://127.0.0.1:1";
  const h = await runIngest({ ...FAST, relays: [dead, good.url], identity: IDENTITY, log: c.log, importer: c.importer });
  try {
    await waitFor(() => c.imported.length >= 1, { what: "import from the good relay" });
    await waitFor(() => c.count(/reconnect scheduled \(ws:\/\/127\.0\.0\.1:1\)/) >= 3, {
      what: "dead relay keeps retrying",
    });
    const s = h.stats();
    assert.equal(s.connected, 1);
    assert.equal(s.relays.find((r) => r.url === good.url).connected, true);
    const d = s.relays.find((r) => r.url === dead);
    assert.equal(d.connected, false);
    assert.ok(d.attempt >= 3, `dead relay attempt counter climbing (${d.attempt})`);
    assert.ok(!c.has(/^ALL 2 relay/), "never went all-down because the good relay stayed up");
    // and the good one still streams after all that
    good.killAllClients();
    await waitFor(() => c.imported.length >= 2, { what: "good relay reconnect + import" });
  } finally {
    h.stop();
    await good.close();
  }
});

test("heartbeat logs connected count, last-event/import age, per-relay state", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  const h = await runIngest({ ...FAST, relays: [relay.url], identity: IDENTITY, log: c.log, importer: c.importer });
  try {
    await waitFor(() => c.count(/^heartbeat: relays 1\/1 up \| last event \d+s ago \| last import \d+s ago \| imported \d+ \| pending \d+ \| 127\.0\.0\.1:\d+=up/) >= 2, {
      what: "two heartbeats",
    });
    relay.killAllClients();
    relay.setAccepting(false);
    await waitFor(() => c.has(/^heartbeat: relays 0\/1 up .*=down\(attempt \d+\)/), { what: "heartbeat shows down + attempt" });
  } finally {
    h.stop();
    await relay.close();
  }
});

test("pong timeout terminates a half-open socket and reconnects", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  // Wrap ws so pong frames are swallowed: the socket looks open but is
  // effectively dead, exactly the half-open case a plain "close"
  // listener never sees.
  const { default: RealWS } = await import("ws");
  class NoPongWS extends RealWS {
    emit(ev, ...args) {
      if (ev === "pong") return false;
      return super.emit(ev, ...args);
    }
  }
  const h = await runIngest({
    ...FAST,
    pingIntervalMs: 60,
    pongTimeoutMs: 40,
    relays: [relay.url],
    identity: IDENTITY,
    log: c.log,
    importer: c.importer,
    WebSocketImpl: NoPongWS,
  });
  try {
    await waitFor(() => c.has(/pong timeout .*terminating half-open socket/), { what: "pong timeout" });
    await waitFor(() => relay.reqs.length >= 2, { what: "reconnect + re-REQ after pong timeout" });
  } finally {
    h.stop();
    await relay.close();
  }
});

test("all relays down past threshold -> onFatal(1), never a silent exit 0", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  let fatal = null;
  const h = await runIngest({
    ...FAST,
    allDownExitMs: 300,
    relays: [relay.url],
    identity: IDENTITY,
    log: c.log,
    importer: c.importer,
    onFatal: (code, reason) => {
      fatal = { code, reason };
    },
  });
  try {
    await waitFor(() => h.stats().connected === 1, { what: "connected" });
    relay.setAccepting(false);
    relay.killAllClients();
    await waitFor(() => fatal !== null, { timeoutMs: 4000, what: "onFatal" });
    assert.equal(fatal.code, 1);
    assert.match(fatal.reason, /all 1 relay\(s\) unreachable for \d+s \(threshold 0s\)|all 1 relay\(s\) unreachable/);
    assert.ok(c.has(/^ALL 1 relay\(s\) disconnected/));
  } finally {
    h.stop();
    await relay.close();
  }
});

test("all relays down with threshold disabled -> stays alive retrying", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const c = collector();
  let fatal = null;
  const h = await runIngest({
    ...FAST,
    allDownExitMs: 0,
    relays: [relay.url],
    identity: IDENTITY,
    log: c.log,
    importer: c.importer,
    onFatal: (code, reason) => {
      fatal = { code, reason };
    },
  });
  try {
    await waitFor(() => h.stats().connected === 1, { what: "connected" });
    relay.setAccepting(false);
    relay.killAllClients();
    await waitFor(() => c.count(/reconnect scheduled/) >= 4, { what: "keeps retrying" });
    await sleep(400);
    assert.equal(fatal, null, "no fatal with threshold disabled");
    // and it comes back when the relay does
    relay.setAccepting(true);
    await waitFor(() => h.stats().connected === 1, { timeoutMs: 4000, what: "reconnect after outage" });
    assert.ok(c.has(/connectivity restored/));
  } finally {
    h.stop();
    await relay.close();
  }
});

// The end-to-end version of the production bug, against the real
// bin/ingest.mjs as a child process: relay goes away for good, and the
// PROCESS must exit nonzero (not 0, not hang). This is exactly what
// systemd sees.
test("real process: all relays gone -> exits 1 (not 0) after threshold", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const bin = path.join(here, "..", "bin", "ingest.mjs");
  const child = spawn(process.execPath, [bin], {
    env: {
      ...process.env,
      OMOSTRICH_DB_TEST_PUBKEY_HEX: PUBKEY,
      OMOSTRICH_DB_RELAYS: relay.url,
      OMOSTRICH_DB_FLUSH_MS: "50",
      OMOSTRICH_DB_BACKFILL_TIMEOUT_MS: "1000",
      OMOSTRICH_DB_BACKOFF_BASE_MS: "40",
      OMOSTRICH_DB_BACKOFF_MAX_MS: "200",
      OMOSTRICH_DB_HEARTBEAT_MS: "100",
      OMOSTRICH_DB_PING_MS: "0",
      OMOSTRICH_DB_ALL_DOWN_EXIT_MS: "500",
      // isolate the child's log file so the test never writes to the
      // real ~/.local/state ingest.log
      HOME: path.join(here, ".tmp-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exit = new Promise((resolve) => child.on("exit", (code, sig) => resolve({ code, sig })));
  try {
    await waitFor(() => /connected: ws:\/\//.test(out), { what: "child connected" });
    await relay.close(); // relay is gone for good: connections refused from here on
    const r = await Promise.race([exit, sleep(8000).then(() => ({ code: "TIMEOUT" }))]);
    assert.notEqual(r.code, "TIMEOUT", `child did not exit; output:\n${out}`);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}; output:\n${out}`);
    assert.match(out, /relay closed \(/);
    assert.match(out, /reconnect scheduled/);
    assert.match(out, /ALL 1 relay\(s\) disconnected/);
    assert.match(out, /FATAL: all 1 relay\(s\) unreachable .* exiting 1/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("real process: SIGTERM -> clean exit 0 (systemd stop path unchanged)", async () => {
  const relay = startFakeRelay({ pubkeyHex: PUBKEY });
  const bin = path.join(here, "..", "bin", "ingest.mjs");
  const child = spawn(process.execPath, [bin], {
    env: {
      ...process.env,
      OMOSTRICH_DB_TEST_PUBKEY_HEX: PUBKEY,
      OMOSTRICH_DB_RELAYS: relay.url,
      OMOSTRICH_DB_BACKFILL_TIMEOUT_MS: "1000",
      OMOSTRICH_DB_HEARTBEAT_MS: "100",
      HOME: path.join(here, ".tmp-home"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    await waitFor(() => /initial backfill window over/.test(out), { what: "child steady state" });
    child.kill("SIGTERM");
    const code = await Promise.race([exit, sleep(5000).then(() => "TIMEOUT")]);
    assert.equal(code, 0, `output:\n${out}`);
    assert.match(out, /SIGTERM received, flushing and exiting 0/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await relay.close();
  }
});
