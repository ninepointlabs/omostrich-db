#!/usr/bin/env node
// Omostrich-DB MCP v1 — stdio JSON-RPC server exposing exactly two
// READ-ONLY tools (my_notes_since, note_engagement) against a local
// nostrdb cache of Tim's own notes and the replies/reactions/zaps
// that reference him. Same shared-tool-surface reasoning as sibling
// repo Omostrich's own bin/mcp.mjs — Hermes, Claude Code/CLI, Grok all
// connect to this the same way.
//
// This process NEVER touches the Omostrich vault, never unlocks it,
// never asks for or accepts an nsec/passphrase. It only calls
// `omostrich-ctl status` once (identity.mjs) to learn Tim's PUBLIC
// npub/pubkeyHex — the same public data any agent could already see.
// If a future feature needs to POST anything, that goes through
// Omostrich's own existing `publish` MCP tool, not a new signing path
// invented here (explicit instruction, honored).
//
// No @modelcontextprotocol/sdk dependency, same reasoning as
// Omostrich's bin/mcp.mjs: a small, stable, versioned JSON-RPC 2.0
// stdio surface (initialize, tools/list, tools/call,
// notifications/initialized) is a smaller footprint than the SDK for
// two tools, and consistent with the sibling repo's own call on this.
import { myNotesSince, noteEngagement } from "../src/tools.mjs";

const PROTOCOL_VERSION = "2024-11-05";

// --- Tool definitions ----------------------------------------------------
// v1 is exactly these two, both read-only, both local-cache-only.
// trending (live relay/indexer query) is deliberately NOT here yet —
// it follows once these two are proven in real use, per the spec.
// No DM decrypt tool, ever — out of scope, already rejected in the
// reader-surface discussion this project was spun off from.

const TOOLS = [
  {
    name: "my_notes_since",
    description:
      "Count and list Tim's own kind-1 Nostr notes since a given date, from the LOCAL cache (not a live relay query — reflects whatever the background ingest process has already seen, not necessarily this exact second). `since` accepts an ISO date, a bare YYYY-MM-DD, or a unix timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        since: {
          type: "string",
          description: "ISO date, YYYY-MM-DD, or unix timestamp. Required — there is no unbounded 'all time' mode.",
        },
        limit: {
          type: "number",
          description: "Max notes to return (default 50).",
        },
      },
      required: ["since"],
      additionalProperties: false,
    },
  },
  {
    name: "note_engagement",
    description:
      "Replies, reactions (likes), and zaps for one or more of Tim's note ids, from the LOCAL cache. Only reflects engagement the background ingest actually saw (events that tagged Tim via #p) — not a live, complete, or global count.",
    inputSchema: {
      type: "object",
      properties: {
        noteIds: {
          type: "array",
          items: { type: "string" },
          description: "One or more Nostr event ids (hex) to look up engagement for.",
        },
      },
      required: ["noteIds"],
      additionalProperties: false,
    },
  },
];

// --- Tool handlers ---------------------------------------------------------

function toolResult(payload, isError) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: !!isError,
  };
}

async function handleMyNotesSince(args) {
  try {
    const result = myNotesSince({ since: args?.since, limit: args?.limit });
    return toolResult({ ok: true, source: "local_cache", ...result }, false);
  } catch (err) {
    return toolResult({ ok: false, error: err.message }, true);
  }
}

async function handleNoteEngagement(args) {
  try {
    const result = noteEngagement({ noteIds: args?.noteIds });
    return toolResult({ ok: true, source: "local_cache", engagement: result }, false);
  } catch (err) {
    return toolResult({ ok: false, error: err.message }, true);
  }
}

// --- JSON-RPC 2.0 / MCP stdio framing -------------------------------------
// Newline-delimited JSON on stdin/stdout, identical framing to
// Omostrich's own bin/mcp.mjs. stdout carries ONLY valid MCP/JSON-RPC
// messages — every diagnostic goes to stderr.

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "omostrich-db", version: "0.1.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      if (name === "my_notes_since") {
        respond(id, await handleMyNotesSince(args));
      } else if (name === "note_engagement") {
        respond(id, await handleNoteEngagement(args));
      } else {
        respondError(id, -32601, `unknown tool: ${name}`);
      }
    } catch (err) {
      respondError(id, -32000, String(err?.message || err));
    }
    return;
  }

  if (id !== undefined) {
    respondError(id, -32601, `unknown method: ${method}`);
  }
}

let stdinBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf("\n")) !== -1) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`omostrich-db-mcp: invalid JSON on stdin, ignoring: ${line}\n`);
      continue;
    }
    handleRequest(msg).catch((err) => {
      process.stderr.write(`omostrich-db-mcp: unhandled error: ${err?.stack || err}\n`);
    });
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.stderr.write("omostrich-db-mcp: ready (stdio)\n");
