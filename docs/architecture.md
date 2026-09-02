# Partner architecture

The partner plugin is split by domain rather than by screen. Dependencies point
in one direction:

```text
client -> HTTP feature routers -> application services -> repositories/store
                                      |
                                      v
                              ephemeral execution -> DSH agent/tool APIs
```

## Module boundaries

- `core/`: shared validation, identifiers and bounded collections. It contains
  no partner feature policy.
- `execution/`: the only owner of short-lived DSH agent sessions. Skill forks,
  delegations and schedules use this service instead of recreating agent setup.
- `skills/`: Skill metadata, filesystem loader, atomic installer, market cache,
  companion bindings and model-facing tools. Skill bodies stay on disk; the
  JSON state only stores indexes and checksums.
- `tasks/`: task-board state, optimistic revisions, activities and model-facing
  tools. UI drag-and-drop is never the only way to move a task.
- `collaboration/`: the public companion directory and delegation envelopes.
  It never exposes another companion's private transcript, credentials or
  memory store.
- `scheduler/`: schedule calculation, overlap policy, restart recovery and run
  history. It does not implement agent execution.
- `api/features/`: thin HTTP adapters. Parsing and response mapping live here;
  business policy stays in services.

## Persistence rules

- `partner-state.json` remains the atomic metadata store.
- Skill contents live below `<defaultCwd>/partner-system/skills`.
- Task activity, delegation and execution histories are bounded before commit.
- Every state mutation is serialized by `PartnerStore`; task edits additionally
  use a revision to reject stale concurrent updates.
- Market downloads are bounded, checksum-verified when supplied, written into a
  temporary directory and atomically renamed.

## Capability and privacy rules

- A Skill may only narrow inherited tool access. It never grants a tool that the
  companion did not already have.
- Market Skills execute in a forked temporary session by default.
- Companion collaboration exposes identity, declared capabilities, enabled
  Skill names, availability and the assigned task envelope only.
- Delegation depth is bounded and self-delegation is rejected.
- Scheduled jobs default to non-overlapping execution and a disposable session.
