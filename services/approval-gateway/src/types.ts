/**
 * Shared types for the approval gateway.
 *
 * The central idea: an agent run is a *persisted state machine*, not a function
 * call. It can stop mid-loop, survive the death of the request that started it,
 * and resume hours later when a human answers.
 */

/** How much damage a tool can do if the model gets it wrong. */
export type RiskLevel = 'safe' | 'sensitive';

export type RunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type Decision = 'approve' | 'reject';

/** A tool the agent may call. */
export interface ToolSpec<TInput = Record<string, unknown>> {
  name: string;
  description: string;
  /**
   * JSON Schema for the tool input. Paired with `strict: true` on the wire so
   * the API guarantees the shape — the executor never has to re-validate types,
   * only business preconditions.
   */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties: false;
  };
  risk: RiskLevel;
  /**
   * Human-readable summary of a *specific* pending call, shown to the approver.
   * This is what someone reads at 4pm on a Friday before clicking approve, so it
   * must state the concrete effect, not the tool's general purpose.
   */
  summarise: (input: TInput) => string;
  execute: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  runId: string;
  tenantId: string;
  /** Set on every outbound side effect so retries cannot double-apply. */
  idempotencyKey: string;
  env: unknown;
  log: (event: string, fields?: Record<string, unknown>) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Returned to the model as the tool_result content. */
  content: string;
}

/**
 * One Anthropic `tool_use` content block.
 *
 * The index signature is deliberate: response content blocks arrive as loose
 * `{ type: string, ... }` objects, and without it TypeScript rejects the
 * narrowing predicate in agent.ts as not assignable to the parameter type.
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgentRun {
  id: string;
  tenant_id: string;
  status: RunStatus;
  /**
   * Full Anthropic message history. Persisting this verbatim is what makes the
   * run resumable — on resume we replay it to the API rather than reconstructing
   * intent from a summary.
   */
  messages: unknown[];
  /**
   * Results of safe tool calls from the current turn, executed but not yet sent
   * back to the model because a sibling call in the same turn is still waiting
   * on a human. Parked here so a resume never re-runs them.
   */
  pending_results: Record<string, { content: string; is_error: boolean }>;
  objective: string;
  result: string | null;
  error: string | null;
  iterations: number;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  run_id: string;
  tenant_id: string;
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
  summary: string;
  status: ApprovalStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  expires_at: string;
  created_at: string;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
