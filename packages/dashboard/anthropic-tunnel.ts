import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { findExecutable } from '../models/cli.js';
import { atomicWrite, safePath, withVaultLock } from '../storage-local/index.js';

const PROXY_IMAGE = 'us-docker.pkg.dev/anthropic-public-registry/images/mcp-proxy@sha256:d243d30642d39857a0579e465cb3b9bf3ae7c1141e83143bb6856777a31467a5';
const CLOUDFLARED_IMAGE = 'cloudflare/cloudflared@sha256:0e56c13c7058fcef9c4f0e7d83372f82330548dbf8f8b366f3d8b506526d93b2';
const home = () => process.env.HOME ?? '';
export const anthropicTunnelDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'engram', 'anthropic-tunnel');
const connectorStoreFile = '.mdb/dashboard/connectors.json';
const validRoute = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const validDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function privateDir(dir: string) { return fs.mkdir(dir, { recursive: true, mode: 0o700 }).then(() => fs.chmod(dir, 0o700)); }
async function atomic(file: string, content: string, mode = 0o600) {
  await privateDir(path.dirname(file)); const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try { await fs.writeFile(temp, content, { mode, flag: 'wx' }); await fs.chmod(temp, mode); await fs.rename(temp, file); await fs.chmod(file, mode); }
  catch (error) { await fs.rm(temp, { force: true }); throw error; }
}
function validate(input: Record<string, unknown>) {
  const tunnelId = input.tunnelId ?? '', tunnelDomain = input.tunnelDomain ?? '', route = input.route ?? '', upstream = input.upstream ?? 'http://host.docker.internal:3336', listenPort = input.listenPort ?? 8080;
  if (typeof tunnelId !== 'string' || !/^tnl_[A-Za-z0-9_-]{6,120}$/.test(tunnelId)) throw new Error('Tunnel ID must use the tnl_ format');
  if (typeof tunnelDomain !== 'string' || !validDomain.test(tunnelDomain) || !tunnelDomain.toLowerCase().endsWith('.tunnel.anthropic.com')) throw new Error('Tunnel domain must be a hostname under tunnel.anthropic.com');
  if (typeof route !== 'string' || !validRoute.test(route)) throw new Error('Route must be a DNS label');
  if (typeof upstream !== 'string') throw new Error('Upstream must be a URL');
  let url: URL; try { url = new URL(upstream); } catch { throw new Error('Upstream must be scheme://host:port with no path'); }
  if (!/^https?:\/\/(?:\[[0-9a-f:]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/i.test(upstream) || !['http:', 'https:'].includes(url.protocol) || !url.hostname || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Upstream must be scheme://host:port with no path');
  if (typeof listenPort !== 'number' || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Proxy listen port must be between 1 and 65535');
  return { tunnelId, tunnelDomain: tunnelDomain.toLowerCase(), route, upstream, listenPort };
}
async function readState() {
  const file = path.join(anthropicTunnelDir(), 'anthropic-tunnel.env');
  try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('Tunnel token file must be a regular 0600 file'); const text = await fs.readFile(file, 'utf8'); const values: Record<string,string> = {}; for (const line of text.split(/\r?\n/)) { const m = /^([A-Z_]+)='([^'\n]*)'$/.exec(line); if (m) values[m[1]!] = m[2]!; } return values; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e; }
}
export async function saveAnthropicTunnel(root: string, input: Record<string, unknown>) {
  const value = validate(input), state = await readState(), token = input.token;
  if (token !== undefined) { if (token === null || token === '') delete state.ANTHROPIC_TUNNEL_TOKEN; else if (typeof token !== 'string' || token.length > 8192 || /[\r\n\0'\\]/.test(token)) throw new Error('Invalid tunnel token'); else state.ANTHROPIC_TUNNEL_TOKEN = token; }
  const dir = anthropicTunnelDir(); await privateDir(dir);
  await atomic(path.join(dir, 'anthropic-tunnel.env'), Object.entries(state).map(([k,v]) => k + "='" + v.replaceAll("'", "'\\''") + "'").join('\n') + (Object.keys(state).length ? '\n' : ''));
  await withVaultLock(root, async () => {
    let store: { version: number; connectors: Record<string, unknown> } = { version: 1, connectors: {} };
    try { const parsed = JSON.parse(await fs.readFile(await safePath(root, connectorStoreFile), 'utf8')); if (parsed?.version !== 1 || !parsed.connectors || typeof parsed.connectors !== 'object') throw new Error(); store = parsed; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Connector configuration is invalid'); }
    store.connectors.anthropicTunnel = value;
    await atomicWrite(root, connectorStoreFile, JSON.stringify(store, null, 2) + '\n');
    await fs.chmod(await safePath(root, connectorStoreFile), 0o600);
  });
  await writeConfigs(value);
  return { ...value, tokenSet: !!state.ANTHROPIC_TUNNEL_TOKEN };
}
async function writeConfigs(v: ReturnType<typeof validate>) {
  const dir = anthropicTunnelDir(); await privateDir(path.join(dir, 'data'));
  const proxy = 'listen_addr: ":' + v.listenPort + '"\ntunnel_domain: "' + v.tunnelDomain + '"\ntls:\n  cert_file: /data/tls.crt\n  key_file: /data/tls.key\nroutes:\n  ' + v.route + ': ' + v.upstream + '\n';
  const compose = 'services:\n  mcp-proxy:\n    image: ' + PROXY_IMAGE + '\n    command: ["run", "--config", "/config/proxy.yaml"]\n    volumes:\n      - ./proxy.yaml:/config/proxy.yaml:ro\n      - ./data:/data:ro\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n  cloudflared:\n    image: ' + CLOUDFLARED_IMAGE + '\n    command: ["tunnel", "--no-autoupdate", "run", "--url", "http://localhost:' + v.listenPort + '"]\n    env_file:\n      - ./anthropic-tunnel.env\n    network_mode: "service:mcp-proxy"\n    depends_on:\n      - mcp-proxy\n';
  await atomic(path.join(dir, 'proxy.yaml'), proxy); await atomic(path.join(dir, 'compose.yaml'), compose);
}
async function config(root: string) {
  try { const file = await safePath(root, connectorStoreFile), parsed = JSON.parse(await fs.readFile(file, 'utf8')); if (!parsed || parsed.version !== 1 || !parsed.connectors || typeof parsed.connectors !== 'object') throw new Error(); return parsed.connectors.anthropicTunnel ? validate(parsed.connectors.anthropicTunnel) : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Anthropic tunnel config is invalid'); }
}
async function run(executable: string, args: string[], timeout = 5000): Promise<{ code: number | null; out: string }> {
  return new Promise(resolve => { const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] }); let out = ''; const timer = setTimeout(() => { child.kill(); resolve({ code: null, out }); }, timeout); child.stdout.on('data', c => { out += String(c).slice(0, 8192); }); child.once('error', () => { clearTimeout(timer); resolve({ code: null, out }); }); child.once('exit', code => { clearTimeout(timer); resolve({ code, out }); }); });
}
async function openssl(args: string[]) { const exe = findExecutable('openssl'); if (!exe) throw new Error('openssl not found'); const result = await run(exe, args, 15000); if (result.code !== 0) throw new Error('openssl certificate operation failed'); return result.out.trim(); }
export async function generateAnthropicCertificates(root: string, rotate = false) {
  const value = await config(root); if (!value) throw new Error('Save tunnel settings first'); const dir = anthropicTunnelDir(), data = path.join(dir, 'data'); await privateDir(data);
  const files = ['ca.key', 'ca.crt', 'tls.key', 'tls.crt'].map(name => path.join(data, name));
  if (!rotate && (await Promise.all(files.map(file => fs.stat(file).then(() => true, () => false)))).some(Boolean)) throw new Error('Certificate files already exist; set rotate:true to replace them');
  const caKey = files[0]!, caCert = files[1]!, tlsKey = files[2]!, tlsCert = files[3]!, csr = path.join(data, 'tls.csr'), ext = path.join(data, 'tls.ext');
  await fs.rm(caKey, { force: true }); await fs.rm(caCert, { force: true }); await fs.rm(tlsKey, { force: true }); await fs.rm(tlsCert, { force: true });
  try {
    // Pre-create private outputs with restrictive modes so OpenSSL never
    // creates a private key under the caller's potentially permissive umask.
    await fs.writeFile(caKey, '', { mode: 0o600, flag: 'wx' });
    await fs.writeFile(tlsKey, '', { mode: 0o600, flag: 'wx' });
    await openssl(['req','-x509','-newkey','rsa:3072','-nodes','-days','3650','-subj','/CN=Engram Anthropic Tunnel CA','-keyout',caKey,'-out',caCert]); await fs.chmod(caKey,0o600);
    await openssl(['req','-new','-newkey','rsa:3072','-nodes','-subj','/CN=*.'+value.tunnelDomain,'-keyout',tlsKey,'-out',csr]); await fs.chmod(tlsKey,0o600);
    await atomic(ext, 'subjectAltName=DNS:*.' + value.tunnelDomain + ',DNS:' + value.route + '.' + value.tunnelDomain + '\nextendedKeyUsage=serverAuth\n');
    await openssl(['x509','-req','-in',csr,'-CA',caCert,'-CAkey',caKey,'-CAcreateserial','-days','825','-sha256','-extfile',ext,'-out',tlsCert]);
    const [caExpiry, tlsExpiry, ca] = await Promise.all([openssl(['x509','-in',caCert,'-noout','-enddate']), openssl(['x509','-in',tlsCert,'-noout','-enddate']), fs.readFile(caCert,'utf8')]);
    await fs.rm(csr,{force:true}); await fs.rm(ext,{force:true}); await fs.chmod(caCert,0o644); await fs.chmod(tlsCert,0o644);
    return { caCertificate: ca, caExpires: caExpiry.replace(/^notAfter=/,''), serverExpires: tlsExpiry.replace(/^notAfter=/,''), note: 'Upload only ca.crt; the private keys never leave this machine' };
  } catch (error) { await Promise.all([...files,csr,ext,path.join(data,'ca.srl')].map(file=>fs.rm(file,{force:true}))); throw error; }
}
async function fileInfo(file: string) { try { const s=await fs.lstat(file); return { present:s.isFile()&&!s.isSymbolicLink(), mode:(s.mode&0o777).toString(8).padStart(4,'0'), modeOk:!s.isSymbolicLink()&&((s.mode&0o777)===0o600||((s.mode&0o777)===0o644&&/\.(crt)$/.test(file))) }; } catch { return {present:false,mode:null,modeOk:false}; } }
export async function anthropicTunnelStatus(root: string) {
  const dir=anthropicTunnelDir(), v=await config(root), env=await readState(), docker=findExecutable('docker');
  const version=docker?await run(docker,['--version'],2000):{code:null,out:''}; const daemon=docker?await run(docker,['info','--format','{{.ServerVersion}}'],2500):{code:null,out:''};
  let containers: unknown = null; if(docker&&v) containers=await run(docker,['compose','-p','engram-anthropic-tunnel','-f',path.join(dir,'compose.yaml'),'ps','--format','json'],2500).then(r=>r.code===0?r.out.trim():null);
  const certs=Object.fromEntries(await Promise.all(['ca.key','ca.crt','tls.key','tls.crt'].map(async f=>[f,await fileInfo(path.join(dir,'data',f))])));
  let expiry: Record<string,string|null>={ca:null,server:null}; const opensslExe=findExecutable('openssl'); if(opensslExe) for(const [name,file] of [['ca','ca.crt'],['server','tls.crt']] as const) { const result=await run(opensslExe,['x509','-in',path.join(dir,'data',file),'-noout','-enddate'],2000); if(result.code===0) expiry[name]=result.out.trim().replace(/^notAfter=/,''); }
  return {config:v,tokenSet:!!env.ANTHROPIC_TUNNEL_TOKEN,configPresent:!!v,proxyPresent:await fs.stat(path.join(dir,'proxy.yaml')).then(()=>true,()=>false),composePresent:await fs.stat(path.join(dir,'compose.yaml')).then(()=>true,()=>false),docker:{found:!!docker,path:docker??null,version:version.code===0?version.out.trim():null,daemonRunning:daemon.code===0},containers,certificates:certs,expiry,upstream:{reachableFromHost:null,note:'Container reachability is separate; use the container test command.'},notVerifiedLive:'Not verified by Engram: your Anthropic account access, tunnel registration, CA acceptance, a real Managed Agents/Messages API call'};
}
export async function controlAnthropicTunnel(root: string, action:'up'|'down') {
  const dir=anthropicTunnelDir(); if(!await config(root)) throw new Error('Save tunnel settings before starting the stack'); const docker=findExecutable('docker'); if(!docker) throw new Error('Docker not found');
  const info=await run(docker,['info','--format','{{.ServerVersion}}'],2500); if(info.code!==0) throw new Error('Docker daemon is not running');
  const r=await run(docker,['compose','-p','engram-anthropic-tunnel','-f',path.join(dir,'compose.yaml'),action,...(action==='up'?['-d']:[])],120000); if(r.code!==0) throw new Error('Docker Compose '+action+' failed; inspect Docker locally (output withheld)'); return { action, completed:true };
}
