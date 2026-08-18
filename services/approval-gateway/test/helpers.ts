import type { RunStore } from '../src/db';
import type { MessageCreateParams, MessageResponse, MessagesClient } from '../src/agent';
import type { AgentRun, Approval } from '../src/types';

/**
 * In-memory RunStore.
 *
 * This exists because the agent depends on the `RunStore` interface rather than
 * the PostgREST class, so the whole approval lifecycle is testable with no
 * network, no Supabase project, and no mocking framework.
 */
export class InMemoryStore implements RunStore {
  runs = new Map<string, AgentRun>();
  approvals = new Map<string, Approval>();
  audit: Array<{ runId: string; event: string; detail: Record<string, unknown> }> = [];

  async createRun(input: {
    id: string;
    tenantId: string;
    objective: string;
    messages: unknown[];
  }): Promise<AgentRun> {
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: input.id,
      tenant_id: input.tenantId,
      status: 'running',
      messages: input.messages,
      pending_results: {},
      objective: input.objective,
      result: null,
      error: null,
      iterations: 0,
      input_tokens: 0,
      output_tokens: 0,
      created_at: now,
      updated_at: now,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  async getRun(runId: string, tenantId: string): Promise<AgentRun | null> {
    const run = this.runs.get(runId);
    if (!run || run.tenant_id !== tenantId) return null;
    return structuredClone(run);
  }

  async updateRun(
    runId: string,
    tenantId: string,
    patch: Partial<AgentRun>,
  ): Promise<AgentRun> {
    const run = this.runs.get(runId);
    if (!run || run.tenant_id !== tenantId) throw new Error('run not found');
    Object.assign(run, patch, { updated_at: new Date().toISOString() });
    return structuredClone(run);
  }

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
    const approval: Approval = {
      id: input.id,
      run_id: input.runId,
      tenant_id: input.tenantId,
      tool_name: input.toolName,
      tool_use_id: input.toolUseId,
      tool_input: input.toolInput,
      summary: input.summary,
      status: 'pending',
      decided_by: null,
      decided_at: null,
      reason: null,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
    };
    this.approvals.set(approval.id, approval);
    return structuredClone(approval);
  }

  async getApproval(approvalId: string): Promise<Approval | null> {
    const approval = this.approvals.get(approvalId);
    return approval ? structuredClone(approval) : null;
  }

  async listPendingApprovals(runId: string, tenantId: string): Promise<Approval[]> {
    return [...this.approvals.values()]
      .filter((a) => a.run_id === runId && a.tenant_id === tenantId && a.status === 'pending')
      .map((a) => structuredClone(a));
  }

  async listApprovalsForRun(runId: string, tenantId: string): Promise<Approval[]> {
    return [...this.approvals.values()]
      .filter((a) => a.run_id === runId && a.tenant_id === tenantId)
      .map((a) => structuredClone(a));
  }

  /** Mirrors the compare-and-set semantics of the PostgREST implementation. */
  async decideApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason: string | null,
  ): Promise<Approval | null> {
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.status !== 'pending') return null;
    approval.status = decision;
    approval.decided_by = decidedBy;
    approval.decided_at = new Date().toISOString();
    approval.reason = reason;
    return structuredClone(approval);
  }

  async appendAudit(entry: {
    runId: string;
    tenantId: string;
    event: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    this.audit.push({ runId: entry.runId, event: entry.event, detail: entry.detail });
  }
}

/** Replays a scripted list of API responses and records what was sent. */
export class ScriptedClient implements MessagesClient {
  calls: MessageCreateParams[] = [];

  constructor(private readonly script: MessageResponse[]) {}

  async create(params: MessageCreateParams): Promise<MessageResponse> {
    this.calls.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedClient ran out of scripted responses');
    return next;
  }
}

export function textResponse(text: string): MessageResponse {
  return {
    id: 'msg_text',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

export function toolUseResponse(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): MessageResponse {
  return {
    id: 'msg_tools',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    content: calls.map((call) => ({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input,
    })),
    usage: { input_tokens: 200, output_tokens: 40 },
  };
}

export function refusalResponse(category: string): MessageResponse {
  return {
    id: 'msg_refusal',
    model: 'claude-opus-5',
    stop_reason: 'refusal',
    stop_details: { category },
    content: [],
    usage: { input_tokens: 50, output_tokens: 0 },
  };
}

/** Deterministic ids so assertions can name them. */
export function sequentialUuid(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

export function silentLogger() {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Record<string, unknown> = {}) => {
    lines.push({ event, fields });
  };
  return { log, lines };
}

/** Last user turn in a message list — where tool_result blocks land. */
export function lastToolResults(
  messages: unknown[],
): Array<{ tool_use_id: string; content: string; is_error: boolean }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role === 'user' && Array.isArray(message.content)) {
      const blocks = message.content as Array<Record<string, unknown>>;
      if (blocks.some((b) => b.type === 'tool_result')) {
        return blocks
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({
            tool_use_id: String(b.tool_use_id),
            content: String(b.content),
            is_error: Boolean(b.is_error),
          }));
      }
    }
  }
  return [];
}
