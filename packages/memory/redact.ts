/** Secret scrubber applied BEFORE anything is queued or stored. Conservative: unknown secret formats are the host policy's job (see exclusions). */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]'],
  // Do not require a right word boundary. Host payloads are deliberately
  // truncated before capture; an overlong credential-like run can therefore
  // end at the scan boundary and otherwise leak its retained prefix.
  [/\bAKIA[0-9A-Z]{12,}/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\b(authorization|api[_-]?key|access[_-]?key|secret|password|passwd|token|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;]{3,}/gi, '$1$2[REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=\S+/g, '$1=[REDACTED]'],
  [/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@']
];
export function redactText(input: string): string { let out = input; for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement); return out; }
/** Redact common personal identifiers only at the remote-provider boundary. Local providers keep the owner-approved source copy. */
export function redactRemotePii(input: string): string {
  let out = input
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED SSN]')
    .replace(/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}\b/gi, '[REDACTED EMAIL]');
  return out.replace(/\b(?:\d[ -]?){13,19}\b/g, value => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return value;
    let sum = 0, double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = digits.charCodeAt(i) - 48;
      if (double && (n *= 2) > 9) n -= 9;
      sum += n; double = !double;
    }
    return sum % 10 === 0 ? '[REDACTED CARD]' : value;
  });
}
export const looksSecret = (input: string): boolean => redactText(input) !== input;

/** Captures retain only a prefix. Bound the scan before applying the scrubber so hostile host payloads cannot trigger unbounded synchronous work. */
export const CAPTURE_TEXT_LIMIT = 20_000;
export function redactCaptureText(input: string, outputLimit = CAPTURE_TEXT_LIMIT): string {
  // Only a retained prefix can reach the spool. Scan an overlap beyond that
  // prefix so a credential beginning near the boundary is redacted before the
  // output is truncated; do not discard the entire capture just because the
  // host sent a large payload.
  const scanLimit = Math.max(0, outputLimit) + 1_048_576;
  const bounded = input.slice(0, scanLimit);
  return redactText(bounded).slice(0, outputLimit);
}
