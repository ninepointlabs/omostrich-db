import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importEvents, stat as ndbStat } from "./nostrdb.mjs";
import { resolveIdentity } from "./identity.mjs";
import { ingestLogPath } from "./paths.mjs";

// Background ingest: subscribes live to relays for
//   1. the user's own kind-1 notes (authors: [pubkeyHex])
//   2. replies/reactions/zaps that reference them (kinds 1/7/9735,
//      #p: [pubkeyHex]) -- same event classes notify-watch.mjs in the
//      omostrich repo already toasts on, reused here as the "your
//      engagement" half of the local cache.
// Batches events and writes them into nostrdb via `ndb import` every
// FLUSH_INTERVAL_MS, rather than shelling out per-event (ndb's own
// CLI has real process-spawn + LMDB-txn-open overhead per invocation;
// batching avoids hammering that for a live-firehose subscription).
//
// No DM decrypt, no kind 4/1059 subscription at all -- out of scope,
// already rejected in the reader-surface discussion this project was
// spun off from.
//
// Read-only. Never touches the vault. Uses omostrich's relay list as
// a starting point (same relays the user already posts to and trusts)
// -- not a broader "network trends" relay set; that's the live
// `trending` tool's job later, not this ingest process's.
//
// ── Why this file has reconnect logic (2026-09-03 production bug) ──
// The first version opened one WebSocket per relay and never
// reconnected. When the last relay closed its socket (~3h39m in),
// Node had no active handles left, the event loop drained, and the
// process exited 0. systemd's Restart=on-failure correctly did
// nothing for a clean exit, so the cache went stale for ~16h and
// nothing was logged about the closes. Every behavior below exists
// to make that impossible:
//   - each relay reconnects on close/error with bounded exponential
//     backoff + jitter, and re-sends its REQ on every open
//   - a heartbeat interval always holds the event loop open and logs
//     connected count + last-ingest age, so "silently idle" can't
//     happen again
//   - ws-level ping/pong detects half-open sockets and terminates
//     them so the close path (and reconnect) actually fires
//   - if EVERY relay has been down continuously past a threshold the
//     process exits NONZERO (never 0) so systemd restarts it fresh

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://relay.nostr.band", "wss://nos.lol"];

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// All tunables are env-overridable so the test harness can run the
// exact production code path on a fast clock. Defaults are the
// production values.
export const DEFAULTS = Object.freeze({
  flushIntervalMs: envInt("OMOSTRICH_DB_FLUSH_MS", 30_000),
  backfillTimeoutMs: envInt("OMOSTRICH_DB_BACKFILL_TIMEOUT_MS", 8_000),
  backoffBaseMs: envInt("OMOSTRICH_DB_BACKOFF_BASE_MS", 1_000),
  backoffMaxMs: envInt("OMOSTRICH_DB_BACKOFF_MAX_MS", 5 * 60_000),
  heartbeatMs: envInt("OMOSTRICH_DB_HEARTBEAT_MS", 60_000),
  pingIntervalMs: envInt("OMOSTRICH_DB_PING_MS", 30_000),
  pongTimeoutMs: envInt("OMOSTRICH_DB_PONG_TIMEOUT_MS", 10_000),
  // How long ALL relays may be simultaneously disconnected before we
  // give up and exit 1 for systemd to restart us. 0 disables (stay
  // alive retrying forever). Default 15 minutes: long enough to ride
  // out a normal outage or a laptop sleep, short enough that a wedged
  // DNS/network stack gets a fresh process instead of an eternal
  // backoff loop.
  allDownExitMs: envInt("OMOSTRICH_DB_ALL_DOWN_EXIT_MS", 15 * 60_000),
  // Overlap subtracted from the last-seen event timestamp when
  // re-subscribing after a reconnect, so events that landed during
  // the gap are refetched (nostrdb dedupes on import).
  resubscribeOverlapSec: envInt("OMOSTRICH_DB_RESUB_OVERLAP_SEC", 600),
});

function relaysFromEnv() {
  const raw = process.env.OMOSTRICH_DB_RELAYS;
  if (!raw) return DEFAULT_RELAYS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(ingestLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(ingestLogPath, line);
  } catch {
    /* best-effort */
  }
}

function defaultImporter(batch) {
  const tmpFile = path.join(os.tmpdir(), `omostrich-db-ingest-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
    importEvents(tmpFile);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

// Exponential backoff with full jitter, bounded. attempt is 0-based.
export function backoffDelay(attempt, { backoffBaseMs, backoffMaxMs }, rand = Math.random) {
  const exp = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(attempt, 30));
  // jitter in [0.5, 1.0] * exp: never zero (would hammer), never above cap
  return Math.floor(exp * (0.5 + rand() * 0.5));
}

// One relay, owns its socket for the life of the process. Reconnects
// itself forever; never rejects, never throws out. The only thing
// that stops it is stop().
class RelayConnection {
  constructor(url, { subId, filters, onEvent, onStateChange, log, opts, WebSocketImpl }) {
    this.url = url;
    this.subId = subId;
    this.baseFilters = filters;
    this.onEvent = onEvent;
    this.onStateChange = onStateChange;
    this.log = log;
    this.opts = opts;
    this.WebSocketImpl = WebSocketImpl;

    this.ws = null;
    this.connected = false;
    this.stopped = false;
    this.attempt = 0; // consecutive failed connects/closes since last good open
    this.reconnects = 0; // lifetime successful re-opens (observability)
    this.closes = 0; // lifetime closes/errors (observability)
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.lastEventCreatedAt = 0; // newest created_at seen from THIS relay
    this.lastOpenAt = 0;
    this.lastCloseAt = 0;
    this.eoseSeen = false;
    this._eoseWaiters = [];
  }

  // Resolves on first EOSE, error, close, or timeout -- used only to
  // bound the initial backfill wait. Never rejects.
  waitForEose(timeoutMs) {
    if (this.eoseSeen) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this._eoseWaiters.push(done);
    });
  }

  _settleEoseWaiters() {
    const w = this._eoseWaiters;
    this._eoseWaiters = [];
    for (const fn of w) fn();
  }

  _filtersForSubscribe() {
    if (!this.lastEventCreatedAt) return this.baseFilters;
    const since = Math.max(0, this.lastEventCreatedAt - this.opts.resubscribeOverlapSec);
    return this.baseFilters.map((f) => ({ ...f, since }));
  }

  connect() {
    if (this.stopped) return;
    this._clearTimers();
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      // synchronous constructor failure (bad URL etc.) -- treat like a
      // failed connect, keep retrying; a typo'd relay must not kill
      // the process or the others
      this.log(`relay connect threw (${this.url}): ${err.message}`);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    let settled = false; // guard: "close" after "error" must not double-count

    ws.on("open", () => {
      if (this.stopped) return;
      this.connected = true;
      this.lastOpenAt = Date.now();
      const wasReconnect = this.reconnects + this.closes > 0;
      if (wasReconnect) this.reconnects += 1;
      this.attempt = 0;
      const filters = this._filtersForSubscribe();
      try {
        ws.send(JSON.stringify(["REQ", this.subId, ...filters]));
      } catch (err) {
        this.log(`relay REQ send failed (${this.url}): ${err.message}`);
      }
      this.log(
        `${wasReconnect ? "reconnected" : "connected"}: ${this.url}` +
          (wasReconnect ? ` (reconnect #${this.reconnects}, since=${filters[0]?.since ?? "none"})` : "")
      );
      this.onStateChange();
      this._startPing();
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // malformed relay message, ignore
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "EVENT" && msg[1] === this.subId) {
        const ev = msg[2];
        if (ev && Number.isFinite(ev.created_at) && ev.created_at > this.lastEventCreatedAt) {
          this.lastEventCreatedAt = ev.created_at;
        }
        this.onEvent(ev, this.url);
      } else if (msg[0] === "EOSE" && msg[1] === this.subId) {
        this.eoseSeen = true;
        this._settleEoseWaiters();
      } else if (msg[0] === "NOTICE") {
        this.log(`relay notice (${this.url}): ${String(msg[1]).slice(0, 200)}`);
      } else if (msg[0] === "CLOSED" && msg[1] === this.subId) {
        // NIP-01: relay closed our subscription server-side. Socket may
        // stay up but we get nothing more -- treat as a drop so we
        // re-subscribe via the normal reconnect path.
        this.log(`relay CLOSED our subscription (${this.url}): ${String(msg[2] ?? "").slice(0, 200)}`);
        try {
          ws.terminate();
        } catch {
          /* already gone */
        }
      }
    });

    ws.on("pong", () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });

    ws.on("error", (err) => {
      this.log(`relay error (${this.url}): ${err.message}`);
      // ws always emits "close" after "error"; let close do the
      // bookkeeping exactly once. But make sure the backfill waiter
      // isn't stuck if this was a pre-open failure.
      this._settleEoseWaiters();
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      settled = true;
      const wasConnected = this.connected;
      this.connected = false;
      this.closes += 1;
      this.lastCloseAt = Date.now();
      this._clearTimers();
      this._settleEoseWaiters();
      if (this.stopped) return;
      const r = reason ? ` ${String(reason).slice(0, 120)}` : "";
      this.log(
        `relay closed (${this.url}): code=${code}${r}` +
          (wasConnected ? ` after ${Math.round((Date.now() - this.lastOpenAt) / 1000)}s up` : " (never opened)")
      );
      this.onStateChange();
      this._scheduleReconnect();
    });
  }

  _startPing() {
    if (!this.opts.pingIntervalMs) return;
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== ws.OPEN) return;
      try {
        ws.ping();
      } catch {
        return;
      }
      if (this.pongTimer) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.log(`relay pong timeout (${this.url}), terminating half-open socket`);
        try {
          ws.terminate(); // fires "close" -> reconnect
        } catch {
          /* already gone */
        }
      }, this.opts.pongTimeoutMs);
    }, this.opts.pingIntervalMs);
  }

  _scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt, this.opts);
    this.attempt += 1;
    this.log(`reconnect scheduled (${this.url}): attempt ${this.attempt} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  stop() {
    this.stopped = true;
    this._clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._settleEoseWaiters();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

// Returns a handle: { stop(), stats() }. In live mode the returned
// promise resolves once the initial backfill window is over and the
// process is in steady state -- it does NOT resolve when relays drop,
// because relays dropping is no longer a terminal condition.
//
// Injectable bits (all optional, defaults are production):
//   relays        string[]
//   identity      { pubkeyHex, npub }   (skips omostrich-ctl lookup)
//   importer      (events[]) => void    (skips ndb)
//   log           (msg) => void
//   onFatal       (code, reason) => void   default: process.exit(code)
//   WebSocketImpl WebSocket class
//   ...DEFAULTS keys
export async function runIngest({ once = false, ...inject } = {}) {
  const opts = { ...DEFAULTS, ...inject };
  const log = inject.log ?? defaultLog;
  const importer = inject.importer ?? defaultImporter;
  const onFatal =
    inject.onFatal ??
    ((code, reason) => {
      log(`FATAL: ${reason} -- exiting ${code} so systemd restarts a fresh process`);
      process.exit(code);
    });
  const WebSocketImpl = inject.WebSocketImpl ?? WebSocket;
  const relays = inject.relays ?? relaysFromEnv();

  const { pubkeyHex, npub } = inject.identity ?? resolveIdentity();
  log(`identity resolved: ${npub}`);
  log(`relays (${relays.length}): ${relays.join(", ")}`);

  let batch = [];
  const seen = new Set();
  let flushTimer = null;
  const stats = {
    startedAt: Date.now(),
    importedTotal: 0,
    importFailures: 0,
    lastImportAt: 0,
    lastEventAt: 0,
    // The all-down clock starts at process start: if NOTHING ever
    // connects (DNS dead, network down at boot) that still counts
    // toward the exit threshold. The "ALL disconnected"/"restored"
    // log lines are gated on everConnected so a slow first connect
    // or one relay refusing during boot doesn't read as an outage.
    allDownSince: Date.now(),
    everConnected: false,
  };

  function flushBatch(toFlush) {
    if (toFlush.length === 0) return;
    try {
      importer(toFlush);
      stats.importedTotal += toFlush.length;
      stats.lastImportAt = Date.now();
      log(`imported ${toFlush.length} event(s) (total ${stats.importedTotal})`);
    } catch (err) {
      stats.importFailures += 1;
      log(`import failed: ${err.message}`);
    }
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const toFlush = batch;
      batch = [];
      flushBatch(toFlush);
    }, opts.flushIntervalMs);
  }

  function onEvent(event) {
    if (!event?.id || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 20000) {
      // cap unbounded growth across a long-running process; nostrdb
      // itself dedupes on import anyway, this is just a fast-path skip
      const first = seen.values().next().value;
      seen.delete(first);
    }
    stats.lastEventAt = Date.now();
    batch.push(event);
    scheduleFlush();
  }

  const subId = "omostrich-db-ingest";
  const filters = [
    { kinds: [1], authors: [pubkeyHex] },
    { kinds: [1, 7, 9735], "#p": [pubkeyHex] },
  ];

  const conns = relays.map(
    (url) =>
      new RelayConnection(url, {
        subId,
        filters,
        onEvent,
        onStateChange,
        log,
        opts,
        WebSocketImpl,
      })
  );

  function connectedCount() {
    return conns.filter((c) => c.connected).length;
  }

  // Tracks the "every relay is down" window. Called on every open and
  // close. The actual exit decision lives in the heartbeat so it's
  // evaluated on a clock, not only on socket events (a process with
  // all sockets dead and every reconnect in long backoff has no
  // socket events to trigger it).
  function onStateChange() {
    const n = connectedCount();
    if (n === 0) {
      if (!stats.allDownSince) {
        stats.allDownSince = Date.now();
        if (stats.everConnected) log(`ALL ${conns.length} relay(s) disconnected; reconnecting with backoff`);
      }
    } else {
      if (stats.allDownSince && stats.everConnected) {
        log(`relay connectivity restored (${n}/${conns.length} connected) after ${Math.round((Date.now() - stats.allDownSince) / 1000)}s all-down`);
      }
      stats.allDownSince = 0;
      stats.everConnected = true;
    }
  }

  function heartbeat() {
    const n = connectedCount();
    const age = (t) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : "never");
    const per = conns
      .map((c) => `${c.url.replace(/^wss?:\/\//, "")}=${c.connected ? "up" : `down(attempt ${c.attempt})`}`)
      .join(" ");
    log(
      `heartbeat: relays ${n}/${conns.length} up | last event ${age(stats.lastEventAt)} | last import ${age(stats.lastImportAt)} | imported ${stats.importedTotal} | pending ${batch.length} | ${per}`
    );
    if (n === 0 && !stats.allDownSince) stats.allDownSince = Date.now(); // belt and braces: never leave the clock unset while down
    if (opts.allDownExitMs > 0 && stats.allDownSince && Date.now() - stats.allDownSince >= opts.allDownExitMs) {
      // Intentional: do NOT quietly exit 0. Flush what we have, then
      // exit nonzero so Restart=on-failure/always brings up a fresh
      // process with fresh DNS and a clean socket table.
      if (flushTimer) clearTimeout(flushTimer);
      flushBatch(batch);
      batch = [];
      stopAll();
      onFatal(1, `all ${conns.length} relay(s) unreachable for ${Math.round((Date.now() - stats.allDownSince) / 1000)}s (threshold ${Math.round(opts.allDownExitMs / 1000)}s)`);
    }
  }

  let heartbeatTimer = null;
  function stopAll() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    for (const c of conns) c.stop();
  }

  // Kick everything off. See stats.allDownSince/everConnected above for
  // how a slow or partially-refused boot is kept from reading as an
  // outage while still counting toward the exit threshold.
  for (const c of conns) c.connect();

  // Bounded initial backfill wait: first EOSE / error / close /
  // timeout per relay. This only gates the `once` mode and the
  // "backfill done" log line; live mode keeps going regardless.
  await Promise.all(conns.map((c) => c.waitForEose(opts.backfillTimeoutMs)));
  log(`initial backfill window over: ${connectedCount()}/${conns.length} relay(s) connected, ${batch.length} event(s) pending`);

  if (once) {
    // flush immediately and close, used by `npm run ingest -- --once`
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    flushBatch(batch);
    batch = [];
    stopAll();
    try {
      log(ndbStat().split("\n").slice(0, 4).join(" | "));
    } catch (err) {
      log(`ndb stat unavailable: ${err.message}`);
    }
    return { stop: stopAll, stats: () => ({ ...stats, connected: connectedCount() }) };
  }

  // Live mode. The heartbeat interval is what guarantees the event
  // loop always has a handle -- even with every socket dead and every
  // reconnect timer pending, this process cannot drain and exit 0.
  heartbeatTimer = setInterval(heartbeat, opts.heartbeatMs);
  if (!inject.noSignalHandlers) {
    const shutdown = (sig) => {
      log(`${sig} received, flushing and exiting 0`);
      if (flushTimer) clearTimeout(flushTimer);
      flushBatch(batch);
      batch = [];
      stopAll();
      process.exit(0);
    };
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }

  return {
    stop: stopAll,
    stats: () => ({
      ...stats,
      connected: connectedCount(),
      relays: conns.map((c) => ({
        url: c.url,
        connected: c.connected,
        attempt: c.attempt,
        reconnects: c.reconnects,
        closes: c.closes,
      })),
    }),
    // exposed for the test harness only
    _flushNow: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      const toFlush = batch;
      batch = [];
      flushBatch(toFlush);
    },
  };
}
