import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordCase } from '../helpers/report.js';
import { serviceDefinition } from '../../packages/adaptive/index.js';

const params = { node: '/usr/local/bin/node', script: '/opt/engram/bin/mdb.js', root: '/home/me/my vault', intervalSeconds: 300 };

test('launchd plist is well-formed (plutil -lint on macOS), runs only the explicit worker command, and escapes special characters', async t => {
  const def = serviceDefinition('launchd', { ...params, root: '/Users/me/a&b <vault>' });
  assert.match(def.filename, /\.plist$/); assert.match(def.content, /<string>schedule<\/string><string>worker<\/string>/); assert.ok(def.content.includes('a&amp;b &lt;vault&gt;'), 'XML special characters are escaped');
  assert.match(def.install, /launchctl load/); assert.match(def.install, /launchctl unload/, 'the uninstall path is printed with the install path');
  if (process.platform !== 'darwin') { t.skip('plutil exists only on macOS'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-plist-')); const file = path.join(dir, def.filename); await fs.writeFile(file, def.content);
  const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' }); await fs.rm(dir, { recursive: true, force: true });
  assert.equal(lint.status, 0, lint.stdout + lint.stderr); recordCase({ suite: 'adaptive', name: 'service-unit-launchd-lint', status: 'PASS', detail: { validator: 'plutil -lint' } });
});

test('systemd user unit has the required sections, an absolute ExecStart with quoted arguments, a restart policy, low priority, and a printed uninstall path', () => {
  const def = serviceDefinition('systemd', params); const lines = def.content.split('\n');
  for (const header of ['[Unit]', '[Service]', '[Install]']) assert.ok(lines.includes(header), header);
  const exec = lines.find(l => l.startsWith('ExecStart='))!; assert.ok(exec.startsWith('ExecStart=/usr/local/bin/node /opt/engram/bin/mdb.js --root "/home/me/my vault" intelligence schedule worker --interval-s 300'), exec);
  assert.ok(lines.includes('Restart=on-failure') && lines.includes('Nice=10') && lines.includes('WantedBy=default.target'));
  assert.match(def.install, /systemctl --user enable --now/); assert.match(def.install, /systemctl --user disable --now/);
  assert.ok(!/(^|\n)\s*(User|Group)=/.test(def.content), 'a user unit never names a user, and nothing here needs root');
  recordCase({ suite: 'adaptive', name: 'service-unit-systemd-shape', status: 'PASS', detail: { validator: 'structural (systemd-analyze is not available on this host)' } });
});

test('launchd label and log path are configurable, validated, and escaped; an invalid label is refused', () => {
  const def = serviceDefinition('launchd', { ...params, label: 'dev.engram.intelligence-worker.e2e1', logPath: '/tmp/a&b/worker.log' });
  assert.equal(def.filename, 'dev.engram.intelligence-worker.e2e1.plist'); assert.ok(def.content.includes('<key>Label</key><string>dev.engram.intelligence-worker.e2e1</string>'));
  assert.ok(def.content.includes('<key>StandardOutPath</key><string>/tmp/a&amp;b/worker.log</string>') && def.content.includes('<key>StandardErrorPath</key>'));
  assert.ok(!serviceDefinition('launchd', params).content.includes('StandardOutPath'), 'no log keys unless asked');
  assert.throws(() => serviceDefinition('launchd', { ...params, label: '../evil' }), /label may only contain/);
  recordCase({ suite: 'adaptive', name: 'service-unit-label-and-log', status: 'PASS' });
});
