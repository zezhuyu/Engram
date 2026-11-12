import { remoteUrlAllowed } from '../core/private-network.js';

/**
 * Minimal MCP-over-HTTP client for setup, refresh and diagnostics. It sends the bearer token only to a URL that passes the same transport rule as the capture spool
 * (HTTPS, loopback, or a tailnet host with the explicit opt-in), and it never logs or returns the token.
 */
export type RemoteFailure = 'transport-refused' | 'auth' | 'workspace' | 'network' | 'protocol';
export class RemoteError extends Error { constructor(readonly kind: RemoteFailure, message: string) { super(message); } }
export interface RemoteSession { sessionId: string; tools: string[]; call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value: unknown }> }

export async function openRemoteSession(options: { url: string; token: string; workspaceId?: string; timeoutMs?: number }): Promise<RemoteSession> {
  const url = new URL(options.url);
  if (!remoteUrlAllowed(url)) throw new RemoteError('transport-refused', 'Refusing to send a credential over plain HTTP to a non-private host');
  const timeout = options.timeoutMs ?? 4000, startedAt = Date.now();
  const post = async (body: unknown, headers: Record<string, string> = {}): Promise<Response> => {
    try { const remaining = timeout - (Date.now() - startedAt); if (remaining <= 0) throw new Error('timeout'); return await fetch(url, { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(remaining) }); }
    catch { throw new RemoteError('network', 'The Engram server did not answer'); }
  };
  const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'engram-setup', version: '1' } } }, options.workspaceId ? { 'X-Engram-Workspace': options.workspaceId } : {});
  if (init.status === 401) throw new RemoteError('auth', 'The server rejected the credential (401)');
  if (init.status === 403) throw new RemoteError(options.workspaceId ? 'workspace' : 'auth', `The credential cannot use workspace ${options.workspaceId ?? ''} or was refused (403)`.trim());
  const sessionId = init.headers.get('mcp-session-id');
  if (init.status !== 200 || !sessionId) throw new RemoteError('protocol', `Unexpected initialize response (${init.status})`);
  let id = 10;
  const rpc = async (method: string, params?: unknown): Promise<{ result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text: string }> }; error?: { message: string } }> => {
    const res = await post({ jsonrpc: '2.0', id: id++, method, params }, { 'Mcp-Session-Id': sessionId });
    if (res.status === 401 || res.status === 403) throw new RemoteError('auth', `The server refused the request (${res.status})`);
    try { return await res.json() as never; } catch { throw new RemoteError('protocol', 'Unreadable server response'); }
  };
  const listed = await rpc('tools/list'); const tools = (listed.result?.tools ?? []).map(tool => tool.name);
  return { sessionId, tools, async call(name, args) {
    const reply = await rpc('tools/call', { name, arguments: args });
    if (reply.error) return { isError: true, value: reply.error.message };
    const text = reply.result?.content?.[0]?.text; let value: unknown = text; try { value = text ? JSON.parse(text) : undefined; } catch { /* plain text */ }
    return { isError: !!reply.result?.isError, value };
  } };
}
