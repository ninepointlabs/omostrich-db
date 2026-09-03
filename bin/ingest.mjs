#!/usr/bin/env node
import { runIngest } from "../src/ingest.mjs";

const once = process.argv.includes("--once");

// Test-harness only: lets test/ spawn this exact binary without an
// Omostrich daemon or cached identity present. Never set in the unit.
const identity = process.env.OMOSTRICH_DB_TEST_PUBKEY_HEX
  ? { pubkeyHex: process.env.OMOSTRICH_DB_TEST_PUBKEY_HEX, npub: "npub1test" }
  : undefined;

runIngest({ once, identity }).catch((err) => {
  console.error("ingest fatal error:", err.message);
  process.exit(1);
});
