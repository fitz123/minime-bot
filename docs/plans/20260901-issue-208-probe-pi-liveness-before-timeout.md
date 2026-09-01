# Plan: Probe Pi liveness before response-timeout termination

## Goal

Keep the existing fixed 30-minute Pi parent-response-silence boundary, but make its expiry verify liveness before terminating: send one uniquely correlated `get_state` RPC through the same child. An exact successful response with `isStreaming: true` proves the Pi RPC process/session is alive, so the accepted turn remains `processing` and the 30-minute silence window re-arms. Probe write failure, an exact failed/non-streaming response, or no exact response within a short bounded local deadline uses the existing SIGTERM → bounded SIGKILL escalation.

## Non-goals

- No configuration surface, generalized watchdog abstraction, metrics, or periodic heartbeat.
- No `pi-dynamic-workflows` changes, workflow-specific coupling, nested progress forwarding, or `web_search` fix.
- No status UI change: an accepted unsettled turn already remains `processing` through `processingStartedAt`.
- No change to the idle-session timeout, startup timeout, crash recovery, `/clean`, `/reconnect`, explicit shutdown, LRU, queue semantics, or prompt settlement.
- No ADR edit, release, deploy, or production replay inside the Ralphex run.

## Context

- Issue #208 records healthy long-running workflow turns terminated at exactly 30 minutes of parent stream silence. The completed fallback plan and draft PR removed the boundary globally; the approved revision keeps the boundary and probes the documented Pi RPC control plane first.
- The mandatory live proof passed before repository mutation: production Pi 0.82.1 with `pi-dynamic-workflows` 1.0.1 answered two distinct correlated `get_state` requests with `success: true` and `isStreaming: true` in 2 ms and 1 ms while a real workflow was in flight after 5.019 s and 10.122 s of unsolicited parent silence. The workflow then ended without error and the parent settled normally.
- On `main`, `src/session-manager.ts` owns `RESPONSE_ACTIVITY_TIMEOUT_MS`, its activity timer, and the existing SIGTERM → five-second SIGKILL escalation inside `sendSessionMessage()`.
- `src/pi-rpc-protocol.ts` already exports `PiRpcEvent`, `sendPiGetState()`, and `readPiStream()`. `handlePiStreamRecord()` parses each valid JSON record before invoking the current zero-argument activity callback, so passing that existing parsed event is the minimum correlation plumbing.
- Pi's internal prompt-completion probe uses `${expectedPromptId}-state`; the response-liveness probe must use a distinct random id and exact correlation without changing `PiRpcParseState` or settlement behavior.
- A ten-second local probe deadline matches the existing bounded startup `get_state` round trip and leaves ample margin over the measured 1–2 ms live responses.
- The existing main regression `refreshes the activity watchdog for filtered lifecycle records before settlement` must be restored/adapted rather than discarded. Existing fake-child, stdin-capture, fake-timer, and `readPiStream` callback patterns cover the required changes.

## Validation Commands

Focused implementation validation:

```bash
npm run test:file -- src/__tests__/session-manager.test.ts
npm run test:file -- src/__tests__/pi-rpc-protocol.test.ts
npm run typecheck
```

Parent-owned post-Ralphex full-suite gate on the exact final `HEAD`:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Probe Pi liveness at the silence boundary before terminating

**Goal:** At 30 minutes of parent response silence, verify the child is still streaming before termination; retain healthy long turns while preserving the existing recovery path for an unresponsive Pi child.

**Serves:** Ninja's approved issue #208 outcome: keep a real hung-process boundary, prove active workflows remain `processing`, and globally remove the unconditional 30-minute kill only from the verified-live case.

- [ ] Restore the 30-minute activity timer and existing SIGTERM → five-second SIGKILL behavior removed by the fallback branch; factor only the repeated termination decision into one local closure while preserving `hasExited()`, `child.killed`, and non-cancellable pending escalation semantics.
- [ ] Change activity expiry to mint one random response-liveness id, send `get_state`, and wait up to a separate module-private ten-second probe deadline; synchronous or asynchronous probe-write failure must enter the same termination path, with at most one probe pending per silence expiry.
- [ ] In `src/pi-rpc-protocol.ts`, pass the already-decoded `PiRpcEvent` to the optional `readPiStream` activity callback and let `sendPiGetState()` accept the existing shared writer's optional write-error callback; add no new parser state, reader, or event filtering, and keep existing zero-argument callback callers source-compatible.
- [ ] Handle activity records with exact correlation: exact `success: true` plus `data.isStreaming === true` clears the probe and re-arms 30 minutes without clearing `processingStartedAt`; exact failed/false responses terminate; unrelated/stale `get_state` responses cannot clear or extend the pending probe; any genuine non-`get_state` lifecycle/tool/message/UI record cancels the probe deadline and re-arms the silence window.
- [ ] Extend normal/error cleanup to clear the activity and probe timers/id while retaining the existing rule that a pending SIGKILL escalation is cancelled only after child exit.
- [ ] Restore/adapt the filtered-lifecycle watchdog regression and add success-path fake-timer coverage proving the first silence expiry writes exactly one uniquely correlated `get_state`, a verified-live response keeps the child/session processing, a second 30-minute window creates a distinct probe, and normal settlement still completes once.
- [ ] Add focused failure/race coverage for exact `isStreaming: false`, exact failed response, missing exact response, synchronous/asynchronous write failure, stale/unrelated `get_state`, genuine intervening activity, and ignored-SIGTERM escalation to SIGKILL; update protocol tests to prove callbacks receive parsed records in order without disturbing the internal prompt-completion probe or settlement.
- [ ] Replace the fallback removal text in `CHANGELOG.md`, run both focused test files and typecheck, then perform a final diff/privacy cut: no workflow coupling, heartbeat, configuration, new subsystem, status change, unrelated hunk, or private data.

## Post-Completion

The parent supervisor runs the full-suite gate, updates and completes PR #209, publishes and deploys the next release, verifies the deployed probe-before-kill artifact, and replays the exact original workflow under the independent three-hour experiment deadline. A successful parent workflow tool result and usable final report validate the complete production outcome; independent workflow failures remain separate diagnosis and do not remove the proven liveness boundary automatically.
