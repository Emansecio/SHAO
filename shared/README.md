# SHAO shared contract (v1)

Dependency-free source of truth for the backend, UI and CLI adapters. Import `contracts.ts` type-only. It adds **zero runtime dependencies**. TypeScript packages use their existing compiler; JSON schemas are standards-based 2020-12.

## Local HTTP contract

The server binds loopback only. The default port is `4317`, overridable with `SHAO_PORT`; if occupied, the server reports the conflict; it does not scan for another port. UI should discover readiness with `GET /api/health` (`{status:"ok",version,capabilities}`), not guess that startup succeeded. Backend serves the built UI same-origin when `frontend/dist` exists. During Vite development use the configured local proxy to `/api`; the backend will not enable wildcard CORS.

- `GET /api/runs` lists recent run summaries; `POST /api/runs` accepts `{prompt,workspace,criteria?}` and returns `{runId,status,createdAt,lastSeq}` with 201.
- `GET /api/runs/{runId}` returns the run projection.
- `GET /api/runs/{runId}/events?after={seq}` replays then follows events as `text/event-stream`. Every frame: `id: <envelope.id>`, `event: <envelope.type>`, `data: <JSON envelope>`. Sequence is monotonic per run. Reconnect with `Last-Event-ID` (resolved to the stored event seq) or `after`; replay is exclusive of that seq. Omit both to replay all history before following live events. `GET /api/runs/{runId}/export?format=json|markdown` exports traceable report and event history.
- `POST /api/runs/{runId}/messages` body `message.schema.json`; accepted human message is durably recorded before wakeup. A new message resumes a stalled run in a fresh CLI turn/session; paused and terminal runs reject the message before accepting it.
- `POST /api/runs/{runId}/control` body `{action:"pause"|"resume"|"cancel"}`; `POST /api/runs/{runId}/turns/{turnId}/cancel` cancels one turn.
- `POST /api/runs/{runId}/specialists` body `{name,profile,scope?,budget?}` adds a mission-scoped specialist.
- `GET /api/runs/{runId}/artifacts/{artifactId}` reads verified text/metadata; append `?download=1` for a safe attachment download. Artifacts are copied from real files inside the canonical run workspace and hashed by the supervisor. `GET /api/runs/{runId}/report?format=json|markdown` returns the current projection of criteria, tasks/review, evidence and public conversation.

All API failures use `{error:{code,message,retryable?}}`. Event actor identity is assigned by core, never trusted from client JSON. Unknown request properties are rejected. IDs are opaque strings. API calls are same-origin by default; the local development proxy avoids broad CORS.

## Event types

`type` is a stable dotted name; evolvable data is in `payload` and validated by event type. Core event set: `run.status`, `agent.spawned`, `agent.status`, `message.delta`, `message.completed`, `action.started`, `action.completed`, `task.started`, `task.status`, `task.completed`, `evidence.published`, `artifact.published`, `criterion.status`, `report.updated`, `runtime.unavailable`, `runtime.quota`, `runtime.auth`, `error`, `turn.stalled`. Producers include public conversation text only; private model reasoning is never an event. Every envelope has all fields (nullable IDs represented as JSON null), even when a field does not apply. Message deltas and their final `message.completed` share the same non-null `messageId` and `turnId`.

## Adapter lifecycle

`capabilities()` runs at preflight and reports available mode/auth without collecting credentials. `start()` is called once per fenced turn generation with durable `operationIntentId`; it returns an async observation stream and terminal outcome promise. A retry for the same logical operation retains the intent id. `cancel()` targets run/turn/generation. `outcome_uncertain` is a reconciliation state: core must not blindly retry. Streams do not authorize state transitions; core commits accepted output and events transactionally.

Adapters do not provide arbitrary shell access through this interface. Context and tool results are untrusted. Capability, scope, path and generation enforcement stay in core/broker. The reviewer runtime uses the other healthy provider when both Claude Code and Codex CLI are ready; otherwise it follows the orchestrator's provider. Dynamic specialists inherit their requesting agent's available runtime.

## Schemas

`schemas/event-envelope.schema.json`, `cli-final.schema.json`, `message.schema.json`, `task.schema.json`, and `evidence.schema.json` define minimal strict wire inputs/outcomes.
## UI event payload / response notes

Automatic task submission is a supervisor routing event: `task.status` uses actor `supervisor`, `causation` references the concrete operation intent, and `payload.submittedBy` identifies the assignee. It is a task handoff to the reviewer, not a `message.completed` peer message or `team.send` edge.

`contracts.ts` exports discriminated `RunEvent` (`RunEvent['type']` narrows `payload`) and canonical status/profile/runtime unions. Envelope `actorId` values: `user`, `orchestrator`, `supervisor`, `system`, or the persisted agent id; recipients are persisted agent ids, with `user` accepted for human-targeted notices. A task assignee submits via MCP `task_decision`; the distinct reviewer explicitly accepts or rejects with evidence IDs. `messageId` + `turnId` identify both delta and completed-message chunks; completed payload is the authoritative public body. Never render a delta as a separate completed message.

Health capabilities is an array of `{runtime,available,auth,mode,reason?}` for `claude-code` and `codex-cli`. No token material is exposed. A missing runtime remains visible as unavailable; run creation may still be accepted and enter an honest paused/stalled status.

`GET /api/runs` returns `RunSummary[]`; `GET /api/runs/{id}` returns `RunProjection` with agents/tasks/criteria/evidence. `POST messages` returns 202 `{messageId,turnId,status:"accepted"}` after durable enqueue. Control returns `{runId,status}`; specialist creation returns `{agent: AgentSummary}`. SSE sends comment heartbeat every 15s, stays connected through nonterminal states, then closes after delivering the terminal event; clients may reconnect for replay. Artifact/report reads return `ArtifactResponse` and markdown/json content respectively; artifact downloads recheck path containment and SHA-256 before returning bytes.

Human POST messages requires `clientMessageId` (stable for retries, unique per user action); the same ID is echoed in `message.completed.payload` and `AcceptedMessage`, and duplicate retries return the original accepted IDs without creating a second event/inbox row. Distinct client IDs preserve intentionally identical text. This removes SSE/202 response races without FIFO text matching.
