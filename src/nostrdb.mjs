import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { nostrdbDir, ndbBin } from "./paths.mjs";

// Thin wrapper around the vendored `ndb` CLI (built by
// scripts/build-nostrdb.sh from vendor/nostrdb-src). No native Node
// bindings -- proven live that `ndb query`/`ndb import` are enough:
// sub-millisecond LMDB-backed queries, real signature-verified import,
// see BUILD-NOTES.md for the exact commands that proved this against
// 20 real events pulled from wss://relay.damus.io.

function ensureDbDir() {
  fs.mkdirSync(nostrdbDir, { recursive: true, mode: 0o700 });
}

function ensureBinExists() {
  if (!fs.existsSync(ndbBin)) {
    throw new Error(
      `nostrdb binary not found at ${ndbBin}. Run: npm run fetch-nostrdb && npm run build-nostrdb`
    );
  }
}

// Import newline-delimited JSON nostr events (already fetched from a
// relay elsewhere -- this module has no network code of its own).
export function importEvents(jsonlPath) {
  ensureDbDir();
  ensureBinExists();
  execFileSync(ndbBin, ["-d", nostrdbDir, "import", jsonlPath], {
    encoding: "utf8",
    timeout: 30000,
  });
}

// Runs `ndb query <args>` and parses its JSON-lines stdout into an
// array of event objects. `ndb query` prints one status/timing line to
// stderr ("using filter '...'" / "N results in X ms") which is
// deliberately ignored here, not parsed as data.
export function query(args) {
  ensureDbDir();
  ensureBinExists();
  const out = execFileSync(ndbBin, ["-d", nostrdbDir, "query", ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
}

export function stat() {
  ensureDbDir();
  ensureBinExists();
  return execFileSync(ndbBin, ["-d", nostrdbDir, "stat"], {
    encoding: "utf8",
    timeout: 10000,
  });
}
