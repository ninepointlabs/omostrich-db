import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { configPath, dataDir } from "./paths.mjs";

// Public identity only. Never touches the vault, never asks for or
// accepts an nsec. Source of truth is a one-time call to Omostrich's
// own `status` command (already public: npub/pubkeyHex, no secrets --
// confirmed live: `omostrich-ctl status` returns npub/pubkeyHex
// alongside relays/profile, nothing signing-related). Cached locally
// after the first successful resolve so this service works even if
// Omostrich's daemon happens to be down later (a locked or stopped
// signer should never block reading your own analytics).

function loadCachedConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function saveCachedConfig(config) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function resolveFromOmostrich() {
  // Same CLI any other agent uses -- omostrich-ctl status. No socket
  // code duplicated here; if that binary isn't on PATH this just fails
  // and the caller falls back to any existing cache.
  const raw = execFileSync("omostrich-ctl", ["status"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const parsed = JSON.parse(raw);
  if (!parsed.ok || !parsed.data?.pubkeyHex) return null;
  return { npub: parsed.data.npub, pubkeyHex: parsed.data.pubkeyHex };
}

// Returns { npub, pubkeyHex } or throws with a clear message if no
// identity is known yet and Omostrich can't currently be reached.
export function resolveIdentity() {
  const cached = loadCachedConfig();
  try {
    const fresh = resolveFromOmostrich();
    if (fresh) {
      if (!cached || cached.pubkeyHex !== fresh.pubkeyHex) {
        saveCachedConfig({ ...cached, ...fresh });
      }
      return fresh;
    }
  } catch {
    // Omostrich daemon down/locked/not installed -- fall through to cache.
  }
  if (cached?.pubkeyHex) {
    return { npub: cached.npub, pubkeyHex: cached.pubkeyHex };
  }
  throw new Error(
    "No identity known yet. Omostrich must be reachable at least once " +
      "(omostrich-ctl status) to learn your public npub/pubkey. " +
      "This never requires an unlock -- status is public data."
  );
}
