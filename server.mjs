// The command bridge — the only public thing in this architecture, and deliberately the dumbest.
//
// Gitit talks to ChatGPT in her own conversation. When she says something that authorises an
// action, ChatGPT POSTs a single command here. Her home machine never opens an inbound port: a
// local sync agent PULLS from this queue, writes to the Center server on 127.0.0.1:5195, and ACKs.
// (docs/V2/DECISIONS.md, 2026-08-29 — Option A, ratified as an experiment.)
//
//     ChatGPT ──POST──▶ [ bridge: queue only ] ◀──pull/ack── local sync agent ──▶ Center :5195
//
// WHAT THIS SERVER HOLDS: commands that have not been collected yet, for at most an hour.
// WHAT IT NEVER HOLDS: conversation history, money, people, "Me", or anything at all after an ACK.
//
// Two tokens, on purpose. BRIDGE_WRITE_TOKEN is pasted into a third-party product Gitit does not
// control; BRIDGE_AGENT_TOKEN never leaves her PC. Splitting them means a leaked write token can
// only ADD a command (still gated by sourceQuote and by the Center server's own validation) — it
// cannot drain the queue or read what is in it — and either can be rotated without the other.
//
// Local:  SECRET=dev BRIDGE_WRITE_TOKEN=... BRIDGE_AGENT_TOKEN=... node server.mjs  → :5198
// Hosted: PORT/HOST/SECRET/tokens/QUEUE_DIR from env                → https://<host>/c/<SECRET>/

import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeValidationError, CommandQueue, bearer, parseCommand, tokenMatches } from "./queue.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 5198;
const HOST = process.env.HOST || "127.0.0.1";
const SECRET = (process.env.SECRET || "").trim();
const PREFIX = SECRET ? `/c/${SECRET}` : "";
const WRITE_TOKEN = (process.env.BRIDGE_WRITE_TOKEN || "").trim();
const AGENT_TOKEN = (process.env.BRIDGE_AGENT_TOKEN || "").trim();
const QUEUE_DIR = process.env.QUEUE_DIR || join(HERE, "queue");
const TTL_MINUTES = Number(process.env.COMMAND_TTL_MINUTES) || 60;
const SEEN_TTL_DAYS = Number(process.env.SEEN_TTL_DAYS) || 7;

// Refuse to start without tokens rather than starting wide open. A queue with no lock on it is
// worse than no queue: anything on the internet could then write into Gitit's week.
for (const [name, value] of [
  ["BRIDGE_WRITE_TOKEN", WRITE_TOKEN],
  ["BRIDGE_AGENT_TOKEN", AGENT_TOKEN],
]) {
  if (!value) {
    console.error(`[bridge] ${name} is not set — refusing to start.`);
    process.exit(1);
  }
}

const queue = new CommandQueue(QUEUE_DIR, {
  ttlMinutes: TTL_MINUTES,
  seenTtlDays: SEEN_TTL_DAYS,
});
await queue.init();

/* ─────────────────────────── http helpers ─────────────────────────── */

const NOINDEX = { "x-robots-tag": "noindex, nofollow, noarchive, nosnippet" };

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...NOINDEX });
  res.end(res.__head ? undefined : body);
}

const json = (res, code, value) => send(res, code, JSON.stringify(value));

/** 64KB is far more than a weekly focus needs and far less than anything worth storing. */
async function readBody(req, cap = 64_000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > cap) throw new BridgeValidationError("body too large");
  }
  return raw;
}

function authorised(req, expected) {
  return tokenMatches(bearer(req), expected);
}

const log = (...parts) => console.log(`[bridge ${new Date().toISOString()}]`, ...parts);

/* ─────────────────────────── routing ─────────────────────────── */

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    // Uptime probes and link previewers send HEAD. Route it as GET; `send` drops the body.
    if (req.method === "HEAD") {
      req.method = "GET";
      res.__head = true;
    }

    if (url.pathname === "/robots.txt") {
      return send(res, 200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8");
    }
    // The only route outside the secret: the platform's health probe, which knows no secret.
    if (url.pathname === "/healthz") return send(res, 200, "ok", "text/plain; charset=utf-8");

    // No secret in the path => this host has nothing on it. The secret is checked BEFORE the token
    // so an unauthenticated scan cannot even learn that a queue lives here.
    if (PREFIX && !url.pathname.startsWith(PREFIX)) return json(res, 404, { error: "not_found" });
    const path = (PREFIX ? url.pathname.slice(PREFIX.length) : url.pathname) || "/";

    // ── ChatGPT writes here ──
    if (req.method === "POST" && path === "/commands") {
      if (!authorised(req, WRITE_TOKEN)) return json(res, 401, { error: "unauthorized" });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return json(res, 400, { error: "bad_request", message: "body is not valid JSON" });
      }
      const command = parseCommand(body);
      const { stored } = await queue.enqueue(command);
      if (!stored) {
        // Idempotency: same id, seen before. Quietly ok, nothing written twice.
        log(`duplicate ignored id=${command.id}`);
        return json(res, 200, { ok: true, id: command.id, duplicate: true });
      }
      log(`queued ${command.type} id=${command.id} week=${command.payload.week}`);
      return json(res, 201, { ok: true, id: command.id, duplicate: false });
    }

    // ── the local agent pulls here ──
    if (req.method === "GET" && path === "/commands/pending") {
      if (!authorised(req, AGENT_TOKEN)) return json(res, 401, { error: "unauthorized" });
      const commands = await queue.pending();
      return json(res, 200, { commands });
    }

    // ── the local agent confirms here; the command is then gone ──
    const ackMatch = path.match(/^\/commands\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      if (!authorised(req, AGENT_TOKEN)) return json(res, 401, { error: "unauthorized" });
      const id = decodeURIComponent(ackMatch[1]);
      const { deleted } = await queue.ack(id);
      log(`ack id=${id} deleted=${deleted}`);
      return json(res, 200, { ok: true, id, deleted });
    }

    return json(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof BridgeValidationError) {
      return json(res, 400, { error: "bad_request", message: error.message });
    }
    console.error("[bridge]", error);
    return json(res, 500, { error: "server_error" });
  }
});

// `0.0.0.0` binds IPv4 only, and a container healthcheck hitting `localhost` resolves to ::1 first
// — exactly how the roundtable's first deploy failed. Omitting the host makes Node bind dual-stack.
const ALL = HOST === "0.0.0.0" || HOST === "::" || HOST === "any";
const started = () => {
  log(`listening on http://${ALL ? "0.0.0.0" : HOST}:${PORT}${PREFIX}/`);
  log(`queue at ${QUEUE_DIR} · ttl ${TTL_MINUTES}m · seen kept ${SEEN_TTL_DAYS}d`);
  if (!SECRET) log("WARNING: no SECRET set — routes are unprefixed. Local development only.");
};
if (ALL) server.listen(PORT, started);
else server.listen(PORT, HOST, started);

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
