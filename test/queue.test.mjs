// Unit tests for the rules, with no socket involved: what the bridge refuses, and what it
// refuses to store twice.

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandQueue, keyOf, parseCommand, tokenMatches } from "../queue.mjs";

const COMMAND = {
  id: "cmd-001",
  type: "weekly_focus.create",
  payload: { title: "לסגור את החוזה", week: "2026-W35", lifeDomain: "עבודה", status: "open" },
  provenance: {
    homebaseConversationId: "conv-abc",
    sourceQuote: "כן, תוסיפי את זה לשבוע",
    createdBy: "chatgpt",
    at: "2026-08-29T09:00:00.000Z",
  },
};

const without = (path) => {
  const copy = structuredClone(COMMAND);
  const parts = path.split(".");
  let node = copy;
  while (parts.length > 1) node = node[parts.shift()];
  delete node[parts[0]];
  return copy;
};

describe("parseCommand", () => {
  it("accepts a well-formed command and normalises it", () => {
    const parsed = parseCommand(COMMAND);
    assert.equal(parsed.id, "cmd-001");
    assert.equal(parsed.payload.week, "2026-W35");
    assert.equal(parsed.provenance.sourceQuote, "כן, תוסיפי את זה לשבוע");
    assert.equal(parsed.provenance.at, "2026-08-29T09:00:00.000Z");
  });

  // THE central rule of this bridge.
  it("refuses a command with no sourceQuote", () => {
    assert.throws(() => parseCommand(without("provenance.sourceQuote")), /sourceQuote is required/);
    assert.throws(
      () => parseCommand({ ...COMMAND, provenance: { ...COMMAND.provenance, sourceQuote: "   " } }),
      /sourceQuote is required/,
    );
  });

  it("refuses a command missing any other required field", () => {
    for (const path of ["id", "type", "payload.title", "payload.week", "provenance.homebaseConversationId"]) {
      assert.throws(() => parseCommand(without(path)), new RegExp("required|must be an object"), path);
    }
  });

  it("refuses an unknown type and a malformed week", () => {
    assert.throws(() => parseCommand({ ...COMMAND, type: "money.transfer" }), /unknown type/);
    assert.throws(
      () => parseCommand({ ...COMMAND, payload: { ...COMMAND.payload, week: "2026-W5" } }),
      /ISO week/,
    );
  });

  it("stamps `at` when the caller omits it", () => {
    const parsed = parseCommand(without("provenance.at"), new Date("2026-08-29T12:00:00.000Z"));
    assert.equal(parsed.provenance.at, "2026-08-29T12:00:00.000Z");
  });
});

describe("CommandQueue", () => {
  let dir;
  let queue;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
    queue = new CommandQueue(dir, { ttlMinutes: 60 });
    await queue.init();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores a command once, and refuses the same id a second time", async () => {
    const first = await queue.enqueue(parseCommand(COMMAND));
    assert.equal(first.stored, true);
    const second = await queue.enqueue(parseCommand(COMMAND));
    assert.equal(second.stored, false);
    assert.equal((await queue.pending()).length, 1);
  });

  it("deletes the command on ack, and still refuses it afterwards", async () => {
    assert.deepEqual(await queue.ack("cmd-001"), { deleted: true });
    assert.equal((await queue.pending()).length, 0);
    const replay = await queue.enqueue(parseCommand(COMMAND));
    assert.equal(replay.stored, false, "an acked id must never come back");
    assert.equal((await queue.pending()).length, 0);
  });

  it("acking an unknown id is an ok, not an error", async () => {
    assert.deepEqual(await queue.ack("never-existed"), { deleted: false });
  });

  it("drops a command nobody collected within the TTL", async () => {
    const command = parseCommand({ ...COMMAND, id: "cmd-stale" });
    const { key } = await queue.enqueue(command);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(join(dir, "pending", `${key}.json`), old, old);
    assert.equal((await queue.pending()).length, 0);
  });

  it("names files by hash, so an id can never escape the queue directory", () => {
    assert.match(keyOf("../../etc/passwd"), /^[0-9a-f]{64}$/);
  });
});

describe("tokenMatches", () => {
  it("accepts only the exact token", () => {
    assert.equal(tokenMatches("abc123", "abc123"), true);
    assert.equal(tokenMatches("abc124", "abc123"), false);
    assert.equal(tokenMatches("abc", "abc123"), false);
    assert.equal(tokenMatches(null, "abc123"), false);
    assert.equal(tokenMatches("", ""), false, "an empty expected token must never match");
  });
});
