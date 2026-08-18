import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, getTool, requiresApproval, toAnthropicTools } from '../src/tools';
import { redact } from '../src/log';

describe('risk classification', () => {
  it('lets read-only tools through without approval', () => {
    expect(requiresApproval('lookup_customer')).toBe(false);
    expect(requiresApproval('get_job_status')).toBe(false);
  });

  it('gates anything with an external, hard-to-undo effect', () => {
    expect(requiresApproval('send_customer_email')).toBe(true);
    expect(requiresApproval('schedule_job')).toBe(true);
  });

  it('fails closed on an unknown tool name', () => {
    // If the registry and the model's tool list ever drift, the safe direction
    // is to ask a human — not to run something nobody classified.
    expect(requiresApproval('drop_all_tables')).toBe(true);
    expect(getTool('drop_all_tables')).toBeUndefined();
  });
});

describe('anthropic wire format', () => {
  const tools = toAnthropicTools();

  it('exposes every registered tool', () => {
    expect(tools).toHaveLength(TOOL_REGISTRY.length);
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_job_status',
      'lookup_customer',
      'schedule_job',
      'send_customer_email',
    ]);
  });

  it('marks every tool strict with a closed schema', () => {
    // strict + additionalProperties:false is what lets the executors skip
    // re-validating types and check only business preconditions.
    for (const tool of tools) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema.additionalProperties).toBe(false);
      expect(tool.input_schema.required.length).toBeGreaterThan(0);
    }
  });

  it('documents every property, since the description is what the model reads', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.description.length).toBeGreaterThan(40);
      for (const key of tool.inputSchema.required) {
        expect(tool.inputSchema.properties[key]).toBeDefined();
      }
    }
  });
});

describe('approval summaries', () => {
  it('states the concrete effect, not the tool purpose', () => {
    const email = getTool('send_customer_email')!;
    const summary = email.summarise({
      customer_id: 'C-42',
      subject: 'Your invoice',
      body: 'Attached.',
    } as never);

    expect(summary).toContain('C-42');
    expect(summary).toContain('Your invoice');
    expect(summary).toContain('Attached.');
  });

  it('truncates a long body so a Slack message stays readable', () => {
    const email = getTool('send_customer_email')!;
    const summary = email.summarise({
      customer_id: 'C-42',
      subject: 'Long',
      body: 'x'.repeat(2000),
    } as never);

    expect(summary).toContain('truncated for review');
    expect(summary.length).toBeLessThan(800);
  });
});

describe('business preconditions the schema cannot express', () => {
  const ctx = {
    runId: 'r-1',
    tenantId: 't-1',
    idempotencyKey: 'k-1',
    env: { CRM_BASE_URL: 'https://crm.test', CRM_API_KEY: 'key' },
    log: () => {},
  };

  it('refuses to back-date a job', async () => {
    const schedule = getTool('schedule_job')!;
    const result = await schedule.execute(
      { customer_id: 'C-1', description: 'Rewire', scheduled_date: '2020-01-01' } as never,
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('in the past');
  });

  it('refuses a malformed date before touching the network', async () => {
    const schedule = getTool('schedule_job')!;
    const result = await schedule.execute(
      { customer_id: 'C-1', description: 'Rewire', scheduled_date: 'next Tuesday' } as never,
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('ISO 8601');
  });

  it('degrades cleanly when a downstream is not configured', async () => {
    const email = getTool('send_customer_email')!;
    const result = await email.execute(
      { customer_id: 'C-1', subject: 's', body: 'b' } as never,
      { ...ctx, env: {} },
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('not configured');
  });
});

describe('log redaction', () => {
  it('redacts secret-looking keys', () => {
    const out = redact({ api_key: 'sk-ant-abc123', nested: { authorization: 'Bearer xyz' } });

    expect(JSON.stringify(out)).not.toContain('sk-ant-abc123');
    expect(JSON.stringify(out)).not.toContain('Bearer xyz');
  });

  it('redacts key-shaped values even under an innocent key name', () => {
    const out = redact({ note: 'the key is sk-ant-api03-supersecretvalue here' }) as {
      note: string;
    };

    expect(out.note).toContain('[redacted]');
    expect(out.note).not.toContain('supersecretvalue');
  });

  it('truncates long strings so one log line cannot swallow a payload', () => {
    const out = redact({ blob: 'y'.repeat(5000) }) as { blob: string };

    expect(out.blob.length).toBeLessThan(2100);
    expect(out.blob).toContain('truncated');
  });

  it('does not recurse without bound', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };

    expect(() => JSON.stringify(redact(deep))).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain('max-depth');
  });
});
