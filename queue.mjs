// The queue itself: validation of an incoming command, and the file store that holds it until the
// local sync agent takes it away. Kept separate from server.mjs so every rule below is unit-testable
// without opening a socket.
//
// WHAT THIS IS NOT. Not a database, not a log, not a mirror of Homebase. A command lives here for
// minutes: it arrives, it is fetched once, it is acknowledged, and it is gone. Nothing survives an
// ACK except an opaque hash of the command id, kept only so the same command cannot be written twice.

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The only command type this bridge understands. An unknown type is a 400, never a stored blob. */
export const SUPPORTED_TYPES = new Set(["weekly_focus.create"]);

/**
 * ISO-8601 week, e.g. "2026-W35". Copied verbatim from center/server/src/weekly-focus/validate.ts
 * (WEEK_PATTERN) so a command the bridge accepts is a command the Center server will also accept —
 * a queue that swallows input its destination rejects would just hide the error for an hour.
 */
export const WEEK_PATTERN = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

const MAX_ID = 200;
const MAX_SHORT = 200;
const MAX_TITLE = 300;
const MAX_QUOTE = 4000;

/** Every rejected command throws this; the server turns it into a 400 with the message. */
export class BridgeValidationError extends Error {}

function requiredString(value, field, max) {
  if (typeof value !== "string") throw new BridgeValidationError(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new BridgeValidationError(`${field} is required`);
  if (trimmed.length > max) {
    throw new BridgeValidationError(`${field} is longer than ${max} characters`);
  }
  return trimmed;
}

function optionalString(value, field, max) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new BridgeValidationError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new BridgeValidationError(`${field} is longer than ${max} characters`);
  }
  return trimmed;
}

function plainObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeValidationError(`${field} must be an object`);
  }
  return value;
}

/**
 * Validate an incoming command and return the normalised copy that gets stored.
 *
 * THE ONE RULE THAT MATTERS: `provenance.sourceQuote` — the sentence Gitit actually said that
 * authorised the write — is REQUIRED. A command without it is a 400 and is never queued. This is
 * the whole point of the bridge: nothing reaches Homebase unless it can name the sentence that
 * asked for it (docs/V2/DECISIONS.md, 2026-08-29).
 */
export function parseCommand(body, now = new Date()) {
  const raw = plainObject(body, "body");

  const id = requiredString(raw.id, "id", MAX_ID);
  const type = requiredString(raw.type, "type", MAX_SHORT);
  if (!SUPPORTED_TYPES.has(type)) {
    throw new BridgeValidationError(
      `unknown type "${type}"; supported: ${[...SUPPORTED_TYPES].join(", ")}`,
    );
  }

  const payloadRaw = plainObject(raw.payload, "payload");
  const week = requiredString(payloadRaw.week, "payload.week", 8);
  if (!WEEK_PATTERN.test(week)) {
    throw new BridgeValidationError(
      `payload.week must be an ISO week like "2026-W35", got "${week}"`,
    );
  }
  const payload = {
    title: requiredString(payloadRaw.title, "payload.title", MAX_TITLE),
    week,
    lifeDomain: optionalString(payloadRaw.lifeDomain, "payload.lifeDomain", MAX_SHORT),
    status: optionalString(payloadRaw.status, "payload.status", MAX_SHORT),
    notes: optionalString(payloadRaw.notes, "payload.notes", MAX_QUOTE),
  };

  const provRaw = plainObject(raw.provenance, "provenance");
  const sourceQuote = optionalString(provRaw.sourceQuote, "provenance.sourceQuote", MAX_QUOTE);
  if (!sourceQuote) {
    throw new BridgeValidationError(
      "provenance.sourceQuote is required: a command must quote the sentence that authorised it",
    );
  }

  let at = now.toISOString();
  if (provRaw.at !== undefined && provRaw.at !== null && provRaw.at !== "") {
    if (typeof provRaw.at !== "string" && typeof provRaw.at !== "number") {
      throw new BridgeValidationError("provenance.at must be an ISO timestamp");
    }
    const parsed = new Date(provRaw.at);
    if (Number.isNaN(parsed.getTime())) {
      throw new BridgeValidationError(`provenance.at is not a valid timestamp: "${provRaw.at}"`);
    }
    at = parsed.toISOString();
  }

  const provenance = {
    homebaseConversationId: requiredString(
      provRaw.homebaseConversationId,
      "provenance.homebaseConversationId",
      MAX_SHORT,
    ),
    sourceQuote,
    createdBy: optionalString(provRaw.createdBy, "provenance.createdBy", MAX_SHORT) ?? "chatgpt",
    at,
  };

  return { id, type, payload, provenance };
}

/* ─────────────────────────── the file store ─────────────────────────── */

/**
 * Command ids come from outside, so they never touch a path. Every file is named by the SHA-256 of
 * the id; the readable id lives inside the JSON. This also makes the ACK route safe: `:id` is
 * hashed the same way and can never escape the queue directory.
 */
export const keyOf = (id) => createHash("sha256").update(String(id), "utf8").digest("hex");

const PENDING = "pending";
const SEEN = "seen";

export class CommandQueue {
  /**
   * @param dir           where the queue lives (a Coolify persistent volume in production)
   * @param ttlMinutes    a command nobody collected is deleted after this long — the safety valve
   *                      that stops a command the Center server keeps rejecting from retrying forever
   * @param seenTtlDays   how long an acknowledged id is remembered, so a retry of the SAME command
   *                      after the fact is still refused. Only a hash is kept, never the content.
   */
  constructor(dir, { ttlMinutes = 60, seenTtlDays = 7 } = {}) {
    this.dir = dir;
    this.pendingDir = join(dir, PENDING);
    this.seenDir = join(dir, SEEN);
    this.ttlMs = ttlMinutes * 60_000;
    this.seenTtlMs = seenTtlDays * 24 * 60 * 60_000;
  }

  async init() {
    await mkdir(this.pendingDir, { recursive: true });
    await mkdir(this.seenDir, { recursive: true });
  }

  /** Delete expired pending commands and forgotten-long-enough seen markers. Called on every read. */
  async purge(now = Date.now()) {
    const dropped = { expired: 0, forgotten: 0 };
    for (const [dir, ttl, counter] of [
      [this.pendingDir, this.ttlMs, "expired"],
      [this.seenDir, this.seenTtlMs, "forgotten"],
    ]) {
      let names = [];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(dir, name);
        try {
          const info = await stat(file);
          if (now - info.mtimeMs > ttl) {
            await rm(file, { force: true });
            dropped[counter] += 1;
          }
        } catch {
          /* raced with another purge — nothing to do */
        }
      }
    }
    return dropped;
  }

  async #exists(dir, key) {
    try {
      await stat(join(dir, `${key}.json`));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store a validated command. Returns `{ stored: false }` when this id was already accepted or
   * already acknowledged — the idempotency rule: the caller gets a quiet 200 and nothing is written
   * a second time. `wx` makes the write itself refuse to overwrite, so two simultaneous POSTs of
   * the same id cannot both land.
   */
  async enqueue(command, now = new Date()) {
    const key = keyOf(command.id);
    if ((await this.#exists(this.pendingDir, key)) || (await this.#exists(this.seenDir, key))) {
      return { stored: false, key };
    }
    const record = { ...command, receivedAt: now.toISOString() };
    try {
      await writeFile(join(this.pendingDir, `${key}.json`), JSON.stringify(record, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if (error && error.code === "EEXIST") return { stored: false, key };
      throw error;
    }
    return { stored: true, key, record };
  }

  /** Everything waiting, oldest first. Expired commands are purged before the list is built. */
  async pending(now = Date.now()) {
    await this.purge(now);
    let names = [];
    try {
      names = await readdir(this.pendingDir);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        out.push(JSON.parse(await readFile(join(this.pendingDir, name), "utf8")));
      } catch {
        /* a half-written or corrupt file is skipped, not fatal */
      }
    }
    return out.sort((a, b) => String(a.receivedAt).localeCompare(String(b.receivedAt)));
  }

  /**
   * The agent finished with a command: delete it and remember only its hash. Idempotent — acking an
   * id that is already gone is an ok, not an error, because the agent may retry an ACK whose
   * response it never saw.
   */
  async ack(id) {
    const key = keyOf(id);
    const existed = await this.#exists(this.pendingDir, key);
    await rm(join(this.pendingDir, `${key}.json`), { force: true });
    await writeFile(join(this.seenDir, `${key}.json`), JSON.stringify({ ackedAt: new Date().toISOString() }), "utf8");
    return { deleted: existed };
  }
}

/* ─────────────────────────── auth ─────────────────────────── */

/** Constant-time compare, so a wrong token cannot be discovered one character at a time. */
export function tokenMatches(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (!expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <token>`, or null. */
export function bearer(req) {
  const header = req.headers?.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}
