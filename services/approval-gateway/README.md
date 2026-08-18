# approval-gateway

A Claude tool-calling agent whose sensitive actions stop and wait for a human — durably,
across process boundaries.

TypeScript on Cloudflare Workers, Postgres/Supabase for state. 62 tests, typecheck clean.

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in
npm run typecheck
npm test
npm run dev                       # http://localhost:8787
```

`npm run dev` and `npm run deploy` need Wrangler: `npm i -D wrangler` (left out of
`devDependencies` to keep `npm install` small for anyone who only wants to read and run
the tests).

---

## The problem this solves

An agent that can email customers and book jobs needs a human in front of those actions.
The naive approach is a prompt instruction — *"always ask before sending email"* — which
is a request, not a control, and which a prompt injection in a customer's enquiry text
can talk past.

The approach here has two halves:

**1. Risk lives in the registry.** Each tool is declared `safe` or `sensitive` in
[`src/tools.ts`](src/tools.ts). Safe means read-only. Sensitive means the effect leaves
the building and is hard to walk back.

```ts
const sendCustomerEmail: ToolSpec<…> = {
  name: 'send_customer_email',
  risk: 'sensitive',
  summarise: (input) => `Email customer ${input.customer_id} — subject "${input.subject}"…`,
  execute: async (input, ctx) => { … },
};
```

The model cannot reach `execute` for a sensitive tool without a recorded human decision.
An unrecognised tool name is treated as sensitive — it fails closed.

**2. The loop is durable.** A sensitive call parks the run in Postgres and returns. The
approver clicks a signed link maybe twenty minutes later, hitting a different Worker
isolate; the run resumes from persisted history.

---

## Why not `toolRunner`

The Anthropic SDK's `toolRunner` (and any in-process loop) assumes tool execution returns
within the lifetime of one call. Here it does not — there is no stack frame to keep alive
while a human decides. So message history and partial results live in Postgres and
"resume" is a fresh invocation that replays them.

The SDK's per-turn hooks do support approval gating; what they cannot do is survive the
death of the request. That distinction, and the schema it forces, is written up in
[`../../docs/architecture.md`](../../docs/architecture.md).

---

## The subtle part

The Anthropic API requires one `tool_result` for **every** `tool_use` block in the
preceding assistant turn, in a single user message. So a turn mixing a safe call with a
sensitive one cannot be answered piecemeal.

This service executes the safe calls immediately, parks their results in
`agent_runs.pending_results` keyed by `tool_use_id`, and sends everything together once
the human decides. Without that column a resume would silently re-execute them.

`test/agent.test.ts` pins it:

```
✓ runs safe siblings immediately and parks them until the gated call is decided
✓ stays parked when a second approver has not answered yet
✓ executes the tool only after a human approves, then finishes
✓ feeds a rejection back to the model as an error rather than failing the run
```

That last one matters: a rejection is not a run failure. The reviewer's reason becomes
the `tool_result` content, so the agent adapts instead of dying or blindly retrying.

---

## API

All routes except `/health` need `x-api-key` and `x-tenant-id`. Tenant identity is read
from the header, never the body — a caller must not be able to name a tenant it does not
own.

**`POST /v1/runs`** — start a run.

```json
{ "objective": "Customer C-1 asked to move Thursday's job to next week. Sort it out." }
```

→ `202` with either a result or pending approvals, each carrying a signed
`decision_url` + `token`.

**`GET /v1/runs/:id`** — status, result, token usage, pending approvals.

**`POST /v1/approvals/:id/decision`**

```json
{ "token": "…", "decision": "approve", "decided_by": "estimator@example.com" }
```

`decision: "reject"` requires a `reason` (`400 reason_required` otherwise) — the model
needs to know *why* to do anything sensible with it. Returns `202`; the run resumes under
`waitUntil` so the approver's browser is not holding the connection open for an agent
loop.

Concurrent decisions are settled by compare-and-set in the database — the second approver
gets `409 already_decided` rather than overwriting the first.

**`GET /health`** — liveness, no auth.

---

## Layout

| File | Responsibility |
|---|---|
| [`src/agent.ts`](src/agent.ts) | The resumable loop: start, park, resume |
| [`src/tools.ts`](src/tools.ts) | Registry, risk classification, executors, approval summaries |
| [`src/approvals.ts`](src/approvals.ts) | HMAC token sign/verify — timing-safe, expiring, single-purpose |
| [`src/db.ts`](src/db.ts) | `RunStore` interface + PostgREST implementation |
| [`src/retry.ts`](src/retry.ts) | Backoff with full jitter, wall-clock deadline, retryable classification |
| [`src/log.ts`](src/log.ts) | One-JSON-object-per-line logging with redaction on the way in |
| [`src/index.ts`](src/index.ts) | Routing, auth, error mapping |

`src/db.ts` exports `RunStore` as an interface and `Db implements RunStore`. That is what
lets the whole approval lifecycle be tested against an in-memory store — no network, no
Supabase project, no mocking framework. Tests run in well under a second, which is the
only reason they get run often enough to matter.

---

## Design decisions worth arguing with

| Decision | Reasoning | Cost |
|---|---|---|
| PostgREST over a Postgres driver | Workers have no raw TCP without Hyperdrive, and a connection pool is the wrong shape for an edge runtime | HTTP round-trip per query; service role bypasses RLS, so every query filters `tenant_id` explicitly ([security.md](../../docs/security.md)) |
| Service role, not per-request JWT | Simpler, one fewer failure mode | Tenant isolation depends on discipline in `db.ts`; mitigated by `RunStore` requiring `tenantId` on every method |
| Full message history persisted | Makes resume a replay rather than a reconstruction | Row grows with the run; enquiry text (and any PII) persists — a retention decision, not an accident |
| `MAX_ITERATIONS = 12` | Bounds spend and stops a non-converging loop | A genuinely long task fails rather than finishing |
| Tool failures become `tool_result` errors, not thrown | The model can route around a failing tool; throwing loses all prior work | A persistently broken tool burns iterations before the ceiling stops it |
| Resume under `waitUntil` | An agent loop must not block the approver's request | The caller does not see the outcome synchronously; poll `GET /v1/runs/:id` |
| Model config: no `temperature` | Rejected with a 400 on this model generation | Steering is prompt-only |

---

## Not production-ready as-is

- No rate limiting. A leaked `GATEWAY_API_KEY` means unbounded run creation and therefore
  unbounded spend.
- `decided_by` is self-reported — an audit annotation, not authentication. Binding
  approver identity into the token at mint time is the correction.
- Downstream API shapes (CRM, mail) follow documented contracts but have not been run
  against live tenants.
- `expire_stale_approvals()` needs scheduling (pg_cron or a 5-minute n8n workflow) or
  parked runs accumulate.

Full list, with blast radius per item: [`../../docs/failure-modes.md`](../../docs/failure-modes.md).
