// Minimal fake Nostr relay for the ingest reconnect tests.
//
// Speaks just enough NIP-01 to drive src/ingest.mjs: on REQ it sends
// one synthetic EVENT per `eventsPerReq`, then EOSE. The test can
// `killAllClients()` to slam every socket shut (simulating the relay
// dropping us), and inspect `reqs` to prove the client re-subscribed
// with a `since` after reconnect. Events here are NOT signed -- the
// ingest under test uses an injected importer, never the real ndb.

import { WebSocketServer } from "ws";

export function startFakeRelay({ eventsPerReq = 1, pubkeyHex } = {}) {
  let acceptConnections = true;
  // Refuse at the HTTP upgrade (401), not after the handshake: the
  // client must see an error and NEVER an "open", otherwise an outage
  // looks like a rapid open/close flap and the ingest's all-down clock
  // keeps resetting -- which is not what a real outage looks like.
  const wss = new WebSocketServer({ port: 0, verifyClient: () => acceptConnections });
  const port = wss.address().port;
  const url = `ws://127.0.0.1:${port}`;
  const clients = new Set();
  const reqs = []; // every REQ seen, in order: { subId, filters, at }
  let seq = 0;

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg[0] !== "REQ") return;
      const subId = msg[1];
      const filters = msg.slice(2);
      reqs.push({ subId, filters, at: Date.now() });
      for (let i = 0; i < eventsPerReq; i++) {
        seq += 1;
        ws.send(
          JSON.stringify([
            "EVENT",
            subId,
            {
              id: `fake-${port}-${seq}`.padEnd(64, "0"),
              pubkey: pubkeyHex,
              kind: 1,
              created_at: Math.floor(Date.now() / 1000),
              tags: [],
              content: `fake event ${seq}`,
              sig: "".padEnd(128, "0"),
            },
          ])
        );
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    });
  });

  return {
    url,
    port,
    reqs,
    get clientCount() {
      return clients.size;
    },
    // Simulate the relay dropping every connection (what happened in
    // production). ws.terminate() = abrupt TCP close, no close frame.
    killAllClients() {
      for (const ws of clients) ws.terminate();
    },
    // Simulate a hard outage: refuse new connections until restored.
    setAccepting(v) {
      acceptConnections = v;
    },
    close() {
      return new Promise((resolve) => {
        for (const ws of clients) ws.terminate();
        wss.close(() => resolve());
      });
    },
  };
}
