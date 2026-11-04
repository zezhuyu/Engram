import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dashboardAuthFile } from './password.js';
import { remoteUrlAllowed } from '../core/private-network.js';

export type ConnectionMode = 'admin' | 'view';
export type DashboardConnection = { id: string; name: string; url: string; credentialFile: string; mode: ConnectionMode; createdAt: string; lastSuccessAt?: string };
type Store = { version: 1; connections: DashboardConnection[] };
const fileFor = (root: string) => path.join(path.dirname(dashboardAuthFile(root)), 'connections.json');
async function read(root: string): Promise<Store> {
  try { const value = JSON.parse(await fs.readFile(fileFor(root), 'utf8')) as Store; if (value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 32 || value.connections.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.url !== 'string' || typeof c.credentialFile !== 'string' || !['admin','view'].includes(c.mode))) throw new Error(); return value; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, connections: [] }; throw new Error('Dashboard connections file is invalid'); }
}
async function write(root: string, store: Store) { const file=fileFor(root), dir=path.dirname(file); await fs.mkdir(dir,{recursive:true,mode:0o700}); await fs.chmod(dir,0o700); const tmp=`${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`; try { await fs.writeFile(tmp,JSON.stringify(store,null,2)+'\n',{mode:0o600,flag:'wx'}); await fs.rename(tmp,file); await fs.chmod(file,0o600); } finally { await fs.rm(tmp,{force:true}); } }
export async function listConnections(root: string) { return (await read(root)).connections; }
export async function saveConnection(root: string, input: { id?: string; name: string; url: string; credentialFile: string; mode: ConnectionMode }) {
  const name=input.name.trim(); let url: URL; try { url=new URL(input.url); } catch { throw new Error('Enter a valid server URL'); }
  if (!name || name.length>80 || !['admin','view'].includes(input.mode) || url.username || url.password || url.search || url.hash || !remoteUrlAllowed(url)) throw new Error('Connection needs a name, HTTP(S) trusted URL, credential file and mode');
  url.pathname=url.pathname.replace(/\/$/,''); const store=await read(root), id=input.id ?? `conn_${randomBytes(9).toString('hex')}`, prior=store.connections.findIndex(item=>item.id===id);
  const item: DashboardConnection={id,name,url:url.toString(),credentialFile:path.resolve(input.credentialFile),mode:input.mode,createdAt:prior>=0?store.connections[prior]!.createdAt:new Date().toISOString()};
  if(prior>=0)store.connections[prior]=item;else { if(store.connections.length>=32)throw new Error('Connection limit reached'); store.connections.push(item); } await write(root,store); return item;
}
export async function removeConnection(root:string,id:string){const store=await read(root),before=store.connections.length;store.connections=store.connections.filter(c=>c.id!==id);if(before!==store.connections.length)await write(root,store);return before!==store.connections.length;}
export async function connectionSecret(root:string,id:string){const connection=(await read(root)).connections.find(c=>c.id===id);if(!connection)throw new Error('Connection not found');const info=await fs.stat(connection.credentialFile);if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('Credential file must be a private 0600 file');const token=(await fs.readFile(connection.credentialFile,'utf8')).trim();if(!token||token.length>4096)throw new Error('Credential file is empty or invalid');return {connection,token};}
export async function markConnectionSuccess(root:string,id:string){const store=await read(root),item=store.connections.find(c=>c.id===id);if(item){item.lastSuccessAt=new Date().toISOString();await write(root,store);}}
