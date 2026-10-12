import net from 'node:net';

/**
 * Opt-in transport trust for deployments that only ever run inside a Tailscale tailnet (WireGuard-encrypted, device-authenticated).
 * It never relaxes anything by default: HTTPS stays mandatory unless the operator sets the variable below, and even then plain HTTP
 * is accepted only for tailnet addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) or MagicDNS names (*.ts.net), never for a public host.
 * Bearer-token authentication, allowed-host checks, rate limits and ACLs are unchanged.
 */
export const TRANSPORT_TRUST_ENV = 'MDB_TRANSPORT_TRUST';

export function isTailnetHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(name)) { const [a, b] = name.split('.').map(Number) as [number, number]; return a === 100 && b >= 64 && b <= 127; }
  if (net.isIPv6(name)) return name.startsWith('fd7a:115c:a1e0:');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(name);
}

export const tailnetTrusted = (env: NodeJS.ProcessEnv): boolean => env[TRANSPORT_TRUST_ENV] === 'tailscale';

/** True when `url` may carry captures: HTTPS, loopback HTTP, or (only with the explicit opt-in) HTTP to a tailnet host. */
export function remoteUrlAllowed(url: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) return true;
  return tailnetTrusted(env) && isTailnetHost(url.hostname);
}

/** Opt-in bind rule: a tailnet address, or all interfaces (0.0.0.0 / ::) because every connection is then filtered by `peerAllowed`. */
export function bindAllowedWithoutTls(host: string, env: NodeJS.ProcessEnv): boolean {
  if (!tailnetTrusted(env)) return false;
  return host === '0.0.0.0' || host === '::' || (net.isIP(host) !== 0 && isTailnetHost(host));
}

/** Per-connection filter for the opt-in mode: only loopback and tailnet peers are served, whatever interface the packet arrived on. IPv4-mapped IPv6 is unwrapped. */
export function peerAllowed(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.replace(/^::ffff:/i, '');
  return address === '127.0.0.1' || address === '::1' || isTailnetHost(address);
}
