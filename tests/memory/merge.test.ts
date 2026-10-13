import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { merge3, mergeScalar, mergeTags, MAX_MERGE_LINES } from '../../packages/memory/merge.js';
import { recordCase } from '../helpers/report.js';

const lines = (...l: string[]) => l.join('\n');

test('non-overlapping edits from both sides are combined; identical edits are taken once; one-sided changes win', () => {
  const base = lines('# Plan', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5', '');
  const ours = lines('# Plan', 'step 1 (local)', 'step 2', 'step 3', 'step 4', 'step 5', '');
  const theirs = lines('# Plan', 'step 1', 'step 2', 'step 3', 'step 4', 'step 5 (server)', 'step 6 (server)', '');
  assert.deepEqual(merge3(base, ours, theirs), { text: lines('# Plan', 'step 1 (local)', 'step 2', 'step 3', 'step 4', 'step 5 (server)', 'step 6 (server)', ''), conflicts: 0 });
  assert.deepEqual(merge3(base, ours, ours), { text: ours, conflicts: 0 }); assert.equal(merge3(base, base, theirs).text, theirs); assert.equal(merge3(base, ours, base).text, ours);
  const both = lines('# Plan', 'step 1 (same)', 'step 2', 'step 3', 'step 4', 'step 5', ''); assert.deepEqual(merge3(base, both, both.replace('step 5', 'step 5')), { text: both, conflicts: 0 });
  assert.deepEqual(merge3(base, lines('# Plan', 'step 1 (same)', 'step 2', 'step 3', 'step 4', 'step 5', ''), lines('# Plan', 'step 1 (same)', 'step 2', 'step 3', 'step 4', 'step 5 (server)', '')).conflicts, 0, 'the same change on both sides plus a separate change');
  recordCase({ suite: 'memory', name: 'merge3-clean', status: 'PASS' });
});

test('overlapping different edits conflict with git-style diff3 markers and keep all three sides; adjacent edits conflict like git', () => {
  const base = lines('a', 'b', 'c', 'd'); const ours = lines('a', 'B-local', 'c', 'd'); const theirs = lines('a', 'B-server', 'c', 'd');
  const merged = merge3(base, ours, theirs, { ours: 'local (offline 2026-10-13T01:00:00Z)', theirs: 'server (revision 4)', base: 'revision 2' });
  assert.equal(merged.conflicts, 1);
  assert.equal(merged.text, lines('a', '<<<<<<< local (offline 2026-10-13T01:00:00Z)', 'B-local', '||||||| revision 2', 'b', '=======', 'B-server', '>>>>>>> server (revision 4)', 'c', 'd'));
  assert.equal(merge3(lines('a', 'b', 'c'), lines('a', 'B', 'c'), lines('a', 'b', 'C')).conflicts, 1, 'neighbouring lines edited on both sides: conflict, as in git');
  assert.equal(merge3('', 'x', 'y').conflicts, 1, 'both sides added different content to an empty base');
  assert.equal(merge3(lines('a'), lines('a', 'x'), lines('a', 'y')).conflicts, 1, 'two different insertions at the same place');
  assert.equal(merge3(lines('a', 'b'), lines('a'), lines('a', 'b2')).conflicts, 1, 'delete versus edit');
  recordCase({ suite: 'memory', name: 'merge3-conflicts', status: 'PASS' });
});

test('very large inputs are not merged by guessing: all three sides are kept in one conflict', () => {
  const big = (tag: string) => Array.from({ length: MAX_MERGE_LINES + 5 }, (_, i) => `${tag}${i}`).join('\n');
  const merged = merge3(big('b'), big('o'), big('t')); assert.equal(merged.conflicts, 1); assert.match(merged.text, /^<<<<<<< local/);
  assert.equal(merge3(big('b'), big('b') + '\nmore', big('b')).conflicts, 0, 'a one-sided change is still just taken');
  recordCase({ suite: 'memory', name: 'merge3-size-guard', status: 'PASS' });
});

test('scalars and tags follow the same rules', () => {
  assert.deepEqual(mergeScalar('open', 'open', 'done'), { value: 'done', conflict: false }); assert.deepEqual(mergeScalar('open', 'blocked', 'open'), { value: 'blocked', conflict: false });
  assert.deepEqual(mergeScalar('open', 'done', 'done'), { value: 'done', conflict: false }); assert.deepEqual(mergeScalar('open', 'blocked', 'done'), { value: 'done', conflict: true, ours: 'blocked', theirs: 'done' });
  assert.deepEqual(mergeTags(['a', 'b'], ['a', 'b', 'c'], ['a', 'd']).sort(), ['a', 'c', 'd']);
  recordCase({ suite: 'memory', name: 'merge3-scalars-tags', status: 'PASS' });
});

// Independent oracle: with unique lines the line alignment is unambiguous, so our result must agree with `git merge-file` about clean versus conflicted and about the merged text when clean.
test('agrees with git merge-file on 300 random edit pairs over unique lines', () => {
  let seed = 12345; const rand = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const dir = mkdtempSync(path.join(tmpdir(), 'merge-oracle-')); let cleanCases = 0, conflictCases = 0, uniqueId = 0;
  try {
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 6 + rand(20) }, (_, i) => `L${i}`);
      const edit = (src: string[]): string[] => { const out = [...src]; for (let k = 0; k < 1 + rand(3); k++) { const at = rand(out.length + 1), op = rand(3); if (op === 0) out.splice(at, 0, `N${uniqueId++}`); else if (op === 1 && at < out.length) out.splice(at, 1); else if (at < out.length) out[at] = `E${uniqueId++}`; } return out; };
      const ours = edit(base), theirs = edit(base); const files = { o: ours, b: base, t: theirs };
      for (const [k, v] of Object.entries(files)) writeFileSync(path.join(dir, k), `${v.join('\n')}\n`);
      const git = spawnSync('/usr/bin/git', ['merge-file', '-p', '--diff3', '-L', 'local', '-L', 'base', '-L', 'server', path.join(dir, 'o'), path.join(dir, 'b'), path.join(dir, 't')], { encoding: 'utf8' });
      const mine = merge3(`${base.join('\n')}\n`, `${ours.join('\n')}\n`, `${theirs.join('\n')}\n`, { ours: 'local', theirs: 'server', base: 'base' });
      assert.equal(mine.conflicts === 0, git.status === 0, `round ${round}: clean/conflict classification differs from git\nbase=${base}\nours=${ours}\ntheirs=${theirs}`);
      if (git.status === 0) { assert.equal(mine.text, git.stdout, `round ${round}: merged text differs from git`); cleanCases++; } else conflictCases++;
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(cleanCases > 40 && conflictCases > 40, `the random set exercised both outcomes (${cleanCases} clean, ${conflictCases} conflicts)`);
  recordCase({ suite: 'memory', name: 'merge3-git-oracle', status: 'PASS', detail: { cleanCases, conflictCases } });
});
