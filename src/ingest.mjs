import WebSocket from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importEvents, stat as ndbStat } from "./nostrdb.mjs";
import { resolveIdentity } from "./identity.mjs";
import { ingestLogPath } from "./paths.mjs";

// Background ingest: subscribes live to relays for
//   1. Tim's own kind-1 notes (authors: [pubkeyHex])
//   2. replies/reactions/zaps that reference him (kinds 1/7/9735,
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
// a starting point (same relays Tim already posts to and trusts) --
// not a broader "network trends" relay set; that's the live `trending`
// tool's job later, not this ingest process's.

const FLUSH_INTERVAL_MS = 30_000;
const RELAYS = ["wss://relay.damus.io", "wss://relay.primal.net", "wss://relay.nostr.band", "wss://nos.lol"];

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.dirname(ingestLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(ingestLogPath, line);
  } catch {
    /* best-effort */
  }
}

function flushBatch(batch) {
  if (batch.length === 0) return;
  const tmpFile = path.join(os.tmpdir(), `omostrich-db-ingest-${Date.now()}.jsonl`);
  try {
    fs.writeFileSync(tmpFile, batch.map((e) => JSON.stringify(e)).join("\n") + "\n");
    importEvents(tmpFile);
    log(`imported ${batch.length} event(s)`);
  } catch (err) {
    log(`import failed: ${err.message}`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

export async function runIngest({ once = false } = {}) {
  const { pubkeyHex, npub } = resolveIdentity();
  log(`identity resolved: ${npub}`);

  let batch = [];
  const seen = new Set();
  const sockets = [];
  let flushTimer = null;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const toFlush = batch;
      batch = [];
      flushBatch(toFlush);
    }, FLUSH_INTERVAL_MS);
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
    batch.push(event);
    scheduleFlush();
  }

  const subId = "omostrich-db-ingest";
  const filters = [
    { kinds: [1], authors: [pubkeyHex] },
    { kinds: [1, 7, 9735], "#p": [pubkeyHex] },
  ];

  await Promise.all(
    RELAYS.map(
      (relayUrl) =>
        new Promise((resolve) => {
          let resolved = false;
          const ws = new WebSocket(relayUrl);
          sockets.push(ws);
          const doResolve = () => {
            if (!resolved) {
              resolved = true;
              resolve();
            }
          };
          ws.on("open", () => {
            ws.send(JSON.stringify(["REQ", subId, ...filters]));
            log(`connected: ${relayUrl}`);
          });
          ws.on("message", (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg[0] === "EVENT" && msg[1] === subId) {
                onEvent(msg[2]);
              } else if (msg[0] === "EOSE" && msg[1] === subId) {
                doResolve();
              }
            } catch {
              /* ignore malformed relay message */
            }
          });
          ws.on("error", (err) => {
            log(`relay error (${relayUrl}): ${err.message}`);
            doResolve();
          });
          ws.on("close", () => doResolve());
          setTimeout(doResolve, 8000);
        })
    )
  );

  log("initial backfill EOSE reached on all relays");

  if (once) {
    // flush immediately and close, used by the systemd oneshot-style
    // manual test path / `npm run ingest -- --once`
    if (flushTimer) clearTimeout(flushTimer);
    flushBatch(batch);
    for (const ws of sockets) ws.close();
    log(ndbStat().split("\n").slice(0, 4).join(" | "));
    return;
  }

  // Live mode: sockets stay open (closeOnEose semantics aside, relays
  // keep streaming new matching events on this same subscription after
  // EOSE), flush timer keeps batching them in. Process is meant to run
  // under systemd as a long-lived service, not a cron/oneshot.
  process.on("SIGTERM", () => {
    log("SIGTERM received, flushing and exiting");
    if (flushTimer) clearTimeout(flushTimer);
    flushBatch(batch);
    for (const ws of sockets) ws.close();
    process.exit(0);
  });
}
