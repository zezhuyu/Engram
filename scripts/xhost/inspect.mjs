// Server-side observation for the multi-host harness. Prints one JSON document describing committed state; never prints credentials.
import { Vault } from '/opt/engram/dist/packages/core/vault.js';
import { IntelligenceEngine } from '/opt/engram/dist/packages/intelligence/index.js';
import { spoolStats } from '/opt/engram/dist/packages/memory/capture.js';
const root = process.argv[2];
const vault = new Vault(root);
const docs = await vault.listDocuments();
const obs = docs.filter(d => d.metadata?.eventId);
const jobs = await new IntelligenceEngine(vault).jobs();
const verify = await vault.verify();
console.log(JSON.stringify({
  documents: docs.length,
  events: obs.map(d => ({ id: d.id, eventId: d.metadata.eventId, eventType: d.metadata.eventType, host: d.metadata.host, createdBy: d.createdBy, scope: d.scope, hostSession: d.metadata.hostSessionId, body: String(d.body).slice(0, 120) })),
  closedSessions: docs.filter(d => d.kind === 'session' && d.metadata.lifecycle === 'closed').map(d => ({ id: d.id, createdBy: d.createdBy, scope: d.scope })),
  handoffJobs: jobs.filter(j => j.kind === 'memory' && String(j.input.instruction ?? '').startsWith('HANDOFF')).length,
  serverSpool: await spoolStats(root),
  journal: verify
}));
