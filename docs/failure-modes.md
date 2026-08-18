# Failure modes

Written as a table on purpose: the question that matters in an incident is not "what
could go wrong" but "when this specific thing goes wrong, what happens, and where do I
look".

## Model and API

| Failure | Blast radius | Handling | Where |
|---|---|---|---|
| Rate limit (429) | One execution stalls | 3 attempts, exponential backoff, full jitter. Jitter matters: without it every workflow that failed in the same incident retries in lockstep | `src/retry.ts`; node `retryOnFail` |
| 5xx / overloaded (529) | Same | Same policy | Same |
| 400 — bad request | One execution fails permanently | **Not retried.** A 400 will be a 400 forever; retrying burns budget and delays the real error | `defaultIsRetryable` |
| Safety refusal | One execution fails cleanly | Arrives as **HTTP 200** with `stop_reason: "refusal"`. Checked before reading `content` | `agent.ts`; `Parse & Score Risk` |
| `max_tokens` truncation | Malformed or missing tool block | `max_tokens: 16000` leaves headroom for thinking + text. Missing tool block throws rather than proceeding on a partial | `agent.ts` |
| Model returns no tool block | Would silently skip the work | Explicit throw: `No record_quote_request tool_use block in response` | All three AI workflows |
| Model invents a citation | **Wrong answer that reads as sourced** — the worst failure here | Every `[n]` verified against supplied chunks; unverified answers are replaced with the abstention string and logged to `fabricated_citations` | Workflow 03 |
| Model's totals disagree with its own line items | Bad data posted to accounting | Line items re-summed in code, 2-cent tolerance; mismatch routes to a bookkeeper | Workflow 02 |
| Loop never converges | Unbounded spend | `MAX_ITERATIONS = 12`, then the run fails with that reason | `agent.ts` |

## Downstream systems

| Failure | Blast radius | Handling | Where |
|---|---|---|---|
| CRM / accounting 5xx | One record not pushed | Retry, then alert. **The extraction is already committed to Postgres**, so nothing is lost and replay is cheap | Workflows 01, 02 |
| Duplicate delivery / replayed webhook | Duplicate lead, double-posted bill | `UNIQUE` idempotency keys + `ON CONFLICT`; `Idempotency-Key` header on every outbound write | `db/schema.sql`, `src/tools.ts` |
| Downstream not configured | Tool cannot run | Returns a clear `"not configured in this environment"` tool result instead of throwing — the service still boots, and the model is told plainly | `src/tools.ts` |
| Document storage unreachable | One document deferred | `attempts` incremented, status back to `pending`, `failed` after 3 | Workflow 02 |
| Slack down | Alert lost | `onError: continueRegularOutput` — the alert failing must not roll back the work it was announcing | All workflows |
| n8n API unreachable | **Monitoring blind** | Dedicated alert: health is `UNKNOWN`, not healthy. A monitor that fails silently is worse than none | Workflow 04 |

## Approval lifecycle

| Failure | Blast radius | Handling | Where |
|---|---|---|---|
| Approval never answered | Run parked forever, DB grows | 24h TTL; `expire_stale_approvals()` expires the approval and fails the run | `db/schema.sql` |
| Two approvers click at once | Conflicting decisions | Compare-and-set: `PATCH ... &status=eq.pending`. Second caller gets `409 already_decided` | `db.ts:decideApproval` |
| Approval link forwarded to the wrong person | Unauthorised action | Token is HMAC-signed, single-approval, expiring. Repointing it at another approval breaks the signature | `src/approvals.ts` |
| Expired token replayed | Unauthorised action | Signature checked *before* expiry, so timing does not distinguish "expired" from "forged" | `verifyApprovalToken` |
| Resume crashes mid-flight | Run stuck in `awaiting_approval` | Approvals are already decided, so resume is idempotent — safe to re-trigger. Tool `Idempotency-Key` derives from `tool_use_id`, so a replay dedupes downstream | `agent.ts`, runbook |
| Rejection with no reason | Model retries the same call blindly | API rejects a rejection with no reason (`400 reason_required`); the reason becomes the `tool_result` | `index.ts` |
| Unknown tool name | Unclassified action executes | Fails closed — unknown ⇒ sensitive ⇒ needs approval | `requiresApproval` |

## Data and tenancy

| Failure | Blast radius | Handling | Where |
|---|---|---|---|
| Missing `tenant_id` filter | **Cross-tenant leak** | RLS on every tenant table; Worker uses the service role and so filters explicitly in every query. Both layers, one invariant | `db/schema.sql`, `src/db.ts` |
| Tenant supplied in the request body | Caller names a tenant it does not own | Tenant read from the authenticated `x-tenant-id` header only | `index.ts:authenticate` |
| Secret in a log line | Credential leak via log shipping | Redaction on the way *in* — key-name patterns and value shapes (`sk-ant-…`, JWTs) | `src/log.ts` |
| Internal error text returned to caller | Information disclosure | Generic `internal_error` + request id; detail stays in the log | `index.ts` |
| Prompt injection in customer text | Model follows attacker instructions | Untrusted content is delimited and labelled data-not-instruction in every system prompt; the real defence is that the tool registry gates side effects regardless of what the model decides | All prompts, `src/tools.ts` |

## Deliberately unhandled

Being explicit about the edges:

- **Anthropic outage beyond the retry budget.** Fails the execution and alerts. No
  cross-provider fallback — that is a real option (`fallbacks: "default"`) and worth
  adding when a client's tolerance justifies the extra surface.
- **Postgres unavailable.** The whole system stops. Correct: parking a run *is* the
  durability guarantee, so continuing without persistence would be worse than failing.
- **Poison-pill document.** Capped at 3 attempts, then `failed`. No dead-letter queue
  with automatic reprocessing.
- **Cost ceilings.** Iterations are bounded; spend is not. For a client I would scope
  the API key to a workspace with its own limit and add per-tenant accounting on
  `input_tokens` / `output_tokens`, both already recorded.
