/**
 * HTTP surface for the approval gateway.
 *
 *   POST /v1/runs                      start an agent run
 *   GET  /v1/runs/:id                  read run state and pending approvals
 *   POST /v1/approvals/:id/decision    record a human decision, then resume
 *   GET  /health                       liveness
 *
 * Long work never blocks the response. Starting a run and resuming after a
 * decision both return immediately and continue under `waitUntil`, because an
 * agent loop can outlive the patience of whatever made the request.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Db } from './db';
import { createLogger } from './log';
import { resumeRun, startRun, type MessagesClient } from './agent';
import { signApprovalToken, verifyApprovalToken } from './approvals';
import { HttpError } from './types';

export interface Env {
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  APPROVAL_SIGNING_SECRET: string;
  GATEWAY_API_KEY: string;
  CRM_BASE_URL?: string;
  CRM_API_KEY?: string;
  MAIL_BASE_URL?: string;
  MAIL_API_KEY?: string;
  PUBLIC_BASE_URL?: string;
}

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'APPROVAL_SIGNING_SECRET',
  'GATEWAY_API_KEY',
] as const;

/** Fail at the edge of the request, not three layers deep in a tool call. */
function assertConfigured(env: Env): void {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new HttpError(500, 'misconfigured', `missing environment variables: ${missing.join(', ')}`);
  }
}

/** Length-independent comparison — never `===` on a secret. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  // Compare a fixed number of bytes regardless of input length so the loop
  // count does not reveal where the values diverge.
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function authenticate(request: Request, env: Env): string {
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey || !timingSafeEqual(apiKey, env.GATEWAY_API_KEY)) {
    throw new HttpError(401, 'unauthorized', 'valid x-api-key header required');
  }

  // Tenant comes from the authenticated header, never from the body — a caller
  // must not be able to name a tenant it does not own.
  const tenantId = request.headers.get('x-tenant-id');
  if (!tenantId) {
    throw new HttpError(400, 'missing_tenant', 'x-tenant-id header required');
  }
  return tenantId;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') throw new Error('not an object');
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid_json', 'request body must be a JSON object');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const log = createLogger({ requestId });
    const url = new URL(request.url);
    const started = Date.now();

    try {
      if (url.pathname === '/health') {
        return json({ ok: true, service: 'approval-gateway' });
      }

      assertConfigured(env);

      const db = new Db({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
      const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
        .messages as unknown as MessagesClient;
      const deps = { anthropic, db, env, log };

      // POST /v1/runs
      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const tenantId = authenticate(request, env);
        const body = await readJson(request);
        const objective = typeof body.objective === 'string' ? body.objective.trim() : '';

        if (objective.length < 10) {
          throw new HttpError(400, 'invalid_objective', 'objective must be at least 10 characters');
        }
        if (objective.length > 8000) {
          throw new HttpError(400, 'invalid_objective', 'objective must be at most 8000 characters');
        }

        const outcome = await startRun({ tenantId, objective }, deps);
        return json(await withApprovalLinks(outcome, env), outcome.status === 'failed' ? 500 : 202);
      }

      // GET /v1/runs/:id
      const runMatch = url.pathname.match(/^\/v1\/runs\/([0-9a-fA-F-]{36})$/);
      if (request.method === 'GET' && runMatch) {
        const tenantId = authenticate(request, env);
        const run = await db.getRun(runMatch[1]!, tenantId);
        if (!run) throw new HttpError(404, 'not_found', 'run not found');

        const pending = await db.listPendingApprovals(run.id, tenantId);
        return json({
          id: run.id,
          status: run.status,
          objective: run.objective,
          result: run.result,
          error: run.error,
          iterations: run.iterations,
          usage: { input_tokens: run.input_tokens, output_tokens: run.output_tokens },
          pending_approvals: pending.map((a) => ({
            id: a.id,
            tool: a.tool_name,
            summary: a.summary,
            expires_at: a.expires_at,
          })),
        });
      }

      // POST /v1/approvals/:id/decision
      const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([0-9a-fA-F-]{36})\/decision$/);
      if (request.method === 'POST' && approvalMatch) {
        const approvalId = approvalMatch[1]!;
        const body = await readJson(request);

        const token = String(body.token ?? url.searchParams.get('token') ?? '');
        const verification = await verifyApprovalToken(token, env.APPROVAL_SIGNING_SECRET);
        if (!verification.valid) {
          log('approval.token_rejected', { approval_id: approvalId, reason: verification.reason });
          throw new HttpError(403, `token_${verification.reason}`, 'approval token is not usable');
        }
        if (verification.payload.approvalId !== approvalId) {
          throw new HttpError(403, 'token_mismatch', 'token does not belong to this approval');
        }

        const decision = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : null;
        if (!decision) {
          throw new HttpError(400, 'invalid_decision', 'decision must be "approve" or "reject"');
        }

        const decidedBy = typeof body.decided_by === 'string' ? body.decided_by : 'unknown';
        const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : null;
        if (decision === 'rejected' && !reason) {
          throw new HttpError(400, 'reason_required', 'a rejection must include a reason');
        }

        const approval = await db.decideApproval(approvalId, decision, decidedBy, reason);
        if (!approval) {
          // Either already decided or expired. Both are "not yours to decide now".
          const existing = await db.getApproval(approvalId);
          throw new HttpError(
            409,
            'already_decided',
            existing ? `approval is already ${existing.status}` : 'approval not found',
          );
        }

        await db.appendAudit({
          runId: approval.run_id,
          tenantId: approval.tenant_id,
          event: `approval.${decision}`,
          detail: { approval_id: approvalId, tool: approval.tool_name, decided_by: decidedBy, reason },
        });
        log('approval.decided', { approval_id: approvalId, decision, tool: approval.tool_name });

        // Resume out of band: the loop may run for a while and the approver's
        // browser should not be holding the connection open for it.
        ctx.waitUntil(
          resumeRun(approval.run_id, approval.tenant_id, deps).catch((error) =>
            log('resume.failed', {
              run_id: approval.run_id,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );

        return json({ ok: true, approval_id: approvalId, decision, run_id: approval.run_id }, 202);
      }

      throw new HttpError(404, 'not_found', 'no such route');
    } catch (error) {
      if (error instanceof HttpError) {
        log('request.rejected', {
          path: url.pathname,
          status: error.status,
          code: error.code,
          duration_ms: Date.now() - started,
        });
        return json({ ok: false, error: error.code, message: error.message }, error.status);
      }

      const message = error instanceof Error ? error.message : String(error);
      log('request.failed', { path: url.pathname, error: message, duration_ms: Date.now() - started });
      // Never leak an internal message to the caller; the log has the detail.
      return json({ ok: false, error: 'internal_error', request_id: requestId }, 500);
    }
  },
};

/** Attach a signed, expiring decision link to each pending approval. */
async function withApprovalLinks(
  outcome: Awaited<ReturnType<typeof startRun>>,
  env: Env,
): Promise<Record<string, unknown>> {
  if (outcome.status !== 'awaiting_approval') return outcome as unknown as Record<string, unknown>;

  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, '') ?? '';
  const approvals = await Promise.all(
    outcome.approvals.map(async (approval) => {
      const expiresAt = Math.floor(new Date(approval.expires_at).getTime() / 1000);
      const token = await signApprovalToken(
        { approvalId: approval.id, expiresAt },
        env.APPROVAL_SIGNING_SECRET,
      );
      return {
        id: approval.id,
        tool: approval.tool_name,
        summary: approval.summary,
        expires_at: approval.expires_at,
        decision_url: `${base}/v1/approvals/${approval.id}/decision`,
        token,
      };
    }),
  );

  return { status: outcome.status, runId: outcome.runId, approvals };
}
