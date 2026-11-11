import { spawn } from 'node:child_process';

export interface DashboardAnnouncement { urls: string[]; passwordSet: boolean; }

const ALERT_SCRIPT = 'on run argv\ndisplay alert (item 1 of argv) message (item 2 of argv) buttons {"OK"} default button "OK"\nend run';

/** Once a password exists the private access token is no longer needed: it is never shown, printed or opened. */
export const withoutToken = (url: string): string => url.split('#')[0]!;

export function dashboardBanner({ urls, passwordSet }: DashboardAnnouncement): string {
  const lines = ['', '==================== Engram dashboard ====================',
    ...(passwordSet ? urls.map(url => `  ${withoutToken(url)}`) : urls.map(url => `  ${url}`)),
    passwordSet ? '  Sign in with your dashboard password.' : '  First run: open the URL above to set your dashboard password.',
    ...(passwordSet ? [] : ['  The #t=… part is a private access token; do not share it.']),
    '==========================================================', ''];
  return lines.join('\n');
}

/** macOS shows a native alert (the text travels as argv, never inside the script); every other platform prints a banner to stderr. */
export function announceDashboard(announcement: DashboardAnnouncement, platform: NodeJS.Platform = process.platform, spawnProcess: typeof spawn = spawn): void {
  // Supervised client dashboards write the one-time URL to a dedicated private note file.
  // The wrapper captures stdout there; never repeat the token in the supervisor's shared log.
  const privateNote = !!process.env.MDB_DASHBOARD_TOKEN_NOTE;
  // A password is already set: no pop-up window and no token URL. The pop-up appears only on first use (no password yet).
  if (announcement.passwordSet) { if (!privateNote) process.stderr.write(dashboardBanner(announcement)); return; }
  const injectedSpawn = spawnProcess !== spawn;
  if (platform === 'darwin' && process.env.MDB_DASHBOARD_ALERT !== 'false' && (process.env.NODE_ENV !== 'test' || injectedSpawn)) {
    const message = `${announcement.urls.join('\n')}\n\nFirst run: open this URL to set your password.\nThe #t=… part is a private token.`;
    try {
      spawnProcess('osascript', ['-e', ALERT_SCRIPT, 'Engram dashboard', message], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    } catch { /* the stdout URL list remains */ }
    return;
  }
  if (privateNote) return;
  process.stderr.write(dashboardBanner(announcement));
}
