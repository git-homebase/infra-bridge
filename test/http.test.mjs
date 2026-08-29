// End-to-end tests over a real listener, started exactly the way production starts it: a child
// process with nothing but environment variables. These are the tests that prove the gates — no
// secret in the path is a 404, no token is a 401, and no sourceQuote is a 400.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Registered dev port 5198 + 1000 — the workspace convention for a port Claude opens itself.
const PORT = 6198;
const SECRET = "test-secret";
const WRITE_TOKEN = "write-token-for-tests";
const AGENT_TOKEN = "agent-token-for-tests";
const BASE = `http://127.0.0.1:${PORT}`;
const PREFIX = `${BASE}/c/${SECRET}`;

const COMMAND = {
  id: "http-001",
  type: "weekly_focus.create",
  payload: { title: "לסגור את החוזה", week: "2026-W35", lifeDomain: "עבודה", status: "open" },
  provenance: {
    homebaseConversationId: "conv-abc",
    sourceQuote: "כן, תוסיפי את זה לשבוע",
    createdBy: "chatgpt",
    at: "2026-08-29T09:00:00.000Z",
  },
};

let child;
let dir;

const post = (url, token, body) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

const get = (url, token) =>
  fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-http-"));
  child = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      SECRET,
      BRIDGE_WRITE_TOKEN: WRITE_TOKEN,
      BRIDGE_AGENT_TOKEN: AGENT_TOKEN,
      QUEUE_DIR: dir,
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await get(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the bridge did not come up");
});

after(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

describe("the bridge over HTTP", () => {
  it("answers the health probe without any secret", async () => {
    const res = await get(`${BASE}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet");
  });

  it("blocks robots", async () => {
    assert.match(await (await get(`${BASE}/robots.txt`)).text(), /Disallow: \//);
  });

  it("is a 404 without the secret in the path", async () => {
    assert.equal((await post(`${BASE}/commands`, WRITE_TOKEN, COMMAND)).status, 404);
    assert.equal((await get(`${BASE}/c/wrong-secret/commands/pending`, AGENT_TOKEN)).status, 404);
  });

  it("is a 401 without a token, and with the wrong one", async () => {
    assert.equal((await post(`${PREFIX}/commands`, null, COMMAND)).status, 401);
    assert.equal((await post(`${PREFIX}/commands`, AGENT_TOKEN, COMMAND)).status, 401);
    assert.equal((await get(`${PREFIX}/commands/pending`, null)).status, 401);
    assert.equal((await get(`${PREFIX}/commands/pending`, WRITE_TOKEN)).status, 401);
  });

  it("is a 400 without a sourceQuote", async () => {
    const body = structuredClone(COMMAND);
    delete body.provenance.sourceQuote;
    const res = await post(`${PREFIX}/commands`, WRITE_TOKEN, body);
    assert.equal(res.status, 400);
    assert.match((await res.json()).message, /sourceQuote is required/);
    assert.deepEqual((await (await get(`${PREFIX}/commands/pending`, AGENT_TOKEN)).json()).commands, []);
  });

  it("queues a command, hands it to the agent once, and forgets it on ack", async () => {
    assert.equal((await post(`${PREFIX}/commands`, WRITE_TOKEN, COMMAND)).status, 201);

    // The same command twice => 200 duplicate, still one item in the queue.
    const again = await post(`${PREFIX}/commands`, WRITE_TOKEN, COMMAND);
    assert.equal(again.status, 200);
    assert.equal((await again.json()).duplicate, true);

    const { commands } = await (await get(`${PREFIX}/commands/pending`, AGENT_TOKEN)).json();
    assert.equal(commands.length, 1);
    assert.equal(commands[0].id, "http-001");
    assert.equal(commands[0].provenance.sourceQuote, "כן, תוסיפי את זה לשבוע");

    const ack = await post(`${PREFIX}/commands/http-001/ack`, AGENT_TOKEN, {});
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).deleted, true);

    const after = await (await get(`${PREFIX}/commands/pending`, AGENT_TOKEN)).json();
    assert.deepEqual(after.commands, [], "an acked command must be gone");
  });
});
