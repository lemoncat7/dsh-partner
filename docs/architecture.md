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
- `companions/`: the only owner of companion identity creation and its initial
  local-session transaction. API and model tools share this boundary; failed
  session provisioning rolls the new identity back.
- `skills/`: Skill metadata, filesystem loader, atomic installer, market cache,
  bounded proxy-aware network transport, companion bindings and model-facing
  tools. Skill bodies stay on disk; the JSON state only stores indexes,
  checksums and non-secret local network preferences.
- `tasks/`: task-board state, optimistic revisions, activities and model-facing
  tools. UI drag-and-drop is never the only way to move a task.
- `collaboration/`: directed companion grants, the public capability directory
  and delegation envelopes. It never exposes another companion's private
  transcript, credentials or memory store.
- `scheduler/`: schedule calculation, overlap policy, restart recovery and run
  history. It does not implement agent execution.
- `api/features/`: thin HTTP adapters. Parsing and response mapping live here;
  business policy stays in services.
- `client-controller.tsx`: owns opening/closing the plugin workspace and
  preparing, renewing and switching DSH sessions. It has no page markup.
- `client.tsx`: the composition root for sidebar registration and companion
  detail routing. It does not own reusable controls or session orchestration.
- `ui/workspace-components.tsx`: the shared workspace template contract. Page
  heroes, content sections, focus-managed create/configure drawers, notices,
  empty states and loading skeletons are defined once here.
- `ui/partner-components.tsx`: small companion-specific presentation
  primitives such as identity marks, channel status, form fields and section
  headings. These components do not fetch data.
- `ui/*-panel.tsx`: one feature per module. Skill installation, the shared
  board and schedules are top-level destinations; each panel owns only its
  resource state and business actions and composes the shared templates.
- `ui/workspace-ui.css`: interaction and material rules for the shared
  templates. Feature-specific layout may remain in `client.css`, but new
  cross-feature UI contracts belong in this module.

## Persistence rules

- `partner-state.json` remains the atomic metadata store.
- Skill contents live below `<defaultCwd>/partner-system/skills`.
- Task activity, delegation and execution histories are bounded before commit.
- Every state mutation is serialized by `PartnerStore`; task edits additionally
  use a revision to reject stale concurrent updates.
- Market downloads are bounded, checksum-verified when supplied, written into a
  temporary directory and atomically renamed.
- Market discovery and package installation share one bounded transport. The
  optional local HTTP proxy applies to both paths and rejects embedded proxy
  credentials.
- Public ZIP packages are parsed in memory and archive paths are never
  extracted to disk. A case-insensitive `SKILL.md` is preferred; a package
  with exactly one Markdown document may use that document, while ambiguous
  multi-Markdown packages are rejected.

## Client interaction rules

- Creation and configuration flows use the shared focus-managed drawer. They
  restore focus on close, trap keyboard focus while open, close on Escape and
  never rely on browser-native dialogs.
- Lists expose loading, empty, error, disabled and retry states without moving
  errors to an unrelated page footer.
- Visual feedback uses opacity and transforms. Static overview cards do not
  create pointer tracking, SVG displacement filters or per-card resize
  observers.
- Form controls and buttons are fully styled by the plugin; browser and theme
  defaults are not part of the component contract.

## Capability and privacy rules

- A Skill may only narrow inherited tool access. It never grants a tool that the
  companion did not already have.
- New companions start with no declared capabilities, memory, daily review,
  heartbeat, channels or collaboration grants. The `partner_companions` tool is
  only composed for a companion explicitly granted the `companions` capability,
  and it may create identity fields only; later permissions remain a user action.
- Market Skills execute in a forked temporary session by default.
- Companion collaboration exposes identity, declared capabilities, enabled
  Skill names, availability and the assigned task envelope only.
- Cross-companion directory access, assignment and `@companion` delegation use
  explicit directed grants (`A -> B`). A grant is not reciprocal. The model
  receives only A's granted directory and the service checks the same edge
  again at execution time. User-initiated board delegation is a separate actor
  and may target any created companion without impersonating another partner.
- Delegation depth is bounded and self-delegation is rejected.
- Scheduled jobs default to non-overlapping execution and a disposable session.
