/** Browser runtime shared by both dashboards (served as part of /assets/app.js). Contains no page that belongs to only one mode. */
export const coreJs = String.raw`const nav = document.querySelector('#nav'), content = document.querySelector('#content'), health = document.querySelector('#health'), updated = document.querySelector('#updated'), disconnect = document.querySelector('#disconnect'), pause = document.querySelector('#pause'), toast = document.querySelector('#toast');

const navIcons = { clients: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM21 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8', 'profile-domains': 'M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01', 'this-device': 'M3 5h18v11H3zM8 20h8M12 16v4', server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01', 'cached-projects': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', overview: 'M3 10 12 3 21 10v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z', knowledge: 'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 0 4 22z M4 5v15a2 2 0 0 1 2-2h14M8 7h8M8 11h8', chat: 'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8A8.5 8.5 0 0 1 8.7 4a8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z', workspaces: 'M3 7h8l2 2h8v11H3z M3 7V5h7l2 2', 'wiki-review': 'M4 6h16M4 12h10M4 18h7m-1 1 3 3 6-7', storage: 'M4 5c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3', jobs: 'M12 8v5l3 2m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0', dream: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1m-8.6 8.6-2.1 2.1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0', capture: 'M12 3v12m-5-5 5 5 5-5M5 20h14', settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm7.4 7 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.8 1l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.8-1l-1.7.6-1.4-2.4L5.1 15a8 8 0 0 1 0-2l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.8-1l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.8 1l1.7-.6 1.4 2.4-1.4 1.1a8 8 0 0 1 0 2z', audit: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' };



const statusNames = ['ok', 'attention', 'problem', 'unknown'], icons = { ok: '✓', attention: '⚠', problem: '⬟', unknown: '○' };

function node(tag, cls, text) { const element = document.createElement(tag); if (cls)
    element.className = cls; if (text !== undefined)
    element.textContent = String(text); return element; }

function formatDuration(ms) { if (ms == null || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0)
    return '—'; if (ms < 1000)
    return '<1 s'; if (ms < 60000)
    return Math.min(59, Math.round(ms / 1000)) + ' s'; const totalSeconds = Math.floor(ms / 1000), minutes = Math.floor(totalSeconds / 60), remainingSeconds = totalSeconds % 60; if (minutes < 60)
    return minutes + ' min' + (remainingSeconds ? ' ' + String(remainingSeconds).padStart(2, '0') + ' s' : ''); const hours = Math.floor(minutes / 60), remainingMinutes = minutes % 60; if (hours < 24)
    return hours + ' h' + (remainingMinutes ? ' ' + String(remainingMinutes).padStart(2, '0') + ' min' : ''); const days = Math.floor(hours / 24), remainingHours = hours % 24; return days + ' d ' + String(remainingHours).padStart(2, '0') + ' h'; }

function safe(value) { if (value === null || value === undefined || value === '')
    return '—'; if (typeof value === 'object')
    return JSON.stringify(value); return String(value); }

function fmt(value) { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : safe(value); }

function statusState(value) { return statusNames.includes(value) ? value : 'unknown'; }

function addMetric(list, label, value) { list.append(node('dt', '', label), node('dd', '', safe(value))); }

async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const reauthNeeded = reauthRequired(path);
    let reauth = {};
    if (reauthNeeded) {
        const password = prompt('Re-enter your local dashboard password to authorize this change');
        if (password === null)
            throw new Error('Change cancelled');
        reauth = { 'X-Engram-Reauth-Password': password };
    }
    const response = await fetch(path, { method, ...options, headers: { ...(token && !sessionMode ? { Authorization: 'Bearer ' + token } : {}), ...(sessionMode ? { 'X-Engram-Dashboard': '1' } : {}), ...reauth, ...options.headers } });
    let body = {};
    try {
        body = await response.json();
    }
    catch { }
    if (response.status === 401 && path.startsWith('/api/') && !path.startsWith('/api/auth/')) {
        sessionMode = false;
        token = '';
        showLogin(true);
        throw new Error('Sign-in required');
    }
    if (response.status === 429) {
        showLockout(response.headers.get('retry-after'));
        throw new Error('Too many sign-in attempts');
    }
    if (!response.ok) {
        const error = new Error(body?.error?.message || 'Request failed (' + response.status + ')');
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
    }
    return body;
}
function showLogin(expired = false) { clearTimeout(timer); const wrap = node('main', 'login-page'), card = node('section', 'login-card'), title = passwordSet ? 'Welcome back' : 'Set a password'; const logo = document.createElement('img'); logo.src = '/assets/logo-64.png'; logo.alt = 'Engram'; logo.className = 'auth-logo'; card.append(logo, node('p', 'eyebrow', 'ENGRAM / LOCAL DASHBOARD'), node('h1', '', title)); if (!passwordSet) {
    card.append(node('p', '', 'Set a password to protect this local dashboard. Use the one-time token in the full URL printed by mdb dashboard. It ends with #t=.... The token changes on every restart.'));
    if (!token)
        card.append(node('p', 'auth-error', clientMode ? 'Open the Engram Client menu and choose Open dashboard, or Copy first-time sign-in link.' : 'Open the full sign-in URL printed by mdb dashboard to set the first password.'));
}
else
    card.append(node('p', '', expired ? 'Your session ended. Enter your dashboard password to continue.' : 'Enter your dashboard password.')); const form = document.createElement('form'); form.className = 'auth-form'; const passwordWrap = node('div', 'password-field'), password = document.createElement('input'); password.type = 'password'; password.autocomplete = passwordSet ? 'current-password' : 'new-password'; password.required = true; password.minLength = 12; password.maxLength = 256; password.setAttribute('aria-label', passwordSet ? 'Password' : 'New password'); password.placeholder = passwordSet ? 'Password' : 'At least 12 characters'; passwordWrap.append(password); const reveal = node('button', 'icon-button password-reveal', '◉'); reveal.type = 'button'; reveal.setAttribute('aria-label', 'Show password'); reveal.title = 'Show password'; reveal.addEventListener('click', () => { const shown = password.type === 'text'; password.type = shown ? 'password' : 'text'; if (confirm)
    confirm.type = shown ? 'password' : 'text'; reveal.textContent = shown ? '◉' : '◎'; reveal.setAttribute('aria-label', shown ? 'Show password' : 'Hide password'); reveal.title = reveal.getAttribute('aria-label'); }); passwordWrap.append(reveal); form.append(passwordWrap); let confirm; if (!passwordSet) {
    const strength = node('small', 'password-strength', 'Use 12 or more characters. A longer phrase is stronger.');
    password.addEventListener('input', () => { const length = password.value.length; strength.textContent = length < 12 ? 'Add ' + (12 - length) + ' more characters.' : length < 16 ? 'Good length. A few more words make it stronger.' : 'Strong passphrase length.'; });
    form.append(strength);
    confirm = document.createElement('input');
    confirm.type = 'password';
    confirm.autocomplete = 'new-password';
    confirm.required = true;
    confirm.minLength = 12;
    confirm.maxLength = 256;
    confirm.setAttribute('aria-label', 'Confirm password');
    confirm.placeholder = 'Confirm password';
    form.append(confirm);
} const message = node('p', 'auth-error'); message.setAttribute('role', 'alert'); const submit = node('button', 'primary', passwordSet ? 'Sign in' : 'Set password'); submit.type = 'submit'; form.append(message, submit); form.addEventListener('submit', async (event) => { event.preventDefault(); submit.disabled = true; message.textContent = ''; try {
    if (passwordSet) {
        await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Dashboard': '1' }, body: JSON.stringify({ password: password.value }) }).then(async (r) => { if (!r.ok) {
            const e = await r.json();
            const err = new Error(e.error?.message || 'Sign-in failed');
            err.retryAfter = r.headers.get('retry-after');
            throw err;
        } });
    }
    else {
        if (!token)
            throw new Error(clientMode ? 'Open the Engram Client menu and choose Open dashboard, or Copy first-time sign-in link.' : 'Open the full sign-in URL printed by mdb dashboard.');
        await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Dashboard': '1' }, body: JSON.stringify({ token, password: password.value, confirm: confirm.value }) }).then(async (r) => { if (!r.ok) {
            const e = await r.json();
            throw new Error(e.error?.message || 'Password setup failed');
        } });
        passwordSet = true;
        location.reload();
        return;
    }
    sessionMode = true;
    token = '';
    location.reload();
}
catch (error) {
    message.textContent = error.message + (error.retryAfter ? ' Retry in ' + error.retryAfter + ' seconds.' : '');
}
finally {
    submit.disabled = false;
} }); card.append(form); wrap.append(card); document.body.replaceChildren(wrap); password.focus(); }

function showLockout(seconds) { clearTimeout(timer); const wrap = node('main', 'login-page'), card = node('section', 'login-card'); card.append(node('p', 'eyebrow', 'ENGRAM / LOCAL DASHBOARD'), node('h1', '', 'Sign-in temporarily locked'), node('p', '', 'Too many sign-in attempts. ' + (seconds ? 'Try again in ' + seconds + ' seconds.' : 'Wait briefly before trying again.'))); const retry = node('button', 'primary', 'Try again'); retry.type = 'button'; retry.addEventListener('click', () => location.reload()); card.append(retry); wrap.append(card); document.body.replaceChildren(wrap); }

function notify(message) { toast.textContent = message; clearTimeout(notify.timer); notify.timer = setTimeout(() => toast.textContent = '', 4500); }

function schedulePoll(delay = 10000) { clearTimeout(timer); if (!paused && !document.hidden)
    timer = setTimeout(refresh, delay); }

function svgIcon(pathData) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); path.setAttribute('d', pathData); svg.append(path); return svg; }

function navRender() {
    const previousScroll = nav.querySelector?.('.nav-scroll')?.scrollTop ?? 0;
    const scroll = node('div', 'nav-scroll'), foot = node('div', 'nav-foot');
    let section = null, current = null;
    for (const [id, label, , group, pinned] of screens) {
        const link = node('a', 'nav-link');
        link.href = '#' + id;
        link.setAttribute('aria-current', page === id ? 'page' : 'false');
        const glyph = node('span', 'nav-icon');
        glyph.append(svgIcon(navIcons[id] || 'M4 12h16'));
        glyph.setAttribute('aria-hidden', 'true');
        link.append(glyph, node('span', '', label));
        link.addEventListener('click', () => { closeMenu(); go(id); });
        if (id === page)
            current = [group, label];
        if (pinned) {
            foot.append(link);
            continue;
        }
        if (group && group !== section) {
            section = group;
            scroll.append(node('p', 'nav-label', group));
        }
        scroll.append(link);
    }
    nav.replaceChildren(scroll, foot);
    scroll.scrollTop = previousScroll;
    const crumb = document.querySelector('#crumb');
    if (crumb) {
        crumb.replaceChildren();
        if (current && current[0]) {
            crumb.append(node('span', 'crumb-group', current[0] + ' / '));
        }
        if (current) {
            const strong = node('strong', '', current[1]);
            crumb.append(strong);
        }
    }
}
function go(id) {
    if (!screens.some(item => item[0] === id))
        id = screens[0][0];
    page = id;
    if (location.hash.slice(1).split('/')[0] !== id)
        location.hash = '#' + id;
    navRender();
    render(true);
    content.focus({ preventScroll: true });
}
function screenFromHash() {
    const wanted = location.hash.slice(1).split('/')[0];
    return screens.some(item => item[0] === wanted) ? wanted : screens[0][0];
}
function closeMenu() {
    document.body.classList.remove('nav-open');
    document.querySelector('#menu')?.setAttribute('aria-expanded', 'false');
}
function initShell() {
    const menu = document.querySelector('#menu');
    menu?.addEventListener('click', () => { const open = document.body.classList.toggle('nav-open'); menu.setAttribute('aria-expanded', String(open)); });
    document.querySelector('#scrim')?.addEventListener('click', closeMenu);
    document.addEventListener('keydown', event => { if (event.key === 'Escape')
        closeMenu(); });
}
function pageHeader(title, description) {
    const head = node('header', 'page-head'), block = node('div');
    block.append(node('h1', '', title));
    if (description)
        block.append(node('p', '', description));
    head.append(block);
    return head;
}
function panel(title) { const box = node('section', 'panel'); box.append(node('h2', '', title)); return box; }

function metricPanel(title, entries) { const box = panel(title), list = node('dl', 'metric-list'); for (const [label, value] of entries)
    addMetric(list, label, value); box.append(list); return box; }

function statusTone(data) { if (data?.doctor?.state === 'problem' || data?.index?.problem || Number(data?.jobs?.failed || 0) + Number(data?.jobs?.dead_letter || 0) > 0 || ['CRITICAL', 'READ_ONLY'].includes(data?.storage?.pressureState))
    return 'problem'; if (data?.doctor?.state === 'attention' || data?.provider?.configured && !data?.provider?.ready)
    return 'attention'; return 'ok'; }

/** True while the last refresh could not reach the backend; the pill must not keep showing the previous good result. */
let linkDown = false;
function setHealth() {
    if (linkDown) {
        health.className = 'pill state-problem';
        health.replaceChildren(node('span', '', icons.problem), node('span', '', 'Disconnected'));
        health.title = 'Cannot reach the dashboard backend. Retrying automatically.';
        return;
    }
    const state = status ? statusTone(status) : 'unknown'; health.className = 'pill state-' + state; health.replaceChildren(node('span', '', icons[state]), node('span', '', state === 'ok' ? 'OK' : state === 'problem' ? 'Problem' : state === 'attention' ? 'Attention' : 'Connecting')); }

function dataTable(title, columns, rows) { const box = panel(title), wrap = node('div', 'table-wrap'), table = node('table', 'data-table'), head = node('thead'), heading = node('tr'); for (const column of columns)
    heading.append(node('th', '', column)); head.append(heading); table.append(head); const body = node('tbody'); if (!rows.length) {
    const row = node('tr'), cell = node('td', 'empty', '');
    cell.colSpan = columns.length;
    const empty = node('div', 'empty-state'), illustration = node('div', '');
    illustration.append(svgIcon('M12 3 20 7v10l-8 4-8-4V7zm0 0v18M4 7l8 5 8-5M8 9v4m8-4v4'));
    empty.append(illustration, node('strong', '', 'No ' + title.toLowerCase() + ' yet'), node('p', '', 'New records will appear here as work runs.'));
    cell.append(empty);
    row.append(cell);
    body.append(row);
} for (const values of rows) {
    const row = node('tr');
    for (const value of values) {
        const cell = node('td', '', safe(value));
        if (value != null)
            cell.title = String(value);
        row.append(cell);
    }
    body.append(row);
} table.append(body); wrap.append(table); box.append(wrap); return box; }

function relativeLabel(iso) { const delta = Date.parse(iso) - Date.now(), minutes = Math.round(Math.abs(delta) / 60000); if (minutes < 1)
    return 'now'; const hours = Math.floor(minutes / 60), days = Math.floor(hours / 24), restHours = hours % 24, restMinutes = minutes % 60; let value = days ? days + ' d ' + restHours + ' h' : hours ? hours + ' h ' + restMinutes + ' min' : minutes + ' min'; return delta >= 0 ? 'in ' + value : value + ' ago'; }

function relativeTimeNode(iso) { const el = node('span', '', relativeLabel(iso)); el.setAttribute('data-relative-time', iso); return el; }

function tickRelativeTimes() { document.querySelectorAll('[data-relative-time]').forEach(el => { const iso = el.getAttribute('data-relative-time'); if (iso)
    el.textContent = relativeLabel(iso); }); }

if (typeof setInterval === 'function')
    setInterval(() => { for (const age of document.querySelectorAll('.folder-context-age'))
        age.textContent = contextAgeLabel(Number(age.getAttribute('data-age-ms'))); }, 1000);

function isFormControl(el) { return el.nodeType === 1 && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName); }

function markTouched(event) { const el = event.target; if (el && el.setAttribute && isFormControl(el))
    el.setAttribute('data-touched', '1'); }

function controlDirty(el) { if (el === document.activeElement || el.getAttribute('data-touched') === '1')
    return true; return el.type === 'file' && !!(el.files && el.files.length); }

function containsDirty(el) { if (el.nodeType !== 1)
    return false; if (isFormControl(el) && controlDirty(el))
    return true; return [...el.querySelectorAll('input,textarea,select')].some(controlDirty); }

function nodeSig(n) { if (n.nodeType === 3)
    return 't:' + n.data; if (n.nodeType !== 1)
    return ''; const attrs = [...n.attributes].filter(a => a.name !== 'data-touched').map(a => a.name + '=' + a.value).sort().join('&'); return n.tagName + '[' + attrs + ']' + (isFormControl(n) ? 'v:' + n.value : '') + '(' + [...n.childNodes].map(nodeSig).join('|') + ')'; }

function hasConnector(node) { return node.nodeType === 1 && ((node.getAttribute && node.getAttribute('data-connector-live') === 'true') || [...(node.childNodes || [])].some(hasConnector)); }

function patchConnectorNode(oldNode, newNode) { if (nodeSig(oldNode) === nodeSig(newNode))
    return; if (oldNode.nodeType === 3 && newNode.nodeType === 3) {
    oldNode.data = newNode.data;
    return;
} if (oldNode.nodeType !== 1 || newNode.nodeType !== 1 || oldNode.tagName !== newNode.tagName) {
    oldNode.replaceWith(newNode);
    return;
} for (const attr of [...oldNode.attributes])
    if (!newNode.hasAttribute(attr.name))
        oldNode.removeAttribute(attr.name); for (const attr of [...newNode.attributes])
    if (oldNode.getAttribute(attr.name) !== attr.value)
        oldNode.setAttribute(attr.name, attr.value); if (isFormControl(oldNode) && !controlDirty(oldNode)) {
    if (oldNode.value !== newNode.value)
        oldNode.value = newNode.value;
    if (oldNode.checked !== newNode.checked)
        oldNode.checked = newNode.checked;
} const a = [...oldNode.childNodes], b = [...newNode.childNodes], keyed = new Map(a.filter(item => item.nodeType === 1 && item.getAttribute('data-key')).map(item => [item.getAttribute('data-key'), item])); for (let i = 0; i < b.length; i++) {
    const next = b[i], key = next.nodeType === 1 ? next.getAttribute('data-key') : null, prior = key ? keyed.get(key) : a[i];
    if (prior) {
        if (prior !== a[i])
            oldNode.insertBefore(prior, a[i] || null);
        patchConnectorNode(prior, next);
    }
    else if (a[i])
        a[i].replaceWith(next);
    else
        oldNode.append(next);
} for (const prior of a)
    if (prior.parentNode === oldNode && !b.some((next, index) => next === prior || (next.nodeType === 3 && a[index] === prior) || (next.nodeType === 1 && prior.nodeType === 1 && next.getAttribute('data-key') === prior.getAttribute('data-key'))))
        prior.remove(); }

function patchNode(oldNode, newNode) { if (nodeSig(oldNode) === nodeSig(newNode))
    return; if (hasConnector(oldNode)) {
    patchConnectorNode(oldNode, newNode);
    return;
} if (!containsDirty(oldNode)) {
    oldNode.replaceWith(newNode);
    return;
} if (oldNode.nodeType !== 1 || newNode.nodeType !== 1 || oldNode.tagName !== newNode.tagName)
    return; const a = [...oldNode.childNodes], b = [...newNode.childNodes]; if (a.length !== b.length)
    return; for (let i = 0; i < a.length; i++)
    patchNode(a[i], b[i]); }

function patchContent(view) { const next = view.nodeType === 11 ? [...view.childNodes] : [view], old = [...content.childNodes]; if (old.length === next.length) {
    next.forEach((n, i) => patchNode(old[i], n));
    return;
} if (!containsDirty(content))
    content.replaceChildren(view); }

content.addEventListener('input', markTouched);

content.addEventListener('change', markTouched);

function startApp() {
    pause.addEventListener('click', () => { paused = !paused; pause.setAttribute('aria-pressed', String(paused)); pause.textContent = paused ? 'Resume refresh' : 'Pause refresh'; clearTimeout(timer); if (!paused)
        refresh(); });
    document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (!document.hidden && !paused)
        refresh(); });
    window.addEventListener('hashchange', () => go(screenFromHash()));
    document.querySelector('#logout').addEventListener('click', async () => {
        try {
            await api('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        }
        catch { }
        sessionMode = false;
        document.querySelector('#logout').hidden = true;
        showLogin();
    });
    initShell();
    page = screenFromHash();
    navRender();
    setHealth();
    fetch('/api/auth/status').then(r => r.json()).then(info => {
        passwordSet = !!info.passwordSet;
        if (passwordSet) {
            sessionMode = true;
            document.querySelector('#logout').hidden = false;
            refresh();
        }
        else
            showLogin();
    }).catch(() => showLogin());
}

`;
