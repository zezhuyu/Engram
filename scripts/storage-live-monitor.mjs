#!/usr/bin/env node
/** Opt-in metadata-only monitor for one isolated command/process group. */
import { spawn, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;
const LOG_LIMIT = 8 * 1024 * 1024;
const TOTAL_LOG_LIMIT = 32 * 1024 * 1024;
const MAX_WALK_ENTRIES = 50_000;
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const MAX_AGGREGATE_GROWTH_BYTES = 2 * GIB;
const APPROVED_DU_EXCLUSION = '/private/tmp/devio_semaphore_USB_Receiver@08330000';
const help = `Usage:
  node scripts/storage-live-monitor.mjs --test-root DIR --diag-dir DIR --approved-budget-gib N --min-free-gib N [options] -- COMMAND [ARGS...]

The test root must already exist; diag-dir must be a new child. Supply --data-root or --watch explicitly.
The workload runs in --cwd DIR, or --test-root by default. Defaults: sample=3s, du=30s.
The wrapped command gets a dedicated process group. Safety limits are sampled, not hard filesystem quotas.
This tool does not create the approved root, alter environment variables, or delete artifacts.
`;

function parseArgs(argv) {
  const opts = { watches: [], intervalSeconds: 3, duIntervalSeconds: 30 };
  let i = 0;
  while (i < argv.length && argv[i] !== '--') {
    const arg = argv[i++];
    if (arg === '--help' || arg === '-h') { process.stdout.write(help); process.exit(0); }
    const key = arg?.startsWith('--') ? arg.slice(2) : '';
    if (!key) throw new Error(`Unexpected option: ${arg}`);
    const value = argv[i++];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    if (key === 'watch') opts.watches.push(path.resolve(value));
    else if (['test-root', 'diag-dir', 'data-root', 'run-id', 'scenario', 'cwd'].includes(key)) opts[key.replaceAll('-', '')] = value;
    else if (['approved-budget-gib', 'min-free-gib', 'interval-seconds', 'du-interval-seconds', 'campaign-baseline-used-bytes', 'prior-aggregate-growth-bytes'].includes(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric value for --${key}`);
      opts[key.replaceAll('-', '')] = n;
    } else throw new Error(`Unknown option: --${key}`);
  }
  if (argv[i] !== '--') throw new Error('Separate options from the command with --');
  opts.command = argv.slice(i + 1);
  return opts;
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function normalizeRoots(paths) {
  const unique = [...new Set(paths.map(p => path.resolve(p)))].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return unique.filter((p, i) => !unique.slice(0, i).some(parent => within(parent, p)));
}
function redact(value) {
  return String(value)
    .replace(/((?:--)?(?:token|secret|password|passwd|api[-_]?key|authorization|credential|private[-_]?key)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/((?:--)?(?:prompt|message|query|input|text|body|title|claim|span|note|document)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[REDACTED]@')
    .replace(/((?:^|\s)(?:-e|--eval)\s+)(?:(?:"[^"]*")|(?:'[^']*')|[^\s]+)/gi, '$1[REDACTED]');
}

async function runFile(command, args, timeoutMs = 15_000) {
  try {
    const result = await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { ok: false, exitCode: typeof error.code === 'number' ? error.code : null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error: error.code ?? error.message };
  }
}

export async function diskSnapshot(paths) {
  const devices = new Map();
  const errors = [];
  for (const p of [...new Set(paths)]) {
    const result = await runFile('/bin/df', ['-Pk', p]);
    const lines = result.stdout.trim().split('\n');
    const line = lines.length > 1 ? lines.at(-1).trim() : '';
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!result.ok || !match) { errors.push({ path: p, error: result.error ?? 'could not parse df output' }); continue; }
    devices.set(match[1], { device: match[1], totalBytes: Number(match[2]) * 1024, usedBytes: Number(match[3]) * 1024, availableBytes: Number(match[4]) * 1024, mount: match[6] });
  }
  return { devices: [...devices.values()], errors, complete: errors.length === 0 && devices.size > 0 };
}

export async function duSnapshot(paths) {
  const directories = {};
  const errors = [];
  const excludedPaths = [];
  for (const p of normalizeRoots(paths)) {
    let totalKb = 0;
    const excludedHere = [];
    const failures = [];
    if (p === '/private/tmp') {
      let names;
      try { names = await fs.readdir(p); }
      catch (error) { const item = { path: p, error: error.code ?? error.message }; errors.push(item); directories[p] = { complete: false, usable: false, error: item.error }; continue; }
      if (names.includes(path.basename(APPROVED_DU_EXCLUSION))) {
        let stat;
        try { stat = await fs.lstat(APPROVED_DU_EXCLUSION); }
        catch (error) { const item = { path: APPROVED_DU_EXCLUSION, error: error.code ?? error.message }; errors.push(item); directories[p] = { complete: false, usable: false, error: item.error }; continue; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          const item = { path: APPROVED_DU_EXCLUSION, error: 'approved exclusion changed type; expected a real directory' };
          errors.push(item); directories[p] = { complete: false, usable: false, error: item.error }; continue;
        }
        excludedHere.push({ path: APPROVED_DU_EXCLUSION, reason: 'OS permission denied during du; exact-path exclusion owner-authorized', kind: 'directory',
          notTraversed: true, matchesEngramTempPrefix: /^(?:engram|mdb)[._-]/i.test(path.basename(APPROVED_DU_EXCLUSION)),
          coverage: 'contents not measured by du; this exact name is not selected by Engram/MDB temp discovery; filesystem-wide df remains active' });
      }
      // Enumerate only the immediate children. The one approved path is skipped
      // by exact string equality before du is invoked; all other failures remain fatal.
      for (const name of names) {
        const childPath = path.join(p, name);
        if (childPath === APPROVED_DU_EXCLUSION) continue;
        const result = await runFile('/usr/bin/du', ['-x', '-k', '-s', childPath], 30_000);
        const match = /^(\d+)\s+(.+)$/.exec(result.stdout.trim().split('\n').at(-1) ?? '');
        if (!result.ok || !match) failures.push({ path: childPath, error: result.stderr.trim() || result.error || 'could not parse du output' });
        else totalKb += Number(match[1]);
      }
    } else {
      const result = await runFile('/usr/bin/du', ['-x', '-k', '-s', p], 30_000);
      const match = /^(\d+)\s+(.+)$/.exec(result.stdout.trim().split('\n').at(-1) ?? '');
      if (!result.ok || !match) failures.push({ path: p, error: result.stderr.trim() || result.error || 'could not parse du output' });
      else totalKb = Number(match[1]);
    }
    if (failures.length) {
      errors.push(...failures);
      directories[p] = { duAllocatedBytes: totalKb * 1024, complete: false, usable: false, errors: failures, excludedPaths: excludedHere };
      continue;
    }
    excludedPaths.push(...excludedHere);
    directories[p] = { duAllocatedBytes: totalKb * 1024, complete: excludedHere.length === 0, usable: true, excludedPaths: excludedHere };
  }
  return { directories, errors, excludedPaths, usable: errors.length === 0,
    complete: errors.length === 0 && excludedPaths.length === 0,
    coverage: excludedPaths.length ? 'PARTIAL_EXACT_PATH_EXCLUSION' : errors.length ? 'INCOMPLETE' : 'COMPLETE' };
}

export async function fileSnapshot(roots, maxEntries = MAX_WALK_ENTRIES) {
  const files = new Map();
  const errors = [];
  let visited = 0;
  let truncated = false;
  const symlinksSkipped = [];
  const walk = async root => {
    let rootDevice;
    try { rootDevice = (await fs.lstat(root)).dev; }
    catch (error) { errors.push({ path: root, error: error.code ?? error.message }); return; }
    const stack = [root];
    while (stack.length && visited < maxEntries) {
      const dir = stack.pop();
      let handle;
      try { handle = await fs.opendir(dir); }
      catch (error) { errors.push({ path: dir, error: error.code ?? error.message }); continue; }
      try {
        for await (const entry of handle) {
          if (++visited > maxEntries) { truncated = true; break; }
          const full = path.join(dir, entry.name);
          try {
            const stat = await fs.lstat(full);
            if (stat.isSymbolicLink()) { symlinksSkipped.push(full); continue; }
            if (stat.dev !== rootDevice) { errors.push({ path: full, error: 'nested filesystem device is not independently sampled' }); continue; }
            if (stat.isDirectory()) stack.push(full);
            else if (stat.isFile()) files.set(full, {
              path: full, logicalBytes: stat.size, allocatedBytes: Number(stat.blocks ?? 0) * 512,
              device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs,
            });
          } catch (error) { errors.push({ path: full, error: error.code ?? error.message }); }
        }
      } catch (error) { errors.push({ path: dir, error: error.code ?? error.message }); }
    }
  };
  for (const root of normalizeRoots(roots)) {
    if (visited >= maxEntries) { truncated = true; break; }
    await walk(root);
  }
  return { files, visited, truncated, errors, symlinksSkipped, complete: !truncated && errors.length === 0 && symlinksSkipped.length === 0 };
}

function inventoryTotals(inventory) {
  let logicalBytes = 0;
  const allocatedInodes = new Set();
  let allocatedBytes = 0;
  for (const file of inventory.files.values()) {
    logicalBytes += file.logicalBytes;
    const identity = `${file.device}:${file.inode}`;
    if (!allocatedInodes.has(identity)) { allocatedInodes.add(identity); allocatedBytes += file.allocatedBytes; }
  }
  return { logicalBytes, allocatedBytes };
}
export function logicalGrowth(before, after) {
  return inventoryTotals(after).logicalBytes - inventoryTotals(before).logicalBytes;
}
export function allocatedFileGrowth(before, after) {
  return inventoryTotals(after).allocatedBytes - inventoryTotals(before).allocatedBytes;
}
export function allocatedFilePositiveGrowth(before, after) {
  const totals = inventory => {
    const byInode = new Map();
    for (const file of inventory.files.values()) {
      const key = `${file.device}:${file.inode}`;
      byInode.set(key, Math.max(byInode.get(key) ?? 0, file.allocatedBytes));
    }
    return byInode;
  };
  const previous = totals(before); const current = totals(after);
  let positive = 0;
  for (const [identity, bytes] of current) positive += Math.max(0, bytes - (previous.get(identity) ?? 0));
  return positive;
}
export function fileChanges(before, after, excludePaths = []) {
  const changes = [];
  const excluded = name => excludePaths.some(root => within(path.resolve(root), path.resolve(name)));
  for (const [name, prior] of before.files) {
    if (excluded(name)) continue;
    const current = after.files.get(name);
    if (!current) { changes.push({ type: 'deleted', path: name, previousLogicalBytes: prior.logicalBytes, previousAllocatedBytes: prior.allocatedBytes, device: prior.device, inode: prior.inode, mtimeMs: prior.mtimeMs }); continue; }
    if (prior.device !== current.device || prior.inode !== current.inode) {
      changes.push({ type: 'replaced', ...current, previousLogicalBytes: prior.logicalBytes, previousAllocatedBytes: prior.allocatedBytes });
    } else if (current.logicalBytes !== prior.logicalBytes || current.allocatedBytes !== prior.allocatedBytes) {
      changes.push({ type: current.logicalBytes > prior.logicalBytes ? 'grew' : current.logicalBytes < prior.logicalBytes ? 'shrank' : 'allocation_changed', ...current, previousLogicalBytes: prior.logicalBytes, previousAllocatedBytes: prior.allocatedBytes });
    } else if (current.mtimeMs !== prior.mtimeMs) changes.push({ type: 'modified_same_size', ...current });
  }
  for (const [name, current] of after.files) if (!before.files.has(name) && !excluded(name)) changes.push({ type: 'created', ...current });
  return changes;
}

export function parseLsofFiles(stdout) {
  const files = [];
  let current;
  const save = () => { if (current?.name?.startsWith('/')) files.push({ ...current, writable: /[wu]/.test(current.accessMode ?? '') }); };
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const field = line[0]; const value = line.slice(1);
    if (field === 'p') continue;
    if (field === 'f') { save(); current = { fd: value.trim() }; }
    else if (current && field === 'a') current.accessMode = value.trim();
    else if (current && field === 't') current.type = value.trim();
    else if (current && field === 'n') current.name = value;
  }
  save();
  return files;
}

export function classifyOpenPath(name, scopes) {
  const absolute = path.resolve(name);
  if (scopes.dataRoots?.some(root => within(root, absolute))) return 'CONFIGURED_DATA_ROOT';
  if (scopes.configuredSideRoots?.some(root => within(root, absolute))) return 'CONFIGURED_ENGRAM_SIDE_STORAGE';
  if (scopes.configuredTempRoots?.some(root => within(root, absolute))) return 'CONFIGURED_ENGRAM_TEMP';
  const matchingTempRoot = scopes.tempRoots?.find(root => within(root, absolute));
  if (matchingTempRoot) {
    const firstComponent = path.relative(matchingTempRoot, absolute).split(path.sep)[0];
    return /^(?:engram|mdb)[._-]/i.test(firstComponent) ? 'ENGRAM_TEMP' : 'SYSTEM_TEMP';
  }
  if (scopes.legacyRoots?.some(root => within(root, absolute))) return 'LEGACY_HOME_XDG';
  if (scopes.testRoot && within(scopes.testRoot, absolute)) return 'DISPOSABLE_RUN_ROOT';
  return 'OUTSIDE_APPROVED_ROOTS';
}
export function duAllocatedGrowth(before, after, roots) {
  let bytes = 0;
  for (const root of normalizeRoots(roots)) {
    const beforeDir = before.directories[root]; const afterDir = after.directories[root];
    if (!beforeDir?.usable || !afterDir?.usable) return { complete: false, usable: false, bytes: null, error: `incomplete du baseline or sample for ${root}` };
    bytes += afterDir.duAllocatedBytes - beforeDir.duAllocatedBytes;
  }
  const excludedPaths = [...(before.excludedPaths ?? []), ...(after.excludedPaths ?? [])];
  return { complete: before.complete && after.complete, usable: true, bytes, excludedPaths,
    coverage: excludedPaths.length ? 'PARTIAL_EXACT_PATH_EXCLUSION' : 'COMPLETE' };
}
export function filesystemGrowth(before, after) {
  const beforeByDevice = new Map(before.devices.map(d => [d.device, d]));
  let netBytes = 0; let positiveGrowthBytes = 0;
  for (const current of after.devices) {
    const prior = beforeByDevice.get(current.device);
    if (!prior) return { complete: false, netBytes: null, positiveGrowthBytes: null, error: `device missing from baseline: ${current.device}` };
    const delta = current.usedBytes - prior.usedBytes;
    netBytes += delta;
    positiveGrowthBytes += Math.max(0, delta);
  }
  if (!before.complete || !after.complete || after.devices.length !== before.devices.length) return { complete: false, netBytes, positiveGrowthBytes, error: 'df snapshot incomplete or device set changed' };
  return { complete: true, netBytes, positiveGrowthBytes };
}
export function aggregateCampaignGrowth(priorBytes, baselineUsedBytes, currentUsedBytes) {
  return priorBytes + Math.max(0, currentUsedBytes - baselineUsedBytes);
}

async function tempNames(tempRoots) {
  // Inspect matching top-level entries only. Recursively walking every legacy
  // engram*/mdb* directory under system temp both touches unrelated old test
  // artifacts and makes a single symlink render the whole baseline unusable.
  // New directories created by the wrapped workload are recursively watched
  // after discovery; pre-existing entries are metadata-only sentinels.
  const directories = new Map(); const entries = new Map(); const errors = [];
  let visited = 0; let truncated = false;
  for (const root of tempRoots) {
    let handle;
    try { handle = await fs.opendir(root); }
    catch (error) { errors.push({ path: root, error: error.code ?? error.message }); continue; }
    try {
      for await (const entry of handle) {
        if (++visited > MAX_WALK_ENTRIES) { truncated = true; break; }
        if (!/^(?:engram|mdb)[._-]/i.test(entry.name)) continue;
        const full = path.join(root, entry.name);
        try {
          const stat = await fs.lstat(full);
          const item = { path: full, device: stat.dev, inode: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
            birthtimeMs: stat.birthtimeMs, logicalBytes: stat.isFile() ? stat.size : null,
            allocatedBytes: stat.isFile() ? Number(stat.blocks ?? 0) * 512 : null,
            kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' };
          entries.set(full, item);
          if (item.kind === 'directory') directories.set(full, item);
        } catch (error) { errors.push({ path: full, error: error.code ?? error.message }); }
      }
    } catch (error) { errors.push({ path: root, error: error.code ?? error.message }); }
  }
  return { directories, entries, errors, visited, truncated, complete: errors.length === 0 && !truncated };
}
function tempEntryChanges(before, after) {
  const changes = [];
  for (const [name, prior] of before.entries) {
    const current = after.entries.get(name);
    if (!current) { changes.push({ type: 'deleted', path: name, previous: prior }); continue; }
    if (prior.device !== current.device || prior.inode !== current.inode) { changes.push({ type: 'replaced', path: name, previous: prior, current }); continue; }
    if (prior.logicalBytes !== current.logicalBytes || prior.allocatedBytes !== current.allocatedBytes || prior.mtimeMs !== current.mtimeMs) changes.push({ type: 'modified', path: name, previous: prior, current });
  }
  for (const [name, current] of after.entries) if (!before.entries.has(name)) changes.push({ type: 'created', path: name, current });
  return changes;
}
async function processTable() {
  const result = await runFile('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command=']);
  if (!result.ok) return { rows: [], complete: false, error: result.error ?? result.stderr.trim() };
  const rows = result.stdout.split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/.exec(line);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].trim(), command: redact(match[5].trim()) } : undefined;
  }).filter(Boolean);
  return { rows, complete: rows.length > 0 };
}
function descendantRows(rootPid, rows) {
  const selected = new Set([rootPid]); let changed = true;
  while (changed) { changed = false; for (const row of rows) if (selected.has(row.ppid) && !selected.has(row.pid)) { selected.add(row.pid); changed = true; } }
  return rows.filter(row => selected.has(row.pid));
}
async function processSnapshot(groupId, rootPid, scopes, knownIdentities = []) {
  const table = await processTable();
  if (!table.complete) return { complete: false, error: table.error ?? 'empty or unreadable ps output', groupId, processes: [], escapedDescendants: [] };
  const descendants = descendantRows(rootPid, table.rows);
  const identities = new Set(knownIdentities.map(p => `${p.pid}:${p.started}`));
  for (const row of descendants) identities.add(`${row.pid}:${row.started}`);
  const knownRows = table.rows.filter(row => identities.has(`${row.pid}:${row.started}`));
  const groupRows = table.rows.filter(row => row.pgid === groupId);
  const sampleRows = [...new Map([...groupRows, ...knownRows].map(row => [`${row.pid}:${row.started}`, row])).values()];
  const processes = [];
  let activityComplete = true;
  if (sampleRows.length > 128) return { complete: false, activityComplete: false, error: `owned process sample exceeded 128 processes (${sampleRows.length})`, groupId, processes, escapedDescendants: [] };
  for (const row of sampleRows) {
    const openResult = await runFile('/usr/sbin/lsof', ['-n', '-P', '-p', String(row.pid), '-Fpanft'], 3000);
    if (!openResult.ok) {
      const check = await processTable();
      if (check.complete && !check.rows.some(p => p.pid === row.pid && p.started === row.started)) continue;
      activityComplete = false;
      processes.push({ pid: row.pid, ppid: row.ppid, pgid: row.pgid, executableCommand: row.command, started: row.started, openReferences: [], openReferenceError: openResult.error ?? openResult.stderr.trim() });
      continue;
    }
    const parsed = parseLsofFiles(openResult.stdout);
    const openReferencesTruncated = parsed.length > 200;
    if (openReferencesTruncated) activityComplete = false;
    const openReferences = parsed.slice(0, 200).map(file => ({ fd: file.fd, accessMode: file.accessMode ?? null, writable: file.writable,
      type: file.type ?? null, path: redact(file.name), classification: classifyOpenPath(file.name, scopes) }));
    if (openReferences.some(file => file.type === 'REG' && file.accessMode === null)) activityComplete = false;
    const cwd = openReferences.find(file => file.type === 'DIR' && file.fd === 'cwd')?.path;
    processes.push({ pid: row.pid, ppid: row.ppid, pgid: row.pgid, executableCommand: row.command, started: row.started,
      ...(cwd ? { cwd } : {}), openReferences, openReferencesTruncated });
  }
  const escapedDescendants = knownRows.filter(row => row.pgid !== groupId).map(({ pid, ppid, pgid, started, command }) => ({ pid, ppid, pgid, started, executableCommand: command }));
  const group = table.rows.filter(row => row.pgid === groupId).map(({ pid, ppid, started, command }) => ({ pid, ppid, started, executableCommand: command }));
  return { complete: true, activityComplete, groupId, group, processes,
    writableReferences: processes.flatMap(proc => proc.openReferences.filter(file => file.writable).map(file => ({ pid: proc.pid, ppid: proc.ppid, pgid: proc.pgid, started: proc.started, executableCommand: proc.executableCommand, ...file }))),
    identities: [...identities].map(value => { const [pid, ...rest] = value.split(':'); return { pid: Number(pid), started: rest.join(':') }; }), escapedDescendants };
}

export function engramStorageScopes(testRoot, dataRoots, tempRoots, env = process.env, home = os.homedir()) {
  const configuredSideRoots = [env.ENGRAM_STATE_DIR, env.ENGRAM_CACHE_DIR, env.ENGRAM_OUTBOX, env.ENGRAM_REMOTE_SPOOL,
    env.ENGRAM_USER_CONFIG ? path.dirname(path.resolve(env.ENGRAM_USER_CONFIG)) : undefined,
    env.XDG_CONFIG_HOME ? path.join(env.XDG_CONFIG_HOME, 'engram') : undefined,
    env.XDG_CACHE_HOME ? path.join(env.XDG_CACHE_HOME, 'engram') : undefined,
    env.XDG_STATE_HOME ? path.join(env.XDG_STATE_HOME, 'engram') : undefined].filter(Boolean).map(value => path.resolve(value));
  const legacyRoots = [path.join(home, '.Engram'), path.join(home, '.Engram-outbox'), path.join(home, '.Engram-remote-spool'),
    path.join(home, '.config', 'engram'), path.join(home, '.cache', 'engram'), path.join(home, '.local', 'state', 'engram')].map(value => path.resolve(value));
  const configuredTempRoots = [env.TMPDIR, env.TMP, env.TEMP].filter(Boolean).map(value => path.resolve(value));
  return { testRoot, dataRoots, tempRoots, configuredSideRoots: normalizeRoots(configuredSideRoots), configuredTempRoots: normalizeRoots(configuredTempRoots), legacyRoots: normalizeRoots(legacyRoots) };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function groupMembers(groupId) {
  const table = await processTable();
  if (!table.complete) throw new Error(`cannot verify owned process group ${groupId}: ${table.error ?? 'ps unavailable'}`);
  return table.rows.filter(row => row.pgid === groupId);
}
async function waitForGroupEmpty(groupId, graceMs) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!(await groupMembers(groupId)).length) return true;
    await delay(150);
  }
  return !(await groupMembers(groupId)).length;
}
async function signalOwnedGroup(groupId, signal) {
  const members = await groupMembers(groupId);
  if (!members.length) return { sent: false, pids: [] };
  if (members.some(member => member.pgid !== groupId)) throw new Error('process-group membership changed during signal check');
  process.kill(-groupId, signal);
  return { sent: true, pids: members.map(({ pid, started, command }) => ({ pid, started, executableCommand: redact(command) })) };
}
async function stopGroup(groupId, record) {
  const stages = [ ['SIGINT', TERM_GRACE_MS], ['SIGTERM', KILL_GRACE_MS], ['SIGKILL', 0] ];
  for (const [signal, grace] of stages) {
    const sent = await signalOwnedGroup(groupId, signal);
    try { await record({ type: 'process_group_signal', processGroupId: groupId, signal, ...sent }); }
    catch (error) { process.stderr.write(`CRITICAL: could not record ${signal} signal event: ${redact(error.message)}\n`); }
    if (!(await groupMembers(groupId)).length) return { complete: true, stages: signal };
    if (grace && await waitForGroupEmpty(groupId, grace)) return { complete: true, stages: signal };
  }
  // Do not let the monitor exit while any member of its dedicated group can still write.
  let remaining = await groupMembers(groupId);
  while (remaining.length) {
    try { await record({ type: 'termination_wait', processGroupId: groupId, remaining: remaining.map(({ pid, started, command }) => ({ pid, started, executableCommand: redact(command) })) }); }
    catch (error) { process.stderr.write(`CRITICAL: could not record termination wait: ${redact(error.message)}\n`); }
    await delay(1000);
    remaining = await groupMembers(groupId);
  }
  return { complete: true, stages: 'SIGKILL' };
}
async function waitUntilOwnedGroupEmpty(groupId, record) {
  let lastNotice = 0;
  for (;;) {
    let members;
    try { members = await groupMembers(groupId); }
    catch (error) {
      const now = Date.now();
      if (now - lastNotice >= 5_000) {
        try { await record({ type: 'visibility_wait', processGroupId: groupId, error: redact(error.message), message: 'cannot verify process-group exit; wrapper remains alive' }); }
        catch { process.stderr.write('CRITICAL: process visibility and diagnostic logging are both unavailable; wrapper will continue waiting.\n'); }
        lastNotice = now;
      }
      await delay(500);
      continue;
    }
    if (!members.length) return;
    try { await stopGroup(groupId, record); }
    catch (error) {
      const now = Date.now();
      if (now - lastNotice >= 5_000) {
        try { await record({ type: 'termination_retry', processGroupId: groupId, error: redact(error.message) }); }
        catch { process.stderr.write('CRITICAL: could not log process-group termination retry; wrapper will continue waiting.\n'); }
        lastNotice = now;
      }
      await delay(500);
    }
  }
}
async function waitForEscapedDescendants(identities, record) {
  const known = identities.map(p => `${p.pid}:${p.started}`);
  const started = Date.now();
  while (known.length) {
    const table = await processTable();
    if (!table.complete) throw new Error('cannot verify that escaped descendants have exited');
    const alive = table.rows.filter(row => known.includes(`${row.pid}:${row.started}`));
    if (!alive.length) return;
    if (Date.now() - started > 10_000) await record({ type: 'escaped_descendant_wait', warning: 'known descendant remains outside the owned process group; monitor will not exit or signal it', processes: alive.map(({ pid, ppid, pgid, started: start, command }) => ({ pid, ppid, pgid, started: start, executableCommand: redact(command) })) });
    await delay(1000);
  }
}

async function assertDirectory(pathName, label) {
  const stat = await fs.lstat(pathName);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(pathName) !== pathName) throw new Error(`${label} must be a real, non-symlink directory: ${pathName}`);
}
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.testroot || !opts.diagdir || !Number.isFinite(opts.approvedbudgetgib) || !Number.isFinite(opts.minfreegib) || !opts.command.length) throw new Error(`Required options missing.\n${help}`);
  const testRoot = path.resolve(opts.testroot); const diagDir = path.resolve(opts.diagdir);
  await assertDirectory(testRoot, '--test-root');
  if (!within(testRoot, diagDir) || diagDir === testRoot) throw new Error('--diag-dir must be a new directory nested inside --test-root');
  if (opts.approvedbudgetgib <= 0 || opts.approvedbudgetgib > 2) throw new Error('--approved-budget-gib must be greater than 0 and at most 2 GiB');
  if (opts.minfreegib < 40) throw new Error('--min-free-gib must be at least 40 GiB');
  if (opts.intervalseconds < 2 || opts.intervalseconds > 60) throw new Error('--interval-seconds must be between 2 and 60');
  if (opts.duintervalseconds < 10 || opts.duintervalseconds > 600) throw new Error('--du-interval-seconds must be between 10 and 600');
  let ancestor = testRoot;
  for (const segment of path.relative(testRoot, diagDir).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment);
    try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('--diag-dir must not traverse symlinks'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }

  const tempRoots = normalizeRoots(['/private/tmp', path.resolve(os.tmpdir())]);
  const rawRoots = [...(opts.dataroot ? [path.resolve(opts.dataroot)] : []), ...opts.watches];
  if (!rawRoots.length) throw new Error('At least one explicit --data-root or --watch directory is required; --test-root is only an approved containment boundary');
  for (const root of rawRoots) await assertDirectory(root, 'watched root');
  if (rawRoots.some(root => !within(testRoot, root) && !opts.dataroot)) throw new Error('watched roots must be inside --test-root unless explicitly selected with --data-root');
  const roots = normalizeRoots(rawRoots);
  const attributionRoots = normalizeRoots([testRoot, ...roots]);
  const pathScopes = engramStorageScopes(testRoot, roots, tempRoots);
  const duRoots = normalizeRoots([testRoot, ...roots, ...tempRoots]);
  const dfPaths = normalizeRoots([testRoot, ...roots, ...tempRoots]);
  const baselineTemps = await tempNames(tempRoots);
  const baselineFiles = await fileSnapshot(roots);
  const baselineAttributionFiles = await fileSnapshot(attributionRoots);
  const baselineDu = await duSnapshot(duRoots);
  const baselineDisk = await diskSnapshot(dfPaths);
  const preflight = await processSnapshot(process.pid, process.pid, pathScopes, []);
  if (!baselineFiles.complete) throw new Error(`Refusing workload: baseline file walk incomplete (${baselineFiles.errors.length} errors, truncated=${baselineFiles.truncated}, symlinks=${baselineFiles.symlinksSkipped.length})`);
  if (!baselineAttributionFiles.complete) throw new Error(`Refusing workload: approved-root attribution walk incomplete (${baselineAttributionFiles.errors.length} errors, truncated=${baselineAttributionFiles.truncated}, symlinks=${baselineAttributionFiles.symlinksSkipped.length})`);
  if (!baselineTemps.complete) throw new Error(`Refusing workload: system-temp discovery incomplete (${baselineTemps.errors.length} errors, truncated=${baselineTemps.truncated})`);
  if (!baselineDu.usable) throw new Error(`Refusing workload: du baseline incomplete outside approved exact exclusions (${baselineDu.errors.length} errors)`);
  if (!baselineDisk.complete) throw new Error(`Refusing workload: df baseline incomplete (${baselineDisk.errors.length} errors)`);
  if (opts.campaignbaselineusedbytes !== undefined && baselineDisk.devices.length !== 1) throw new Error('campaign-wide disk guard currently requires exactly one measured filesystem volume');
  const campaignBaselineUsedBytes = opts.campaignbaselineusedbytes ?? baselineDisk.devices.reduce((sum, d) => sum + d.usedBytes, 0);
  const priorAggregateGrowthBytes = opts.prioraggregategrowthbytes ?? 0;
  if (!Number.isSafeInteger(campaignBaselineUsedBytes) || campaignBaselineUsedBytes < 0 || !Number.isSafeInteger(priorAggregateGrowthBytes) || priorAggregateGrowthBytes < 0) throw new Error('campaign disk guard values must be non-negative safe integers');
  if (priorAggregateGrowthBytes >= MAX_AGGREGATE_GROWTH_BYTES) throw new Error('Refusing workload: approved aggregate growth budget is already exhausted');
  if (!preflight.complete) throw new Error(`Refusing workload: process monitoring preflight failed (${preflight.error})`);
  const initialFree = Math.min(...baselineDisk.devices.map(d => d.availableBytes));
  if (initialFree <= opts.minfreegib * GIB) throw new Error(`Refusing to start: available space ${initialFree} bytes is at/below floor ${opts.minfreegib * GIB}`);
  const runId = opts.runid ?? randomUUID();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(runId) || runId === '.' || runId === '..') throw new Error('--run-id may contain only letters, numbers, dot, underscore and dash');
  try { await fs.lstat(diagDir); throw new Error('--diag-dir must not already exist'); } catch (error) { if (error.code !== 'ENOENT') throw error; }

  // Durable diagnostics are ready before a workload can start.
  await fs.mkdir(diagDir, { recursive: true, mode: 0o700 });
  const logBase = path.join(diagDir, `storage-monitor-${runId}.jsonl`);
  let bytesLogged = 0; let currentLogBytes = 0; let rotation = 0; let logPath = logBase; let logCreated = false;
  const append = async record => {
    const data = `${JSON.stringify({ runId, at: new Date().toISOString(), ...record })}\n`;
    const size = Buffer.byteLength(data);
    if (bytesLogged + size > TOTAL_LOG_LIMIT) throw new Error('monitor log cap reached; visibility lost');
    if (currentLogBytes && currentLogBytes + size > LOG_LIMIT) { rotation++; logPath = `${logBase}.${rotation}`; currentLogBytes = 0; logCreated = false; }
    await fs.appendFile(logPath, data, { mode: 0o600, flag: logCreated ? 'a' : 'wx' });
    logCreated = true; currentLogBytes += size; bytesLogged += size;
  };
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const git = await runFile('/usr/bin/git', ['-C', repoRoot, 'rev-parse', 'HEAD']);
  if (!git.ok || !/^[a-f0-9]{40,64}$/i.test(git.stdout.trim())) throw new Error('Refusing workload: cannot record current Git commit');
  const monitorScriptSha256 = createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex');
  const startedAt = new Date().toISOString();
  const command = opts.command.map(redact);
  await append({ type: 'run_start', gitCommit: git.stdout.trim(), command, scenario: opts.scenario ? redact(opts.scenario) : null,
    commandArgumentCount: opts.command.length, monitorScriptSha256,
    testRoot, dataRoot: opts.dataroot ? path.resolve(opts.dataroot) : null, workingDirectory: opts.cwd ? path.resolve(opts.cwd) : testRoot, tmpdir: process.env.TMPDIR ?? null, osTmpdir: os.tmpdir(), startedAt,
    approvedBudgetBytes: opts.approvedbudgetgib * GIB, minimumFreeBytes: opts.minfreegib * GIB, intervalSeconds: opts.intervalseconds,
    duIntervalSeconds: opts.duintervalseconds, watchedRoots: roots, attributionRoots, storageScopes: pathScopes, systemTempRoots: tempRoots, duRoots,
    ownedProcessGroupId: null, campaignBaselineUsedBytes, priorAggregateGrowthBytes,
    accounting: 'Safety uses whole-volume df only; attribution reports logical file bytes, st_blocks*512 allocated file bytes, du allocated bytes, and sampled process open-file activity separately' });
  await append({ type: 'baseline', disks: baselineDisk.devices, du: baselineDu.directories, duAccountingComplete: baselineDu.complete, duCoverage: baselineDu.coverage, excludedPaths: baselineDu.excludedPaths,
    filesystemAccountingComplete: baselineDisk.complete && baselineFiles.complete && baselineAttributionFiles.complete && baselineDu.complete, fileTotals: inventoryTotals(baselineFiles), walkedFiles: baselineFiles.files.size,
    walkEntries: baselineFiles.visited, walkComplete: baselineFiles.complete, attributionWalkEntries: baselineAttributionFiles.visited, attributionWalkComplete: baselineAttributionFiles.complete, tempWalkEntries: baselineTemps.visited, tempWalkComplete: baselineTemps.complete,
    preflightProcesses: preflight.processes, tempDirectories: [...baselineTemps.directories.values()] });

  const workingDirectory = opts.cwd ? path.resolve(opts.cwd) : testRoot;
  await assertDirectory(workingDirectory, '--cwd');
  const child = spawn(opts.command[0], opts.command.slice(1), { cwd: workingDirectory, env: process.env, stdio: 'inherit', shell: false, detached: true });
  let childExit; let childError;
  const completion = new Promise(resolve => {
    child.once('exit', (code, signal) => { childExit = { code, signal }; resolve(childExit); });
    child.once('error', error => { childError = redact(error.message); childExit = { code: 127, signal: null, spawnError: childError }; resolve(childExit); });
  });
  const pgid = child.pid;
  if (!Number.isInteger(pgid)) throw new Error('Failed to create wrapped process group');
  let abortReason = null; let stopPromise = null; let sampling = true; let sampleRunning = false;
  let lastFiles = baselineFiles; let lastAttributionFiles = baselineAttributionFiles; let lastDuAt = Date.now();
  let peakPositiveGrowth = 0; let peakNetGrowth = 0; let peakCampaignGrowth = priorAggregateGrowthBytes; let peakUnexplained = 0; let monitorComplete = true; let monitorErrors = [];
  const knownIdentities = new Map();
  const remember = snapshot => { for (const identity of snapshot.identities ?? []) knownIdentities.set(`${identity.pid}:${identity.started}`, identity); };
  const requestStop = (reason) => {
    if (stopPromise) return stopPromise;
    abortReason = reason;
    stopPromise = (async () => {
      process.stderr.write(`storage monitor stopping owned process group ${pgid}: ${reason}\n`);
      try { await append({ type: 'abort', reason, processGroupId: pgid, signalPolicy: 'owned process group only' }); } catch (error) { monitorComplete = false; monitorErrors.push(`abort log write failed: ${error.message}`); }
      try { await stopGroup(pgid, append); }
      catch (error) { monitorComplete = false; monitorErrors.push(`process group termination/verification failed: ${error.message}`); process.stderr.write(`CRITICAL: cannot verify owned process group termination: ${redact(error.message)}\n`); stopPromise = null; }
    })();
    return stopPromise;
  };
  const onSignal = signal => { void requestStop(`monitor received ${signal}`); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  const timer = setInterval(async () => {
    if (sampleRunning || !sampling || childExit) return;
    sampleRunning = true;
    try {
      const now = Date.now();
      const disks = await diskSnapshot(dfPaths);
      if (!disks.complete) throw new Error(`df sample incomplete: ${JSON.stringify(disks.errors)}`);
      const fsDelta = filesystemGrowth(baselineDisk, disks);
      if (!fsDelta.complete) throw new Error(`filesystem device accounting incomplete: ${fsDelta.error}`);
      const campaignCurrentUsedBytes = disks.devices.reduce((sum, d) => sum + d.usedBytes, 0);
      const campaignGrowthBytes = aggregateCampaignGrowth(priorAggregateGrowthBytes, campaignBaselineUsedBytes, campaignCurrentUsedBytes);
      peakPositiveGrowth = Math.max(peakPositiveGrowth, fsDelta.positiveGrowthBytes);
      peakNetGrowth = Math.max(peakNetGrowth, fsDelta.netBytes);
      peakCampaignGrowth = Math.max(peakCampaignGrowth, campaignGrowthBytes);
      const minFree = Math.min(...disks.devices.map(d => d.availableBytes));
      if (fsDelta.positiveGrowthBytes >= opts.approvedbudgetgib * GIB) await requestStop(`aggregate positive filesystem growth ${fsDelta.positiveGrowthBytes} bytes reached approved budget`);
      if (campaignGrowthBytes >= MAX_AGGREGATE_GROWTH_BYTES) await requestStop(`campaign aggregate filesystem growth ${campaignGrowthBytes} bytes reached 2 GiB approved limit`);
      if (minFree <= opts.minfreegib * GIB) await requestStop(`available disk space ${minFree} bytes reached minimum floor`);

      const tempScan = await tempNames(tempRoots);
      if (!tempScan.complete) throw new Error(`system-temp name scan incomplete: ${JSON.stringify(tempScan.errors)}`);
      const tempChanges = tempEntryChanges(baselineTemps, tempScan);
      const changedPreexistingTemps = tempChanges.filter(change => baselineTemps.entries.has(change.path));
      const newTempDirectories = [...tempScan.directories.keys()].filter(name => !baselineTemps.directories.has(name));
      const currentFiles = await fileSnapshot([...roots, ...newTempDirectories]);
      if (!currentFiles.complete) throw new Error(`file walk incomplete (errors=${currentFiles.errors.length}, truncated=${currentFiles.truncated}, symlinks=${currentFiles.symlinksSkipped.length})`);
      const currentAttributionFiles = await fileSnapshot([...attributionRoots, ...newTempDirectories]);
      if (!currentAttributionFiles.complete) throw new Error(`approved-root attribution walk incomplete (errors=${currentAttributionFiles.errors.length}, truncated=${currentAttributionFiles.truncated}, symlinks=${currentAttributionFiles.symlinksSkipped.length})`);
      const fileDelta = allocatedFileGrowth(baselineFiles, currentFiles);
      const filePositiveDelta = allocatedFilePositiveGrowth(baselineFiles, currentFiles);
      const logicalDelta = logicalGrowth(baselineFiles, currentFiles);
      const changes = fileChanges(lastFiles, currentFiles); lastFiles = currentFiles;
      const runRootChanges = fileChanges(lastAttributionFiles, currentAttributionFiles); lastAttributionFiles = currentAttributionFiles;

      if (now - lastDuAt >= opts.duintervalseconds * 1000) {
        const currentDu = await duSnapshot(duRoots);
        if (!currentDu.usable) throw new Error(`du sample incomplete outside approved exact exclusions: ${JSON.stringify(currentDu.errors)}`);
        const duDelta = duAllocatedGrowth(baselineDu, currentDu, duRoots);
        if (!duDelta.usable) throw new Error(duDelta.error);
        lastDuAt = now;
        await append({ type: 'du_sample', directories: currentDu.directories, watchedDuAllocatedNetDeltaBytes: duDelta.bytes,
          duAccountingComplete: currentDu.complete, duCoverage: currentDu.coverage, excludedPaths: currentDu.excludedPaths });
      }
      // st_blocks tracks unique file inodes across disjoint normalized roots. du is an independent allocated-space check.
      const attributionPositiveDelta = allocatedFilePositiveGrowth(baselineAttributionFiles, currentAttributionFiles);
      const knownGrowth = attributionPositiveDelta;
      const attributionDifference = fsDelta.positiveGrowthBytes - Math.max(0, knownGrowth);
      const unexplained = Math.max(0, attributionDifference);
      peakUnexplained = Math.max(peakUnexplained, unexplained);

      const process = await processSnapshot(pgid, child.pid, pathScopes, [...knownIdentities.values()]);
      if (!process.complete) throw new Error(`process monitoring incomplete: ${process.error}`);
      remember(process);
      if (process.escapedDescendants.length) throw new Error('wrapped descendant escaped its dedicated process group; refusing to continue without ownership');
      const outsideWritableReferences = process.writableReferences.filter(file => file.type === 'REG'
        && ['OUTSIDE_APPROVED_ROOTS', 'LEGACY_HOME_XDG', 'SYSTEM_TEMP', 'ENGRAM_TEMP'].includes(file.classification));
      if (outsideWritableReferences.length) await requestStop(`owned process has writable file references outside approved storage roots (${outsideWritableReferences.length})`);
      await append({ type: 'sample', disks: disks.devices, filesystemUsagePositiveGrowthBytes: fsDelta.positiveGrowthBytes, filesystemUsageNetDeltaBytes: fsDelta.netBytes,
        campaignAggregateGrowthBytes: campaignGrowthBytes, peakCampaignAggregateGrowthBytes: peakCampaignGrowth,
        watchedFileLogicalNetDeltaBytes: logicalDelta, watchedFileAllocatedNetDeltaBytes: fileDelta, watchedFileAllocatedPositiveGrowthBytes: filePositiveDelta, knownWatchedGrowthBytes: knownGrowth,
        unexplainedFilesystemGrowthBytes: unexplained, attributionDiscrepancyBytes: attributionDifference, minimumAvailableBytes: minFree, fileChanges: changes,
        approvedRootFileChanges: runRootChanges, approvedRootLogicalNetDeltaBytes: logicalGrowth(baselineAttributionFiles, currentAttributionFiles),
        approvedRootAllocatedNetDeltaBytes: allocatedFileGrowth(baselineAttributionFiles, currentAttributionFiles),
        approvedRootAllocatedPositiveGrowthBytes: attributionPositiveDelta,
        walkedFiles: currentFiles.files.size, walkEntries: currentFiles.visited, walkComplete: currentFiles.complete,
        approvedRootWalkedFiles: currentAttributionFiles.files.size, approvedRootWalkEntries: currentAttributionFiles.visited, approvedRootWalkComplete: currentAttributionFiles.complete,
        tempWalkEntries: tempScan.visited, tempWalkComplete: tempScan.complete, tempDirectories: [...tempScan.directories.values()],
        ownedProcessGroupId: pgid, ownedProcessGroupMembers: process.group, completeProcessTree: process.processes, processes: process.processes,
        processTreeCoverage: 'SAMPLED_PID_PPID_PGID_START_IDENTITY', processActivityComplete: process.activityComplete,
        processActivityCoverage: process.activityComplete ? 'SAMPLED_LSOF_OPEN_FILES' : 'PARTIAL_LSOF_UNAVAILABLE_OR_TRUNCATED',
        writableReferences: process.writableReferences, outsideWritableReferences, changedPreexistingEngramTempEntries: changedPreexistingTemps,
        systemTempEntryChanges: tempChanges, newlyWatchedSystemTempDirectories: newTempDirectories });
      if (!monitorComplete) throw new Error('monitoring integrity failed');
    } catch (error) {
      monitorComplete = false; monitorErrors.push(redact(error.message));
      await requestStop(`monitor failure; fail closed: ${redact(error.message)}`);
    } finally { sampleRunning = false; }
  }, opts.intervalseconds * 1000);

  const outcome = await completion;
  try {
    const remainingMembers = await groupMembers(pgid);
    if (remainingMembers.length) await requestStop('wrapped command exited while owned process group still had descendants');
  } catch (error) {
    monitorComplete = false; monitorErrors.push(`cannot verify owned process group after command exit: ${redact(error.message)}`);
    process.stderr.write(`CRITICAL: process visibility lost after command exit; retaining wrapper until group can be verified empty.\n`);
  }
  if (stopPromise) await stopPromise;
  await waitUntilOwnedGroupEmpty(pgid, append);
  sampling = false; clearInterval(timer);
  while (sampleRunning) await delay(100);
  // Keep the wrapper alive while known descendants that escaped the process group still exist; never signal them.
  const escaped = [...knownIdentities.values()].filter(identity => identity.pid !== child.pid);
  if (escaped.length) {
    try { await waitForEscapedDescendants(escaped, append); }
    catch (error) { monitorComplete = false; monitorErrors.push(redact(error.message)); }
  }
  process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);

  const finalTemps = await tempNames(tempRoots);
  if (!finalTemps.complete) { monitorComplete = false; monitorErrors.push('final system-temp scan incomplete'); }
  const finalNewTempDirectories = [...finalTemps.directories.keys()].filter(name => !baselineTemps.directories.has(name));
  const afterFiles = await fileSnapshot([...roots, ...finalNewTempDirectories]);
  const afterAttributionFiles = await fileSnapshot([...attributionRoots, ...finalNewTempDirectories]);
  const afterDu = await duSnapshot(duRoots);
  const afterDisk = await diskSnapshot(dfPaths);
  if (!afterFiles.complete || !afterAttributionFiles.complete || !afterDu.usable || !afterDisk.complete) { monitorComplete = false; monitorErrors.push('final accounting snapshot incomplete outside approved exact exclusions'); }
  const fsDelta = filesystemGrowth(baselineDisk, afterDisk);
  if (!fsDelta.complete) { monitorComplete = false; monitorErrors.push(fsDelta.error); }
  const fileLogicalDelta = logicalGrowth(baselineFiles, afterFiles);
  const fileAllocatedDelta = allocatedFileGrowth(baselineFiles, afterFiles);
  const duDelta = duAllocatedGrowth(baselineDu, afterDu, duRoots);
  if (!duDelta.usable) { monitorComplete = false; monitorErrors.push(duDelta.error); }
  const minFree = afterDisk.devices.length ? Math.min(...afterDisk.devices.map(d => d.availableBytes)) : null;
  const campaignFinalGrowthBytes = fsDelta.complete ? aggregateCampaignGrowth(priorAggregateGrowthBytes, campaignBaselineUsedBytes, afterDisk.devices.reduce((sum, d) => sum + d.usedBytes, 0)) : null;
  const postExitBreaches = [];
  if (fsDelta.complete && fsDelta.positiveGrowthBytes >= opts.approvedbudgetgib * GIB) postExitBreaches.push('aggregate growth reached approved limit after command exit');
  if (campaignFinalGrowthBytes !== null && campaignFinalGrowthBytes >= MAX_AGGREGATE_GROWTH_BYTES) postExitBreaches.push('campaign aggregate growth reached 2 GiB approved limit after command exit');
  if (minFree !== null && minFree <= opts.minfreegib * GIB) postExitBreaches.push('available space reached minimum floor after command exit');
  const finalTempChanges = tempEntryChanges(baselineTemps, finalTemps);
  const changedPreexistingTemps = finalTempChanges.filter(change => baselineTemps.entries.has(change.path));
  const fileAllocatedPositiveDelta = allocatedFilePositiveGrowth(baselineAttributionFiles, afterAttributionFiles);
  const attributionDifference = fsDelta.complete ? fsDelta.positiveGrowthBytes - fileAllocatedPositiveDelta : null;
  const unexplained = attributionDifference === null ? null : Math.max(0, attributionDifference);
  if (postExitBreaches.length && !abortReason) abortReason = postExitBreaches[0];
  const endProcess = await processSnapshot(pgid, child.pid, pathScopes, [...knownIdentities.values()]);
  if (!endProcess.complete || endProcess.group.length || endProcess.escapedDescendants.length) { monitorComplete = false; monitorErrors.push('process group or descendant remained at final verification'); }
  const result = { type: 'run_end', endedAt: new Date().toISOString(), exitCode: outcome.code, signal: outcome.signal, ...(outcome.spawnError ? { spawnError: outcome.spawnError } : {}),
    abortReason, postExitBreaches, monitorComplete, monitorErrors, processGroupId: pgid, processGroupEmpty: endProcess.complete && endProcess.group.length === 0,
    campaignBaselineUsedBytes, priorAggregateGrowthBytes, campaignAggregateGrowthBytes: campaignFinalGrowthBytes, peakCampaignAggregateGrowthBytes: peakCampaignGrowth,
    filesystemUsagePositiveGrowthBytes: fsDelta.positiveGrowthBytes, filesystemUsageNetDeltaBytes: fsDelta.netBytes,
    peakFilesystemPositiveGrowthBytes: peakPositiveGrowth, peakFilesystemNetGrowthBytes: peakNetGrowth, peakUnexplainedFilesystemGrowthBytes: peakUnexplained,
    watchedFileLogicalNetDeltaBytes: fileLogicalDelta, watchedFileAllocatedNetDeltaBytes: fileAllocatedDelta,
    watchedDuAllocatedNetDeltaBytes: duDelta.bytes, duAccountingComplete: afterDu.complete, duCoverage: afterDu.coverage, excludedPaths: afterDu.excludedPaths,
    filesystemAccountingComplete: afterDisk.complete && afterFiles.complete && afterAttributionFiles.complete && afterDu.complete,
    attributionCoverage: { configuredDataRoots: roots, disposableRunRoot: testRoot, processTree: 'SAMPLED_PID_PPID_PGID_START_IDENTITY', openFiles: endProcess.activityComplete ? 'SAMPLED_LSOF_OPEN_FILES' : 'PARTIAL_LSOF_UNAVAILABLE_OR_TRUNCATED', systemicFilesystemDiscrepancyIsNotAutomaticallyFatal: true },
    watchedFileAllocatedPositiveGrowthBytes: fileAllocatedPositiveDelta, knownWatchedGrowthBytes: fileAllocatedPositiveDelta,
    unexplainedFilesystemGrowthBytes: unexplained, attributionDiscrepancyBytes: attributionDifference, minimumAvailableBytes: minFree, fileChanges: fileChanges(baselineFiles, afterFiles),
    approvedRootFileChanges: fileChanges(baselineAttributionFiles, afterAttributionFiles), approvedRootLogicalNetDeltaBytes: logicalGrowth(baselineAttributionFiles, afterAttributionFiles),
    approvedRootAllocatedNetDeltaBytes: allocatedFileGrowth(baselineAttributionFiles, afterAttributionFiles), approvedRootAllocatedPositiveGrowthBytes: fileAllocatedPositiveDelta,
    residualFiles: [...afterFiles.files.values()], walkEntries: afterFiles.visited, walkComplete: afterFiles.complete,
    approvedRootResidualFiles: [...afterAttributionFiles.files.values()], approvedRootWalkEntries: afterAttributionFiles.visited, approvedRootWalkComplete: afterAttributionFiles.complete,
    tempWalkEntries: finalTemps.visited, tempWalkComplete: finalTemps.complete,
    systemTempDirectories: [...finalTemps.directories.values()], directories: afterDu.directories,
    processesAtEnd: endProcess.processes, logFiles: rotation ? Array.from({ length: rotation + 1 }, (_, i) => i ? `${logBase}.${i}` : logBase) : [logBase] };
  await append(result);
  process.stdout.write(`${JSON.stringify({ runId, exitCode: outcome.code, signal: outcome.signal, abortReason, monitorComplete,
    filesystemAccountingComplete: result.filesystemAccountingComplete, attributionCoverage: result.attributionCoverage, duCoverage: result.duCoverage, excludedPaths: result.excludedPaths,
    filesystemUsagePositiveGrowthBytes: fsDelta.positiveGrowthBytes, campaignAggregateGrowthBytes: result.campaignAggregateGrowthBytes,
    peakCampaignAggregateGrowthBytes: result.peakCampaignAggregateGrowthBytes, residualFiles: result.residualFiles.length,
    watchedFileLogicalNetDeltaBytes: result.watchedFileLogicalNetDeltaBytes,
    watchedFileAllocatedNetDeltaBytes: result.watchedFileAllocatedNetDeltaBytes,
    peakFilesystemPositiveGrowthBytes: result.peakFilesystemPositiveGrowthBytes,
    unexplainedFilesystemGrowthBytes: result.unexplainedFilesystemGrowthBytes,
    fileChanges: result.fileChanges.map(change => ({ type: change.type, path: change.path, logicalBytes: change.logicalBytes, allocatedBytes: change.allocatedBytes })),
    residualFiles: result.residualFiles.map(file => ({ path: file.path, logicalBytes: file.logicalBytes, allocatedBytes: file.allocatedBytes, inode: file.inode, mtimeMs: file.mtimeMs })),
    processGroupEmpty: result.processGroupEmpty, processActivityCoverage: result.attributionCoverage.openFiles, approvedRootAllocatedNetDeltaBytes: result.approvedRootAllocatedNetDeltaBytes,
    approvedRootCreatedFiles: result.approvedRootFileChanges.filter(change => change.type === 'created').length, log: logBase })}\n`);
  if (abortReason || !monitorComplete || outcome.code !== 0) process.exitCode = outcome.code ?? 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(error => { process.stderr.write(`${redact(error.message)}\n`); process.exitCode = 2; });
}
