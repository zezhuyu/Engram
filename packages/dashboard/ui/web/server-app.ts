/** Server dashboard: screens, state, router and refresh loop. Joined with the shared core and the server pages; nothing client-side is included. */
export const serverAppJs = String.raw`
const MODE = 'server';
const screens = [
    ['overview', 'Overview', '', 'Memory'],
    ['knowledge', 'Knowledge', '', 'Memory'],
    ['chat', 'Wiki chat', '', 'Memory'],
    ['workspaces', 'Workspaces', '', 'Memory'],
    ['wiki-review', 'Wiki review', '', 'Memory'],
    ['dream', 'Dream & wiki', '', 'Learning'],
    ['profile-domains', 'Profile domains', '', 'Learning'],
    ['capture', 'Capture', '', 'Learning'],
    ['clients', 'Clients', '', 'System'],
    ['storage', 'Storage & index', '', 'System'],
    ['jobs', 'Jobs & scheduler', '', 'System'],
    ['settings', 'Settings', '', '', true],
    ['audit', 'Audit', '', '', true]
];
/** Changes that need the dashboard password typed again: secrets, tunnels and gateway control. */
function reauthRequired(path) {
    return path === '/api/settings/model-secret' || /^\/api\/connectors\/(?:openai\/(?:start|stop|restart)|claude\/(?:local\/apply|web\/rotate-key|web\/key)|anthropic-tunnel\/(?:certs|up|down))$/.test(path);
}
const hashParams = new URLSearchParams(location.hash.slice(1));
let token = hashParams.get('t') || '', sessionMode = false, passwordSet = false, clientMode = false, status = null, settings = null, page = 'overview', paused = false, timer = 0, backoff = 10000, changed = new Map(), preview = null, modelDetection = null;
// The one-time setup token is read once and removed from the address bar; ordinary screen links (#dream) are kept.
if (token)
    history.replaceState(null, '', location.pathname + location.search);

async function render(force = false, poll = false) {
    if (!force && ['knowledge', 'chat', 'workspaces', 'wiki-review'].includes(page) && content.childElementCount)
        return;
    if (!status) {
        content.replaceChildren(pageHeader(screens.find(item => item[0] === page)?.[1] ?? 'Overview', 'Connecting to your local vault…'), node('div', 'skeleton'));
        return;
    }
    let view;
    switch (page) {
        case 'clients':
            view = await clientsPage();
            break;
        case 'knowledge':
            view = await knowledgePage();
            break;
        case 'profile-domains':
            view = await profileDomainsPage();
            break;
        case 'chat':
            view = await chatPage();
            break;
        case 'workspaces':
            await workspacesPage();
            return;
        case 'wiki-review':
            await wikiReviewPage();
            return;
        case 'storage':
            view = storagePage();
            break;
        case 'jobs':
            view = jobsPage();
            break;
        case 'dream':
            view = await dreamPage();
            break;
        case 'capture':
            view = capturePage();
            break;
        case 'settings':
            if (!settings) {
                try {
                    await loadSettings();
                }
                catch (error) {
                    view = settingsError(error);
                    break;
                }
            }
            view = await settingsPage();
            break;
        case 'audit':
            view = await auditPage();
            break;
        default:
            view = await overview();
    }
    if (poll)
        patchContent(view);
    else
        content.replaceChildren(view);
}

async function refresh() {
    if (paused || document.hidden)
        return;
    try {
        status = await api('/api/status');
        disconnect.hidden = true;
        backoff = 10000;
        linkDown = false;
        health.title = '';
        setHealth();
        updated.textContent = 'Updated ' + new Date(status.generatedAt || Date.now()).toLocaleTimeString();
        await render(false, true);
    }
    catch (error) {
        disconnect.hidden = false;
        linkDown = true;
        setHealth();
        backoff = Math.min(Math.max(backoff * 2, 10000), 300000);
        notify('Dashboard disconnected: ' + error.message);
    }
    schedulePoll(backoff);
}
startApp();
`;
