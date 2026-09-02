#!/usr/bin/env node
import { runIngest } from "../src/ingest.mjs";

const once = process.argv.includes("--once");

runIngest({ once }).catch((err) => {
  console.error("ingest fatal error:", err.message);
  process.exit(1);
});
