import { spawn } from 'node:child_process';
import path from 'node:path';

export interface ChildResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
const vaultModule = new URL('../../packages/core/vault.js', import.meta.url).href;
export const modules = { vault: vaultModule, storage: new URL('../../packages/storage-local/index.js', import.meta.url).href, search: new URL('../../packages/search-files/index.js', import.meta.url).href };
export function runChild(code: string, env: Record<string, string> = {}): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.on('error', reject); child.on('close', (c, s) => resolve({ code: c, signal: s, stdout, stderr }));
  });
}
/** Source for a child that opens `root`, installs a fault at `stage` in `mode`, and returns after running `body`. */
export function faultPreamble(root: string, spec: { stage: string; mode: 'kill' | 'throw-eio' | 'throw-enospc' | 'none'; after?: string }): string {
  return `import {Vault} from ${JSON.stringify(vaultModule)};
let armed=${spec.after ? 'false' : 'true'};
const fault=(stage)=>{ if(stage===${JSON.stringify(spec.after ?? '')}) armed=true; if(!armed||stage!==${JSON.stringify(spec.stage)}) return; const mode=${JSON.stringify(spec.mode)};
  if(mode==='kill') process.kill(process.pid,'SIGKILL');
  if(mode==='throw-eio'){const e=new Error('injected EIO');e.code='EIO';throw e;}
  if(mode==='throw-enospc'){const e=new Error('injected ENOSPC');e.code='ENOSPC';throw e;} };
const vault=new Vault(${JSON.stringify(path.resolve(root))},undefined,{fault: ${spec.mode === 'none' ? 'undefined' : 'fault'}});`;
}
