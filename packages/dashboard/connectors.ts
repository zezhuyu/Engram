import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isIP } from 'node:net';
import { parseStrictJson } from '../../scripts/lib/strict-json.js';
import { safePath, atomicWrite, withVaultLock } from '../storage-local/index.js';

const FILE = '.mdb/dashboard/connectors.json';
export type ConnectorName = 'openai' | 'claude';
// The old OpenAI public-URL/OAuth settings remain on disk for migration safety,
// but are deliberately outside this API schema. OpenAI settings now come from
// the tunnel-specific dashboard module.
const FIELDS: Record<ConnectorName, string[]> = { openai: [], claude: [] };
type Config = Record<string, Record<string, string>>;
export type HostResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
const resolveWithDns: HostResolver = hostname => lookup(hostname, { all: true, verbatim: true });
export async function resolveConnectorAddress(url: URL, allowPrivate = false, resolveHost: HostResolver = resolveWithDns): Promise<{ address: string; family: number }> {
  const records = await resolveHost(url.hostname).catch(() => []);
  if (!records.length) throw new Error('Connection host did not resolve');
  if (!allowPrivate && records.some(record => privateAddress(record.address))) throw new Error('Private and loopback addresses are blocked; explicitly allow private address to continue');
  return records[0]!;
}
async function readConfig(root: string): Promise<Config> {
  try { const value = parseStrictJson(await fs.readFile(await safePath(root, FILE), 'utf8'), 'Connector configuration') as any; if (!value || value.version !== 1 || !value.connectors || typeof value.connectors !== 'object') throw new Error(); return value.connectors; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error('Connector configuration is invalid'); }
}
export async function connectorConfig(root: string) {
  const cfg = await readConfig(root);
  return Object.fromEntries((['openai', 'claude'] as const).map(name => [name, Object.fromEntries(FIELDS[name].map(field => [field, field === 'publicUrl' ? { set: typeof cfg[name]?.[field] === 'string', value: cfg[name]?.[field] ?? null } : { set: typeof cfg[name]?.[field] === 'string' && cfg[name]![field]!.length > 0 }]))]));
}
export async function saveConnectorConfig(root: string, name: ConnectorName, input: Record<string, unknown>, confirm: string): Promise<void> {
  if (!['openai', 'claude'].includes(name) || confirm !== `SAVE ${name.toUpperCase()} CONNECTOR`) throw new Error(`Type SAVE ${name.toUpperCase()} CONNECTOR to confirm`);
  const next: Record<string, string | null> = {};
  for (const field of FIELDS[name]) {
    const value = input[field]; if (value === undefined) continue;
    if (value === null || value === '') { next[field] = null; continue; }
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error(`Invalid ${field}`);
    if (field === 'publicUrl') { let url: URL; try { url = new URL(value); } catch { throw new Error('Public URL must be a valid HTTPS URL'); } if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Public URL must be HTTPS without credentials, query, or fragment'); next[field] = url.toString().replace(/\/$/, ''); }
    else next[field] = value;
  }
  await withVaultLock(root, async () => {
    const cfg = await readConfig(root), existing = cfg[name] ?? {};
    for (const [field, value] of Object.entries(next)) if (value === null) delete existing[field]; else existing[field] = value;
    cfg[name] = existing; await atomicWrite(root, FILE, JSON.stringify({ version: 1, connectors: cfg }, null, 2)); await fs.chmod(await safePath(root, FILE), 0o600);
  });
}
const claudeEnvFile = () => path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config'), 'engram', 'claude-connector.env');
export async function claudeWebConfig(root: string) {
  const cfg = await readConfig(root), value = cfg.claudeWeb ?? {};
  const mode = value.mode === 'fixed-header' ? 'fixed-header' : 'authless';
  return { url: typeof value.url === 'string' ? value.url : '', mode, headerName: ['authorization', 'x-api-key', 'x-auth-token'].includes(String(value.headerName)) ? String(value.headerName) : 'x-api-key', createdAt: typeof value.createdAt === 'string' ? value.createdAt : null, keySet: (await readPrivateKey()).length > 0, gateway: mode === 'fixed-header' ? { url: 'http://127.0.0.1:3336/mcp', launcher: path.join(path.dirname(claudeEnvFile()), 'claude-keyed-gateway-launcher.sh') } : null };
}
async function readPrivateKey(): Promise<string> {
  const file = claudeEnvFile();
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Claude connector key file must be an owned regular 0600 file'); const text = await fs.readFile(file, 'utf8'), match = /^ENGRAM_CLAUDE_CONNECTOR_KEY='([^'\n]*)'\s*$/m.exec(text); return match?.[1] ?? ''; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function writePrivateKey(key: string | null): Promise<void> {
  const file = claudeEnvFile(); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(file), 0o700);
  if (key === null) { await fs.rm(file, { force: true }); return; }
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp'; try { await fs.writeFile(temp, `ENGRAM_CLAUDE_CONNECTOR_KEY='${key}'\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); await fs.chmod(file, 0o600); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
async function writeClaudeGatewayLauncher(mode: unknown, headerName: unknown): Promise<void> {
  const dir = path.dirname(claudeEnvFile()), file = path.join(dir, 'claude-keyed-gateway-launcher.sh');
  if (mode !== 'fixed-header') { await fs.rm(file, { force: true }); return; }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url)), script = path.resolve(moduleDir, '../../../scripts/hosted/keyed-gateway.mjs');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const text = '#!/bin/sh\nset -eu\nset -a\n. ' + quote(path.join(dir, 'keyed-gateway.env')) + '\n. ' + quote(claudeEnvFile()) + '\nset +a\nexport GATEWAY_BIND=127.0.0.1\nexport GATEWAY_PORT=3336\nexport GATEWAY_INBOUND_HEADER=' + quote(String(headerName).toLowerCase()) + '\nexport GATEWAY_INBOUND_KEY_ENV=ENGRAM_CLAUDE_CONNECTOR_KEY\nexec ' + quote(process.execPath) + ' ' + quote(script) + '\n';
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp'; await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700);
  try { await fs.writeFile(temp, text, { mode: 0o700, flag: 'wx' }); await fs.rename(temp, file); await fs.chmod(file, 0o700); } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
export async function saveClaudeWebConfig(root: string, input: Record<string, unknown>): Promise<{ config: Awaited<ReturnType<typeof claudeWebConfig>>; oneTimeKey?: string }> {
  const urlValue = input.url; let url = '';
  if (urlValue !== undefined && urlValue !== null && urlValue !== '') { if (typeof urlValue !== 'string') throw new Error('Public URL must be a valid HTTPS URL'); const parsed = validateConnectorTestUrl(urlValue, false, true); if (!parsed.pathname.endsWith('/mcp')) throw new Error('Public URL must end in /mcp'); url = parsed.toString(); }
  const mode = input.mode === undefined ? 'authless' : input.mode; if (mode !== 'authless' && mode !== 'fixed-header') throw new Error('Choose authless or fixed-header');
  const headerName = input.headerName === undefined ? 'x-api-key' : input.headerName; if (!['authorization', 'x-api-key', 'x-auth-token'].includes(String(headerName))) throw new Error('Unsupported fixed header name');
  const store = await readConfig(root), all = { ...store }, saved = { ...(all.claudeWeb ?? {}) as Record<string, string> }; saved.url = url; saved.mode = mode; saved.headerName = String(headerName); saved.createdAt = saved.createdAt || new Date().toISOString(); all.claudeWeb = saved;
  const hadKey = (await readPrivateKey()).length > 0; let oneTimeKey: string | undefined;
  if (mode === 'fixed-header' && !hadKey) { oneTimeKey = randomBytes(32).toString('base64url'); await writePrivateKey(oneTimeKey); }
  if (mode === 'authless' && hadKey) await writePrivateKey(null);
  await writeClaudeGatewayLauncher(mode, headerName);
  await withVaultLock(root, async () => { await atomicWrite(root, FILE, JSON.stringify({ version: 1, connectors: all }, null, 2)); await fs.chmod(await safePath(root, FILE), 0o600); });
  return { config: await claudeWebConfig(root), ...(oneTimeKey ? { oneTimeKey } : {}) };
}
export async function rotateClaudeWebKey(root: string): Promise<{ key: string; config: Awaited<ReturnType<typeof claudeWebConfig>> }> {
  const cfg = await claudeWebConfig(root); if (cfg.mode !== 'fixed-header') throw new Error('Enable fixed-header authentication before generating a key');
  const key = randomBytes(32).toString('base64url'); await writePrivateKey(key); return { key, config: await claudeWebConfig(root) };
}
export async function deleteClaudeWebKey(root: string): Promise<void> { await writePrivateKey(null); await writeClaudeGatewayLauncher('authless', 'x-api-key'); const store = await readConfig(root), saved = { ...(store.claudeWeb ?? {}) }; saved.mode = 'authless'; store.claudeWeb = saved; await withVaultLock(root, async () => { await atomicWrite(root, FILE, JSON.stringify({ version: 1, connectors: store }, null, 2)); await fs.chmod(await safePath(root, FILE), 0o600); }); }
export async function claudeWebProbe(root: string, resolveHost: HostResolver = resolveWithDns) { const config = await claudeWebConfig(root); if (!config.url) throw new Error('Configure a public HTTPS MCP URL first'); const started = Date.now(), result = await testConnectorConnection(config.url, false, resolveHost); return { reachable: result.statusCode >= 200 && result.statusCode < 500, statusCode: result.statusCode, latencyMs: Date.now() - started }; }
const ipv4Private = (ip: string) => { const n = ip.split('.').map(Number); return n.length !== 4 || n[0] === 10 || n[0] === 127 || n[0] === 0 || n[0] === 169 && n[1] === 254 || n[0] === 172 && n[1]! >= 16 && n[1]! <= 31 || n[0] === 192 && n[1] === 168 || n[0]! >= 224; };
const privateAddress = (ip: string) => ip.includes(':') ? isIP(ip) === 6 && (ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip) || ip.toLowerCase().startsWith('::ffff:') && ipv4Private(ip.slice(7))) : isIP(ip) === 4 && ipv4Private(ip);
export function validateConnectorTestUrl(raw: string, allowPrivate = false, allowNonstandardPort = false): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new Error('Enter a valid public HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !allowNonstandardPort && url.port && url.port !== '443') throw new Error('Connection test requires an HTTPS URL without credentials, query, or fragment');
  if (!allowPrivate && (url.hostname === 'localhost' || privateAddress(url.hostname.replace(/^\[|\]$/g, '')))) throw new Error('Private and loopback addresses are blocked; explicitly allow private address to continue');
  return url;
}
export function validateConnectorRedirect(source: URL, location: string | undefined): never {
  if (location) { let target: URL; try { target = new URL(location, source); } catch { throw new Error('Connection test rejected an invalid redirect'); } if (target.host !== source.host) throw new Error('Connection test rejected a redirect to another host'); }
  throw new Error('Connection test does not follow redirects');
}
export async function testConnectorConnection(raw: string, allowPrivate = false, resolveHost: HostResolver = resolveWithDns, headers: Record<string, string> = {}, testOptions: { ca?: string | Buffer; allowNonstandardPort?: boolean } = {}): Promise<{ statusCode: number; version: string | null }> {
  const url = validateConnectorTestUrl(raw, allowPrivate, testOptions.allowNonstandardPort), record = await resolveConnectorAddress(url, allowPrivate, resolveHost);
  const result = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
    const request = https.request(url, { method: 'GET', timeout: 5000, servername: url.hostname, ca: testOptions.ca, headers: { accept: 'application/json', ...headers }, lookup: ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) => options.all ? callback(null, [record]) : callback(null, record.address, record.family)) as never }, response => {
      if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) { response.resume(); try { validateConnectorRedirect(url, response.headers.location); } catch (error) { reject(error); } return; }
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 8192) request.destroy(new Error('Version response too large')); }); response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body }));
    });
    request.on('timeout', () => request.destroy(new Error('Connection test timed out'))); request.on('error', () => reject(new Error('Connection test failed'))); request.end();
  });
  let version: string | null = null; try { const parsed = JSON.parse(result.body); if (typeof parsed.version === 'string' && parsed.version.length <= 100) version = parsed.version; } catch { /* unrecognized response */ }
  return { statusCode: result.statusCode, version };
}
