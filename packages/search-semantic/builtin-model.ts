import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import manifest from './bge-m3-manifest.json' with { type: 'json' };

export type BuiltinFile = { name: string; bytes: number; sha256: string };
export type BuiltinManifest = { id: string; repo: string; revision: string; license: string; dimensions: number; maxTokens: number; files: BuiltinFile[] };
export const BGE_M3 = manifest as BuiltinManifest;
export type DownloadStatus = { state: 'not_installed' } | { state: 'downloading'; bytes: number; totalBytes: number; file: string } | { state: 'verifying'; file: string } | { state: 'ready'; destination: string } | { state: 'failed'; reason: string };
export interface BuiltinModelOptions { env?: NodeJS.ProcessEnv; home?: string; fetch?: typeof fetch; allowHosts?: (host: string) => boolean; downloadBaseUrl?: string; manifest?: BuiltinManifest; onProgress?: (event: { bytes: number; totalBytes: number; file: string }) => void; freeBytes?: (directory: string) => Promise<number> }
let active: { controller: AbortController; promise: Promise<string> } | undefined;
let lastStatus: DownloadStatus = { state: 'not_installed' };
function modelDirectory(options: BuiltinModelOptions = {}): string {
  const model = options.manifest ?? BGE_M3;
  const env = options.env ?? process.env; const home = options.home ?? env.HOME ?? homedir();
  if (env.ENGRAM_MODEL_CACHE) return path.resolve(env.ENGRAM_MODEL_CACHE);
  const root = process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Engram', 'models') : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'engram', 'models');
  return path.join(root, model.id, model.revision);
}
export async function previewBuiltinModel(options: BuiltinModelOptions = {}) {
  const model = options.manifest ?? BGE_M3; const destination = modelDirectory(options); const totalBytes = model.files.reduce((n, f) => n + f.bytes, 0);
  let diskFree: number | null = null; try { diskFree = await (options.freeBytes ?? defaultFreeBytes)(path.dirname(destination)); } catch { /* unknown disk capacity is disclosed */ }
  return { id: model.id, repo: model.repo, revision: model.revision, license: model.license, files: model.files.map(f => ({ ...f })), totalBytes, destination, ramWarning: 'Inference uses about 1.8 GiB RAM; first indexing is CPU intensive and can take minutes.', diskFree };
}
async function defaultFreeBytes(directory: string): Promise<number> { await mkdir(directory, { recursive: true, mode: 0o700 }); const { statfs } = await import('node:fs/promises'); const s = await statfs(directory); return Number(s.bavail) * Number(s.bsize); }
function allowed(host: string, options: BuiltinModelOptions): boolean { return options.allowHosts ? options.allowHosts(host) : host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co'); }
async function request(url: URL, headers: Record<string, string>, options: BuiltinModelOptions, redirects = 0): Promise<Response> {
  if (url.protocol !== 'https:' && !(options.allowHosts && url.protocol === 'http:')) throw new Error('Model download requires verified HTTPS');
  if (!allowed(url.hostname, options)) throw new Error('Model download redirected to a disallowed host');
  if (redirects > 5) throw new Error('Too many model download redirects');
  const res = await (options.fetch ?? fetch)(url, { headers, redirect: 'manual', signal: active?.controller.signal });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const loc = res.headers.get('location'); await res.body?.cancel(); if (!loc) throw new Error('Invalid model download redirect');
    return request(new URL(loc, url), headers, options, redirects + 1);
  }
  return res;
}
async function verifyFile(filePath: string, file: BuiltinFile): Promise<boolean> {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) return false;
  const h = createHash('sha256'); let bytes = 0; for await (const chunk of createReadStream(filePath)) { h.update(chunk); bytes += chunk.length; }
  return bytes === file.bytes && h.digest('hex') === file.sha256;
}
async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new Error('Model cache directory is unsafe');
  await chmod(directory, 0o700);
}
export async function startDownload(options: BuiltinModelOptions = {}): Promise<string> {
  if (active) throw new Error('A built-in model download is already running');
  const model = options.manifest ?? BGE_M3;
  const controller = new AbortController(); const operation = (async () => {
    const preview = await previewBuiltinModel(options); const available = await (options.freeBytes ?? defaultFreeBytes)(path.dirname(preview.destination));
    if (available < preview.totalBytes) throw new Error('Not enough free disk space for the built-in model');
    await privateDirectory(preview.destination);
    for (const file of model.files) {
      const finalPath = path.join(preview.destination, file.name); const partPath = `${finalPath}.part`;
      await privateDirectory(path.dirname(finalPath));
      try { if (await verifyFile(finalPath, file)) continue; else await rm(finalPath, { force: true }); } catch { /* fetch below */ }
      let offset = 0; try { const partInfo = await lstat(partPath); if (!partInfo.isFile() || partInfo.isSymbolicLink()) throw new Error('Model partial file is unsafe'); await chmod(partPath, 0o600); offset = partInfo.size; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { /* fresh file */ } else throw error; }
      if (offset > file.bytes) { await rm(partPath, { force: true }); offset = 0; }
      const url = new URL(`${options.downloadBaseUrl ?? 'https://huggingface.co'}/${model.repo}/resolve/${model.revision}/${file.name}`);
      lastStatus = { state: 'downloading', bytes: offset, totalBytes: file.bytes, file: file.name };
      const res = await request(url, offset ? { range: `bytes=${offset}-` } : {}, options);
      if (!res.ok || !res.body) throw new Error(`Model download failed (HTTP ${res.status})`);
      if (offset && res.status !== 206) { await res.body.cancel(); await rm(partPath, { force: true }); offset = 0; throw new Error('Model server did not honor resume request; retry the download'); }
      const writer = createWriteStream(partPath, { flags: offset ? 'a' : 'w', mode: 0o600 }); let received = offset;
      const reader = res.body.getReader(); try { for (;;) { if (controller.signal.aborted) throw new Error('Model download cancelled'); const chunk = await reader.read(); if (chunk.done) break; received += chunk.value.length; if (received > file.bytes) throw new Error('Downloaded model file exceeded its pinned size'); if (!writer.write(chunk.value)) await new Promise<void>(resolve => writer.once('drain', resolve)); lastStatus = { state: 'downloading', bytes: received, totalBytes: file.bytes, file: file.name }; options.onProgress?.({ bytes: received, totalBytes: file.bytes, file: file.name }); } } finally { writer.end(); await new Promise<void>(resolve => writer.once('close', resolve)); }
      lastStatus = { state: 'verifying', file: file.name };
      if (!await verifyFile(partPath, file)) { await rm(partPath, { force: true }); throw new Error(`SHA-256 verification failed for ${file.name}`); }
      await rename(partPath, finalPath); const handle = await open(finalPath, 'r'); try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
    }
    lastStatus = { state: 'ready', destination: preview.destination }; return preview.destination;
  })();
  active = { controller, promise: operation };
  try { return await operation; } catch (e) { if (controller.signal.aborted) { lastStatus = { state: 'failed', reason: 'Download cancelled' }; throw new Error('Model download cancelled'); } lastStatus = { state: 'failed', reason: (e as Error).message }; throw e; } finally { active = undefined; }
}
export function cancelDownload(): boolean { if (!active) return false; active.controller.abort(); return true; }
export async function builtinModelStatus(options: BuiltinModelOptions = {}): Promise<DownloadStatus> {
  if (active) return lastStatus;
  if (lastStatus.state === 'failed') return lastStatus;
  const destination = modelDirectory(options);
  for (const f of (options.manifest ?? BGE_M3).files) if (!await verifyFile(path.join(destination, f.name), f).catch(() => false)) return { state: 'not_installed' };
  lastStatus = { state: 'ready', destination }; return lastStatus;
}
export async function removeBuiltinModel(options: BuiltinModelOptions = {}): Promise<void> {
  if (active) throw new Error('Cannot remove the built-in model while a download is running');
  await rm(modelDirectory(options), { recursive: true, force: true }); lastStatus = { state: 'not_installed' };
}
