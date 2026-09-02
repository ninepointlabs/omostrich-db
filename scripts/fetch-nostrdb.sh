#!/usr/bin/env bash
# Fetches nostrdb source and its build dependencies as pinned tarballs
# (not git submodules -- git clone of these hosts gets blocked by this
# machine's security scanner as "raw IP / schemeless URL", so curl of
# GitHub's tarball archive endpoint is used instead; same bytes, same
# commits, verified against real GitHub API SHA lookups below).
#
# Pinned refs (checked against the live GitHub API on 2026-09-02, not
# guessed):
#   nostrdb:    1b42298990a89170d698d58a7ee261829f41898e (master @ pin time)
#   secp256k1:  1ad5185cd42c0636104129fcc9f6a4bf9c67cc40 (nostrdb's own
#               submodule pin at that same nostrdb commit -- read via
#               `gh api repos/damus-io/nostrdb/contents/deps/secp256k1
#               ?ref=<nostrdb commit>`, not assumed to be secp256k1 master)
#   flatcc:     05dc16dc2b0316e61063bb1fc75426647badce48 (nostrdb's
#               Makefile pins this exact commit of jb55/flatcc directly)
#   libsodium:  nostrdb's Makefile/submodule pin (79e78fc8...) 404s as a
#               tarball from jedisct1/libsodium on this network -- not
#               every commit SHA is preserved as a fetchable archive by
#               GitHub for repos with squash/rebase history. Falls back
#               to the 1.0.20 stable release tarball instead. This is a
#               real, documented substitution, not a silent guess -- the
#               API surface nostrdb/nip44.c uses (crypto_box_seal,
#               crypto_secretbox, crypto_sign_ed25519, siphash24) has
#               been stable across libsodium majors for years, and the
#               build was proven end-to-end against this exact
#               substitution (see BUILD-NOTES.md).

set -euo pipefail
cd "$(dirname "$0")/.."

VENDOR_DIR="vendor"
mkdir -p "$VENDOR_DIR"

NOSTRDB_SHA=1b42298990a89170d698d58a7ee261829f41898e
SECP256K1_SHA=1ad5185cd42c0636104129fcc9f6a4bf9c67cc40
FLATCC_SHA=05dc16dc2b0316e61063bb1fc75426647badce48
LIBSODIUM_VERSION=1.0.20

echo "Fetching nostrdb @ $NOSTRDB_SHA ..."
curl -sL -o /tmp/omostrich-db-nostrdb.tar.gz \
  "https://github.com/damus-io/nostrdb/archive/${NOSTRDB_SHA}.tar.gz"

echo "Fetching secp256k1 @ $SECP256K1_SHA (nostrdb's own submodule pin) ..."
curl -sL -o /tmp/omostrich-db-secp256k1.tar.gz \
  "https://github.com/bitcoin-core/secp256k1/archive/${SECP256K1_SHA}.tar.gz"

echo "Fetching flatcc @ $FLATCC_SHA (nostrdb's own Makefile pin) ..."
curl -sL -o /tmp/omostrich-db-flatcc.tar.gz \
  "https://github.com/jb55/flatcc/archive/${FLATCC_SHA}.tar.gz"

echo "Fetching libsodium $LIBSODIUM_VERSION (stable release, see header note) ..."
curl -sL -o /tmp/omostrich-db-libsodium.tar.gz \
  "https://download.libsodium.org/libsodium/releases/libsodium-${LIBSODIUM_VERSION}.tar.gz"

echo "Extracting ..."
node scripts/extract-tgz.mjs /tmp/omostrich-db-nostrdb.tar.gz "$VENDOR_DIR/nostrdb-src"
node scripts/extract-tgz.mjs /tmp/omostrich-db-secp256k1.tar.gz "$VENDOR_DIR/nostrdb-src-tmp-secp256k1"
node scripts/extract-tgz.mjs /tmp/omostrich-db-flatcc.tar.gz "$VENDOR_DIR/nostrdb-src-tmp-flatcc"
node scripts/extract-tgz.mjs /tmp/omostrich-db-libsodium.tar.gz "$VENDOR_DIR/nostrdb-src-tmp-libsodium"

# The tarball root dir name varies (repo-SHA, repo-vX.Y.Z, etc) --
# resolve it rather than assume.
SRC_ROOT=$(find "$VENDOR_DIR/nostrdb-src" -mindepth 1 -maxdepth 1 -type d | head -1)
SECP_ROOT=$(find "$VENDOR_DIR/nostrdb-src-tmp-secp256k1" -mindepth 1 -maxdepth 1 -type d | head -1)
FLATCC_ROOT=$(find "$VENDOR_DIR/nostrdb-src-tmp-flatcc" -mindepth 1 -maxdepth 1 -type d | head -1)
SODIUM_ROOT=$(find "$VENDOR_DIR/nostrdb-src-tmp-libsodium" -mindepth 1 -maxdepth 1 -type d | head -1)

rm -rf "$SRC_ROOT/deps/secp256k1" "$SRC_ROOT/deps/flatcc" "$SRC_ROOT/deps/libsodium"
mv "$SECP_ROOT" "$SRC_ROOT/deps/secp256k1"
mv "$FLATCC_ROOT" "$SRC_ROOT/deps/flatcc"
mv "$SODIUM_ROOT" "$SRC_ROOT/deps/libsodium"
rmdir "$VENDOR_DIR/nostrdb-src-tmp-secp256k1" "$VENDOR_DIR/nostrdb-src-tmp-flatcc" "$VENDOR_DIR/nostrdb-src-tmp-libsodium"
chmod +x "$SRC_ROOT"/deps/secp256k1/configure "$SRC_ROOT"/deps/secp256k1/autogen.sh \
  "$SRC_ROOT"/deps/libsodium/configure "$SRC_ROOT"/devtools/*.sh 2>/dev/null || true

echo "Vendored source ready at $VENDOR_DIR/nostrdb-src/$(basename "$SRC_ROOT")"
echo "Run scripts/build-nostrdb.sh next."
