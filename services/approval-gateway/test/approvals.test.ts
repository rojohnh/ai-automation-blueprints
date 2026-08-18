import { describe, expect, it } from 'vitest';
import { signApprovalToken, verifyApprovalToken } from '../src/approvals';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

describe('approval tokens', () => {
  it('round-trips a valid token', async () => {
    const token = await signApprovalToken({ approvalId: 'ap-1', expiresAt: FUTURE }, SECRET);
    const result = await verifyApprovalToken(token, SECRET);

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.payload.approvalId).toBe('ap-1');
    expect(result.payload.expiresAt).toBe(FUTURE);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signApprovalToken({ approvalId: 'ap-1', expiresAt: FUTURE }, OTHER_SECRET);
    const result = await verifyApprovalToken(token, SECRET);

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects a tampered payload', async () => {
    // The whole point: swap the approval id and the signature no longer matches,
    // so an approver cannot repoint their link at a different pending action.
    const token = await signApprovalToken({ approvalId: 'ap-1', expiresAt: FUTURE }, SECRET);
    const forgedBody = btoa(JSON.stringify({ approvalId: 'ap-2', expiresAt: FUTURE }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const result = await verifyApprovalToken(`${forgedBody}.${token.split('.')[1]}`, SECRET);

    expect(result).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects an expired token even though the signature is good', async () => {
    const past = Math.floor(Date.now() / 1000) - 1;
    const token = await signApprovalToken({ approvalId: 'ap-1', expiresAt: past }, SECRET);

    const result = await verifyApprovalToken(token, SECRET);

    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('treats the expiry boundary as expired', async () => {
    const now = 1_800_000_000;
    const token = await signApprovalToken({ approvalId: 'ap-1', expiresAt: now }, SECRET);

    expect(await verifyApprovalToken(token, SECRET, now)).toEqual({
      valid: false,
      reason: 'expired',
    });
    expect((await verifyApprovalToken(token, SECRET, now - 1)).valid).toBe(true);
  });

  it.each(['', 'nodot', 'a.b.c', '.sig', 'body.'])(
    'rejects malformed token %j',
    async (token) => {
      const result = await verifyApprovalToken(token, SECRET);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(['malformed', 'bad_signature']).toContain(result.reason);
    },
  );

  it('refuses to sign with a weak secret', async () => {
    await expect(
      signApprovalToken({ approvalId: 'ap-1', expiresAt: FUTURE }, 'too-short'),
    ).rejects.toThrow(/at least 32/);
  });
});
