#!/usr/bin/env node
// PAX/GNU-long-name-aware .tar.gz extractor with no external `tar`
// dependency. GitHub's codeload archive tarballs use PAX extended
// headers ('x' typeflag) for any path over 100 bytes -- a naive
// fixed-100-byte-name-field reader silently truncates or skips those
// entries, which corrupts deep vendored trees like libsodium's
// (confirmed the hard way: a first pass at this without PAX handling
// silently dropped several nested source files and the build failed
// with "No rule to make target ...box_curve25519xsalsa20poly1305.c"
// until this was fixed).

import { createGunzip } from "node:zlib";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const src = process.argv[2];
const dest = process.argv[3];

if (!src || !dest) {
  console.error("usage: extract-tgz.mjs <src.tar.gz> <dest-dir>");
  process.exit(1);
}

function parseOctal(buf) {
  return parseInt(buf.toString("utf8").replace(/\0.*$/, "").trim() || "0", 8) || 0;
}

function parsePaxData(buf) {
  const out = {};
  const text = buf.toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    const spaceIdx = text.indexOf(" ", pos);
    if (spaceIdx === -1) break;
    const len = parseInt(text.slice(pos, spaceIdx), 10);
    if (!len || len <= 0) break;
    const record = text.slice(pos, pos + len);
    const eq = record.indexOf("=", spaceIdx - pos + 1);
    if (eq !== -1) {
      const key = record.slice(spaceIdx - pos + 1, eq);
      const value = record.slice(eq + 1, len - 1);
      out[key] = value;
    }
    pos += len;
  }
  return out;
}

function parseTarStream(buf, destDir) {
  let offset = 0;
  let overridePath = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    let name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + "/" + name;
    const size = parseOctal(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156]);
    offset += 512;
    const dataStart = offset;
    const dataEnd = offset + size;

    if (typeFlag === "x" || typeFlag === "g") {
      const paxData = parsePaxData(buf.subarray(dataStart, dataEnd));
      if (paxData.path) overridePath = paxData.path;
    } else if (typeFlag === "L") {
      overridePath = buf.subarray(dataStart, dataStart + size).toString("utf8").replace(/\0.*$/, "");
    } else {
      const finalName = overridePath || name;
      overridePath = null;
      if (finalName) {
        const outPath = path.join(destDir, finalName);
        if (typeFlag === "5" || finalName.endsWith("/")) {
          mkdirSync(outPath, { recursive: true });
        } else if (typeFlag === "0" || typeFlag === "\0" || typeFlag === "") {
          mkdirSync(path.dirname(outPath), { recursive: true });
          writeFileSync(outPath, buf.subarray(dataStart, dataEnd));
        }
        // symlinks (typeflag '2') and other special types are skipped;
        // not needed for building nostrdb's C sources.
      }
    }
    offset = dataEnd;
    offset += (512 - (size % 512)) % 512;
  }
}

const chunks = [];
const gz = createGunzip();
createReadStream(src).pipe(gz);
gz.on("data", (c) => chunks.push(c));
gz.on("end", () => {
  const buf = Buffer.concat(chunks);
  mkdirSync(dest, { recursive: true });
  parseTarStream(buf, dest);
  console.log("extracted to", dest);
});
gz.on("error", (e) => {
  console.error("gunzip error:", e.message);
  process.exit(1);
});
