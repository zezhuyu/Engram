import type { Document, Scope } from '../../packages/core/types.js';
import { Vault } from '../../packages/core/vault.js';
import { correctInsight } from '../../packages/intelligence/insights.js';

/**
 * Synthetic multi-domain evaluation pack (documented in verification/dream/pack.md). 5 knowledge domains with deliberate cross-domain structure,
 * one unrelated domain, a contradicting pair, private workspace notes that tempt through shared vocabulary, and a user goal.
 */
const wiki: Scope = { type: 'global', area: 'wiki' };
export interface Pack { ids: Record<string, string>; docs: Record<string, Document>; goalId: string; privateWorkspace: string }
type Spec = { key: string; kind: string; title: string; body: string; tags: string[]; links?: Array<{ type: string; target: string }>; scope?: Scope };
const specs: Spec[] = [
  { key: 'pyApi', kind: 'wiki_page', title: 'Python HTTP APIs', body: 'Python services expose JSON over HTTP using FastAPI. Responses are structured as JSON documents.', tags: ['domain:python-api', 'api', 'json', 'provides:json'] },
  { key: 'pyPipe', kind: 'wiki_page', title: 'Python data pipelines', body: 'Pandas pipelines transform raw records into clean dataframes.', tags: ['domain:python-api', 'pipeline', 'dataframe', 'provides:dataframe'] },
  { key: 'pyRate', kind: 'procedure', title: 'Python rate limiting', body: 'Use a token bucket per client to enforce request quotas in a Python API.', tags: ['domain:python-api', 'ratelimit', 'api'] },
  { key: 'jsDash', kind: 'wiki_page', title: 'JavaScript dashboards', body: 'Browser dashboards consume JSON through fetch and render widgets.', tags: ['domain:js-frontend', 'dashboard', 'consumes:json'] },
  { key: 'jsChart', kind: 'wiki_page', title: 'Charting libraries', body: 'Chart libraries draw lines and bars from arrays of JSON records.', tags: ['domain:js-frontend', 'chart', 'consumes:json'] },
  { key: 'jsCache', kind: 'finding', title: 'Frontend caching', body: 'Client side caches reduce repeated fetches but need ratelimit friendly invalidation.', tags: ['domain:js-frontend', 'cache', 'ratelimit'] },
  { key: 'opsDeploy', kind: 'procedure', title: 'Zero downtime deploys', body: 'Blue green deploys switch traffic after health checks pass; keep a rollback ready.', tags: ['domain:devops', 'deploy', 'rollback'] },
  { key: 'opsCache', kind: 'finding', title: 'Cache invalidation incident', body: 'A stale cache after a deploy served old data for two hours.', tags: ['domain:devops', 'cache', 'incident'] },
  { key: 'opsAlert', kind: 'wiki_page', title: 'Alerting on error budgets', body: 'Alert when the error budget burn rate exceeds the agreed threshold.', tags: ['domain:devops', 'alerting', 'slo'] },
  { key: 'vizDash', kind: 'wiki_page', title: 'Dashboard design principles', body: 'Good dashboards show a few key metrics with clear context.', tags: ['domain:data-viz', 'dashboard', 'metrics'] },
  { key: 'vizSeries', kind: 'wiki_page', title: 'Time series visualization', body: 'Plot time series with consistent axes and annotated events.', tags: ['domain:data-viz', 'timeseries', 'chart', 'consumes:dataframe'] },
  { key: 'secAuth', kind: 'wiki_page', title: 'API authentication tokens', body: 'Issue short lived tokens and verify them on every API request.', tags: ['domain:security', 'api', 'token'] },
  { key: 'secRate', kind: 'procedure', title: 'Rate limiting abuse prevention', body: 'Rate limits stop credential stuffing and scraping against public endpoints.', tags: ['domain:security', 'ratelimit', 'abuse'] },
  { key: 'secRotate', kind: 'procedure', title: 'Secret rotation', body: 'Rotate secrets on a schedule and after any suspected exposure.', tags: ['domain:security', 'secret', 'rotation'] },
  { key: 'gardenSoil', kind: 'wiki_page', title: 'Soil acidity', body: 'Tomatoes prefer slightly acidic soil.', tags: ['domain:gardening', 'soil', 'tomato'] },
  { key: 'gardenPrune', kind: 'wiki_page', title: 'Pruning roses', body: 'Prune roses in late winter before new growth.', tags: ['domain:gardening', 'roses', 'pruning'] },
  { key: 'gardenCompost', kind: 'wiki_page', title: 'Compost basics', body: 'Balance green and brown material for compost.', tags: ['domain:gardening', 'compost'] },
  { key: 'claimAll', kind: 'finding', title: 'Caching every API response', body: 'Caching all API responses is always safe and speeds everything up.', tags: ['domain:python-api', 'cache', 'api'] },
  { key: 'claimNone', kind: 'finding', title: 'Authenticated responses must not be cached', body: 'Caching authenticated API responses is unsafe and leaks data between users.', tags: ['domain:security', 'cache', 'api'] },
  { key: 'privApi', kind: 'note', title: 'Internal billing API', body: 'PRIVATE-MARKER The billing API exposes customer balances.', tags: ['domain:finance', 'api', 'billing'], scope: { type: 'workspace', workspaceId: 'private' } },
  { key: 'privDash', kind: 'note', title: 'Executive dashboard', body: 'PRIVATE-MARKER Revenue dashboard for the board meeting.', tags: ['domain:finance', 'dashboard', 'revenue'], scope: { type: 'workspace', workspaceId: 'private' } }
];
export async function buildPack(vault: Vault): Promise<Pack> {
  await vault.createWorkspace('private', 'private finance notes', {});
  const ids: Record<string, string> = {}; const docs: Record<string, Document> = {};
  for (const s of specs) {
    const links = s.key === 'claimNone' ? [{ type: 'contradicts', target: docs.claimAll!.uri }] : s.links;
    const d = await vault.put({ scope: s.scope ?? wiki, kind: s.kind, title: s.title, body: s.body, tags: s.tags, ...(links ? { links } : {}) });
    ids[s.key] = d.id; docs[s.key] = d;
  }
  const goal = await correctInsight(vault, { scope: { type: 'global', area: 'profile' }, preferenceKey: 'goal-dashboard', claim: 'Ship a personal metrics dashboard for my side projects', category: 'goal', reason: 'stated by the user' });
  return { ids, docs, goalId: goal.id, privateWorkspace: 'private' };
}
export const PACK_SIZE = specs.length;
