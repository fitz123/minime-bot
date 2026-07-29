# Plan: Conversational dedicated Ops with local voice and readable reports

## Goal
Make the independently supervised dedicated Ops Telegram bot the normal conversational Ops interface. It must answer Russian text and locally transcribed voice questions from trusted bounded task/status/history context, while preserving deterministic slash commands as the provider-independent emergency path and routing any approved mutation through the existing lifecycle controls.

## Context
- `src/ops-worker/telegram-control.ts` already owns a separate raw Bot API poller, operator/chat allowlists, durable update acknowledgements, fixed slash commands, and report delivery without the primary Telegram runtime.
- `src/ops-worker/worker-cli.ts`, `supervisor.ts`, and `pi-attempt.ts` already provide the dedicated process, incident scheduler, single custody/process-group invariants, package-owned Pi invocation, quota evidence, standard sessions, and bounded execution primitives.
- `src/voice.ts` and `src/telegram-bot.ts` already implement local ffmpeg/whisper transcription, bounded Telegram downloads, private temporary files, and cleanup.
- `status-server.ts`, `task-store.ts`, `types.ts`, `alertmanager-intake.ts`, and `reporting.ts` provide bounded task, audit, report, alert, and verification records. Alert text remains untrusted data.
- Existing status/task/report text is deterministic but machine-oriented.

## Non-goals
- Routing normal Ops conversation through the primary bot or adding a primary-agent Ops tool.
- Removing, weakening, or making slash commands depend on Pi, the provider, or voice transcription.
- Giving conversational Pi incident custody, executable tools, raw alert authority, or a new mutation path.
- Guessing among multiple lifecycle-eligible tasks; adding a generic coordinator, broker, database, service, or issue-#70 maintenance queue.
- Paid ASR/TTS, automatic spoken replies, or broad changes to the primary Telegram runtime.
- Private rollout, release mechanics, deployment, or production drills inside the public-package implementation run.

## Architecture
Preserve three layers in one dedicated Ops process:

1. **Conversational text/voice:** a bounded, tool-free package-owned Pi turn receives a redacted current snapshot plus the operator text. Voice first crosses the shared local transcription boundary and then uses the identical text path.
2. **Deterministic controls:** existing slash commands are recognized and completed before any conversational admission. They never spawn Pi or ASR.
3. **Independent runtime:** both layers stay inside the dedicated Ops service and use its token, state, scheduler, and package-owned Pi runtime; neither calls the primary bot.

The conversational lane has one in-flight turn per configured operator/chat, no unbounded queue, fixed input/context/output-token/output-byte/media/time limits, and a bounded clarification slot. It neither claims task custody nor reserves the remediation Pi slot. The scheduler can preempt/abort a conversational turn, and conversation is admitted only when no incident action/process group/custody owner is runnable. Failure or preemption produces a concise deterministic fallback naming useful slash commands.

Pi returns a strict bounded envelope: read-only answer, clarification, or a proposed existing control intent. The host computes lifecycle-eligible candidates. A mutation executes only when exactly one candidate is eligible (or one exact candidate was selected from the immediately preceding bounded clarification); otherwise it asks one clarification and records no task mutation. The final operation calls the same command/control function used by the slash command, preserving authorization, replay, audit, and safe-boundary checks.

## Validation Commands

```bash
npm test -- --test-name-pattern='ops worker|voice|report'
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Build bounded trusted conversational views and readable renderers
**Serves:** The operator must ask about current work, state/pool counts, recent alerts/outcomes, reports/history, and required input without IDs, and must receive readable narratives with exact truth.
- [x] Add pure bounded snapshot/view helpers over current task and policy records, with deterministic recency ordering, state counts, custody/activity, recent alert outcomes, reports, verification, blockers, and requested input.
- [x] Keep untrusted alert fields quoted/redacted as data and exclude them from system instructions or execution authority.
- [x] Replace only the explicitly requested status/task/report machine-style views with readable narrative renderers while preserving exact states, actions, blockers, timestamps, verification truth, pagination, redaction, and reply-byte limits.
- [x] Add focused tests for empty, active, blocked, recent-history, redaction, truncation, and exact-truth cases; snapshot mutation-command replies and command availability so unrelated slash-command bytes cannot drift.
- [x] Run the focused tests before Task 2.

### Task 2: Reuse local Telegram voice transcription in the dedicated Ops poller
**Serves:** Telegram voice in the dedicated Ops chat must be locally transcribed and handled exactly like equivalent text, with no paid ASR/TTS or spoken reply.
- [x] Expose/reuse one package-owned local audio ingestion boundary from `src/voice.ts` so primary and Ops paths share ffmpeg/whisper execution, download retry/timeout/size checks, private temp-file handling, cleanup, empty-transcript handling, and safe errors.
- [x] Extend the dedicated raw Bot API parser for strictly validated Telegram voice metadata and bounded `getFile`/download handling; accept no generic document/audio execution path and never log tokenized URLs or transcript-sensitive errors.
- [x] Feed the resulting transcript into the exact same conversational method as text and return only a text reply/fallback.
- [x] Add tests proving text/voice parity, local binaries only, type/size/time limits, malformed metadata rejection, cleanup, and deterministic transcription fallback while slash commands remain usable.
- [x] Run the focused tests before Task 3.

### Task 3: Add the tool-free bounded Ops conversation runner
**Serves:** Ordinary Russian text must work naturally when provider/VPN is available, stay privacy-safe and bounded, and fail usefully when Pi/provider/quota/VPN is unavailable.
- [x] Add a package-owned Pi conversation runner with a fixed no-tools/no-ambient-context policy, prompt-through-stdin, current redacted snapshot, strict response envelope, and answers in the operator's language.
- [x] Enforce fixed input, context, output-token, output-byte, runtime, stall, and session/clarification bounds; own and reconcile any child process/session separately from remediation sessions.
- [x] Validate every model envelope fail-closed: read-only answers cannot mutate, alert text cannot become authority, and malformed/oversized/provider/quota/network/timeout output maps to one deterministic readable fallback with command guidance.
- [x] Add tests for Russian Q&A categories, bounded history, envelope validation, privacy, all failure classes, process/session cleanup, and zero task/custody/audit mutation for read-only turns.
- [x] Run the focused tests before Task 4.

### Task 4: Integrate incident-first admission and safe natural-language steering
**Serves:** Conversation must not starve remediation or bypass lifecycle authorization, and unambiguous answer/retry/pause/resume/cancel intent must work without IDs while ambiguity performs no mutation.
- [ ] Add one in-memory bounded conversation lane that acknowledges and continues polling independently, so long voice/provider work cannot delay later slash commands or report delivery.
- [ ] Make scheduler admission deterministically higher priority: reject conversation while incident work is active/runnable, and abort/reap an in-flight conversational child before an incident Pi launch can proceed.
- [ ] Centralize fixed command operations so slash and validated natural-language intents share exact task eligibility, replay IDs, authorization/lifecycle checks, audit writes, and replies; retain at most one expiring clarification with no mutation until exact selection.
- [ ] Add race/fault tests for simultaneous Q&A and incident arrival, concurrency saturation, preemption, unambiguous steering audit, ambiguous clarification, duplicate Telegram delivery, command/provider independence, and unchanged custody ownership.
- [ ] Run the full validation command set and perform a final scope/public-data cut pass.

## Post-completion
- Open one sanitized feature PR linked to #132 and complete CI/Copilot review.
- Merge, create the next live-release-derived SemVer-valid CalVer release PR, publish the tag/release, and validate merged `main`.
- If explicit conversation enablement requires private configuration, use one private control-workspace PR; otherwise record that no private code/config change was needed.
- Deploy only through the canonical package wrapper after inspecting active sessions/workflows.
- Run dedicated text, voice, slash-command, primary-down, read-only/no-mutation, steering/ambiguity, non-starvation/bounds, provider/transcription fallback, readable-report, health, and tail-audit production drills before closing #132.
