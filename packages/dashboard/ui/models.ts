// Pure view-model helpers. They are unit-tested as TypeScript and embedded into the browser script as source text (browserModels).
export type State = Record<string, any>;
export interface StatusCard { key: string; label: string; value: string; detail: string; state: 'ok' | 'attention' | 'problem' | 'unknown'; target: string }
export function deriveCards(data: State): StatusCard[] {
  const number = (value: unknown): string => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : '—';
  const state = (value: unknown): StatusCard['state'] => value === 'unavailable' || value == null ? 'unknown' : value ? 'attention' : 'ok';
  const doctor = data.doctor ?? {}, index = data.index ?? {}, jobs = data.jobs ?? {}, scheduler = data.scheduler ?? {};
  const failed = Number(jobs.failed ?? 0) + Number(jobs.dead_letter ?? 0);
  const integrityState = doctor.state === 'ok' ? 'ok' : doctor.state === 'attention' ? 'attention' : doctor.state === 'problem' ? 'problem' : 'unknown';
  return [
    { key: 'integrity', label: 'Integrity', value: doctor.state === 'ok' ? 'Verified' : doctor.state === 'attention' ? 'Attention' : doctor.state === 'problem' ? 'Problem' : 'Unavailable', detail: `${number(doctor.checks?.length)} checks`, state: integrityState, target: 'overview' },
    { key: 'journal', label: 'Journal', value: number(index.journalSequence), detail: 'committed events', state: 'ok', target: 'storage' },
    { key: 'index', label: 'Index', value: index.available ? 'Available' : 'Unavailable', detail: `${number(index.manifest?.entries)} entries`, state: state(index.problem), target: 'storage' },
    { key: 'jobs', label: 'Jobs', value: failed ? `${number(failed)} failed` : `${number(jobs.pending)} queued`, detail: `${number(jobs.running)} running`, state: failed ? 'problem' : 'ok', target: 'jobs' },
    { key: 'scheduler', label: 'Scheduler', value: scheduler.enabled ? scheduler.paused ? 'Paused' : 'Enabled' : 'Disabled', detail: scheduler.mode ?? 'schedule status', state: scheduler.enabled && !scheduler.paused ? 'ok' : 'attention', target: 'jobs' },
    { key: 'provider', label: 'Provider', value: data.provider?.ready ? 'Ready' : data.provider?.configured ? 'Unavailable' : 'Not configured', detail: data.provider?.allowNetwork ? 'network permitted' : 'network disabled', state: data.provider?.ready ? 'ok' : data.provider?.configured ? 'attention' : 'unknown', target: 'dream' },
    { key: 'capture', label: 'Capture spool', value: number(data.capture?.queued ?? data.capture?.pending), detail: 'queued items', state: 'ok', target: 'capture' },
    { key: 'storage', label: 'Storage', value: data.storage?.usageBytes?.total != null ? `${(data.storage.usageBytes.total / 1e9).toFixed(1)} GB` : 'Available', detail: data.storage?.pressureState ?? 'usage summary', state: data.storage?.pressureState === 'CRITICAL' || data.storage?.pressureState === 'READ_ONLY' ? 'problem' : data.storage?.pressureState === 'WARNING' ? 'attention' : 'ok', target: 'storage' },
  ];
}

export function extractHttpUrl(text: string): string {
  return text.match(/https?:\/\/[^\s<>\"']{1,2048}/i)?.[0]?.replace(/[),.;!?]+$/, '') ?? '';
}

export function parseKeyPointLines(text: string): string[] { return text.split('\n').filter(Boolean); }
export function formatKeyPointLines(lines: string[]): string { return lines.join('\n'); }

export interface ChatMessageView { role: 'user' | 'assistant' | 'system'; label: string; text: string; citations: Array<{ uri: string; revisionId: string }>; contextSources?: Array<{ uri: string; revisionId: string; title: string }>; sourceId?: string; examples?: string[]; suggestions?: Array<{id:string;title:string}>; kind?: string; provider?: string; model?: string; locality?: 'local'|'remote'; mode?: 'model'|'deterministic'; degradedReason?: { code:string; message:string }; timestamp?: string }
export function deriveChatMessages(turns: Array<{ role: string; text: string; citations?: Array<{ uri: string; revisionId: string }>; contextSources?: Array<{ uri: string; revisionId: string; title: string }>; sourceId?: string; examples?: string[]; suggestions?: Array<{id:string;title:string}>; kind?: string; provider?: string; model?: string; locality?: 'local'|'remote'; mode?: 'model'|'deterministic'; degradedReason?: { code:string; message:string }; timestamp?: string }>): ChatMessageView[] {
  return turns.map(turn => ({
    role: turn.role === 'user' || turn.role === 'system' ? turn.role : 'assistant',
    label: turn.role === 'user' ? 'You' : turn.role === 'system' ? 'Source' : 'Engram',
    text: turn.text,
    citations: turn.citations ?? [],
    contextSources: turn.contextSources,
    ...(turn.examples ? { examples: turn.examples } : {}), ...(turn.suggestions ? { suggestions: turn.suggestions } : {}), ...(turn.kind ? { kind: turn.kind } : {}), ...(turn.provider ? { provider: turn.provider } : {}), ...(turn.model ? { model: turn.model } : {}), ...(turn.locality ? { locality: turn.locality } : {}), ...(turn.mode ? { mode: turn.mode } : {}), ...(turn.degradedReason ? { degradedReason: turn.degradedReason } : {}),
    ...(turn.timestamp ? { timestamp: turn.timestamp } : {}),
    ...(turn.sourceId ? { sourceId: turn.sourceId } : {}),
  }));
}

export function newestChatScrollTop(feedHeight: number, feedScrollHeight: number, messageHeight: number, messageTop: number): number {
  return messageHeight > feedHeight ? Math.max(0, messageTop) : feedScrollHeight;
}

export function deriveAttention(data: State): Array<{ title: string; next: string }> {
  const items: Array<{ title: string; next: string }> = [];
  if (data.doctor?.state === 'problem') items.push({ title: 'Vault integrity needs attention', next: 'Run mdb verify to inspect the vault.' });
  else if (data.doctor?.state === 'attention') items.push({ title: 'Some vault checks need attention', next: 'Run mdb doctor for details.' });
  if (data.index?.problem) items.push({ title: 'The search index is stale or unavailable', next: 'Run mdb index verify; rebuild with mdb index rebuild if needed.' });
  if (Number(data.jobs?.failed ?? 0) + Number(data.jobs?.dead_letter ?? 0) > 0) items.push({ title: 'One or more jobs failed', next: 'Run mdb jobs status to inspect job state.' });
  if (data.storage?.pressureState === 'CRITICAL' || data.storage?.pressureState === 'READ_ONLY') items.push({ title: 'Storage pressure limits writes', next: 'Run mdb storage status before retrying writes.' });
  return items;
}

export const browserModels = `${deriveCards.toString()};\n${deriveAttention.toString()};\n${extractHttpUrl.toString()};\n${parseKeyPointLines.toString()};\n${formatKeyPointLines.toString()};\n${deriveChatMessages.toString()};\n${newestChatScrollTop.toString()};\n`;
