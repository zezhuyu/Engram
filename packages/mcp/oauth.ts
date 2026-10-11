import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey as CryptoJsonWebKey } from 'node:crypto';
import type { ActorContext } from '../core/types.js';
import { isValidRemotePermission } from './credentials.js';

type OAuthConfig = { issuer: string; jwksUrl: string; resource: string; audience: string; clients: string[]; subjects: Record<string, { actorId: string; permissions: string[] }>; scopeMap: Record<string, string[]> };
type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let jwksCache: { url: string; expires: number; keys: Jwk[] } | undefined;
const fail = (): undefined => undefined;
const parseConfig = (env: NodeJS.ProcessEnv): OAuthConfig | undefined => {
  const { MDB_MCP_OAUTH_ISSUER: issuer, MDB_MCP_OAUTH_JWKS_URL: jwksUrl, MDB_MCP_OAUTH_RESOURCE: resource, MDB_MCP_OAUTH_AUDIENCE: audience, MDB_MCP_OAUTH_CLIENT_IDS: rawClients, MDB_MCP_OAUTH_SUBJECTS_JSON: rawSubjects, MDB_MCP_OAUTH_SCOPE_MAP_JSON: rawScopeMap } = env;
  if (![issuer, jwksUrl, resource, audience, rawClients, rawSubjects, rawScopeMap].some(Boolean)) return undefined;
  if (![issuer, jwksUrl, resource, audience, rawClients, rawSubjects, rawScopeMap].every(Boolean)) throw new Error('OAuth resource validation requires issuer, JWKS URL, resource, audience, allowed client IDs, subject map, and scope map');
  const safeHttps = (value: string) => { const url = new URL(value); return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1'; };
  try {
    if (!safeHttps(issuer!) || !safeHttps(jwksUrl!) || !safeHttps(resource!)) throw new Error();
    if (audience !== resource) throw new Error();
    const clients = JSON.parse(rawClients!) as unknown; const subjects = JSON.parse(rawSubjects!) as OAuthConfig['subjects']; const scopeMap = JSON.parse(rawScopeMap!) as OAuthConfig['scopeMap'];
    if (!Array.isArray(clients) || !clients.length || clients.some(client => typeof client !== 'string' || client.length > 256) || !subjects || Array.isArray(subjects) || typeof subjects !== 'object' || !scopeMap || Array.isArray(scopeMap) || typeof scopeMap !== 'object') throw new Error();
    for (const [subject, mapping] of Object.entries(subjects)) if (!subject || !mapping || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(mapping.actorId) || !Array.isArray(mapping.permissions) || !mapping.permissions.length || mapping.permissions.some(p => !isValidRemotePermission(p))) throw new Error();
    for (const [scope, permissions] of Object.entries(scopeMap)) if (!/^[A-Za-z0-9:._/-]{1,120}$/.test(scope) || !Array.isArray(permissions) || !permissions.length || permissions.some(p => !isValidRemotePermission(p))) throw new Error();
    if (!Object.keys(subjects).length || !Object.keys(scopeMap).length) throw new Error();
    return { issuer: issuer!, jwksUrl: jwksUrl!, resource: resource!, audience: audience!, clients, subjects, scopeMap };
  } catch { throw new Error('OAuth resource validation configuration is invalid'); }
};

export function oauthResourceMetadata(env: NodeJS.ProcessEnv): { resource: string; authorization_servers: string[]; scopes_supported: string[]; bearer_methods_supported: string[] } | undefined {
  const config = parseConfig(env); if (!config) return undefined;
  return { resource: config.resource, authorization_servers: [config.issuer], scopes_supported: Object.keys(config.scopeMap), bearer_methods_supported: ['header'] };
}

async function keysFor(url: string, refresh = false): Promise<Jwk[]> {
  if (!refresh && jwksCache?.url === url && jwksCache.expires > Date.now()) return jwksCache.keys;
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error('JWKS unavailable');
  const text = await response.text(); if (Buffer.byteLength(text) > 64_000) throw new Error('JWKS too large');
  const body = JSON.parse(text) as { keys?: unknown };
  if (!Array.isArray(body.keys) || body.keys.length > 32) throw new Error('Invalid JWKS');
  const keys = body.keys.filter((key): key is Jwk => !!key && typeof key === 'object' && typeof (key as Jwk).kid === 'string' && (key as Jwk).use !== 'enc');
  jwksCache = { url, keys, expires: Date.now() + 5 * 60_000 };
  return keys;
}

function decodePart(value: string): Record<string, unknown> {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (Buffer.byteLength(decoded) > 16_000) throw new Error('JWT part too large');
  const parsed = JSON.parse(decoded); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Invalid JWT');
  return parsed;
}

/** Validates a JWT access token from a configured issuer, then intersects token scopes with an explicit subject grant map. */
export async function resolveOAuthActor(authorization: string | undefined, env: NodeJS.ProcessEnv): Promise<ActorContext | undefined> {
  const config = parseConfig(env); if (!config) return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(authorization ?? ''); if (!match || match[1]!.length > 32_768) return undefined;
  try {
    const token = match[1]!; const parts = token.split('.'); if (parts.length !== 3) return fail();
    const header = decodePart(parts[0]!); const claims = decodePart(parts[1]!);
    const alg = header.alg; if (!['RS256', 'ES256'].includes(String(alg)) || typeof header.kid !== 'string') return fail();
    let key = (await keysFor(config.jwksUrl)).find(item => item.kid === header.kid && (item.alg === undefined || item.alg === alg));
    if (!key) key = (await keysFor(config.jwksUrl, true)).find(item => item.kid === header.kid && (item.alg === undefined || item.alg === alg));
    if (!key) return fail();
    const publicKey = createPublicKey({ key: key as CryptoJsonWebKey, format: 'jwk' }); const signed = Buffer.from(`${parts[0]}.${parts[1]}`); const signature = Buffer.from(parts[2]!, 'base64url');
    const valid = alg === 'RS256' ? verifySignature('RSA-SHA256', signed, publicKey, signature) : verifySignature('sha256', signed, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature);
    const clientId = typeof claims.client_id === 'string' ? claims.client_id : claims.azp;
    if (!valid || claims.iss !== config.issuer || !(claims.aud === config.audience || Array.isArray(claims.aud) && claims.aud.includes(config.audience)) || typeof clientId !== 'string' || !config.clients.includes(clientId)) return fail();
    const now = Math.floor(Date.now() / 1000); if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 || claims.exp <= now || claims.exp - claims.iat > 3600 || claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30)) return fail();
    if (typeof claims.sub !== 'string') return fail();
    const subject = config.subjects[claims.sub]; if (!subject) return fail();
    const scopes = typeof claims.scope === 'string' ? claims.scope.split(/\s+/) : Array.isArray(claims.scp) && claims.scp.every(item => typeof item === 'string') ? claims.scp as string[] : [];
    const tokenPermissions = new Set(scopes.flatMap(scope => config.scopeMap[scope] ?? []));
    const permissions = subject.permissions.filter(permission => tokenPermissions.has(permission)); if (!permissions.length) return fail();
    return { actorId: subject.actorId, permissions, credentialBound: true, authId: `oauth:${createHash('sha256').update(token).digest('hex')}` };
  } catch { return fail(); }
}
