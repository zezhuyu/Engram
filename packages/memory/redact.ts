/** Secret scrubber applied BEFORE anything is queued or stored. Conservative: unknown secret formats are the host policy's job (see exclusions). */
const PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{8,}\b/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\b(authorization|api[_-]?key|access[_-]?key|secret|password|passwd|token|client[_-]?secret)(["']?\s*[:=]\s*["']?)[^\s"',;]{3,}/gi, '$1$2[REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=\S+/g, '$1=[REDACTED]'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[REDACTED]@']
];
export function redactText(input: string): string { let out = input; for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement); return out; }
export const looksSecret = (input: string): boolean => redactText(input) !== input;
