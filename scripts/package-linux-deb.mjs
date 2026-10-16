#!/usr/bin/env node
// Assemble a directly installable Debian package around an existing Linux role bundle.
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const roles = ['client', 'server'];

export async function createDebRoot({ destination, bundle, role, version, architecture = 'amd64' }) {
  if (!roles.includes(role)) throw new Error('Unknown app role');
  if (!/^\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.+~]+)?$/.test(version)) throw new Error('Invalid Debian package version');
  if (!['amd64', 'arm64'].includes(architecture)) throw new Error('Unsupported Debian architecture');
  const root = resolve(destination);
  const installDir = join(root, 'opt', `engram-${role}`);
  await mkdir(installDir, { recursive: true });
  await cp(resolve(bundle), installDir, { recursive: true, verbatimSymlinks: true });
  const packageName = `engram-${role}`;
  await mkdir(join(root, 'DEBIAN'), { recursive: true });
  await writeFile(join(root, 'DEBIAN/control'), [
    `Package: ${packageName}`,
    `Version: ${version}`,
    `Section: utils`,
    `Priority: optional`,
    `Architecture: ${architecture}`,
    `Maintainer: Engram maintainers`,
    `Depends: libc6 (>= 2.35)`,
    `Description: Engram ${role} standalone application and service bundle`,
    ' Includes a private Node runtime and the Engram service installer.',
    '',
  ].join('\n'));
  await mkdir(join(root, 'usr', 'bin'), { recursive: true });
  const appCommand = join(root, 'usr', 'bin', `engram-${role}`);
  await writeFile(appCommand, `#!/bin/sh\nexec /opt/${packageName}/${packageName} "$@"\n`);
  await chmod(appCommand, 0o755);
  const serviceCommand = join(root, 'usr', 'bin', `engram-${role}-service`);
  await writeFile(serviceCommand, `#!/bin/sh\nexec /opt/engram-${role}/backend/runtime/bin/node /opt/engram-${role}/install-service.mjs "$@"\n`);
  await chmod(serviceCommand, 0o755);
  const readme = await readFile(join(resolve(bundle), 'README.md'), 'utf8');
  await mkdir(join(root, 'usr', 'share', 'doc', packageName), { recursive: true });
  await writeFile(join(root, 'usr', 'share', 'doc', packageName, 'README.md'), readme);
  return { root, packageName };
}

export async function buildDeb({ destination, bundle, role, version, architecture = 'amd64' }) {
  const output = resolve(destination);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), 'engram-deb-'));
  try {
    const { root, packageName } = await createDebRoot({ destination: join(temporary, 'root'), bundle, role, version, architecture });
    const file = join(output, `${packageName}_${version}_${architecture}.deb`);
    const result = spawnSync('dpkg-deb', ['--build', '--root-owner-group', root, file], { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`dpkg-deb exited with status ${result.status}`);
    return file;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [bundle, destination = 'release', role] = process.argv.slice(2);
  if (!bundle || !roles.includes(role)) throw new Error('Usage: node scripts/package-linux-deb.mjs BUNDLE DESTINATION client|server');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const version = `${metadata.version}-ci.${(process.env.GITHUB_SHA ?? 'local').slice(0, 12)}`;
  const architecture = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!architecture) throw new Error(`Unsupported Linux architecture: ${process.arch}`);
  console.log(`Created ${await buildDeb({ destination, bundle, role, version, architecture })}`);
}
