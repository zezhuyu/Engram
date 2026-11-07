import { spawn } from 'node:child_process';

export interface DashboardAnnouncement { urls: string[]; passwordSet: boolean; }

const ALERT_SCRIPT = 'on run argv\ndisplay alert (item 1 of argv) message (item 2 of argv) buttons {"OK"} default button "OK"\nend run';

export function dashboardBanner({ urls, passwordSet }: DashboardAnnouncement): string {
  const lines = ['', '==================== Engram dashboard ====================',
    ...urls.map(url => `  ${url}`),
    passwordSet ? '  Sign in with your dashboard password.' : '  First run: open the URL above to set your dashboard password.',
    '  The #t=… part is a private access token; do not share it.',
    '==========================================================', ''];
  return lines.join('\n');
}

/** macOS shows a native alert (the text travels as argv, never inside the script); every other platform prints a banner to stderr. */
export function announceDashboard(announcement: DashboardAnnouncement, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'darwin' && process.env.MDB_DASHBOARD_ALERT !== 'false' && process.env.NODE_ENV !== 'test') {
    const message = `${announcement.urls.join('\n')}\n\n${announcement.passwordSet ? 'Sign in with your dashboard password.' : 'First run: open this URL to set your password.'}\nThe #t=… part is a private token.`;
    try {
      spawn('osascript', ['-e', ALERT_SCRIPT, 'Engram dashboard', message], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    } catch { /* the stdout URL list remains */ }
    return;
  }
  process.stderr.write(dashboardBanner(announcement));
}
