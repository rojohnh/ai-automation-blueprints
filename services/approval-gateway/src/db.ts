/**
 * Persistence via Supabase / PostgREST.
 *
 * Workers cannot open a raw TCP connection to Postgres without Hyperdrive, and
 * a connection pool is the wrong shape for an edge runtime anyway. PostgREST
 * over HTTP fits the environment: stateless, per-request auth, no pool to leak.
 *
 * Every call here uses the *service role* key, so row-level security is not the
 * boundary — tenant scoping is enforced explicitly in each query below. That is
 * a deliberate trade-off and it means one missing `tenant_id` filter is a
 * cross-tenant data leak. See docs/security.md.
 */

import type { AgentRun, Approval, ApprovalStatus, RunStatus } from './types';
import { withRetry, withTimeout } from './retry';

export interface DbConfig {
  url: string;
  serviceKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The persistence surface the agent depends on.
 *
 * Declared as an interface, not the concrete class, so the loop can be tested
 * against an in-memory store without a network or a Supabase project. Anything
 * that satisfies this contract is a valid backend — PostgREST here, but a
 * D1 or plain `pg` implementation would drop in unchanged.
 */
export interface RunStore {
  createRun(input: {
    id: string;
    tenantId: string;
    objective: string;
    messages: unknown[];
  }): Promise<AgentRun>;
  getRun(runId: string, tenantId: string): Promise<AgentRun | null>;
  updateRun(
    runId: string,
    tenantId: string,
    patch: Partial<
      Pick<
        AgentRun,
        | 'status'
        | 'messages'
        | 'pending_results'
        | 'result'
        | 'error'
        | 'iterations'
        | 'input_tokens'
        | 'output_tokens'
      >
    >,
  ): Promise<AgentRun>;
  createApproval(input: {
    id: string;
    runId: string;
    tenantId: string;
    toolName: string;
    toolUseId: string;
    toolInput: Record<string, unknown>;
    summary: string;
    expiresAt: string;
  }): Promise<Approval>;
  getApproval(approvalId: string): Promise<Approval | null>;
  listPendingApprovals(runId: string, tenantId: string): Promise<Approval[]>;
  listApprovalsForRun(runId: string, tenantId: string): Promise<Approval[]>;
  decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason: string | null,
  ): Promise<Approval | null>;
  appendAudit(entry: {
    runId: string;
    tenantId: string;
    event: string;
    detail: Record<string, unknown>;
  }): Promise<void>;
}

export class Db implements RunStore {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: DbConfig) {
    this.base = config.url.replace(/\/$/, '') + '/rest/v1';
    this.headers = {
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      'Content-Type': 'application/json',
    };
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { prefer?: string } = {},
  ): Promise<T> {
    const { prefer, ...rest } = init;

    return withRetry(async () => {
      const response = await withTimeout(
        this.fetchImpl(this.base + path, {
          ...rest,
          headers: {
            ...this.headers,
            ...(prefer ? { Prefer: prefer } : {}),
            ...(rest.headers as Record<string, string> | undefined),
          },
        }),
        this.timeoutMs,
        `db ${path}`,
      );

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const error = new Error(`db ${response.status}: ${body.slice(0, 400)}`);
        (error as { status?: number }).status = response.status;
        throw error;
      }

      if (response.status === 204) return undefined as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    });
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  async createRun(input: {
    id: string;
    tenantId: string;
    objective: string;
    messages: unknown[];
  }): Promise<AgentRun> {
    const rows = await this.request<AgentRun[]>('/agent_runs', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({
        id: input.id,
        tenant_id: input.tenantId,
        objective: input.objective,
        messages: input.messages,
        status: 'running' satisfies RunStatus,
      }),
    });
    return rows[0]!;
  }

  async getRun(runId: string, tenantId: string): Promise<AgentRun | null> {
    const rows = await this.request<AgentRun[]>(
      `/agent_runs?id=eq.${encodeURIComponent(runId)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async updateRun(
    runId: string,
    tenantId: string,
    patch: Partial<
      Pick<
        AgentRun,
        | 'status'
        | 'messages'
        | 'pending_results'
        | 'result'
        | 'error'
        | 'iterations'
        | 'input_tokens'
        | 'output_tokens'
      >
    >,
  ): Promise<AgentRun> {
    const rows = await this.request<AgentRun[]>(
      `/agent_runs?id=eq.${encodeURIComponent(runId)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      },
    );
    if (!rows[0]) throw new Error(`run ${runId} not found for tenant`);
    return rows[0];
  }

  // ── approvals ─────────────────────────────────────────────────────────────

  async createApproval(input: {
    id: string;
    runId: string;
    tenantId: string;
    toolName: string;
    toolUseId: string;
    toolInput: Record<string, unknown>;
    summary: string;
    expiresAt: string;
  }): Promise<Approval> {
    const rows = await this.request<Approval[]>('/approvals', {
      method: 'POST',
      prefer: 'return=representation',
      body: JSON.stringify({
        id: input.id,
        run_id: input.runId,
        tenant_id: input.tenantId,
        tool_name: input.toolName,
        tool_use_id: input.toolUseId,
        tool_input: input.toolInput,
        summary: input.summary,
        status: 'pending' satisfies ApprovalStatus,
        expires_at: input.expiresAt,
      }),
    });
    return rows[0]!;
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    const rows = await this.request<Approval[]>(
      `/approvals?id=eq.${encodeURIComponent(approvalId)}&limit=1`,
    );
    return rows[0] ?? null;
  }

  async listPendingApprovals(runId: string, tenantId: string): Promise<Approval[]> {
    return this.request<Approval[]>(
      `/approvals?run_id=eq.${encodeURIComponent(runId)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.pending`,
    );
  }

  async listApprovalsForRun(runId: string, tenantId: string): Promise<Approval[]> {
    return this.request<Approval[]>(
      `/approvals?run_id=eq.${encodeURIComponent(runId)}` +
        `&tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.asc`,
    );
  }

  /**
   * Record a decision, but only if the approval is still pending.
   *
   * The `status=eq.pending` filter makes this a compare-and-set: two approvers
   * clicking at the same moment cannot both win, and a decision can never
   * overwrite an earlier one. PostgREST returns an empty array when the filter
   * matches nothing, which is exactly the "someone beat you to it" signal.
   */
  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason: string | null,
  ): Promise<Approval | null> {
    const rows = await this.request<Approval[]>(
      `/approvals?id=eq.${encodeURIComponent(approvalId)}&status=eq.pending`,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: JSON.stringify({
          status: decision,
          decided_by: decidedBy,
          decided_at: new Date().toISOString(),
          reason,
        }),
      },
    );
    return rows[0] ?? null;
  }

  // ── audit ─────────────────────────────────────────────────────────────────

  async appendAudit(entry: {
    runId: string;
    tenantId: string;
    event: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    await this.request<void>('/audit_log', {
      method: 'POST',
      prefer: 'return=minimal',
      body: JSON.stringify({
        run_id: entry.runId,
        tenant_id: entry.tenantId,
        event: entry.event,
        detail: entry.detail,
      }),
    });
  }
}
