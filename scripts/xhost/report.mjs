// Renders verification/memory/cross-machine-report.md from verification/memory/xhost/results.json (written by run.mjs). No results are invented here.
import { promises as fs } from 'node:fs';
const r = JSON.parse(await fs.readFile('verification/memory/xhost/results.json', 'utf8'));
const find = (id, re) => r.scenarios.filter(s => s.id === id).flatMap(s => s.checks.filter(c => !re || re.test(c.what)));
const rows = [
  ['1', 'Each client initializes remote capture using supported lifecycle hooks', 'X1', null, 'Install adapter on B/C; hooks for SessionStart, UserPromptSubmit, PostToolUse, SessionEnd use https and carry no token'],
  ['2', 'Both clients generate meaningful memory events without memory-writing instructions', 'X2', null, 'Replay real-format lifecycle payloads through the installed hook command; no explicit record call'],
  ['3', 'Both clients deliver observations over TLS', 'X3', null, 'openssl chain + hostname verification; rogue CA, wrong host, no-CA and plain HTTP refused'],
  ['4', 'Interrupt network access between clients and server', 'X4-X8', /^X4/, '`docker network disconnect` for B and C; probe fails'],
  ['5', 'Continue operating both agents while disconnected', 'X4-X8', /^X5/, 'Hooks keep exiting 0 inside the 5 s hook timeout'],
  ['6', 'Bounded local buffering and fail-open behaviour', 'X4-X8', /^X6/, '1100 concurrent hooks against a 1000-entry cap; all exit 0'],
  ['7', 'Restart the server while clients remain active', 'X4-X8', /^X7/, 'Kill and restart the server process while clients are offline'],
  ['8', 'Restore connectivity', 'X4-X8', /^X8/, '`docker network connect`; drain to zero'],
  ['9', 'Exactly-once observable ingestion using idempotency keys', 'X4-X8', /^X9/, 'Unique event ids; each buffered envelope committed once'],
  ['10', 'Session-end handoffs generated while disconnected are eventually delivered', 'X4-X8', /^X10/, 'SessionEnd delivered, sessions closed, HANDOFF jobs queued (no model run here)'],
  ['11', 'Actor attribution and workspace permissions', 'X11', null, 'createdBy/scope per event; cross-registration use returns 404 (X3b)'],
  ['12', 'Duplicate, reordered and replayed events cannot corrupt committed memory', 'X4-X8', /^X12/, 'Reversed spool + duplicated envelopes; later replay of delivered envelopes; journal verify'],
  ['13', 'Revoked credentials cannot resume delivery until reauthenticated', 'X13', null, 'Revoke, 401, events retained, new credential drains them once'],
  ['14', 'Client process restarts while events remain queued', 'X14', null, 'SIGKILL the client container mid-write, restart, drain']
];
const status = cs => !cs.length ? 'NOT_RUN' : cs.every(c => c.ok === true) ? 'PASS' : cs.some(c => c.ok === false) ? 'FAIL' : 'PARTIAL';
let md = `# Cross-machine remote capture report\n\nGenerated ${r.runAt} by \`node scripts/xhost/run.mjs\` (Docker ${r.docker}).\n\n**Tier: ${r.tier}. Physical separate hosts: NOT_RUN.** Containers on one machine are isolated filesystems, process and network namespaces with real TLS, but they are not physical cross-machine deployment and do not satisfy that requirement.\n\n## Topology\n\n- Network \`${r.topology.network}\` ${r.topology.subnet} (dedicated user-defined bridge, labelled engram-xhost=1)\n${Object.entries(r.topology.hosts).map(([h, ip]) => `- ${h} ${ip}`).join('\n')}\n- xhost-a: Engram HTTP MCP bound to 127.0.0.1:3333, TLS terminator on 8443 (valid), 8444 (certificate from a rogue CA), 8445 (certificate for another host name). ${r.topology.tls}\n- xhost-b: Claude Code adapter role, credential \`claude-b\` scoped to workspace ws-b. xhost-c: Codex adapter role, credential \`codex-c\` scoped to ws-c.\n- Hooks are the commands the adapters install, fed real-format lifecycle payloads. The live Claude Code and Codex binaries are not run here (single-machine live evidence: remote-real-host-evaluation.json).\n\n## Scenario matrix\n\n| # | Expected behaviour | Procedure | Result | Checks |\n|---|---|---|---|---|\n`;
for (const [n, what, id, re, how] of rows) { const cs = find(id, re); const extra = n === '3' ? find('X3b') : []; const all = [...cs, ...extra]; md += `| ${n} | ${what} | ${how} | ${status(all)} | ${all.filter(c => c.ok === true).length}/${all.length} |\n`; }
md += `\n## All checks\n\n`;
for (const s of r.scenarios) { md += `### ${s.id} ${s.title} — ${s.status}\n\n`; for (const c of s.checks) md += `- ${c.ok === true ? 'PASS' : c.ok === false ? 'FAIL' : 'NOT_RUN'}: ${c.what}${c.detail ? ` (${c.detail.replace(/\|/g, '/').slice(0, 240)})` : ''}\n`; md += '\n'; }
md += `## Raw evidence\n\n\`verification/memory/xhost/results.json\`, \`verification/memory/xhost/raw/\` (openssl output, drain results, server state, server log tail). Bearer tokens are redacted.\n`;
await fs.writeFile('verification/memory/cross-machine-report.md', md);
console.log(rows.map(([n, , id, re]) => `${n}:${status(find(id, re))}`).join(' '));
