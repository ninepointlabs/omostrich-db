import { query } from "./nostrdb.mjs";
import { resolveIdentity } from "./identity.mjs";

// v1 read-only tools. Both operate entirely against the local nostrdb
// cache -- no relay round-trip, no network call, sub-millisecond in
// practice (proven live, see BUILD-NOTES.md). Neither ever touches the
// vault or requires the signer to be unlocked; they only need Tim's
// public identity, resolved once via identity.mjs.

function toUnixSeconds(input) {
  // Accept an ISO date string, a bare YYYY-MM-DD, or a raw unix
  // timestamp (number or numeric string) -- whatever an agent is most
  // likely to pass along from "since last Tuesday" style reasoning.
  if (typeof input === "number") return Math.floor(input);
  if (typeof input === "string") {
    if (/^\d+$/.test(input.trim())) return parseInt(input.trim(), 10);
    const parsed = Date.parse(input);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  throw new Error(`Could not parse "${input}" as a date/timestamp`);
}

// my_notes_since({ since, limit? }) -> { count, notes: [...] }
// `since` is required -- there is no "all time" mode by design, this
// stays a bounded local-cache lookup, not an unbounded dump.
export function myNotesSince({ since, limit = 50 }) {
  if (since === undefined || since === null || since === "") {
    throw new Error("since is required (ISO date, YYYY-MM-DD, or unix timestamp)");
  }
  const sinceUnix = toUnixSeconds(since);
  const { pubkeyHex } = resolveIdentity();
  const args = ["--kind", "1", "--author", pubkeyHex, "--since", String(sinceUnix)];
  if (limit) args.push("--limit", String(limit));
  const notes = query(args);
  return {
    count: notes.length,
    since: new Date(sinceUnix * 1000).toISOString(),
    notes: notes.map((n) => ({
      id: n.id,
      created_at: n.created_at,
      content: n.content,
    })),
  };
}

// note_engagement({ noteIds: [...] }) -> per-id replies/reactions/zaps
// from the local cache. Engagement events are matched by their "e" tag
// referencing the note id -- same tag convention the ingest
// subscription (#p: [pubkeyHex]) relies on relays honoring; a
// reply/reaction/zap that never mentions Tim via #p tag was never
// ingested in the first place, so this can only report what the
// background ingest actually saw, not a live/global count.
export function noteEngagement({ noteIds }) {
  if (!Array.isArray(noteIds) || noteIds.length === 0) {
    throw new Error("noteIds must be a non-empty array of note ids");
  }
  const results = {};
  for (const noteId of noteIds) {
    // kinds 1 (reply), 7 (reaction), 9735 (zap) -- ndb's query CLI
    // filters by a single --tag <char> <value> pair, so this is one
    // ndb invocation per note id per kind rather than a single combined
    // query; each is still sub-millisecond against the local cache
    // (proven live), and note counts here are small (v1 has no
    // pagination need yet).
    const replies = query(["--kind", "1", "--tag", "e", noteId]);
    const reactions = query(["--kind", "7", "--tag", "e", noteId]);
    const zaps = query(["--kind", "9735", "--tag", "e", noteId]);
    results[noteId] = {
      replyCount: replies.length,
      reactionCount: reactions.length,
      zapCount: zaps.length,
      replies: replies.map((r) => ({ id: r.id, pubkey: r.pubkey, created_at: r.created_at, content: r.content })),
      reactions: reactions.map((r) => ({ id: r.id, pubkey: r.pubkey, content: r.content })),
      zaps: zaps.map((z) => ({ id: z.id, pubkey: z.pubkey, created_at: z.created_at })),
    };
  }
  return results;
}
