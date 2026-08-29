# infra-bridge — the command bridge

The one public piece of the 2026-08-29 architecture, and deliberately the dumbest thing in the
workspace: **an authenticated queue that forgets.**

```
Gitit's conversation in ChatGPT
        │  HTTP POST, Bearer token, one command
        ▼
   this bridge  ── public, on Gitit's Hetzner server, queue only
        ▲
        │  outbound pull + ack
   center/sync-agent  ── runs on Gitit's PC
        │
        ▼
   Center server on 127.0.0.1:5195  →  WeeklyFocus + FocusWrite
```

**The home machine never opens an inbound port.** The agent pulls. That is the whole security shape.

## The one rule

A command must quote **the sentence that authorised it**. `provenance.sourceQuote` is required;
without it the command is a `400` and is never queued. Nothing reaches Homebase unless it can say,
in Gitit's own words, what asked for it.

## What it holds, and for how long

| | |
|---|---|
| Commands not yet collected | up to `COMMAND_TTL_MINUTES` (default 60), then deleted |
| Acknowledged command ids | a SHA-256 hash only, for `SEEN_TTL_DAYS` (default 7), so a replay is refused |
| Everything else | **nothing** — no conversation history, no money, no people, no "Me" |

## Routes

Every real route lives under `/c/<SECRET>/`. Without the secret the host answers `404` — before it
ever looks at a token, so a scan cannot learn a queue lives here.

| | | |
|---|---|---|
| `POST` | `/c/<SECRET>/commands` | ChatGPT enqueues one command. `Bearer BRIDGE_WRITE_TOKEN`. |
| `GET` | `/c/<SECRET>/commands/pending` | The agent pulls. `Bearer BRIDGE_AGENT_TOKEN`. |
| `POST` | `/c/<SECRET>/commands/<id>/ack` | The agent confirms; the command is deleted. Agent token. |
| `GET` | `/healthz` | Liveness. No secret, no token, no data. |
| `GET` | `/robots.txt` | `Disallow: /`. Every response also carries `x-robots-tag: noindex`. |

Responses: `201` a new command was queued · `200 {duplicate:true}` this id was already seen, nothing
written twice · `400` malformed or unquoted · `401` wrong/absent token · `404` wrong secret.

### Two tokens, on purpose

`BRIDGE_WRITE_TOKEN` gets pasted into a third-party product Gitit does not control.
`BRIDGE_AGENT_TOKEN` never leaves her PC. A leaked write token can only *add* a command — still
gated by `sourceQuote` and by the Center server's own validation. It cannot drain the queue or read
what is in it, and either token can be rotated without touching the other.

## The command shape

Exactly as specified in `docs/V2/DECISIONS.md` (2026-08-29):

```json
{
  "id": "<idempotency key, unique per authorised turn>",
  "type": "weekly_focus.create",
  "payload": {
    "title": "לסגור את החוזה עם הספק",
    "week": "2026-W35",
    "lifeDomain": "עבודה",
    "status": "open"
  },
  "provenance": {
    "homebaseConversationId": "<the conversation this came from>",
    "sourceQuote": "כן, תוסיפי את זה לשבוע",
    "createdBy": "chatgpt",
    "at": "2026-08-29T09:00:00.000Z"
  }
}
```

`title` and `week` are required; `week` must be an ISO week (`2026-W35`, leading zero required).
`lifeDomain`, `status` and `notes` are optional. `at` defaults to the server clock.
`weekly_focus.create` is the only type — anything else is a `400`.

## Running it

```bash
npm test          # 17 tests: the rules, the queue, and the gates over a real listener
npm run typecheck # syntax check, no build step and no dependencies
npm start         # needs SECRET + both tokens in the environment, or it refuses to start
```

Local dev port **5198** (registered in the `dev-ports` skill); the container listens on 3000.
There are **no dependencies** — Node's standard library only.

## Deployment

Coolify on the Hetzner hub, same pattern as `docs/V2/design/roundtable`: Dockerfile build, the
repo holds code only, all secrets are Coolify environment variables, and `queue/` is a persistent
volume mounted at `/data/queue` so a redeploy in the middle of a pending command does not drop it.

## Swapping the front door

If it turns out ChatGPT can only write into a specific product (the 2026-08-29 entry names Supabase
as an untested candidate), only this server is replaced. The agent polls a different source and
nothing else in Homebase changes — which is exactly why the queue is ours and the connector is not.
