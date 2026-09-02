#!/usr/bin/env bash
# Builds the vendored nostrdb source (fetched by fetch-nostrdb.sh) into
# a real `ndb` binary + libnostrdb.a, then copies the binary into
# bin/vendor/ where the rest of this repo expects to find it.
#
# Proven to produce a working binary on this machine (Arch Linux):
# real relay events ingested, real sub-millisecond queries returned
# correct results (see BUILD-NOTES.md for the exact commands run).

set -euo pipefail
cd "$(dirname "$0")/.."

SRC_ROOT=$(find vendor/nostrdb-src -mindepth 1 -maxdepth 1 -type d | head -1)
if [ -z "$SRC_ROOT" ]; then
  echo "No vendored source found. Run scripts/fetch-nostrdb.sh first." >&2
  exit 1
fi

echo "Building in $SRC_ROOT ..."
cd "$SRC_ROOT"
make -j"$(nproc)" all

mkdir -p ../../../bin/vendor
cp ndb ../../../bin/vendor/ndb
echo "Built and installed bin/vendor/ndb"
../../../bin/vendor/ndb --help | head -3
