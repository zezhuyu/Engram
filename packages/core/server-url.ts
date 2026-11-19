/** Path prefix a server is mounted under, derived from its public MCP URL (`https://host/engram/mcp` -> `/engram`; `https://host/mcp` -> ``). */
export function serverBasePath(value: string): string {
  let pathname: string; try { pathname = new URL(value).pathname; } catch { return ''; }
  return pathname.replace(/\/+$/, '').replace(/\/mcp$/, '').replace(/\/+$/, '');
}

/** Resolve a server route (`/replica/v1/hello`) against a server base URL, keeping any gateway prefix. Query strings in `route` are preserved. */
export function serverRouteUrl(base: string | URL, route: string): URL {
  const url = new URL(base.toString()), prefix = serverBasePath(url.toString()), target = new URL(route, 'http://route.invalid');
  url.pathname = prefix + target.pathname; url.search = target.search; url.hash = '';
  return url;
}
