# Telegram rich agent answers

Telegram agent answers use native rich messages, including short paragraphs. Existing commands, errors, service notices, Discord output, and unreferenced outbox attachments keep their ordinary delivery behavior. Telegram DM previews use text-only native rich drafts, refreshed every 15 seconds. Draft calls bypass automatic transport retries; final calls retain the existing bounded retries and their ambiguous-delivery risk.

To interleave a local photo with an answer, write a JPEG or PNG to the session outbox (`MINIME_OUTBOX`) and reference its basename:

```markdown
# Results

The first result:

![First result](outbox:first.png)

The comparison:

![Comparison](outbox:comparison.jpg)
```

Use basenames without spaces, directory separators, or symlinks. Photos must be regular JPEG/PNG files, at most 10 MB, with positive dimensions whose sum is at most 10000 and whose aspect ratio is at most 20. The file contents and dimensions are checked independently of the filename extension. Place photos between paragraphs, outside table cells. External image syntax becomes a caption/link; the bot does not download arbitrary image URLs. Code examples are literal and do not consume outbox files.

The relay prepares the full accumulated Markdown before legacy newline collapse or tail slicing. It splits conservatively below Telegram's text, block, nesting, table-column, and attachment limits; large tables repeat their headers. Oversized or excessively nested structures are delivered as native literal text with a normalization notice. Literal code uses native preformatted blocks, retaining interior blank lines. Unknown HTML-like placeholders use native rich text rather than relying on Telegram's Markdown parser, which strips unknown tags and interprets supported HTML. Supported inline formatting remains intentional formatting. This is not a lossless parser for arbitrary Markdown; unsupported structures may be normalized. Deterministic send errors do not trigger ordinary-message fallback.

All inline sources are validated and moved into the outbox's `.rich-reserved/<delivery-id>/` directory before any final chunk is sent. A source is deleted only after every chunk referencing it has been confirmed. Failed or uncertain sources survive normal session preparation/cleanup and remain excluded from standalone attachment scanning. Cleanup failures also leave confirmed sources excluded. Diagnostics identify the reservation directory for explicit inspection; nothing automatically replays these files. A later chunk failure can leave partial delivery. `NO_REPLY` suppresses final text and all outbox dispatch before reservation.

Incoming rich posts supply bounded text from headings, paragraphs, lists, tables, quotes and captions, plus actual downloaded photo content to Pi vision. Ordinary incoming photos use the same explicit Pi vision input. The immediate parent contributes ordinary or rich photos even when the new message is ordinary text; explicit quote text takes precedence over full parent text. Reply chains are not traversed. Direct and parent photos share deduplication, a 50-photo cap and a total download budget of the smaller of `maxMediaBytes` and 20 MB. Coalesced Pi prompts also enforce 50 photos / 20 MB. Unsupported blocks and omitted media have descriptive markers. Existing authorization, topic routing, forwarding provenance, indexing and queue release/drop custody apply, including acknowledged steering.
