import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { resolveOAuthActor, oauthResourceMetadata } from '../../packages/mcp/oauth.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('OAuth resource validation pins issuer, audience and client and intersects mapped scopes with the subject ACL ceiling', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`; const resource = `${base}/mcp`; const issuer = `${base}/issuer`;
  const env = {
    MDB_MCP_OAUTH_ISSUER: issuer, MDB_MCP_OAUTH_JWKS_URL: `${base}/jwks`, MDB_MCP_OAUTH_RESOURCE: resource, MDB_MCP_OAUTH_AUDIENCE: resource,
    MDB_MCP_OAUTH_CLIENT_IDS: JSON.stringify(['chatgpt-custom-app', 'claude-custom-connector']),
    MDB_MCP_OAUTH_SUBJECTS_JSON: JSON.stringify({ 'person-1': { actorId: 'remote-user', permissions: ['workspace:research:read', 'workspace:research:write'] } }),
    MDB_MCP_OAUTH_SCOPE_MAP_JSON: JSON.stringify({ 'memory.read': ['workspace:research:read'], 'memory.write': ['workspace:research:write'] }),
  };
  const now = Math.floor(Date.now() / 1000);
  const jwt = (overrides: Record<string, unknown> = {}, scope = 'memory.read') => {
    const head = b64({ alg: 'RS256', kid: 'key-1', typ: 'JWT' });
    const claims = b64({ iss: issuer, aud: resource, sub: 'person-1', client_id: 'chatgpt-custom-app', iat: now, exp: now + 300, scope, ...overrides });
    const signed = `${head}.${claims}`; return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
  };
  const readToken = jwt(); const readActor = await resolveOAuthActor(`Bearer ${readToken}`, env);
  assert.equal(readActor?.actorId, 'remote-user'); assert.deepEqual(readActor?.permissions, ['workspace:research:read']); assert.equal(readActor?.credentialBound, true);
  const writeActor = await resolveOAuthActor(`Bearer ${jwt({}, 'memory.write')}`, env);
  assert.deepEqual(writeActor?.permissions, ['workspace:research:write']); assert.notEqual(writeActor?.authId, readActor?.authId, 'different tokens for the same subject bind separate MCP sessions');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ iss: `${issuer}/wrong` })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ aud: 'https://other.example/mcp' })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ client_id: 'unapproved-app' })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ sub: 'unknown-user' })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ exp: now - 1 })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({}, 'unmapped.scope')}`, env), undefined);
  const metadata = oauthResourceMetadata(env); assert.equal(metadata?.resource, resource); assert.deepEqual(metadata?.authorization_servers, [issuer]);
});

test('OAuth resource configuration rejects wildcard ACL grants and audience/resource confusion', () => {
  const base = { MDB_MCP_OAUTH_ISSUER: 'https://issuer.example', MDB_MCP_OAUTH_JWKS_URL: 'https://issuer.example/jwks', MDB_MCP_OAUTH_RESOURCE: 'https://memory.example/mcp', MDB_MCP_OAUTH_AUDIENCE: 'https://other.example', MDB_MCP_OAUTH_CLIENT_IDS: '["app"]', MDB_MCP_OAUTH_SUBJECTS_JSON: '{"user":{"actorId":"user","permissions":["*"]}}', MDB_MCP_OAUTH_SCOPE_MAP_JSON: '{"read":["workspace:x:read"]}' };
  assert.throws(() => oauthResourceMetadata(base), /configuration is invalid/);
  assert.throws(() => oauthResourceMetadata({ ...base, MDB_MCP_OAUTH_AUDIENCE: 'https://memory.example/mcp' }), /configuration is invalid/);
  const restricted = { ...base, MDB_MCP_OAUTH_AUDIENCE: 'https://memory.example/mcp', MDB_MCP_OAUTH_SUBJECTS_JSON: '{"user":{"actorId":"user","permissions":["workspace:x:read"]}}' };
  assert.equal(oauthResourceMetadata(restricted)?.resource, 'https://memory.example/mcp');
});
