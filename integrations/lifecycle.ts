import type { Engram } from '../packages/sdk/index.js';
import type { Scope } from '../packages/core/types.js';
export type CaptureEvent = 'session_start' | 'user_message' | 'tool_outcome' | 'session_end';
export interface CaptureOptions { enabled: boolean; allowedEvents: CaptureEvent[]; allowedSources: string[]; redact?: (body: string) => string }
/** Portable opt-in host adapter. The host supplies explicit events; this never scans files or transcripts. */
export class LifecycleAdapter {
  private sessionId?: string;
  constructor(private readonly client: Engram, private readonly scope: Scope, private readonly options: CaptureOptions) {}
  async capture(event: CaptureEvent, source: string, body = ''): Promise<unknown> {
    if (!this.options.enabled || !this.options.allowedEvents.includes(event) || !this.options.allowedSources.includes(source)) return { captured: false, reason: 'Capture not enabled for this event/source' };
    const scrubbed = this.options.redact ? this.options.redact(body) : body.replace(/\b(?:sk-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._~-]+)\b/g, '[REDACTED]');
    if (event === 'session_start') {
      const result = await this.client.intelligence.sessionStart({ scope: this.scope, source });
      this.sessionId = result.id;
      return result;
    }
    if (!this.sessionId) return { captured: false, reason: 'No explicit active session' };
    if (event === 'session_end') { const result = await this.client.intelligence.sessionEnd({ sessionId: this.sessionId, body: scrubbed }); this.sessionId = undefined; return result; }
    return this.client.intelligence.observe({ sessionId: this.sessionId, body: scrubbed, source });
  }
}
