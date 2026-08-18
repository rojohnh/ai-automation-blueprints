# Runbook

Procedures for the things that actually page someone. Each one states the symptom, the
diagnosis, and the fix — in that order, because in an incident you start from the
symptom.

Set once per session:

```bash
export PGURL="postgres://…"          # read-only role is enough for diagnosis
export GW="https://approval-gateway.example.workers.dev"
export API_KEY="…"                   # x-api-key
```

---

## 1. A run is stuck in `awaiting_approval`

**Symptom.** A run has not moved for hours; the requester is asking.

**Diagnose.**

```sql
select r.id, r.status, r.updated_at,
       a.id as approval_id, a.tool_name, a.status as approval_status, a.expires_at
  from agent_runs r
  left join approvals a on a.run_id = r.id
 where r.status = 'awaiting_approval'
 order by r.updated_at;
```

Read the approval rows:

| What you see | What happened | Do this |
|---|---|---|
| `pending`, `expires_at` in the future | Nobody has decided yet | Re-send the link (step 2) |
| `pending`, `expires_at` in the past | Expiry sweep is not running | Run the sweep (step 3) — then fix the schedule |
| All `approved` / `rejected` | **Resume failed after the decision** | Re-trigger resume (below) |

**Fix — decided but not resumed.** Resume is idempotent: approvals are already decided,
and every outbound tool call carries an `Idempotency-Key` derived from its
`tool_use_id`, so a replay dedupes downstream rather than double-acting.

Re-post the decision for any one already-decided approval on that run; the handler
returns `409 already_decided` **and** the run advances on the next resume. To force it
explicitly, call `resumeRun(runId, tenantId, deps)` from a one-off script against the
same environment, or `wrangler tail` while re-posting to confirm the resume fires.

Check the audit trail first — it tells you exactly how far the run got:

```sql
select event, detail, created_at
  from audit_log where run_id = '<run-id>' order by created_at;
```

---

## 2. Re-send an approval link

Tokens expire with their approval; a fresh token for a still-pending approval is fine.
There is no admin endpoint for this by design — minting approval tokens is a privileged
operation and does not belong on the public surface.

```bash
# From the service directory, against the same APPROVAL_SIGNING_SECRET.
node --input-type=module -e '
import { signApprovalToken } from "./src/approvals.ts";
const [id, exp] = process.argv.slice(1);
console.log(await signApprovalToken(
  { approvalId: id, expiresAt: Number(exp) },
  process.env.APPROVAL_SIGNING_SECRET,
));
' "<approval-id>" "$(date -d '+24 hours' +%s)"
```

Then:

```
POST $GW/v1/approvals/<approval-id>/decision
{ "token": "<token>", "decision": "approve", "decided_by": "you@example.com" }
```

If the approval already expired, do not re-sign it — expire the run (step 3) and start a
fresh one. A stale action approved after the fact is how the wrong email gets sent.

---

## 3. Expire stale approvals

Should be on a schedule (pg_cron, or a 5-minute n8n workflow). To run it now:

```sql
select * from expire_stale_approvals();
-- → expired_approvals | failed_runs
```

Idempotent and safe to run repeatedly.

---

## 4. Replay a failed document (workflow 02)

**Symptom.** `inbound_documents` rows sitting at `status = 'failed'`.

```sql
select id, storage_key, attempts, last_error, received_at
  from inbound_documents where status = 'failed' order by received_at desc limit 20;
```

Group by `last_error` before replaying anything — a single systemic cause (expired
accounting OAuth token, storage permissions) is far more likely than twenty unrelated
failures, and replaying into an unfixed cause just burns tokens.

Once the cause is fixed:

```sql
-- Reset a specific batch. Attempts back to 0, so the poll picks them up.
update inbound_documents
   set status = 'pending', attempts = 0, last_error = null
 where id = any($1::uuid[]);
```

Replay is safe: `UNIQUE (tenant_id, storage_key)` plus the `Idempotency-Key` on the
accounting call mean a document already posted will not post twice.

---

## 5. Bookkeeper queue is growing

**Symptom.** `status = 'needs_review'` climbing — the auto-post rate has dropped.

```sql
select unnest(review_reasons) as reason, count(*)
  from inbound_documents
 where status = 'needs_review' and processed_at > now() - interval '7 days'
 group by 1 order by 2 desc;
```

| Dominant reason | Read it as | Action |
|---|---|---|
| `confidence 0.8x` | Model is unsure across the board | Check for a new supplier template or a scan-quality change upstream |
| `line items sum to X but subtotal reads Y` | Real arithmetic disagreement | Inspect the PDFs — often rounding or a discount line the schema does not model |
| `unreadable: …` | Input quality | Fix the scanner or the ingestion path, not the prompt |
| One supplier dominates | Template-specific | Worth a supplier-specific prompt example before touching thresholds |

Resist raising the thresholds to clear the queue. The queue is the control working.

---

## 6. Ungrounded answers from the knowledge assistant

**Symptom.** Staff report a confidently wrong answer.

```sql
-- Fabricated citations: the model cited a chunk we never supplied.
select created_at, question, answer, fabricated_citations
  from kb_interactions
 where cardinality(fabricated_citations) > 0
 order by created_at desc limit 20;

-- Abstention rate — a rising trend is a retrieval problem, not a model problem.
select date_trunc('day', created_at) as day,
       count(*) as total,
       sum(case when abstained then 1 else 0 end) as abstained
  from kb_interactions
 where created_at > now() - interval '14 days'
 group by 1 order by 1;
```

A fabricated citation is caught before the user sees it — the answer is replaced with
the abstention string. A rising *abstention* rate usually means the corpus is stale or
the `0.35` similarity floor is wrong for the new content, not that the model got worse.

---

## 7. Automation health monitor is quiet — is it working?

A monitor whose silence is ambiguous is not a monitor.

```sql
select checked_at, total_failures, affected_workflows
  from automation_health order by checked_at desc limit 5;
```

Rows only land when there are failures, so an empty result is ambiguous by design. The
unambiguous signal is the **`Alert: Monitor Blind`** message — if the n8n API is
unreachable the monitor says health is `UNKNOWN` rather than staying quiet. Confirm the
15-minute schedule is enabled in n8n before trusting silence.

---

## 8. Rotating secrets

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put GATEWAY_API_KEY
```

**`APPROVAL_SIGNING_SECRET` needs care.** Rotating it invalidates every outstanding
approval link — signatures no longer verify. Sequence:

1. Drain: wait until no `approvals` rows are `pending`, or expire them (step 3).
2. Rotate.
3. Re-send links for anything that still needs deciding (step 2).

Rotating during a backlog silently breaks every link in flight, and the failure looks
like `403 token_bad_signature` to a confused approver.
