# Memory quality and layered processing

This branch retains existing memories and history archives, adds SQLite tables
without rewriting existing records, and introduces no external service or vector
model dependency. There are no UI/theme changes. Daily review reuses its existing
model request for optional scene and experience proposals.

## Responsibilities

- `memory-reflection.ts`: candidate extraction and lifecycle instructions. One-shot
  work belongs in the daily summary; continuing observation belongs in concerns.
- `memory-quality.ts`: validates candidate quotes against user speech. Assistant
  responses and generated summaries are not evidence. Ambiguous or missing sources
  are rejected, including completion/removal proposals. Daily review uses real turn
  IDs rather than recording its synthetic summary as evidence.
- `memory-store.ts`: scoped target-ID updates, lock protection and persistence.
  Unknown, cross-scope or wrong-kind targets never fall back to inserting a row.
  Exact subject matching remains available for legacy callers. Model-selected IDs
  enable synonymous subject updates without destructive fuzzy automatic merging.
- Read-time status marks expired active entries as expired without rewriting data.
  Renewed durable preferences/profiles/relationships clear old implicit expiration;
  an explicit new expiration is preserved. Corrections can lower confidence.
- Chinese bigrams and preserved Latin word boundaries improve lexical ranking.
- `memory-journal.ts`: durable turn payloads, extraction checkpoints, expiring
  leases, exponential retry backoff (30 seconds to 1 hour). Scoped FIFO prevents
  old retries from overwriting newer work. Other scopes may continue independently.
- `memory-worker.ts`: lifecycle, opt-out/removal checks and background scheduling.
  Per-turn extraction and daily review share a single model slot. Shutdown aborts
  in-flight model work, and failed jobs remain recoverable. A crashed lease expires
  within five minutes. Model calls retain their 60/90-second deadlines.
- `memory-retrieval.ts`: relevance and ranking without model calls. No unrelated
  memory padding. At most two history fragments from the most recent 100 durable
  turns and two scene views are included in topic context. Assistant history is
  explicitly labeled as unverified historical output, never as a user fact.
- `memory-artifacts.ts`: source-linked scene views and reviewable experience
  drafts. Scene content is derived on read, so corrections/deletions immediately
  propagate. Drafts require positive user evidence from at least two sessions;
  repeated tool use alone is insufficient. No auto-install, auto-binding or edits
  to existing skills. At most 100 scenes and 100 drafts per scope are retained.
- `profile-domain.ts`: deterministic, versioned persona baseline. Includes up to
  four repeatedly evidenced high-confidence preferences (or user-locked entries),
  alongside explicit identity facts. No inferred personality or sensitive traits.
- `api/features/memory-layers-api.ts`: authenticated-parent management routes,
  manual retry, paginated history, optimistic-version draft review/export.

## Transaction and recovery boundaries

Enqueue persists before returning from the session event. The stable turn ID
deduplicates duplicate events. Extraction is checkpointed before writing memory;
memory changes, daily count and the commit marker share a SQLite transaction.
Retries reuse checkpointed output, not another model completion. Concern batches
have a separate idempotency record. New concern notification is attempted before
the job is marked complete. Delivery is at-least-once: a process crash after delivery
but before commit can still duplicate a notification; it does not duplicate memory.

Daily review defers while its scope has pending turns, and checks again in the
write transaction. Normal retention no longer deletes active non-expiring memories
or locked records. Pending jobs are retained regardless of history age. Completed
turn payloads follow history retention; this also defines their deduplication window.
Maintenance runs at most once per six hours per active companion after success.

## Management endpoints

Under the existing companion API prefix, all require the parent route's existing
origin/access checks. Supply the exact contact `scopeId` as a query parameter:

- `GET /companions/:id/memory/layers`: scenes, drafts and pending/retrying jobs.
- `GET /companions/:id/memory/history`: newly journaled history, up to 30 turns.
  Next page uses the last row's `at` as `before` and `id` as `beforeId`, including
  ties. Older JSONL archives remain available to daily review; not bulk-migrated.
- `POST /companions/:id/memory/jobs/:jobId`: retry a non-running pending job now.
- `POST /companions/:id/memory/experiences/:draftId`: body `{action, version}`;
  action is `approved` or `rejected`. Stale versions cannot review newer content.
- `GET /companions/:id/memory/experiences/:draftId`: export approved Markdown in
  a JSON `document` field. Installation uses the existing explicit Skill workflow.

## Memory workspace

The companion's top-level tabs separate **记忆** from **持续关注**. Memory opens
on a contact-scoped profile, with explicit facts and stable collaboration preferences.
The primary navigation is 画像 / 记忆 / 回顾; scenes and chat history are secondary
views, while experience review and relationship auditing live under 更多.
Learning and heartbeat settings use the shared workspace dialog independently.

`src/ui/memory/` owns these components. The resource hook aborts obsolete requests,
keys results to their requested path and pauses polling in hidden documents.
Memory rows render in batches of 20; graph/history requests start only when opened;
long history bodies mount only on expansion. Editors retain their local drafts
during background refresh. Retry and review operations guard duplicate submission.
The legacy memory endpoint also accepts `scopeId` so a busy contact cannot consume
another contact's 100-row result limit. No existing memory data is moved or deleted.

Browser regression: `PARTNER_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.mjs
node scripts/verify-memory-workspace.mjs` (with installed Chromium). This uses
isolated fixtures and checks phone/tablet/desktop in both themes, scope switching,
filters, lazy graph/history, settings feedback and duplicate submission prevention.

## Boundaries

Quote verification establishes provenance, not semantic truth: classification and
whether a quote supports a claim still depend on extraction quality. Existing locked
memories remain authoritative. Repeated or unrelated retrieval candidates are not
automatically merged or deleted.

Missing-evidence proposals are not written; their original conversations remain
available for daily review within history retention. Successful procedures are
proposals, not proven executable programs: users must review applicability and
safety before installing. Scene generation and draft generation depend on daily
review being enabled. No psychological inference, automatic memory cleanup,
cross-contact sharing, vector service or autonomous skill activation is introduced.

Validation: `npm test`, including memory quality, journal recovery, artifact
provenance and profile/recall regression tests. Local deployment still requires
a consistent SQLite backup and health checks; unit tests cannot prove live model
extraction quality or remote-channel availability.
