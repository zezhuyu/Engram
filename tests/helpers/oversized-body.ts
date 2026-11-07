import assert from 'node:assert/strict';

const CONNECTION_REJECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

export function oversizedBodyConnectionCode(error: unknown): string | undefined {
  if (!(error instanceof TypeError) || error.message !== 'fetch failed') return undefined;
  const cause = error.cause;
  if (!cause || typeof cause !== 'object' || !('code' in cause) || typeof cause.code !== 'string') return undefined;
  return CONNECTION_REJECTION_CODES.has(cause.code) ? cause.code : undefined;
}

export async function assertOversizedBodyRejected(request: () => Promise<{ status: number }>): Promise<number | string> {
  try {
    const response = await request();
    assert.equal(response.status, 413, 'oversized body receives a bounded HTTP rejection');
    return response.status;
  } catch (error) {
    const code = oversizedBodyConnectionCode(error);
    assert.ok(code, `oversized body request failed for an unexpected reason: ${String(error)}`);
    return `connection:${code}`;
  }
}
