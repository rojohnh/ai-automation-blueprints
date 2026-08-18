/**
 * Approval tokens.
 *
 * An approval link goes into Slack or email, which means the URL itself is the
 * credential. So the token must be:
 *
 *   - unforgeable          → HMAC-SHA256 over the payload
 *   - single-purpose       → bound to one approval id, not a session
 *   - short-lived          → carries its own expiry, checked on use
 *   - decision-neutral     → the token proves *who may decide*, not *what was
 *                            decided; approve and reject share one token so a
 *                            forwarded "approve" link cannot be replayed as a
 *                            different outcome than the approver intended.
 *
 * Verification uses crypto.subtle.verify rather than a string compare, so the
 * comparison does not leak signature bytes through timing.
 */

const encoder = new TextEncoder();

export interface ApprovalTokenPayload {
  approvalId: string;
  /** Unix seconds. */
  expiresAt: number;
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new Error('approval signing secret must be at least 32 characters');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** `<base64url(payload)>.<base64url(hmac)>` */
export async function signApprovalToken(
  payload: ApprovalTokenPayload,
  secret: string,
): Promise<string> {
  const key = await importKey(secret);
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64UrlEncode(signature)}`;
}

export type TokenVerification =
  | { valid: true; payload: ApprovalTokenPayload }
  | { valid: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export async function verifyApprovalToken(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<TokenVerification> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: 'malformed' };
  }
  const [body, signature] = parts as [string, string];

  let key: CryptoKey;
  let signatureBytes: Uint8Array;
  try {
    key = await importKey(secret);
    signatureBytes = base64UrlDecode(signature);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  // Constant-time by construction — never compare signatures with ===.
  const signatureOk = await crypto.subtle.verify(
    'HMAC',
    key,
    signatureBytes as unknown as ArrayBuffer,
    encoder.encode(body),
  );
  if (!signatureOk) return { valid: false, reason: 'bad_signature' };

  let payload: ApprovalTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(body)));
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof payload?.approvalId !== 'string' ||
    typeof payload?.expiresAt !== 'number'
  ) {
    return { valid: false, reason: 'malformed' };
  }

  // Signature checked before expiry, so an attacker cannot use response timing
  // to distinguish "expired but validly signed" from "forged".
  if (payload.expiresAt <= now) return { valid: false, reason: 'expired' };

  return { valid: true, payload };
}
