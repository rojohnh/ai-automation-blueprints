/**
 * Structured logging with redaction.
 *
 * Every line is one JSON object so it can be queried in Datadog / Logtail /
 * Workers Logs without a grok pattern. Redaction runs on the way *in*, not at
 * the sink — a secret that reaches the log line has already leaked.
 */

const SECRET_KEY_PATTERN =
  /(api[-_]?key|secret|token|password|passwd|authorization|bearer|signature|credential)/i;

const SECRET_VALUE_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}/g, // OpenAI-style
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

const MAX_DEPTH = 6;

/** Recursively redact secret-looking keys and values. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';

  if (typeof value === 'string') {
    let out = value;
    for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, '[redacted]');
    return out.length > 2000 ? out.slice(0, 2000) + '…[truncated]' : out;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }

  return value;
}

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export interface LoggerOptions {
  requestId: string;
  runId?: string;
  tenantId?: string;
  sink?: (line: string) => void;
}

export function createLogger(options: LoggerOptions): Logger {
  const sink = options.sink ?? ((line: string) => console.log(line));

  return (event, fields = {}) => {
    sink(
      JSON.stringify({
        ts: new Date().toISOString(),
        event,
        request_id: options.requestId,
        ...(options.runId ? { run_id: options.runId } : {}),
        ...(options.tenantId ? { tenant_id: options.tenantId } : {}),
        ...(redact(fields) as Record<string, unknown>),
      }),
    );
  };
}
