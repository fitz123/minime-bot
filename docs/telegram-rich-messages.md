# Telegram rich agent answers

Telegram agent answers use native rich messages, including short paragraphs. Existing commands, errors, service notices, Discord output, and unreferenced outbox attachments keep their ordinary delivery behavior. Telegram DM previews use text-only native rich drafts showing the latest bounded source blocks (with fence context retained for code tails). Identical projected previews are deduplicated and visible drafts refresh every 15 seconds. Draft calls bypass automatic transport retries; final calls retain the existing bounded retries and their ambiguous-delivery risk.

To interleave a local photo with an answer, write a JPEG or PNG to the session outbox (`MINIME_OUTBOX`) and reference its basename:

```markdown
# Results

The first result:

![First result](outbox:first.png)

The comparison:

![Comparison](outbox:comparison.jpg)
```

Use basenames without spaces, directory separators, or symlinks. Photos must be regular JPEG/PNG files, at most 10 MB, with positive dimensions whose sum is at most 10000 and whose aspect ratio is at most 20. The file contents and dimensions are checked independently of the filename extension. Place photos between paragraphs, outside table cells, and use captions without closing brackets (`]`). An invalid inline reference prevents final answer delivery. External image syntax becomes a caption/link; the bot does not download arbitrary image URLs. Code examples are literal and do not consume outbox files.

The relay prepares the full accumulated Markdown before legacy newline collapse or tail slicing. It splits conservatively below Telegram's text, block, nesting, table-column, and attachment limits; large tables repeat their headers. Oversized or excessively nested structures are delivered as native literal text with a normalization notice. Compatible adjacent headings, paragraphs, tables, photos and literal code are packed into one native block array when within limits. More complex Markdown stays on the server-parsed path and may require a separate message at an encoding boundary. Literal code uses native preformatted blocks, retaining interior blank lines. Unknown HTML-like placeholders use native rich text rather than relying on Telegram's Markdown parser, which strips unknown tags and interprets supported HTML. Supported inline formatting remains intentional formatting. This is not a lossless parser for arbitrary Markdown; unsupported structures may be normalized. Deterministic send errors do not trigger ordinary-message fallback.

All inline sources are validated and moved into the outbox's `.rich-reserved/<delivery-id>/` directory before any final chunk is sent. A source is deleted only after every chunk referencing it has been confirmed. Failed or uncertain sources survive normal session preparation/cleanup, including interrupted internal consultations; startup moves stale human-backup reservations back into the normal excluded subtree. These files remain excluded from standalone attachment scanning. Cleanup failures also leave confirmed sources excluded. Diagnostics identify the reservation directory for explicit inspection; nothing automatically replays these files. A later chunk failure can leave partial delivery. `NO_REPLY` suppresses final text and all outbox dispatch before reservation.

Incoming rich posts supply bounded text from headings, paragraphs, lists, tables, quotes and captions, plus actual downloaded photo content to Pi vision. Ordinary incoming photos use the same explicit Pi vision input. The immediate parent contributes ordinary or rich photos even when the new message is ordinary text; explicit quote text takes precedence over full parent text. Reply chains are not traversed. Unavailable parent photos are omitted with a marker; the primary user text and successful downloads still reach the agent. A failure downloading the message’s own photo retains the existing error behavior. Direct and parent photos share deduplication, a 50-photo cap and a total download budget of the smaller of `maxMediaBytes` and 20 MB. Coalesced Pi prompts and acknowledged steering retain their text and fitting images within 50 photos / 20 MB, skipping excess images with an explicit omission note. Unsupported blocks and omitted media have descriptive markers. Existing authorization, topic routing, forwarding provenance, indexing and queue release/drop custody apply, including acknowledged steering.

## Cron results and send-path audit (issue 218)

Fresh LLM and script cron results, including retained `kind: "output"` records from older versions, use explicit result intent in `cron-runner.ts`. Delivery reuses `prepareRichAnswer` and `createTelegramApiAdapter` through `cron-rich-delivery.ts`. It uses the same resolved bot token and the result's chat/thread destination; replay uses the destination stored in the record. Each confirmed chunk writes its text projection to the existing passive-context echo spool. Echo write failure does not retry a confirmed post.

Cron retains its three fresh delivery attempts (5s and 30s delays), then one replay attempt per scheduled invocation before generation. There is no additional API retry layer. Rich preparation failures, native API rejections (including deterministic 4xx), and uncertain transport failures retain the original output and block regeneration while replay fails. They never use ordinary-message fallback. Ordinary service-delivery validation failures keep their previous classification. Configured outbox expiration still applies. Whole-result retries can duplicate already confirmed chunks, and a crash between send and record cleanup can still duplicate delivery; this change adds no exactly-once guarantee or chunk checkpoint protocol.

LLM empty/`NO_REPLY` suppression still happens before delivery; script output retains its existing literal `NO_REPLY` behavior. Cron print-mode has no session outbox or attachment dispatch contract. Local inline photo references therefore fail preflight and retain the result without touching ambient media. Interactive inline reservations, confirmed consumption, and standalone attachment dispatch are unchanged.

| Path | Classification and disposition |
| --- | --- |
| Telegram queued/interactive answers, acknowledged steering, result-only stream fallback | Already rich through `telegram-bot.ts` → `relayStream` → adapter; no additional successful answer bypass found. |
| Fresh and replayed cron results, including script reports and unresolved LLM reports | Migrated to native rich delivery in this follow-up. |
| Interactive DM drafts | Native rich drafts; `DRAFT_REFRESH_INTERVAL_MS = 15_000`, projection deduplication, and suspension unchanged. No issue 211 work. |
| Terminal agent errors, command/status replies, queue/recovery/media errors, transcription echo | Error/service/input feedback; ordinary delivery retained. |
| Cron admin notices, direct `scripts/deliver.sh` callers, monitoring/Alertmanager notifications | Ordinary service utilities retained; cron result routing no longer shells through them. External callers' intent is outside this package audit. |
| Unreferenced outbox photos/documents | Standalone attachments retained; interactive inline photos still use existing rich custody. |
| Discord adapter/relay | Existing Discord behavior retained. |
| Pi collaboration, continuation, and acknowledged-steer extension `sendMessage` calls | Internal agent context, not Telegram posts. |

Validation intercepts grammY's fetch transport through the existing cron `deliver` dependency, exercising routing, serialization, retained records, and echo consumption without production sends. Deployment smoke validation should inspect a genuine Telegram response's `rich_message.blocks`; a mocked API response is not evidence of server rendering.
