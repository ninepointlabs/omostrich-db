# Omostrich-DB

A headless Nostr read/analytics service, sibling to
[Omostrich](https://github.com/ninepointlabs/omostrich). Not an
Omarchy plugin — no QML, no bar icon, no Quickshell dependency, no
relationship to `omostrich.service` beyond calling Omostrich's own
`status` once to learn a public npub.

**Read-only. Never touches the Omostrich vault. Never unlocks it. Never
sees an nsec.** If a future feature needs to *post* something, that
goes through Omostrich's own `publish` (MCP or `omostrich-ctl`),
explicit-ask, same as any other agent request — not a new signing path
in this repo.

## What it is

Two jobs, two very different data paths:

1. **Your own stats — fast, local.** A background process
   (`bin/ingest.mjs`) subscribes to relays for your own kind-1 notes
   plus the replies/reactions/zaps (kinds 1/7/9735) that tag you, and
   writes them into [nostrdb](https://github.com/damus-io/nostrdb) —
   Damus/Primal's embedded LMDB-backed Nostr event store — running
   locally as `bin/vendor/ndb`. Questions like "how many times did I
   post this week" answer from that local cache, sub-millisecond, no
   relay round-trip at ask-time.
2. **Network trends — live, external** (not in v1). Your own archive
   can't show what's trending across Nostr; that needs relays or an
   indexer queried live, at ask-time, labeled honestly by source. This
   is the planned `trending` tool — it comes after `my_notes_since` and
   `note_engagement` are proven in real use, not before.

## Identity, not custody

Needs only your **public** npub/pubkey — resolved once via a call to
Omostrich's own `status` (`omostrich-ctl status`, already public data:
no secrets in that response) and cached locally afterward so this
service keeps working even if Omostrich's daemon happens to be
stopped or locked later.

## MCP surface (v1: two read-only tools)

```bash
hermes mcp add omostrich-db --command node --args ~/Projects/omostrich-db/bin/mcp.mjs
claude mcp add omostrich-db -- node ~/Projects/omostrich-db/bin/mcp.mjs
```

Same non-TTY gotcha as Omostrich's own MCP server: `hermes mcp add`
prompts "Enable all N tools? [Y/n/select]", and if stdin isn't a real
terminal that prompt gets nothing and the add is silently cancelled
with nothing saved. Answer it explicitly if you hit that:

```bash
printf 'Y\n' | hermes mcp add omostrich-db --command node --args ~/Projects/omostrich-db/bin/mcp.mjs
```

Start a new Hermes session before the tools show up — an
already-running session doesn't pick up a newly-added MCP server.

**`my_notes_since`** — count/list your own kind-1 notes since a date
(ISO, `YYYY-MM-DD`, or unix timestamp), from the local cache.

**`note_engagement`** — replies/reactions/zaps for one or more note
ids, from the local cache. Only reflects what the background ingest
actually saw (events tagging you via `#p`) — not a live or globally
complete count.

Both tools return `"source": "local_cache"` explicitly, and both
require the background ingest process to have actually run at least
once — an empty/never-started cache just means empty results, not an
error.

**No write tools in v1.** **No DM decrypt tool, ever** — out of scope,
already rejected in the reader-surface discussion this project was
spun off from ([[Omostrich-Reader-Surface]] in the Obsidian vault).

## Setup

```bash
git clone <this repo> ~/Projects/omostrich-db
cd ~/Projects/omostrich-db
npm ci

# Fetches nostrdb + its build deps (secp256k1, flatcc, libsodium) as
# pinned tarballs and builds the vendored `ndb` CLI. See BUILD-NOTES.md
# for exactly what this does and why it's tarballs-over-curl rather
# than git submodules on this machine.
npm run fetch-nostrdb
npm run build-nostrdb

# One-shot backfill + exit, useful to sanity check before installing
# the long-running unit:
node bin/ingest.mjs --once
```

Then either run `bin/ingest.mjs` yourself under whatever process
supervisor you use, or hand `systemd/omostrich-db-ingest.service` to
whoever manages your systemd units (see below) — install it as a user
unit exactly like any other background service. It never touches
`omostrich.service`, never restarts the signer, and has nothing to do
with the vault's lock state.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/omostrich-db-ingest.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now omostrich-db-ingest.service
```

## Paths

| What | Where |
|---|---|
| Local nostrdb (LMDB) cache | `~/.local/share/omostrich-db/nostrdb/` |
| Cached identity (public npub/pubkey only) | `~/.local/share/omostrich-db/config.json` |
| Ingest log | `~/.local/state/omarchy/omostrich-db/ingest.log` |
| Vendored `ndb` binary | `bin/vendor/ndb` (built, not committed — see `.gitignore`) |
| MCP server (stdio) | `bin/mcp.mjs` |
| Background ingest entry point | `bin/ingest.mjs` |
| systemd user unit | `systemd/omostrich-db-ingest.service` (not installed by this repo — see Setup) |

## Constraints (carried over from the reader-surface discussion)

- Not in the Omostrich dropdown or overlay — this is a separate
  process entirely, on purpose.
- Not a full local index of all of Nostr — that duplicates real
  indexers badly. Only your own notes plus engagement that tags you.
- No DM decrypt, ever.
- Read tools are safe to enable by default for any agent — they never
  touch signing, and the worst they can leak is what's already public
  on relays.

## See also

- [Omostrich](https://github.com/ninepointlabs/omostrich) — the
  signer/composer this reads identity from and (if ever needed) would
  publish through.
- `BUILD-NOTES.md` — exactly how the vendored `ndb` binary gets built
  on this machine, what was proven live before any of this repo's
  application code was written, and the one deliberate dependency
  substitution (libsodium pin → stable release) with its full
  reasoning.
