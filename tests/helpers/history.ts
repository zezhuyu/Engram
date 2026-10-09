export interface HistoryEntry { process: string; op: string; objectId?: string; expectedRevision?: string; observedRevision?: string; startedAt: number; endedAt: number; outcome: 'ok' | 'CONFLICT' | 'error'; error?: string }
/** Invocation/response log for concurrent histories. */
export class HistoryRecorder {
  readonly entries: HistoryEntry[] = [];
  record(entry: HistoryEntry): void { this.entries.push(entry); }
  parse(processName: string, stdout: string): void { for (const line of stdout.split('\n')) if (line.startsWith('H ')) this.record({ process: processName, ...JSON.parse(line.slice(2)) as Omit<HistoryEntry, 'process'> }); }
  forObject(id: string): HistoryEntry[] { return this.entries.filter(e => e.objectId === id); }
}
