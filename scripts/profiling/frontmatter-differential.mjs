// Differential check of the front matter fast path against the YAML parser over every revision file of a vault. Read-only. Usage: node frontmatter-differential.mjs <vault root>
import fs from 'node:fs'; import path from 'node:path'; import YAML from 'yaml'; import { performance } from 'node:perf_hooks'; import { isDeepStrictEqual } from 'node:util';
import { parseFrontmatterFast } from '../../dist/packages/core/frontmatter-fast.js';
const root = path.resolve(process.argv[2]); const objects = path.join(root, '.mdb/objects'); let files = 0, fast = 0, declined = 0, mismatches = 0, fastMs = 0, yamlMs = 0; const samples = [];
for (const id of fs.readdirSync(objects)) { const revs = path.join(objects, id, 'revs'); if (!fs.existsSync(revs)) continue;
  for (const f of fs.readdirSync(revs)) { const text = fs.readFileSync(path.join(revs, f), 'utf8'); const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text); if (!m) continue; files++;
    let t = performance.now(); const a = parseFrontmatterFast(m[1]); fastMs += performance.now() - t; t = performance.now(); const b = YAML.parse(m[1]); yamlMs += performance.now() - t;
    if (a === undefined) { declined++; if (samples.length < 5) samples.push(m[1].slice(0, 400)); continue; } fast++; if (!isDeepStrictEqual(a, b) || JSON.stringify(a) !== JSON.stringify(b)) { mismatches++; if (samples.length < 5) samples.push('MISMATCH ' + m[1].slice(0, 400)); } } }
console.log(JSON.stringify({ root, revisionFiles: files, fastAccepted: fast, declined, mismatches, fastParserMs: Math.round(fastMs), yamlParserMsOnAll: Math.round(yamlMs), declinedSamples: samples }, null, 2));
