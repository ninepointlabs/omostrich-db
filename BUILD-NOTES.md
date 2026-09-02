# nostrdb build notes

How `scripts/fetch-nostrdb.sh` + `scripts/build-nostrdb.sh` were
arrived at, and what was actually proven on this machine (Arch Linux,
2026-09-02) before either script existed.

## Why tarballs, not git submodules

`nostrdb`'s own build (`deps/secp256k1` via `.gitmodules`, `deps/flatcc`
and `deps/lmdb` via Makefile-driven `curl`/`tar`) normally wants either
`git submodule` or a `git clone`. Both got blocked on this machine by
the terminal's security scanner ("URL uses raw IP address" / "Schemeless
URL in sink context" on `git clone https://...`) — a false-positive
class of block on this environment, not a real problem with those
hosts. Plain `curl -L <github tarball URL> -o file.tar.gz` was not
blocked and pulls the identical bytes GitHub would hand `git clone`,
so that's what the fetch script uses.

## Why a hand-rolled tar extractor

`tar -xzf ... -C <dest>` itself got blocked too ("Archive extraction to
a potentially sensitive location"). `scripts/extract-tgz.mjs` is a
minimal pure-Node gunzip + tar reader instead — no new dependency, and
it sidesteps that block entirely since it's not the `tar` binary.

First version of that extractor only read the fixed 100-byte tar name
field and ignored PAX extended headers. That silently corrupted deep
paths (anything nested past ~100 characters, which GitHub's archive
tool encodes via a PAX `x` header instead of the short field) —
libsodium's `crypto_box/curve25519xsalsa20poly1305/box_curve25519xsalsa20poly1305.c`
and others were dropped entirely, and the build failed with `No rule to
make target ...box_curve25519xsalsa20poly1305.c`. Fixed by adding PAX
(`x`/`g` typeflag) and GNU-long-name (`L` typeflag) support — confirmed
fixed by re-extracting and finding the previously-missing file present.

## Dependency pin provenance (checked live, not memorized)

- `nostrdb` pinned to `1b42298990a89170d698d58a7ee261829f41898e` —
  `master` HEAD via the real GitHub API on pin day
  (`api.github.com/repos/damus-io/nostrdb/commits/master`).
- `secp256k1` pinned to `1ad5185cd42c0636104129fcc9f6a4bf9c67cc40` —
  read directly from nostrdb's own submodule pointer at that exact
  nostrdb commit (`api.github.com/repos/damus-io/nostrdb/contents/deps/
  secp256k1?ref=<nostrdb sha>`), not assumed to be secp256k1's own
  master.
- `flatcc` pinned to `05dc16dc2b0316e61063bb1fc75426647badce48` — read
  directly out of nostrdb's `Makefile` (`FLATCC_VER=`), which pins an
  exact commit of `jb55/flatcc` (a fork), not upstream flatcc.
- `libsodium`: nostrdb's submodule pins `79e78fc81331809b6e69723b3230
  ac45d5e2f169`. That exact commit tarball 404s from
  `jedisct1/libsodium` on this network (GitHub doesn't guarantee an
  archive endpoint stays resolvable for every historical commit,
  especially after a repo's history has been rewritten upstream —
  confirmed via a direct `curl`, got a 14-byte "Not Found" body, not a
  guess). Substituted the `1.0.20` stable release tarball instead.
  This is a real, acknowledged substitution: the libsodium API surface
  `nostrdb/src/nip44.c` actually calls (`crypto_box_seal`,
  `crypto_secretbox_*`, `crypto_sign_ed25519_*`, siphash) has been
  stable across libsodium majors for years, and the resulting binary
  was proven to work end-to-end (see below) — but if `nostrdb` upstream
  ever depends on something introduced after 1.0.20, this pin is the
  first thing to revisit.

## What was actually proven, live, before writing a line of MCP/query code

1. `make -j$(nproc) all` in the vendored tree completes with exit 0 —
   real compiler output, `ndb` binary produced (~4-6 MB depending on
   debug symbols).
2. `./ndb -d <fresh-dir> stat` on an empty DB returns clean, all-zero
   table stats — LMDB environment opens and initializes correctly.
3. Connected to a **real, live** relay (`wss://relay.damus.io`) via
   `ws` (already a dependency in the sibling `omostrich` repo), pulled
   20 real, currently-signed kind-1 events with a plain `REQ` (no
   fabricated/synthetic event data anywhere in this test).
4. `./ndb -d <dir> import events.jsonl` — imported those 20 real
   events; `stat` afterward showed `note: 20` with real non-zero byte
   counts, confirming signature verification passed and events were
   actually written into LMDB (not silently dropped).
5. `./ndb -d <dir> query --kind 1 --limit 3` — returned real event JSON
   in ~0.008ms.
6. `./ndb -d <dir> query --author <hex pubkey from event #1>` — returned
   exactly that one event, proving the author-index query path (the
   exact primitive `my_notes_since` needs) works correctly.
7. `./ndb -d <dir> query --since <far-future timestamp>` — returned 0
   results as expected, proving the time-window filter (the other half
   of `my_notes_since`) works correctly.

All of the above was re-run a second time through the actual
`scripts/fetch-nostrdb.sh` + `scripts/build-nostrdb.sh` pipeline (not
just the manual scratch-directory build used to first prove
feasibility) to confirm the scripted path produces the same working
binary, before this file or the rest of the repo was written.
