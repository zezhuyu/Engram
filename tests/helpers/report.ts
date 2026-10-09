import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface CaseRecord { suite: string; name: string; status: 'PASS' | 'FAIL'; seed?: number; detail?: Record<string, unknown> }
/** When VERIFY_CASES_FILE is set (by scripts/verify-*.ts), every case is appended as JSONL so reports are built from observed results. */
export function recordCase(record: CaseRecord): void {
  const file = process.env.VERIFY_CASES_FILE; if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n');
}
