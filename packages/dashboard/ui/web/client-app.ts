/** Client dashboard: screens, state, router and refresh loop. Joined with the shared core and the client pages; no server administration is included. */
export const clientAppJs = String.raw`
const MODE = 'client';
const screens = [
    ['this-device', 'This device', '', ''],
    ['workspaces', 'Workspaces', '', ''],
    ['cached-projects', 'Cached projects', '', ''],
    ['server', 'Server', '', ''],
    ['settings', 'Settings', '', '', true]
];
/** Changes that need the dashboard password typed again: rewriting the server endpoint in agent configuration. */
function reauthRequired(path) {
    return path === '/api/client/server/apply';
}
const hashParams = new URLSearchParams(location.hash.slice(1));
let token = hashParams.get('t') || '', sessionMode = false, passwordSet = false, clientMode = true, status = null, settings = null, page = 'this-device', paused = false, timer = 0, backoff = 10000, changed = new Map(), preview = null, replicaTick = 0;
// The one-time setup token is read once and removed from the address bar; ordinary screen links (#server) are kept.
if (token)
    history.replaceState(null, '', location.pathname + location.search);

async function render() {
    let view;
    switch (page) {
        case 'workspaces':
            view = await clientWorkspacesPage();
            break;
        case 'cached-projects':
            view = await cachedProjectsPage();
            break;
        case 'server':
            view = await serverPage();
            break;
        case 'settings':
            view = await clientSettingsPage();
            break;
        default:
            view = await thisDevicePage();
    }
    patchContent(view);
}

async function refresh() {
    clearTimeout(timer);
    if (paused || document.hidden)
        return;
    try {
        const result = await api('/api/client/status');
        status = { doctor: { state: result.state } };
        health.title = (result.checks || []).map(check => check.text).join(' · ');
        document.querySelector('#vault-path').textContent = 'This device' + (result.captureHost ? ' · ' + result.captureHost : '');
        setHealth();
        updated.textContent = 'Updated ' + new Date(result.generatedAt || Date.now()).toLocaleTimeString();
        disconnect.hidden = true;
        await render();
        backoff = 10000;
    }
    catch (error) {
        status = { doctor: { state: 'problem' } };
        health.title = error.message || 'Client status unavailable';
        setHealth();
        disconnect.hidden = false;
        backoff = Math.min(Math.max(backoff * 2, 10000), 300000);
        notify('Client status unavailable: ' + error.message);
    }
    schedulePoll(backoff);
}
startApp();
`;
