#!/usr/bin/env node
// Assemble Linux daemon bundles from the existing standalone runtime.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workerLauncher } from './package-macos.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function packageLinuxBundles(destination, backend) {
  const output = resolve(destination);
  for (const role of ['client', 'server']) {
    const bundle = join(output, `engram-${role}`);
    await mkdir(bundle, { recursive: true });
    await cp(resolve(backend), join(bundle, 'backend'), { recursive: true });
    await writeFile(join(bundle, `engram-${role}`), workerLauncher(role, 'linux'), { mode: 0o755 });
    await cp(join(root, 'scripts/install-linux-service.mjs'), join(bundle, 'install-service.mjs'));
    await cp(join(root, 'linux/README.md'), join(bundle, 'README.md'));
    await writeFile(join(bundle, 'role.json'), JSON.stringify({ role }) + '\n');
  }
  console.log(`Created Linux client and server bundles in ${output}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (platform() !== 'linux') throw new Error('Build production Linux bundles on Linux');
  const destination = process.argv[2] ?? 'dist-linux';
  let backend = process.argv[3];
  if (!backend) {
    const result = spawnSync(process.execPath, [join(root, 'scripts/standalone.mjs'), 'package', 'linux', arch()], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Standalone packaging failed');
    backend = join(root, 'dist-standalone', `engram-linux-${arch()}`);
  }
  await packageLinuxBundles(destination, backend);
}
