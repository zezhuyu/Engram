import { promises as fs } from 'node:fs';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { parseStrictJson } from '../../scripts/lib/strict-json.js';
import { safePath, atomicWrite, withVaultLock } from '../storage-local/index.js';

const FILE = '.mdb/dashboard/connectors.json';
export type ConnectorName = 'openai' | 'claude';
const FIELDS: Record<ConnectorName, string[]> = { openai: ['publicUrl', 'tunnelName', 'tunnelId', 'tunnelToken', 'oauthClientId', 'oauthClientSecret'], claude: ['publicUrl', 'tunnelName', 'tunnelId', 'tunnelToken', 'oauthClientId', 'oauthClientSecret'] };
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
const ipv4Private = (ip: string) => { const n = ip.split('.').map(Number); return n.length !== 4 || n[0] === 10 || n[0] === 127 || n[0] === 0 || n[0] === 169 && n[1] === 254 || n[0] === 172 && n[1]! >= 16 && n[1]! <= 31 || n[0] === 192 && n[1] === 168 || n[0]! >= 224; };
const privateAddress = (ip: string) => ip.includes(':') ? ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip) || ip.toLowerCase().startsWith('::ffff:') && ipv4Private(ip.slice(7)) : ipv4Private(ip);
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
