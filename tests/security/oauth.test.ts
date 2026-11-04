import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { disposableVault } from '../helpers/disposable-vault.js';
import { Engram } from '../../packages/sdk/index.js';
import { resolveOAuthActor, oauthResourceMetadata } from '../../packages/mcp/oauth.js';

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

test('OAuth resource validation pins issuer, audience and client and intersects mapped scopes with the subject ACL ceiling', async t => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'RS256', use: 'sig' };
  let jwksRequests = 0;
  const server = createServer((request, response) => { jwksRequests++; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })); });
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
  const jwt = (overrides: Record<string, unknown> = {}, scope = 'memory.read', header: Record<string, unknown> = {}) => {
    const head = b64({ alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header });
    const claims = b64({ iss: issuer, aud: resource, sub: 'person-1', client_id: 'chatgpt-custom-app', iat: now, exp: now + 300, scope, ...overrides });
    const signed = `${head}.${claims}`; return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
  };
  const readToken = jwt(); const readActor = await resolveOAuthActor(`Bearer ${readToken}`, env);
  assert.equal(readActor?.actorId, 'remote-user'); assert.deepEqual(readActor?.permissions, ['workspace:research:read']); assert.equal(readActor?.credentialBound, true);
  const writeActor = await resolveOAuthActor(`Bearer ${jwt({}, 'memory.write')}`, env);
  assert.deepEqual(writeActor?.permissions, ['workspace:research:write']); assert.notEqual(writeActor?.authId, readActor?.authId, 'different tokens for the same subject bind separate MCP sessions');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ iss: `${issuer}/wrong` })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ aud: 'https://other.example/mcp' })}`, env), undefined);
  assert.equal((await resolveOAuthActor(`Bearer ${jwt({ aud: [resource] })}`, env))?.actorId, 'remote-user', 'a single-element audience list with the exact resource is valid');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ client_id: 'unapproved-app' })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ sub: 'unknown-user' })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ exp: now - 1 })}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({}, 'unmapped.scope')}`, env), undefined);
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ aud: [resource, 'https://extra.example'] })}`, env), undefined, 'audience must be the exact configured resource');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ client_id: undefined, azp: 'chatgpt-custom-app' })}`, env), undefined, 'azp cannot substitute for client_id');
  const beforeUnknownKid = jwksRequests;
  await Promise.all(Array.from({ length: 1_000 }, (_, i) => resolveOAuthActor(`Bearer ${jwt({}, 'memory.read', { kid: `attacker-kid-${i}` })}`, env)));
  assert.equal(jwksRequests - beforeUnknownKid, 1, '1,000 distinct unknown kids share one bounded endpoint refresh');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({}, 'memory.read', { alg: 'ES256' })}`, env), undefined, 'a token cannot select an algorithm different from its RSA key');
  const metadata = oauthResourceMetadata(env); assert.equal(metadata?.resource, resource); assert.deepEqual(metadata?.authorization_servers, [issuer]);
  const separated = { ...env, MDB_MCP_OAUTH_SUBJECTS_JSON: JSON.stringify({ 'person-1': { actorId: 'remote-user', permissions: ['workspace:research:read', 'workspace:research:write'], clients: {
    'chatgpt-custom-app': { actorId: 'chatgpt-user', permissions: ['workspace:research:read'] },
    'claude-custom-connector': { actorId: 'claude-user', permissions: ['workspace:research:read', 'workspace:research:write'] },
  } } }) };
  assert.equal((await resolveOAuthActor(`Bearer ${jwt()}`, separated))?.actorId, 'chatgpt-user');
  assert.equal((await resolveOAuthActor(`Bearer ${jwt({ client_id: 'claude-custom-connector' })}`, separated))?.actorId, 'claude-user');
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({}, 'memory.write')}`, separated), undefined, 'read-only ChatGPT identity cannot acquire write permissions');
  const missing = { ...separated, MDB_MCP_OAUTH_CLIENT_IDS: JSON.stringify(['chatgpt-custom-app', 'claude-custom-connector', 'unmapped-client']) };
  assert.equal(await resolveOAuthActor(`Bearer ${jwt({ client_id: 'unmapped-client' })}`, missing), undefined, 'no fallback to subject grant');
  assert.throws(() => oauthResourceMetadata({ ...separated, MDB_MCP_OAUTH_SUBJECTS_JSON: separated.MDB_MCP_OAUTH_SUBJECTS_JSON.replace('claude-user', 'chatgpt-user') }), /configuration is invalid/);
});

test('an attacker-triggered unknown-kid refresh cannot block a rotated signing key for ten seconds', async t => {
  const oldKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const newKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = (pair: typeof oldKey, kid: string) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
  let keys = [jwk(oldKey, 'old')];
  let jwksRequests = 0;
  const server = createServer((_request, response) => { jwksRequests++; response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys })); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`; const resource = `${base}/mcp`; const issuer = `${base}/issuer`;
  const env = {
    MDB_MCP_OAUTH_ISSUER: issuer, MDB_MCP_OAUTH_JWKS_URL: `${base}/jwks`, MDB_MCP_OAUTH_RESOURCE: resource, MDB_MCP_OAUTH_AUDIENCE: resource,
    MDB_MCP_OAUTH_CLIENT_IDS: '["app"]',
    MDB_MCP_OAUTH_SUBJECTS_JSON: JSON.stringify({ subject: { actorId: 'actor', permissions: ['workspace:w:read'] } }),
    MDB_MCP_OAUTH_SCOPE_MAP_JSON: '{"read":["workspace:w:read"]}',
  };
  const originalNow = Date.now;
  const start = originalNow();
  Date.now = () => start;
  t.after(() => { Date.now = originalNow; });
  const token = (kid: string, pair: typeof oldKey) => {
    const header = b64({ alg: 'RS256', kid });
    const claims = b64({ iss: issuer, aud: resource, sub: 'subject', client_id: 'app', iat: Math.floor(start / 1000), exp: Math.floor(start / 1000) + 300, scope: 'read' });
    const signed = `${header}.${claims}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), pair.privateKey).toString('base64url')}`;
  };
  const resolve = async (kid: string, pair: typeof oldKey) => resolveOAuthActor(`Bearer ${token(kid, pair)}`, env);

  assert.equal((await resolve('old', oldKey))?.actorId, 'actor', 'initial key primes the per-URL cache');
  assert.equal(await resolve('attacker-controlled-kid', oldKey), undefined, 'unknown kid remains unauthorized after its bounded refresh');
  keys = [jwk(oldKey, 'old'), jwk(newKey, 'new')];
  Date.now = () => start + 9_000;
  assert.equal((await resolve('new', newKey))?.actorId, 'actor', 'a legitimate rotation is accepted within the ten-second availability bound');
  assert.ok(jwksRequests <= 3, 'refresh remains globally bounded per configured JWKS endpoint');
});

test('OAuth resource configuration rejects wildcard ACL grants and audience/resource confusion', () => {
  const base = { MDB_MCP_OAUTH_ISSUER: 'https://issuer.example', MDB_MCP_OAUTH_JWKS_URL: 'https://issuer.example/jwks', MDB_MCP_OAUTH_RESOURCE: 'https://memory.example/mcp', MDB_MCP_OAUTH_AUDIENCE: 'https://other.example', MDB_MCP_OAUTH_CLIENT_IDS: '["app"]', MDB_MCP_OAUTH_SUBJECTS_JSON: '{"user":{"actorId":"user","permissions":["*"]}}', MDB_MCP_OAUTH_SCOPE_MAP_JSON: '{"read":["workspace:x:read"]}' };
  assert.throws(() => oauthResourceMetadata(base), /configuration is invalid/);
  assert.throws(() => oauthResourceMetadata({ ...base, MDB_MCP_OAUTH_AUDIENCE: 'https://memory.example/mcp' }), /configuration is invalid/);
  const restricted = { ...base, MDB_MCP_OAUTH_AUDIENCE: 'https://memory.example/mcp', MDB_MCP_OAUTH_SUBJECTS_JSON: '{"user":{"actorId":"user","permissions":["workspace:x:read"]}}' };
  assert.equal(oauthResourceMetadata(restricted)?.resource, 'https://memory.example/mcp');
  for (const issuer of ['http://issuer.example', 'ftp://localhost/issuer', 'https://user:password@issuer.example']) assert.throws(() => oauthResourceMetadata({ ...restricted, MDB_MCP_OAUTH_ISSUER: issuer }), /configuration is invalid/);
});

test('OAuth-only HTTP server starts without legacy credentials and challenges unauthenticated discovery', async t => {
  const { root } = await disposableVault(t);
  const owner = new Engram(root); await owner.createWorkspace('x'); await owner.createWorkspace('hidden');
  await owner.vault.grant('x', 'chatgpt-beta', ['read']); await owner.vault.grant('x', 'claude-beta', ['read', 'write']);
  const secret = await owner.put({ scope: { type: 'workspace', workspaceId: 'hidden' }, kind: 'note', title: 'Hidden', body: 'FORBIDDEN_OAUTH_CANARY' });
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = createServer((_request, response) => response.end(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'beta', alg: 'RS256' }] })));
  await new Promise<void>(ok => keys.listen(0, '127.0.0.1', ok)); t.after(() => keys.close());
  const keysAddress = keys.address(); assert.ok(keysAddress && typeof keysAddress === 'object');
  const env: NodeJS.ProcessEnv = { ...process.env, MDB_MCP_TRANSPORT: 'http', MDB_MCP_TOOLSET: 'remote-web', MDB_MCP_HTTP_HOST: '127.0.0.1', MDB_MCP_HTTP_PORT: '0',
    MDB_MCP_OAUTH_ISSUER: 'https://issuer.example', MDB_MCP_OAUTH_JWKS_URL: `http://127.0.0.1:${keysAddress.port}/jwks`, MDB_MCP_OAUTH_RESOURCE: 'https://memory.example/mcp', MDB_MCP_OAUTH_AUDIENCE: 'https://memory.example/mcp',
    MDB_MCP_OAUTH_CLIENT_IDS: '["chatgpt","claude"]', MDB_MCP_OAUTH_SUBJECTS_JSON: JSON.stringify({ user: { actorId: 'ceiling', permissions: ['workspace:x:read', 'workspace:x:write'], clients: { chatgpt: { actorId: 'chatgpt-beta', permissions: ['workspace:x:read'] }, claude: { actorId: 'claude-beta', permissions: ['workspace:x:read', 'workspace:x:write'] } } } }), MDB_MCP_OAUTH_SCOPE_MAP_JSON: '{"memory.read":["workspace:x:read"],"memory.write":["workspace:x:write"]}' };
  delete env.MDB_MCP_HTTP_TOKEN;
  const child = spawn(process.execPath, [resolve('bin/mdb-mcp.js'), '--root', root], { env });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } });
  const endpoint = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('OAuth-only startup timed out')), 10_000);
    let stderr = ''; child.stderr.on('data', chunk => { stderr += String(chunk); const match = /MCP HTTP listening at (http:\/\/\S+)/.exec(stderr); if (match) { clearTimeout(timer); ok(match[1]!); } });
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`OAuth-only startup exited ${code}: ${stderr}`)); });
  });
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate') ?? '', /resource_metadata="https:\/\/memory.example\/\.well-known\/oauth-protected-resource\/mcp"/);
  const version = await fetch(new URL('/version', endpoint));
  assert.deepEqual(await version.json(), { name: 'engram', version: '0.1.0' }, 'the unauthenticated connection probe exposes only the server version');
  const tokenFor = (client: string) => {
    const now = Math.floor(Date.now() / 1000); const head = b64({ alg: 'RS256', kid: 'beta' });
    const body = b64({ iss: env.MDB_MCP_OAUTH_ISSUER, aud: env.MDB_MCP_OAUTH_AUDIENCE, sub: 'user', client_id: client, scope: 'memory.read memory.write', iat: now, exp: now + 300 });
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const call = async (token: string, name: string, args: object) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) })).json() as Promise<{ result: { isError?: boolean; content: { text: string }[] } }>;
  const input = { scope: { type: 'workspace', workspaceId: 'x' }, kind: 'note', title: 'OAuth canary', body: 'Authorized', source: 'synthetic-http-test', idempotencyKey: 'oauth-create' };
  assert.equal((await call(tokenFor('chatgpt'), 'engram_create', input)).result.isError, true);
  const created = await call(tokenFor('claude'), 'engram_create', input); assert.ok(!created.result.isError);
  const document = JSON.parse(created.result.content[0]!.text) as { id: string; revisionId: string };
  assert.ok(!(await call(tokenFor('chatgpt'), 'engram_get', { objectId: document.id })).result.isError);
  for (const client of ['chatgpt', 'claude']) {
    const denied = await call(tokenFor(client), 'engram_get', { objectId: secret.id });
    assert.equal(denied.result.isError, true); assert.doesNotMatch(JSON.stringify(denied), /FORBIDDEN_OAUTH_CANARY/);
  }
  const patched = await call(tokenFor('claude'), 'engram_patch', { objectId: document.id, expectedRevisionId: document.revisionId, body: 'Revision two', idempotencyKey: 'oauth-patch' });
  assert.ok(!patched.result.isError); assert.equal((await owner.vault.history(document.id)).length, 2);
});
