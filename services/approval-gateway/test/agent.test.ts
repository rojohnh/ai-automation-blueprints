import { describe, expect, it } from 'vitest';
import {
  MAX_ITERATIONS,
  resumeRun,
  startRun,
  type AgentDeps,
  type MessageResponse,
} from '../src/agent';
import {
  InMemoryStore,
  ScriptedClient,
  lastToolResults,
  refusalResponse,
  sequentialUuid,
  silentLogger,
  textResponse,
  toolUseResponse,
} from './helpers';

const TENANT = 'tenant-a';

/**
 * Tool executors read config off `env`. Leaving the downstreams unconfigured
 * makes every tool return its "not configured" result deterministically, with
 * no network call — which is exactly what these tests need, because what is
 * under test is the control flow, not the CRM.
 */
function makeDeps(script: MessageResponse[]) {
  const store = new InMemoryStore();
  const client = new ScriptedClient(script);
  const { log, lines } = silentLogger();
  const deps: AgentDeps = {
    anthropic: client,
    db: store,
    env: {},
    log,
    uuid: sequentialUuid('approval'),
    now: () => new Date('2026-08-19T00:00:00.000Z'),
  };
  return { store, client, deps, lines };
}

describe('agent loop', () => {
  it('completes without tools when the model answers directly', async () => {
    const { store, deps } = makeDeps([textResponse('Nothing to do — the job is already booked.')]);

    const outcome = await startRun({ tenantId: TENANT, objective: 'Check job 42 status' }, deps);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.result).toContain('already booked');

    const run = await store.getRun(outcome.runId, TENANT);
    expect(run?.status).toBe('completed');
    expect(run?.input_tokens).toBe(100);
    expect(run?.output_tokens).toBe(20);
  });

  it('runs a safe tool inline and keeps going without asking anyone', async () => {
    const { store, client, deps } = makeDeps([
      toolUseResponse([{ id: 'tu-1', name: 'get_job_status', input: { job_id: 'J-1' } }]),
      textResponse('That job is scheduled for Thursday.'),
    ]);

    const outcome = await startRun({ tenantId: TENANT, objective: 'What is job J-1 doing?' }, deps);

    expect(outcome.status).toBe('completed');
    // Two model calls: the tool request, then the answer. No approval created.
    expect(client.calls).toHaveLength(2);
    expect(store.approvals.size).toBe(0);

    const results = lastToolResults(client.calls[1]!.messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_use_id).toBe('tu-1');
  });

  it('parks the run on a sensitive tool instead of executing it', async () => {
    const { store, deps } = makeDeps([
      toolUseResponse([
        {
          id: 'tu-9',
          name: 'send_customer_email',
          input: { customer_id: 'C-1', subject: 'Your quote', body: 'Here it is.' },
        },
      ]),
    ]);

    const outcome = await startRun({ tenantId: TENANT, objective: 'Email C-1 their quote' }, deps);

    expect(outcome.status).toBe('awaiting_approval');
    if (outcome.status !== 'awaiting_approval') return;

    expect(outcome.approvals).toHaveLength(1);
    const approval = outcome.approvals[0]!;
    expect(approval.tool_name).toBe('send_customer_email');
    expect(approval.status).toBe('pending');
    // The summary is what a human reads before deciding, so it must carry the
    // actual payload rather than the tool's generic description.
    expect(approval.summary).toContain('Your quote');
    expect(approval.summary).toContain('Here it is.');

    const run = await store.getRun(outcome.runId, TENANT);
    expect(run?.status).toBe('awaiting_approval');
    expect(store.audit.map((a) => a.event)).toContain('run.awaiting_approval');
  });

  it('executes the tool only after a human approves, then finishes', async () => {
    const { store, client, deps } = makeDeps([
      toolUseResponse([
        {
          id: 'tu-9',
          name: 'send_customer_email',
          input: { customer_id: 'C-1', subject: 'Your quote', body: 'Here it is.' },
        },
      ]),
      textResponse('Email sent to the customer.'),
    ]);

    const started = await startRun({ tenantId: TENANT, objective: 'Email C-1 their quote' }, deps);
    expect(started.status).toBe('awaiting_approval');
    if (started.status !== 'awaiting_approval') return;

    await store.decideApproval(started.approvals[0]!.id, 'approved', 'estimator@example.com', null);
    const resumed = await resumeRun(started.runId, TENANT, deps);

    expect(resumed.status).toBe('completed');

    // The tool really ran on resume: its result is in the replayed history.
    const results = lastToolResults(client.calls[1]!.messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.tool_use_id).toBe('tu-9');
    expect(results[0]!.content).toContain('Mail service is not configured');
  });

  it('feeds a rejection back to the model as an error rather than failing the run', async () => {
    const { store, client, deps } = makeDeps([
      toolUseResponse([
        {
          id: 'tu-9',
          name: 'send_customer_email',
          input: { customer_id: 'C-1', subject: 'Your quote', body: 'Here it is.' },
        },
      ]),
      textResponse('Understood — I will not email the customer.'),
    ]);

    const started = await startRun({ tenantId: TENANT, objective: 'Email C-1 their quote' }, deps);
    if (started.status !== 'awaiting_approval') throw new Error('expected approval');

    await store.decideApproval(
      started.approvals[0]!.id,
      'rejected',
      'estimator@example.com',
      'Pricing is not final yet',
    );
    const resumed = await resumeRun(started.runId, TENANT, deps);

    expect(resumed.status).toBe('completed');

    const results = lastToolResults(client.calls[1]!.messages);
    expect(results[0]!.is_error).toBe(true);
    expect(results[0]!.content).toContain('rejected this action');
    expect(results[0]!.content).toContain('Pricing is not final yet');
    // Nothing was sent — the executor was never reached.
    expect(results[0]!.content).not.toContain('Mail service is not configured');
  });

  it('runs safe siblings immediately and parks them until the gated call is decided', async () => {
    const { store, client, deps } = makeDeps([
      toolUseResponse([
        { id: 'tu-safe', name: 'get_job_status', input: { job_id: 'J-7' } },
        {
          id: 'tu-gated',
          name: 'send_customer_email',
          input: { customer_id: 'C-2', subject: 'Update', body: 'Running late.' },
        },
      ]),
      textResponse('Done.'),
    ]);

    const started = await startRun({ tenantId: TENANT, objective: 'Update C-2 about J-7' }, deps);
    if (started.status !== 'awaiting_approval') throw new Error('expected approval');

    // Only the sensitive call produced an approval; the safe result is parked.
    expect(started.approvals).toHaveLength(1);
    const parked = await store.getRun(started.runId, TENANT);
    expect(Object.keys(parked!.pending_results)).toEqual(['tu-safe']);

    await store.decideApproval(started.approvals[0]!.id, 'approved', 'ops@example.com', null);
    await resumeRun(started.runId, TENANT, deps);

    // The API requires one tool_result per tool_use in the same user turn.
    // Both must be present, and the safe one must not have been re-executed.
    const results = lastToolResults(client.calls[1]!.messages);
    expect(results.map((r) => r.tool_use_id).sort()).toEqual(['tu-gated', 'tu-safe']);
  });

  it('stays parked when a second approver has not answered yet', async () => {
    const { store, deps } = makeDeps([
      toolUseResponse([
        {
          id: 'tu-a',
          name: 'send_customer_email',
          input: { customer_id: 'C-1', subject: 'A', body: 'a' },
        },
        {
          id: 'tu-b',
          name: 'schedule_job',
          input: { customer_id: 'C-1', description: 'Rewire', scheduled_date: '2026-09-01' },
        },
      ]),
    ]);

    const started = await startRun({ tenantId: TENANT, objective: 'Email and book C-1' }, deps);
    if (started.status !== 'awaiting_approval') throw new Error('expected approval');
    expect(started.approvals).toHaveLength(2);

    await store.decideApproval(started.approvals[0]!.id, 'approved', 'ops@example.com', null);

    // One decided, one outstanding: resuming must not call the model at all,
    // which is why the script has no second response to give.
    const resumed = await resumeRun(started.runId, TENANT, deps);
    expect(resumed.status).toBe('awaiting_approval');
  });

  it('treats an unknown tool as sensitive rather than executing it', async () => {
    const { deps } = makeDeps([
      toolUseResponse([{ id: 'tu-x', name: 'wire_funds', input: { amount: 999999 } }]),
    ]);

    const outcome = await startRun({ tenantId: TENANT, objective: 'Move some money' }, deps);

    expect(outcome.status).toBe('awaiting_approval');
    if (outcome.status !== 'awaiting_approval') return;
    expect(outcome.approvals[0]!.summary).toContain('Unrecognised tool');
  });

  it('fails the run on a refusal instead of reading empty content', async () => {
    const { store, deps } = makeDeps([refusalResponse('cyber')]);

    const outcome = await startRun({ tenantId: TENANT, objective: 'Do something disallowed' }, deps);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toContain('cyber');

    const run = await store.getRun(outcome.runId, TENANT);
    expect(run?.status).toBe('failed');
  });

  it('stops at the iteration ceiling rather than looping forever', async () => {
    const script = Array.from({ length: MAX_ITERATIONS }, (_v, i) =>
      toolUseResponse([{ id: `tu-${i}`, name: 'get_job_status', input: { job_id: 'J-1' } }]),
    );
    const { deps } = makeDeps(script);

    const outcome = await startRun({ tenantId: TENANT, objective: 'Loop forever please' }, deps);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toContain(`${MAX_ITERATIONS} iterations`);
  });

  it('will not read a run belonging to another tenant', async () => {
    const { deps } = makeDeps([textResponse('done')]);
    const started = await startRun({ tenantId: TENANT, objective: 'Something harmless' }, deps);

    const outcome = await resumeRun(started.runId, 'tenant-b', deps);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toBe('run not found');
  });
});
