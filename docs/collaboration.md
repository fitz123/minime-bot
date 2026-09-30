# Same-host Pi collaboration

The running bot can route internal conversations between configured agents,
logical threads, exact bot sessions, and opted-in standalone Pi terminals. A
terminal can be an ordinary PTY host, including Agterm. The router runs inside the
bot, uses a user-only Unix socket, and does not launch terminal applications.
There is no separate daemon, cross-host connection, or intercom dependency.

## Enable the bot

Add this top-level configuration to the bot's control workspace, or its instance
identity overlay:

```yaml
collaboration:
  socketPath: /tmp/minime-collaboration/router.sock
```

Omit `collaboration`, or set it to `false`, to disable it. This is startup
configuration; changing it requires the deployment owner to restart the bot.
Use a distinct socket per bot instance. The path must be absolute and at most
100 UTF-8 bytes (Unix socket paths have small operating-system limits).

The bot creates a missing parent directory with mode `0700`. An existing parent
must already be a user-owned, non-symlink `0700` directory. The socket is `0600`.
Startup refuses a live socket or an unrelated file. A user-owned socket that
refuses a connection can be removed as stale after checking it did not change.
Normal shutdown closes the listener and connections. A crashed bot may leave a
stale socket for its next startup to reclaim.

Participating bot children automatically load the package extension. Their
processes, exact transcript bindings, scheduling, and RPC stdout reader remain
owned solely by SessionManager. Do not also add this wrapper to
`piExtraExtensions`. `PI_EXTENSIONS_DISABLED=1` still disables all explicit
wrappers; owner delivery to bot contexts is rejected while they are disabled.

## Enable a standalone Pi terminal

Keep the launcher's existing full-context setup and explicitly add:

```sh
MINIME_COLLABORATION_SOCKET=/tmp/minime-collaboration/router.sock \
MINIME_COLLABORATION_LABEL='Planning terminal' \
  pi --extension /path/to/minime-bot/dist/extensions/pi/collaboration.js
```

Use Pi **0.99.1**, the package's pinned version. A source checkout can load
`extensions/pi/collaboration.ts` instead. The package does not read or assemble
private terminal-launcher context. The parent launcher owns those inputs.

`MINIME_COLLABORATION_SOCKET` opts the extension in; without it the wrapper
registers no tools. `MINIME_COLLABORATION_LABEL` is an optional discovery label.
Leave `MINIME_COLLABORATION_SESSION` unset in standalone launchers: SessionManager
supplies that exact identity only to its own children. These collaboration env
values are not inherited by default/`ask_agent` child spawns.

If the bot is absent, ordinary Pi turns and tools still work. Collaboration tools
report disconnected. The extension retries registration once per second using an
unreferenced timer, so an absent router does not keep a terminal process alive.
It never retries a sent request or replays a received message. New/resumed/forked
sessions, reloads, and tree changes acquire a new terminal address; old addresses
do not move to replacement contexts. Discovery is necessary again after a switch.
Queued, uninjected input is rejected when a context change begins, even if another
extension subsequently cancels the switch.

## Addresses and tools

Addresses are objects with separate `kind` and `id` fields. Use discovery rather
than guessing a target or treating one address kind as another.

| Kind | ID | Meaning |
| --- | --- | --- |
| `agent` | configured agent ID | Start an internal consultation with that agent's configured workspace, model, system prompt and context. It gets a dedicated continuing transcript, separate from its human thread. |
| `thread` | owner's logical session key | Address a configured/known logical thread. Telegram keys are a chat key or chat/topic key. Known stored Discord lanes are also discoverable. The bot owner alone opens/resumes the thread. |
| `session` | exact Pi session ID | Pin a bot-owned transcript. An inactive session can be resumed by its owner only if the original exact binding is usable. A reset, missing transcript, or identity mismatch is rejected; no snapshot or replacement is substituted. |
| `terminal` | discovered incarnation ID | Address that connected standalone Pi context. It cannot be resumed or autostarted by the router. A closed/switching terminal requires fresh discovery. |

`collaboration_discover({offset?: number})` returns up to 64 `endpoints` and an
optional `nextOffset`. Pass that value as `offset` for the next page. Labels help
identify peers; IDs distinguish them. Discovery is a current view, not a lease.
Exact sessions include continuing agent consultations. An agent address is never
an alias for whichever human session happens to be active.

`collaboration_send({to: {kind, id}, text})` starts a conversation and returns a
receipt. Incoming content includes a message `id`, conversation ID, and exact
sender address. Use `collaboration_reply({replyTo: id, text})` to continue that
conversation in both directions. The first bot delivery resolves its agent/thread
address to the exact session before the target can reply. Follow-up replies stay
in those contexts, including after an owner-mediated idle resume.

`collaboration_receipt({id})` looks up delivery state. A send/reply waits only for
the router acknowledgement, **never for the peer's answer**. Finish the current
turn after asking for clarification so the reply can be consumed. Pi waits for
tool completion before processing queued input; a synchronous mutual question
would deadlock. This tool therefore does not implement blocking consultation.
The existing `ask_agent` tool keeps its existing synchronous child-run contract
and policy; it is not silently replaced by collaboration. The separate bot-wide
collaboration opt-in exposes configured agents independently of `askAgent`
allowlists.

## Receipts and bounded conversations

| Status | Meaning |
| --- | --- |
| `accepted` | Router accepted the message for delivery. The target may still be busy; this is not consumption or a successful answer. |
| `consumed` | The owning Pi lifecycle emitted the incoming message event. This does not mean the model completed successfully or published anything. |
| `rejected` | The owner/router could not accept the target, bound, or operation before model consumption. Read the reason, correct it, and decide whether a new send is appropriate. |
| `disconnected` | No connected terminal/router or live target was available before dispatch. |
| `unknown` | A write, acknowledgement, connection, process, or retained receipt was lost. Effects may already have occurred. Do not blindly replay. |
| `expired` | The receiver dropped queued input before injection, or the conversation's reply window ended. This is not inferred merely from a lost acknowledgement. |

Each conversation stops accepting replies after **32 total messages or ten
minutes**. Start a new conversation deliberately if more work is needed. These
are conversation stop conditions, not a global model budget. The router also
bounds its resources (256 connections, 4096 retained receipts, 16,000 text
characters per message). It rejects new work when capacity is exhausted. Receipts
are retained for at most a further ten minutes after the conversation deadline;
a missing receipt is unknown, including after a router restart.

If an acknowledged target disconnects before confirming consumption, the outcome
is unknown. After reconnect, tools can send new work and discover peers; old sends
are not replayed. Receipts can update from accepted to a terminal status. An
unknown timeout may later be clarified by an actual consumption acknowledgement.
No durable exactly-once guarantee is provided.

## Scheduling, output, and trade-offs

Bot internal turns run through SessionManager's per-session queue. They wait for
human input staging, debounce/collected messages, the active human turn, and its
final transport relay cleanup. They cannot steer into a human turn. Human input
arriving during an internal turn queues for the next turn; it is not steered into
the private turn. Internal admission does not evict a busy session when the bot's
normal process limit is full; it rejects that consultation instead.

Internal streams are never passed to Telegram or Discord drafts, final text, or
file relays. During an internal turn the human outbox directory is held aside.
Any files written into the internal outbox are discarded before restoring it,
including on error/reset; they cannot be sent by the next human relay. Save work
products in the workspace if they should survive the internal turn. Outbox
isolation failures stop further delivery from that child until owner reconnect.
Session teardown and crash recovery fence that cleanup before the path is reused.
Each lane has at most one reserved human-outbox backup; normal startup and
teardown also discard it after a whole-bot crash. During internal turns the bot
extension points `MINIME_OUTBOX` at a separate private directory. Bash commands
capture that environment, so delayed background output stays outside the human
outbox after the turn ends. The next internal turn or owner teardown/startup
reclaims that bounded private directory.

Standalone scheduling belongs to the extension. It keeps a bounded inbox while
Pi is busy, drops expired input before injection, and starts the next internal
turn via Pi's supported custom-message API when idle/settled. Terminal UI and
transcripts may show internal content. Stored internal context may influence later
human turns; collaboration is not a hidden-history or deletion feature.

Publication to humans is a **separate explicit action**. The collaboration prompt
instructs peers not to publish or use the delivery outbox. This is coordination
among trusted same-user agents, not an enterprise ACL against a hostile process
with shell access. Direct external publishing tools remain subject to their own
explicit authorization. Use the supplied `MINIME_OUTBOX` environment when working
with delivery files; do not cache a previous turn's outbox path.

State is local and ephemeral at the router; Pi transcripts follow the existing
session-store lifecycle and are not deleted or migrated by this feature. Router
availability depends on the bot. A standalone terminal remains usable without it.
