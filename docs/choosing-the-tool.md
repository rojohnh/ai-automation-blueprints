# Choosing n8n, custom code, or an off-the-shelf platform

The most expensive decision in an automation project is made in the first hour, usually
by reflex. This is the reasoning I actually apply, and the worked examples from this
repo that land on each side of it.

## The decision, compressed

Ask in this order and stop at the first yes.

**1. Does a product already do this well?**
Inbox triage, meeting notes, transcript summaries, generic document Q&A — these are
solved shapes with real products behind them. Building your own means owning prompts,
evals, and a UI forever so you can be slightly more bespoke than something that already
works. Build nothing. Recommending this costs a chunk of billable work and it is still
the right answer often enough that skipping the question is negligent.

**2. Is the work a pipeline of I/O between systems?**
Data arrives, passes through a mostly-linear sequence of fetch / transform / write, and
leaves. The topology is the logic. → **n8n.**

**3. Does anything outlive a single execution?**
Durable state, concurrency that needs arbitration, control flow that is not a DAG, or
logic that genuinely needs a test suite. → **custom code.**

Most real projects are a mix, and the seam between rows 2 and 3 is where the design
work is: n8n at the edges for integration breadth, code in the middle for the part that
must be correct.

## Where n8n wins outright

- **Integration breadth.** Hundreds of authenticated connectors, credential storage,
  OAuth refresh, retries, and an execution log — all before you write a line.
- **The canvas is the documentation.** A client's ops manager can look at workflow 01
  and see that high-value quotes route to a human. No architecture diagram will ever be
  that reliably in sync with the code.
- **Someone else can change it.** A threshold tweak or an extra Slack channel does not
  need me. That is a real handover property, not a compromise.
- **Operational surface for free.** Execution history, per-node error output, replay from
  the UI.

**Workflows 01–04 all stay in n8n**, and each is a pipeline: webhook or schedule in,
fixed sequence of I/O, result out. Even the branching is topology — an `IF` node with
two labelled paths on a canvas is *more* legible than the same condition in code.

Note what is in code *inside* those workflows: thresholds, arithmetic reconciliation,
citation verification. Code nodes are not an admission that n8n was the wrong choice.
They are where logic that deserves diffing and reasoning lives, inside a pipeline that
deserves a canvas.

## Where n8n is the wrong tool

Concretely, from this repo — the approval gateway.

A run stops mid-loop and waits on a human who answers in twenty minutes from their
phone. n8n's Wait node genuinely handles pausing and webhook resumption, so "n8n cannot
pause" would be false. The reasons it is still wrong here:

| Requirement | Why a canvas fights it |
|---|---|
| Compare-and-set on the decision | Two approvers clicking at once must produce one winner. That is a conditional write with a returned row count, not a node. |
| Signed, expiring, single-purpose tokens | HMAC sign/verify with timing-safe comparison, expiry checked after signature. Expressible in a Code node; not *reviewable* there. |
| Partial tool-result bookkeeping | Safe results parked by `tool_use_id` until the gated sibling is decided (see [architecture.md](architecture.md)). The state shape is the hard part, and it wants a schema and tests. |
| A test suite | 62 tests run in under a second against an in-memory store. The agent loop has enough branches — refusal, unknown tool, iteration ceiling, mixed turns, tenant mismatch — that "we clicked through it" is not coverage. |
| Loop with dynamic tool dispatch | An agent loop is `while (model wants a tool)`. On a canvas that is a cycle whose iteration count is unknown at design time — the shape a DAG is worst at. |

The honest summary: it is *possible* in n8n and it would be worse. Not because n8n is
weak, but because the thing being built is a state machine with concurrency
requirements, and that is what code with tests is for.

## Where custom code is the wrong tool

The failure mode I watch for in my own work, since it is the more expensive direction:

- **Rebuilding connectors.** Hand-rolling Google Workspace OAuth to avoid a node is
  weeks of work to reproduce something that already exists and is maintained.
- **Making yourself the only maintainer.** A TypeScript service the client cannot read
  means every threshold change is a ticket to me. Sometimes correct; always a cost, and
  it should be a decision rather than a side effect.
- **Ceremony for a five-node pipeline.** A repo, CI, deploy pipeline, and error
  reporting around what a canvas does in an afternoon.

## Applied to this repo

| Artefact | Choice | Deciding factor |
|---|---|---|
| 01 quote intake | n8n | Pipeline; ops staff need to read and tune the routing |
| 02 invoice → accounting | n8n | Pipeline; per-document retry is native; the reconciliation lives in a Code node where it can be reasoned about |
| 03 knowledge assistant | n8n | Pipeline: embed → search → generate → verify → log |
| 04 health monitor | n8n | Scheduled poll; the alerting shape belongs where the ops team can adjust it |
| approval gateway | TypeScript | State outlives the execution; concurrency needs arbitration; branch count demands tests |

## The question I ask a client

> When this needs changing in six months, who changes it — and will they be able to tell
> whether their change was safe?

If the answer is "their ops lead, and the canvas will show them", it belongs in n8n. If
it is "an engineer, and the test suite will tell them", it belongs in code. That single
question resolves most of these arguments faster than any feature comparison.
