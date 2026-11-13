# t3code-listener

A minimal external app that listens to [T3 Code](https://github.com/pingdotgg/t3code) orchestration
shell events over the authenticated WebSocket RPC stream (`orchestration.subscribeShell`).

It is the same projection the T3 web/desktop/mobile clients use for their thread list: project and
thread metadata plus status flags (work state, pending input/approval, plan review, settled). It never
reads workspace files, and reads a thread's messages only for [silent threads](#silent-threads).

## Requirements

- Node.js 24+ (runs TypeScript directly via type stripping).
- Yarn 1.x (`yarn install`).
- A T3 Code server and a **read-only pairing link** (Settings → Connections → Read only).

## Setup

```bash
yarn install
```

## Pairing and sessions

You only pair once per server. The pairing credential is single-use with a ~5-minute TTL, but the bearer
access token it yields lasts about 30 days. The listener caches that bearer and reuses it on restart:

- Default cache: `$XDG_CONFIG_HOME/t3code-listener/sessions.json` (or `~/.config/...`), written `0600`,
  keyed by server URL.
- `--token-file <path>` overrides the location; `--no-persist` disables reading and writing it.
- If the server rejects a cached session (revoked/expired), the listener clears it and re-pairs
  automatically when a pairing credential is available.

There is no refresh token, so after the ~30-day bearer expires you pair again with a fresh read-only link. When a
session is rejected and no pairing credential is available, the listener exits with a message telling you to re-pair
rather than retrying forever.

### Longer-lived token

If you would rather not re-pair monthly, the T3 CLI can issue a bearer with a custom TTL and exact scopes. Run it
on the host that owns the T3 data directory:

```bash
t3 auth session issue --scope orchestration:read --scope orchestration:operate \
  --ttl 365d --token-only --base-dir ~/.t3 > ~/.config/t3code-listener/bearer
chmod 600 ~/.config/t3code-listener/bearer
yarn start --url http://localhost:3000 --bearer-file ~/.config/t3code-listener/bearer
```

The listener caches that bearer by its own `exp`, so after this one command later runs need only `--url`.

Each `--scope` replaces the default set. `orchestration:read` is enough for hooks; `orchestration:operate` is
needed only for [silent threads](#silent-threads), and it can also send messages and archive or delete threads.
Treat the file as a secret. Revoke it with `t3 auth session revoke <session-id>` or Settings → Connections.

## Usage

Pair with a read-only link (the token may be in the query string or the `#` fragment):

```bash
yarn start --pairing-url 'http://localhost:3000/#token=...'
```

Later runs need only the server URL:

```bash
yarn start --url http://localhost:3000
```

Or pass the pieces explicitly:

```bash
yarn start --url http://localhost:3000 --token <pairing-token>
yarn start --url http://localhost:3000 --bearer <access-token>
```

Environment fallbacks: `T3_PAIRING_URL`, `T3_URL`, `T3_PAIRING_TOKEN`, `T3_BEARER`,
`T3_BEARER_FILE`, `T3_CLIENT_LABEL`, `T3_TOKEN_FILE`, `T3_HOOKS_FILE`.

Options:

| Flag | Meaning |
| --- | --- |
| `--pairing-url <url>` | Read-only pairing link. |
| `--url <base>` | Server base URL, e.g. `http://localhost:3000`. |
| `--token <token>` | One-time pairing token, exchanged for a bearer. |
| `--bearer <token>` | Existing bearer access token (cached by its `exp` claim). |
| `--bearer-file <path>` | Read the bearer token from a file instead of argv/env. |
| `--label <label>` | Client label reported to the server. |
| `--token-file <path>` | Bearer token cache path. |
| `--hooks-file <path>` | External hook definitions (default `~/.config/t3code-listener/hooks.json`). |
| `--no-persist` | Do not read or write the bearer token cache. |
| `--no-reconnect` | Exit on the first disconnect instead of retrying. |

## Hooks

Run shell commands on agent lifecycle transitions, Cursor-hooks style. Define them in
`~/.config/t3code-listener/hooks.json` (override with `--hooks-file` / `T3_HOOKS_FILE`):

```json
{
  "version": 1,
  "hooks": [
    {
      "event": "turn.completed",
      "command": "notify-send 'T3 Code' \"$T3_THREAD_TITLE finished\""
    },
    {
      "event": "input.requested",
      "command": "notify-send -u critical 'T3 Code' \"$T3_THREAD_TITLE needs input ($T3_INPUT_KIND)\"",
      "match": { "kind": "user_input" },
      "timeoutMs": 10000
    }
  ]
}
```

Events are **edge-triggered** from `thread.updated` transitions. The initial snapshot only seeds
state, so reconnects do not re-fire hooks for work that was already pending.

| Event | Fires when |
| --- | --- |
| `turn.completed` | A thread's latest run reaches `completed`, i.e. the agent finished generating. |
| `turn.failed` | A thread's status becomes `failed`. |
| `turn.cancelled` | A thread's status becomes `interrupted`, `cancelled`, or `rolled_back`. |
| `input.requested` | A new pending runtime request appears, or an actionable plan appears. `input.kind` is `user_input`, `permission`, `mcp-elicitation`, `command`, `file-read`, `file-change`, `dynamic_tool_call`, `auth_refresh`, or `plan_review`. |

`turn.completed` tracks the run status, not thread settlement (`settledAt`). Settlement can lag behind
generation while background work drains, so a settled thread with no completed run does not fire it. The payload
still includes `thread.settledAt` for context.

Each hook takes:

| Field | Meaning |
| --- | --- |
| `event` | One of the events above, or `"*"`. |
| `command` | Shell command run with `sh -c` (or `cmd` on Windows). |
| `match.projectId` | Only fire for this project. |
| `match.threadId` | Only fire for this thread. |
| `match.kind` | Only fire for this `input.kind`. |
| `match.status` | Only fire when the thread status matches. |
| `match.titlePattern` | JavaScript regex tested against the thread title. |
| `match.subagent` | `true`: only subagent threads (`delegate_task` children and native provider subagents). `false`: only non-subagent threads. Omit for both. |
| `timeoutMs` | Kill the command after this many ms (default 30000). |

### Silent threads

A top-level `silent` entry lets an agent opt a run out of notifying, e.g. a scheduled check that found
nothing ends its reply with `[silent]`:

```json
{
  "version": 1,
  "hooks": [],
  "silent": { "messagePattern": "\\[silent\\]\\s*$" }
}
```

When a top-level thread's run completes, the listener reads the thread (`orchestration.getThreadProjection`)
and tests its last assistant message against `messagePattern`, a JavaScript regex. On a match it skips that
`turn.completed`'s hooks and marks the thread read (the app's `thread.visit` command), so it leaves the
unread list. Other events still fire, and subagent threads are never read. The read returns the whole thread,
so it costs one round-trip per completed run while `silent` is set. Marking read needs the `orchestration:operate` scope, which a read-only pairing link lacks: see
[Longer-lived token](#longer-lived-token). Without it the hooks are still skipped and a warning is logged.
A thread that cannot be read counts as not silent, so its hooks fire.

The event JSON is written to the command's stdin, and the same fields are exported as `T3_EVENT`,
`T3_THREAD_ID`, `T3_THREAD_TITLE`, `T3_PARENT_THREAD_ID`, `T3_THREAD_RELATIONSHIP` (`subagent`, `fork`, or empty),
`T3_PROJECT_ID`, `T3_PROJECT_TITLE`, `T3_CWD` (thread worktree, else project workspace root), `T3_STATUS`,
`T3_INPUT_KIND`, `T3_SEQUENCE`, and `T3_TIMESTAMP`. Hooks run detached so a slow command never
blocks the stream; non-zero exits and timeouts are logged.

See [`examples/hooks.json`](examples/hooks.json) for a ready-to-copy desktop-notification config.

## Output

The listener is silent during normal operation: shell events are consumed internally and hooks are the output.
Errors (bad credentials, unreadable hooks file, failed or timed-out hook) still go to stderr.

The listener reconnects with `afterSequence` set to the highest sequence it has seen, so it resumes
without re-downloading the whole snapshot. A stale cursor makes the server send a fresh snapshot instead.

## How it works

1. `POST /oauth/token` exchanges the pairing credential for a bearer token. Omitting `scope` makes the
   server grant the pairing link's own scopes, so a read-only link yields `orchestration:read`.
2. The bearer is cached (unless `--no-persist`) and reused on later runs.
3. `POST /api/auth/websocket-ticket` issues a short-lived, single-use ticket.
4. The RPC client connects to `/ws?orchestrationProtocol=2&wsTicket=...` and subscribes to
   `orchestration.subscribeShell`.

The `orchestration:read` scope is currently the narrowest grant that includes `subscribeShell`; it also
allows file reads. The bearer session lasts about 30 days. Neither the scope nor the stream is a published
public SDK contract, so expect to pin to a server version.

## Verification

`yarn smoke` runs the stream handling against an in-memory RPC server (no T3 instance or credentials
needed) and asserts the stream and cursor paths. `yarn smoke:hooks` asserts hook edge detection and command
dispatch.

```bash
yarn typecheck
yarn smoke
yarn smoke:hooks
```

## Layout

- `src/config.ts` - CLI/env parsing and URL normalization.
- `src/auth.ts` - pairing exchange, WebSocket ticket, `/ws` URL.
- `src/tokenStore.ts` - bearer token cache (read/write/clear, `0600`).
- `src/protocol.ts` - minimal `orchestration.subscribeShell` RPC group and resume cursor.
- `src/json.ts` - small JSON narrowing helpers.
- `src/hooks.ts` - hook config, transition detection, matching, command runner.
- `src/index.ts` - connect, subscribe, reconnect loop.
- `scripts/smoke.ts` - serverless end-to-end check.
- `scripts/hooks-smoke.ts` - hook detection and dispatch check.
