import os from "node:os";
import path from "node:path";

// Mirrors omostrich's src/paths.mjs conventions exactly: XDG-ish dirs
// under the user's home, own name, own directories -- no shared state
// with omostrich beyond calling its MCP/socket as a client.
export const dataDir = path.join(os.homedir(), ".local", "share", "omostrich-db");
export const stateDir = path.join(os.homedir(), ".local", "state", "omarchy", "omostrich-db");

export const nostrdbDir = path.join(dataDir, "nostrdb");
export const configPath = path.join(dataDir, "config.json");
export const ingestLogPath = path.join(stateDir, "ingest.log");
export const seenReplyIdsPath = path.join(stateDir, "seen-reply-ids.json");

// Where the vendored `ndb` CLI binary lives once scripts/build-nostrdb.sh
// has run. Resolved relative to this repo's own root, not installed
// anywhere on PATH -- this is a private implementation detail of this
// repo, not a public command.
export const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
export const ndbBin = path.join(repoRoot, "bin", "vendor", "ndb");
