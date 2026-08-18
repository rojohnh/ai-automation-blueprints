# n8n workflows

Four importable workflows, 55 nodes total. Each imports cleanly and passes the
structural check described at the bottom of this page.

**Import:** n8n → *Workflows* → *Import from File*. Apply [`../db/schema.sql`](../db/schema.sql)
first — every workflow reads or writes tables defined there.

## Credentials to repoint

Exports carry credential *references*, never values. After importing, point each at
your own credential:

| Placeholder id | Credential type | Used by |
|---|---|---|
| `ANTHROPIC_CREDENTIAL_ID` | Header Auth — `x-api-key: sk-ant-…` | 01, 02, 03 |
| `OPENAI_CREDENTIAL_ID` | Header Auth — `Authorization: Bearer sk-…` | 03 (embeddings) |
| `POSTGRES_CREDENTIAL_ID` | Postgres | 01, 02, 03, 04 |
| `SLACK_CREDENTIAL_ID` | Slack API | 01, 02, 04 |
| `FIELD_CRM_CREDENTIAL_ID` | Header Auth | 01 |
| `DOC_STORAGE_CREDENTIAL_ID` | Header Auth | 02 |
| `ACCOUNTING_OAUTH_CREDENTIAL_ID` | OAuth2 | 02 |
| `N8N_API_CREDENTIAL_ID` | Header Auth — `X-N8N-API-KEY` | 04 |

Environment variables referenced via `$env`: `FIELD_CRM_BASE_URL`,
`DOCUMENT_STORAGE_BASE_URL`, `ACCOUNTING_API_BASE_URL`, `N8N_API_BASE_URL`,
`PAGER_WEBHOOK_URL`.

> Anthropic uses `x-api-key`, not `Authorization: Bearer`. A Header Auth credential with
> the wrong header name produces a 401 that reads like a bad key.

---

## 01 — Inbound quote request

`POST /webhook/quote-intake` → structured lead → approval gate.

Free-text enquiry in; a typed lead row out, plus a routing decision. The extraction is
forced through a tool schema with `strict: true`, so the parser never has to cope with
prose or a stray code fence.

**The point of this one:** the thresholds live in a Code node, not the prompt.

```js
const HIGH_VALUE_AUD = 15000;
const MIN_CONFIDENCE = 0.75;
```

A prompt that says *"escalate expensive jobs"* is a request the model interprets
differently as the prompt drifts. A constant in a Code node is a rule you can diff,
review, and change without re-evaluating the model. Escalation triggers on value,
confidence, emergency urgency, or too many open questions.

**Paths:** invalid payload → `400`. Extraction failure → Slack alert + manual review
queue → `202`. Needs approval → Slack to `#quotes-approval` → `202`. Clean → CRM job →
`201`. CRM failure → alert, lead already safe in Postgres.

Replay-safe via `leads.idempotency_key UNIQUE` + `ON CONFLICT`.

---

## 02 — Supplier invoice → accounting

15-minute poll → PDF → structured invoice → accounting API, or a bookkeeper.

The PDF is sent to Claude **natively** as a base64 `document` block rather than OCR'd
first. OCR-then-regex loses table structure, which is exactly the part that matters on
an invoice.

**The point of this one:** the model transcribes, and then *we* do the arithmetic.

```js
const lineSum = round2(inv.line_items.reduce((a, li) => a + li.line_total, 0));
if (Math.abs(lineSum - inv.subtotal) > TOLERANCE) { /* blocked */ }
```

Two independent gates decide whether a bill posts without a human: the model's own
confidence, and addition performed in JavaScript. A language model is the wrong tool for
addition, and an invoice that does not balance is the one you least want auto-posted.
Anything unbalanced, low-confidence, or with unreadable fields routes to
`#accounts-payable` with the reasons attached.

Retries are per-document (`attempts`, capped at 3), so one poison PDF does not stall the
batch. `Idempotency-Key: doc-<id>` on the accounting call makes replay safe.

---

## 03 — Knowledge assistant (pgvector)

`POST /webhook/kb-ask` → embed → cosine search → grounded answer with verified
citations.

**The point of this one:** citations are checked, not trusted.

```js
const cited = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
const fabricated = cited.filter(n => !valid.has(n));
```

A fabricated citation is the worst failure a RAG system has, because a wrong answer that
*looks* sourced gets believed. Sources are numbered before they go to the model; every
`[n]` in the answer is checked against the chunks actually supplied. Fail the check and
the answer is replaced with the abstention string and logged to
`kb_interactions.fabricated_citations` — which then doubles as the quality metric worth
alerting on.

Tenant scoping comes from the `x-tenant-id` header, never the body, and every retrieval
is filtered by it. No results above the `0.35` similarity floor → abstain immediately
without spending a generation.

---

## 04 — Automation health monitor

15-minute poll of the n8n executions API → grouped alert → escalation.

**The point of this one:** an alert per failed execution is how a channel gets muted.
Failures are grouped by workflow, and only repetition (`>= 3` in the window) pages
anyone — that is a broken integration rather than a transient blip.

The branch that matters most is the one for the monitor's own failure: if the n8n API is
unreachable, it says health is **`UNKNOWN`**, not healthy. A monitor that goes quiet when
it breaks is worse than no monitor, because silence gets read as good news.

---

## Conventions used throughout

| Convention | Why |
|---|---|
| `retryOnFail` + `maxTries: 3` on every external call | Transient failures are the common case |
| `onError: continueErrorOutput` with the branch wired | An error path that goes nowhere is not error handling |
| `onError: continueRegularOutput` on Slack | A failed alert must not roll back the work it was announcing |
| Parameterised SQL (`$1`, `$2`) via `queryReplacement` | String-concatenated SQL with model output in it is an injection waiting to happen |
| Idempotency key computed in the first Code node | Replay protection needs to exist before anything is written |
| Response codes that mean something | `400` malformed, `202` queued or awaiting a human, `201` created, `503` upstream unavailable |
| Untrusted text delimited and labelled | Enquiries and documents are data; every system prompt says so |

## Structural validation

All four are checked mechanically:

- every connection resolves to a node that exists
- every `$('Node Name')` expression names a node that exists
- every node with `onError: continueErrorOutput` has that second branch wired
- no orphaned nodes
- every Code node body parses as JavaScript

What this does **not** prove: that a live Slack, Xero, or ServiceM8 tenant accepts these
payloads. Downstream shapes follow the documented contracts and will need adjusting to
your instance.
