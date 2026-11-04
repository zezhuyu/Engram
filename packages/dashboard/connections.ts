import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dashboardAuthFile } from './password.js';
import { remoteUrlAllowed } from '../core/private-network.js';
import { parseStrictJson } from '../../scripts/lib/strict-json.js';

export type ConnectionMode = 'admin' | 'view';
export type DashboardConnection = { id: string; name: string; url: string; credentialFile: string; mode: ConnectionMode; createdAt: string; lastSuccessAt?: string };
type Store = { version: 1; connections: DashboardConnection[] };
const fileFor = (root: string) => path.join(path.dirname(dashboardAuthFile(root)), 'connections.json');
async function read(root: string): Promise<Store> {
  try { const value = parseStrictJson(await fs.readFile(fileFor(root), 'utf8'), 'Dashboard connections') as Store; if (value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 32 || value.connections.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.url !== 'string' || typeof c.credentialFile !== 'string' || !['admin','view'].includes(c.mode))) throw new Error(); return value; }
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
export async function connectionSecret(root:string,id:string,beforeOpen?:()=>Promise<void>){
  const connection=(await read(root)).connections.find(c=>c.id===id); if(!connection) throw new Error('Connection not found');
  try {
    const file=path.resolve(connection.credentialFile), parent=await fs.realpath(path.dirname(file)), canonical=path.join(parent,path.basename(file)), normalized=canonical.toLowerCase();
    if(['/proc/','/dev/','/sys/'].some(prefix=>normalized.startsWith(prefix)) || canonical=== '/proc' || canonical==='/dev' || canonical==='/sys') throw new Error();
    const real=await fs.realpath(file); if(real!==canonical) throw new Error();
    await beforeOpen?.();
    const handle=await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info=await handle.stat(); if(!info.isFile() || (process.getuid && info.uid!==process.getuid()) || ![0o600,0o400].includes(info.mode&0o777) || info.size<1 || info.size>4096) throw new Error();
      const bytes=Buffer.alloc(4097); let size=0;
      while(size<bytes.length) { const {bytesRead}=await handle.read(bytes,size,bytes.length-size,size); if(!bytesRead) break; size+=bytesRead; }
      if(size<1 || size>4096) throw new Error(); const token=bytes.subarray(0,size).toString('utf8').trim(); if(!token) throw new Error(); return {connection,token};
    }
    finally { await handle.close(); }
  } catch { throw new Error('Credential file is invalid or unavailable'); }
}
export async function markConnectionSuccess(root:string,id:string){const store=await read(root),item=store.connections.find(c=>c.id===id);if(item){item.lastSuccessAt=new Date().toISOString();await write(root,store);}}
