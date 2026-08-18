/**
 * The tool registry.
 *
 * Risk classification lives *here*, in code, not in the system prompt. A prompt
 * that says "ask before sending email" is a request; a registry entry that says
 * `risk: 'sensitive'` is an enforced property of the system. The model cannot
 * argue its way past this, and neither can a prompt injection buried in a
 * customer's enquiry text.
 *
 * Rule of thumb used below: if the effect is visible outside this system and
 * cannot be trivially undone, it is `sensitive`.
 */

import type { ToolContext, ToolResult, ToolSpec } from './types';
import { withRetry, withTimeout } from './retry';

interface HttpEnv {
  CRM_BASE_URL?: string;
  CRM_API_KEY?: string;
  MAIL_BASE_URL?: string;
  MAIL_API_KEY?: string;
}

async function postJson(
  url: string,
  apiKey: string,
  body: unknown,
  idempotencyKey: string,
): Promise<Response> {
  return withRetry(() =>
    withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          // Retries are only safe because the downstream honours this.
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      }),
      20_000,
      `POST ${new URL(url).pathname}`,
    ),
  );
}

// ── safe tools: read-only, no external side effect ──────────────────────────

const lookupCustomer: ToolSpec<{ query: string }> = {
  name: 'lookup_customer',
  description:
    'Find a customer record by name, email, or phone number. Returns at most 5 matches. ' +
    'Use this before any tool that needs a customer_id.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Name, email address, or phone number to search for.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  risk: 'safe',
  summarise: (input) => `Look up customers matching "${input.query}"`,
  async execute(input, ctx): Promise<ToolResult> {
    const env = ctx.env as HttpEnv;
    if (!env.CRM_BASE_URL || !env.CRM_API_KEY) {
      return { ok: false, content: 'CRM is not configured in this environment.' };
    }

    const url = new URL(`${env.CRM_BASE_URL}/customers`);
    url.searchParams.set('q', input.query);
    url.searchParams.set('limit', '5');
    url.searchParams.set('tenant_id', ctx.tenantId);

    const response = await withRetry(() =>
      withTimeout(
        fetch(url, { headers: { Authorization: `Bearer ${env.CRM_API_KEY}` } }),
        15_000,
        'GET /customers',
      ),
    );

    if (!response.ok) {
      return { ok: false, content: `Customer lookup failed with status ${response.status}.` };
    }
    return { ok: true, content: JSON.stringify(await response.json()) };
  },
};

const getJobStatus: ToolSpec<{ job_id: string }> = {
  name: 'get_job_status',
  description: 'Read the current status, assigned technician, and scheduled date of one job.',
  inputSchema: {
    type: 'object',
    properties: { job_id: { type: 'string', description: 'The job identifier.' } },
    required: ['job_id'],
    additionalProperties: false,
  },
  risk: 'safe',
  summarise: (input) => `Read status of job ${input.job_id}`,
  async execute(input, ctx): Promise<ToolResult> {
    const env = ctx.env as HttpEnv;
    if (!env.CRM_BASE_URL || !env.CRM_API_KEY) {
      return { ok: false, content: 'CRM is not configured in this environment.' };
    }

    const response = await withRetry(() =>
      withTimeout(
        fetch(`${env.CRM_BASE_URL}/jobs/${encodeURIComponent(input.job_id)}`, {
          headers: {
            Authorization: `Bearer ${env.CRM_API_KEY}`,
            'X-Tenant-Id': ctx.tenantId,
          },
        }),
        15_000,
        'GET /jobs/:id',
      ),
    );

    if (response.status === 404) {
      return { ok: false, content: `No job found with id ${input.job_id}.` };
    }
    if (!response.ok) {
      return { ok: false, content: `Job lookup failed with status ${response.status}.` };
    }
    return { ok: true, content: JSON.stringify(await response.json()) };
  },
};

// ── sensitive tools: leave the building, hard to walk back ───────────────────

const sendCustomerEmail: ToolSpec<{
  customer_id: string;
  subject: string;
  body: string;
}> = {
  name: 'send_customer_email',
  description:
    'Send an email to a customer. The customer will receive this immediately and it cannot be recalled.',
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', description: 'Customer to email, from lookup_customer.' },
      subject: { type: 'string', description: 'Subject line.' },
      body: { type: 'string', description: 'Plain-text body of the email.' },
    },
    required: ['customer_id', 'subject', 'body'],
    additionalProperties: false,
  },
  risk: 'sensitive',
  summarise: (input) =>
    `Email customer ${input.customer_id} — subject "${input.subject}" ` +
    `(${input.body.length} chars):\n\n${input.body.slice(0, 500)}` +
    (input.body.length > 500 ? '\n…[truncated for review]' : ''),
  async execute(input, ctx): Promise<ToolResult> {
    const env = ctx.env as HttpEnv;
    if (!env.MAIL_BASE_URL || !env.MAIL_API_KEY) {
      return { ok: false, content: 'Mail service is not configured in this environment.' };
    }

    const response = await postJson(
      `${env.MAIL_BASE_URL}/send`,
      env.MAIL_API_KEY,
      {
        tenant_id: ctx.tenantId,
        customer_id: input.customer_id,
        subject: input.subject,
        body: input.body,
      },
      ctx.idempotencyKey,
    );

    if (!response.ok) {
      return { ok: false, content: `Email send failed with status ${response.status}.` };
    }
    ctx.log('tool.email_sent', { customer_id: input.customer_id });
    return { ok: true, content: 'Email sent.' };
  },
};

const scheduleJob: ToolSpec<{
  customer_id: string;
  description: string;
  scheduled_date: string;
}> = {
  name: 'schedule_job',
  description:
    'Book a job in the field service system. This allocates a technician and notifies the customer.',
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string' },
      description: { type: 'string', description: 'What work is being scheduled.' },
      scheduled_date: { type: 'string', description: 'ISO 8601 date, YYYY-MM-DD.' },
    },
    required: ['customer_id', 'description', 'scheduled_date'],
    additionalProperties: false,
  },
  risk: 'sensitive',
  summarise: (input) =>
    `Book "${input.description}" for customer ${input.customer_id} on ${input.scheduled_date}`,
  async execute(input, ctx): Promise<ToolResult> {
    const env = ctx.env as HttpEnv;
    if (!env.CRM_BASE_URL || !env.CRM_API_KEY) {
      return { ok: false, content: 'CRM is not configured in this environment.' };
    }

    // Business precondition the schema cannot express: no back-dating.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.scheduled_date)) {
      return { ok: false, content: 'scheduled_date must be an ISO 8601 date (YYYY-MM-DD).' };
    }
    if (input.scheduled_date < new Date().toISOString().slice(0, 10)) {
      return { ok: false, content: 'Cannot schedule a job in the past.' };
    }

    const response = await postJson(
      `${env.CRM_BASE_URL}/jobs`,
      env.CRM_API_KEY,
      {
        tenant_id: ctx.tenantId,
        customer_id: input.customer_id,
        description: input.description,
        scheduled_date: input.scheduled_date,
      },
      ctx.idempotencyKey,
    );

    if (!response.ok) {
      return { ok: false, content: `Job creation failed with status ${response.status}.` };
    }
    ctx.log('tool.job_scheduled', { customer_id: input.customer_id });
    return { ok: true, content: JSON.stringify(await response.json()) };
  },
};

export const TOOL_REGISTRY: ReadonlyArray<ToolSpec<never>> = [
  lookupCustomer,
  getJobStatus,
  sendCustomerEmail,
  scheduleJob,
] as unknown as ReadonlyArray<ToolSpec<never>>;

export function getTool(name: string): ToolSpec<never> | undefined {
  return TOOL_REGISTRY.find((tool) => tool.name === name);
}

export function requiresApproval(name: string): boolean {
  const tool = getTool(name);
  // Unknown tool → treat as sensitive. Failing closed is the only safe default
  // when the registry and the model's tool list have drifted apart.
  return tool ? tool.risk === 'sensitive' : true;
}

/** Tool definitions in Anthropic wire format. */
export function toAnthropicTools() {
  return TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    strict: true as const,
  }));
}
