/** Pages of the CLIENT dashboard only. Never included in the server dashboard script. */
export const clientPagesJs = String.raw`let clientFoldersSnapshot = null, clientFoldersFetchedAt = 0;

function contextAgeLabel(ageMs) { if (ageMs == null)
    return '—'; const age = Math.max(0, ageMs + Date.now() - clientFoldersFetchedAt); if (age < 60000)
    return 'just now'; if (age < 3600000)
    return Math.floor(age / 60000) + 'm ago'; if (age < 86400000)
    return Math.floor(age / 3600000) + 'h ago'; return Math.floor(age / 86400000) + 'd ago'; }

async function cachedProjectsPage() {
    const wrap = node('div');
    wrap.setAttribute('data-connector-live', 'true');
    wrap.append(pageHeader('Cached projects', 'Project folders on this device. Personal, wiki and other shared areas remain live on the server and are never cached.'));
    const foldersPanel = panel('Project folders on this device');
    let folderData;
    try {
        if (!clientFoldersSnapshot || Date.now() - clientFoldersFetchedAt >= 10000) {
            clientFoldersSnapshot = await api('/api/client/folders');
            clientFoldersFetchedAt = Date.now();
        }
        folderData = clientFoldersSnapshot;
    }
    catch (error) {
        folderData = null;
        foldersPanel.append(node('p', 'empty', 'Project folders unavailable: ' + error.message));
    }
    const folderRows = folderData?.rows || [];
    if (folderData && folderRows.length) {
        const table = node('table', 'data-table'), head = node('thead'), header = node('tr');
        for (const label of ['Folder', 'Workspace', 'Mode', 'State', 'Context cache', 'Queued writes', 'Conflicts', 'Hooks'])
            header.append(node('th', '', label));
        head.append(header);
        const body = node('tbody');
        for (const item of folderRows) {
            const row = node('tr');
            row.setAttribute('data-key', 'folder-' + item.path);
            const folder = node('td', '', String(item.folderName));
            folder.title = String(item.path);
            folder.setAttribute('aria-label', String(item.folderName) + ' · ' + String(item.path));
            row.append(folder, node('td', '', String(item.workspaceId)), node('td', '', String(item.mode)));
            const state = !item.mounted ? 'unmounted' : item.mode === 'replica' ? (item.replica?.state === 'synced' ? 'synced' : item.replica?.state === 'offline' || item.replica?.state === 'disabled' || !item.replica?.state ? 'offline' : 'stale') : item.mode === 'remote' ? (item.contextCache?.stale ? 'stale' : item.contextCache?.ageMs == null ? 'offline' : 'synced') : 'synced';
            row.append(node('td', '', state));
            const cacheCell = node('td');
            if (item.contextCache?.ageMs != null) {
                const age = node('span', 'folder-context-age', contextAgeLabel(item.contextCache.ageMs));
                age.setAttribute('data-age-ms', String(item.contextCache.ageMs));
                if (item.contextCache.stale)
                    cacheCell.append(age, node('span', 'badge', 'STALE'));
                else
                    cacheCell.append(age);
            }
            else
                cacheCell.append(node('span', 'muted', '—'));
            row.append(cacheCell, node('td', '', String(item.queuedWrites || 0)), node('td', '', String(item.replica?.conflicts || 0)), node('td', '', item.hooksInstalled ? 'Installed' : '—'));
            body.append(row);
        }
        table.append(head, body);
        foldersPanel.append(table);
        if (folderData.approximate)
            foldersPanel.append(node('p', 'muted', 'Folder status is approximate; refresh shortly for the remaining entries.'));
    }
    else if (folderData)
        foldersPanel.append(node('p', 'empty', 'No project folders are bound on this machine. Run mdb init --project in a project folder, or enable replica sync below.'));
    wrap.append(foldersPanel);
    let data;
    try {
        data = await api('/api/client/replica');
    }
    catch (error) {
        wrap.append(node('p', 'empty', 'Replica status unavailable: ' + error.message));
        return wrap;
    }
    const pill = node('span', 'badge', data.state === 'disabled' ? 'Replica sync is not enabled' : String(data.state));
    wrap.append(pill);
    if (!data.enabled) {
        const enable = node('button', 'primary', 'Enable replica sync');
        enable.onclick = async () => { try {
            await api('/api/client/replica/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            notify('Replica sync enabled');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        } };
        wrap.append(enable);
        return wrap;
    }
    const status = panel('Replica status');
    for (const replica of data.replicas || []) {
        status.append(node('h3', '', String(replica.replicaId) + ' · ' + String(replica.state)));
        const table = node('div', 'metric-list');
        for (const [key, value] of Object.entries(replica.status || {}))
            if (!['conflicts', 'workspaces'].includes(key))
                table.append(node('dt', '', key), node('dd', '', safe(value)));
        status.append(table);
    }
    wrap.append(status);
    let projects;
    try {
        projects = await api('/api/client/replica/projects');
    }
    catch (error) {
        wrap.append(node('p', 'empty', 'Project status unavailable: ' + error.message));
        return wrap;
    }
    const rows = projects.rows || [];
    if (rows.length) {
        const table = node('table', 'data-table'), body = node('tbody');
        for (const item of rows) {
            const row = node('tr');
            row.setAttribute('data-key', 'replica-' + item.replicaId + '-' + item.workspaceId);
            const workspaceCell = node('td', '', String(item.workspaceId) + (item.folders?.length ? ' · ' + item.folders.map(f => f.name + (f.mounted ? '' : ' (unavailable)')).join(', ') : ''));
            if (item.folders?.length)
                workspaceCell.title = item.folders.map(f => f.path).join('\n');
            row.append(workspaceCell, node('td', '', String(item.state) + ' · ' + String(item.pendingPush) + ' pending · ' + String(item.diverged) + ' diverged · ' + String(item.deferred) + ' deferred'), node('td', '', String(item.lastPullAt || '—')), node('td', '', String(item.lastPushAt || '—')), node('td', '', String(item.diskSizeBytes || 0) + (item.diskSizeApproximate ? ' bytes (approx.)' : ' bytes') + ' / ' + String(item.diskQuotaBytes || 0) + ' byte quota' + (item.diskQuotaWarning ? ' · WARNING ≥80%' : '')));
            const actions = node('td'), sync = node('button', 'secondary', 'Sync now');
            sync.onclick = async () => { try {
                await api('/api/client/replica/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicaId: item.replicaId }) });
                notify('Sync completed');
                void render(true);
            }
            catch (error) {
                notify(error.message);
            } };
            const remove = node('button', 'secondary', 'Remove');
            remove.onclick = async () => { if (!confirm('Unenroll ' + item.workspaceId + ' from this device? Local replica data will be kept.'))
                return; try {
                await api('/api/client/replica/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicaId: item.replicaId, workspaceId: item.workspaceId }) });
                notify('Workspace unenrolled; local data kept');
                void render(true);
            }
            catch (error) {
                notify(error.message);
            } };
            actions.append(sync, remove);
            row.append(actions);
            body.append(row);
        }
        table.append(body);
        wrap.append(table);
    }
    const add = panel('Add workspace'), form = document.createElement('form'), input = document.createElement('input'), submit = node('button', 'primary', 'Add workspace');
    input.required = true;
    input.maxLength = 100;
    input.placeholder = 'Workspace ID';
    form.append(input, submit);
    form.onsubmit = async (event) => { event.preventDefault(); try {
        await api('/api/client/replica/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: input.value }) });
        notify('Workspace enrolled');
        void render(true);
    }
    catch (error) {
        notify(error.message);
    } };
    add.append(form);
    wrap.append(add);
    const conflicts = await api('/api/client/replica/conflicts').catch(() => ({ rows: [] }));
    for (const item of conflicts.rows || []) {
        const section = panel('Conflict · ' + String(item.title)), columns = node('div', 'detail-grid');
        columns.append(node('pre', '', String(item.server.text)), node('pre', '', String(item.local.text)));
        section.append(columns);
        for (const choice of ['server', 'mine']) {
            const button = node('button', 'secondary', choice === 'server' ? 'Take server' : 'Take mine');
            button.onclick = async () => { if (choice === 'server' && !confirm('Discard the local candidate and keep the server version?'))
                return; try {
                await api('/api/client/replica/conflicts/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicaId: item.replicaId, objectId: item.objectId, choice }) });
                notify('Conflict resolved');
                void render(true);
            }
            catch (error) {
                notify(error.message);
            } };
            section.append(button);
        }
        const titleInput = document.createElement('input');
        titleInput.value = String(item.local.title);
        titleInput.setAttribute('aria-label', 'Resolved title');
        const textarea = document.createElement('textarea');
        textarea.value = String(item.local.text);
        textarea.setAttribute('aria-label', 'Resolve with edited text');
        section.append(titleInput, textarea);
        const edited = node('button', 'secondary', 'Resolve with edited text');
        edited.onclick = async () => { try {
            await api('/api/client/replica/conflicts/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicaId: item.replicaId, objectId: item.objectId, choice: 'edited', title: titleInput.value, text: textarea.value }) });
            notify('Conflict resolved');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        } };
        section.append(edited);
        const discard = node('button', 'secondary', 'Discard local candidate');
        discard.onclick = async () => { if (!confirm('Discard this local candidate?'))
            return; try {
            await api('/api/client/replica/conflicts/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ replicaId: item.replicaId, objectId: item.objectId }) });
            notify('Candidate discarded');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        } };
        section.append(discard);
        wrap.append(section);
    }
    return wrap;
}

async function clientSettingsPage() {
    const wrap = node('div');
    wrap.append(pageHeader('Settings', 'The background service, capture queue and dashboard on this device.'));
    let data;
    try {
        data = await api('/api/client/settings');
    }
    catch (error) {
        wrap.append(node('section', 'panel', 'Settings are available when this dashboard was started with mdb dashboard --client.'));
        return wrap;
    }
    const svc = data.service || {}, installed = !!svc.installed || !!svc.loaded, running = !!svc.running;
    const service = panel('Background service');
    const statusRow = node('div', 'action-row');
    statusRow.append(node('span', 'pill state-' + (running ? 'ok' : installed ? 'attention' : 'unknown'), running ? 'Running' : installed ? 'Stopped' : 'Not installed'));
    if (svc.unavailable)
        statusRow.append(node('small', 'muted', svc.unavailable));
    service.append(statusRow, node('p', 'muted', 'Watches the local outbox and sends captured items to the server, and starts again after a restart.'));
    const serviceAction = async (action, done) => {
        try {
            await api('/api/client/service', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) });
            notify(done);
            await render();
        }
        catch (error) {
            notify(error.message);
        }
    };
    const controls = node('div', 'action-row');
    if (!installed) {
        const install = node('button', 'primary', 'Install service');
        install.type = 'button';
        install.onclick = () => serviceAction('install', 'Service installed');
        controls.append(install);
    }
    else if (!running) {
        const start = node('button', 'primary', 'Start service');
        start.type = 'button';
        start.onclick = () => serviceAction('start', 'Service started');
        controls.append(start);
    }
    else {
        const stop = node('button', 'secondary', 'Stop service');
        stop.type = 'button';
        stop.onclick = () => serviceAction('stop', 'Service stopped');
        controls.append(stop);
    }
    const logs = node('button', 'ghost', 'View logs');
    logs.type = 'button';
    logs.onclick = async () => {
        try {
            const result = await api('/api/client/service/logs');
            const dialog = document.createElement('dialog'), card = node('div', 'dialog-card');
            card.append(node('h2', '', 'Service logs'), node('pre', '', result.logs));
            const close = node('button', 'primary', 'Close');
            close.onclick = () => dialog.close();
            card.append(close);
            dialog.append(card);
            document.body.append(dialog);
            dialog.showModal();
            dialog.addEventListener('close', () => dialog.remove(), { once: true });
        }
        catch (error) {
            notify(error.message);
        }
    };
    controls.append(logs);
    service.append(controls);
    wrap.append(service);
    const queued = Number(data.outbox?.queued ?? 0);
    const outbox = panel('Capture queue');
    outbox.append(node('dl', 'metric-list'));
    const metrics = outbox.lastChild;
    addMetric(metrics, 'Queued', data.outbox?.unavailable ? 'Unavailable' : fmt(queued));
    addMetric(metrics, 'Conflicts', data.outbox?.conflicts ?? '—');
    addMetric(metrics, 'Rejected', data.outbox?.rejected ?? '—');
    addMetric(metrics, 'Oldest item', data.outbox?.oldest ?? 'None');
    addMetric(metrics, 'Capture', (data.consent ? 'Consent given' : 'No consent') + (data.paused ? ' · paused' : ''));
    if (queued > 0) {
        const row = node('div', 'action-row'), send = node('button', 'primary', 'Send queued items now');
        send.type = 'button';
        send.onclick = drainOutbox;
        row.append(send);
        outbox.append(row);
    }
    wrap.append(outbox);
    wrap.append(metricPanel('Dashboard', [['Listener', (data.dashboard?.tls ? 'HTTPS' : 'HTTP') + ' · ' + data.dashboard?.host + ':' + data.dashboard?.port], ['Password', data.dashboard?.passwordSet ? 'Set' : 'Setup required'], ['Workspace paths', (data.workspacePaths || []).join(', ') || 'Not configured']]));
    if (installed) {
        const danger = panel('Remove service');
        danger.classList.add('danger-zone');
        danger.append(node('p', 'muted', 'Stops the background service and removes it from this machine. Captured items stay queued in the outbox until it is installed again.'));
        const remove = node('button', 'danger', 'Remove service');
        remove.type = 'button';
        remove.onclick = () => { if (confirm('Remove the Engram background service from this machine?'))
            serviceAction('uninstall', 'Service removed'); };
        danger.append(remove);
        wrap.append(danger);
    }
    return wrap;
}
function updateReplicaHeader(data) { const pill = document.querySelector('#health'), label = pill.querySelector('span:last-child'); label.textContent = data.enabled ? String(data.state) : 'Replica sync is not enabled'; pill.className = 'pill ' + (data.state === 'Sync mode' ? 'state-ok' : ['Daemon stopped', 'Access refused', 'Conflict'].includes(data.state) ? 'state-problem' : 'state-attention'); const stamp = data.lastSyncAt ? Date.parse(data.lastSyncAt) : NaN; const paint = () => { if (Number.isFinite(stamp)) {
    const mins = Math.floor(Math.max(0, Date.now() - stamp) / 60000), relative = mins < 1 ? 'just now' : mins < 60 ? mins + ' min ago' : Math.floor(mins / 60) + ' hr ago';
    updated.textContent = 'Last sync ' + relative + ' · ' + new Date(stamp).toLocaleString();
}
else
    updated.textContent = 'No replica sync recorded'; }; paint(); clearInterval(replicaTick); replicaTick = setInterval(paint, 60000); }

async function drainOutbox() {
    try {
        const result = await api('/api/client/outbox/drain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        notify('Outbox sent' + (result.drain?.delivered != null ? ' · ' + result.drain.delivered + ' delivered' : ''));
        await render();
    }
    catch (error) {
        notify(error.message);
    }
}
function statCell(label, value, detail, state) {
    const cell = node('div', 'card'), row = node('span', 'card-label');
    if (state)
        row.append(node('span', 'status-icon state-' + state, icons[state]));
    row.append(node('span', '', label));
    cell.append(row, node('div', 'card-value', value), node('div', 'card-detail', detail));
    return cell;
}
async function thisDevicePage() {
    const data = await api('/api/client/device'), area = node('div');
    const head = pageHeader('This device', 'What this machine captures and has queued for the server.');
    const queued = Number(data.outbox?.queued ?? 0);
    if (queued > 0) {
        const send = node('button', 'primary', 'Send ' + fmt(queued) + ' queued now');
        send.type = 'button';
        send.onclick = drainOutbox;
        head.append(send);
    }
    area.append(head);
    const strip = node('div', 'cards');
    const capture = data.user?.paused ? 'Paused' : data.user?.captureConsent ? 'On' : 'Off';
    strip.append(statCell('Capture', capture, data.user?.captureMode || 'not configured', capture === 'On' ? 'ok' : 'attention'), statCell('Outbox', fmt(queued), queued ? 'oldest ' + safe(data.outbox?.oldest) : 'nothing waiting', queued ? 'attention' : 'ok'), statCell('Conflicts', fmt(data.outbox?.conflicts ?? 0), 'rejected ' + fmt(data.outbox?.rejected ?? 0), Number(data.outbox?.conflicts ?? 0) ? 'attention' : 'ok'), statCell('Remote spool', fmt(data.spool?.queued ?? 0), 'queued captures', Number(data.spool?.queued ?? 0) ? 'attention' : 'ok'));
    area.append(strip);
    area.append(metricPanel('Capture', [['Workspace', data.user?.workspaceId], ['Principal', data.user?.principalId], ['Hosts', (data.user?.hosts || []).join(', ')], ['Server', data.serverHost], ['Include projects', (data.user?.includeProjects || []).join(', ') || 'All'], ['Exclude projects', (data.user?.excludeProjects || []).join(', ') || 'None'], ['Last drain', data.outbox?.lastDrain ?? 'Not recorded']]), metricPanel('Projects on this device', [['Trusted paths', (data.projects?.trusted || []).join(', ') || 'None recorded'], ['Bound paths', (data.projects?.bound || []).join(', ') || 'None configured']]), metricPanel('Runtime', [['Outbox service', safe(data.service)], ['Dashboard service', safe(data.service?.clientDashboard)], ['Dashboard listener', (data.dashboard?.host || '127.0.0.1') + ':' + data.dashboard?.port], ['Token file', data.tokenFile?.present ? (data.tokenFile?.modeOk ? 'Present, private' : 'Present, unsafe permissions') : 'Missing'], ['Versions', 'Engram ' + safe(data.versions?.engram) + ' · Node ' + safe(data.versions?.node)]]));
    return area;
}
async function clientWorkspacesPage() { const area = node('div'); area.setAttribute('data-connector-live', 'true'); area.append(pageHeader('Workspaces', 'All workspaces known to this device, including server access, trusted folders, cached context, queued writes and replicas.')); let data; try {
    data = await api('/api/client/workspaces');
}
catch (error) {
    area.append(node('p', 'empty', 'Workspace status unavailable: ' + error.message));
    return area;
} if (data.error)
    area.append(node('p', 'empty', 'Workspace status unavailable: ' + String(data.error)));
else if (data.stale)
    area.append(node('p', 'muted', 'Server workspace list is stale · last contact ' + String(data.server?.ageMs ?? 'unknown') + ' ms ago')); const rows = data.rows || []; if (data.approximate)
    area.append(node('p', 'muted', 'Workspace status is approximate and capped at 200 workspaces.')); if (!rows.length)
    area.append(node('p', 'empty', 'No workspaces yet. Connect this device to a server, bind a project folder, use cached context, queue a write, or enroll a replica workspace.'));
else {
    const table = node('table', 'data-table'), head = node('thead'), hr = node('tr');
    for (const label of ['Workspace', 'Connection', 'Modes', 'Cache', 'Queued writes', 'Replica', 'Bound project folders', 'Write access'])
        hr.append(node('th', '', label));
    head.append(hr);
    const body = node('tbody');
    for (const item of rows) {
        const row = node('tr');
        row.setAttribute('data-key', 'workspace-' + item.id);
        row.append(node('td', '', String(item.name || item.id) + ' · ' + String(item.id)), node('td', '', String(item.connection) + (item.lastContactAt ? ' · ' + item.lastContactAt : '')), node('td', '', String((item.modes || []).join(', ') || '—')), node('td', '', item.cache?.ageMs == null ? '—' : String(item.cache.ageMs) + ' ms' + (item.cache.stale ? ' · STALE' : '')), node('td', '', String(item.queuedWrites || 0) + ' · ' + String(item.queuedBytes || 0) + ' bytes'), node('td', '', String(item.replica?.state || '—') + ' · push ' + String(item.replica?.pendingPush || 0) + ' · pull ' + String(item.replica?.pendingPull ?? 'unknown') + ' · conflicts ' + String(item.replica?.conflicts || 0)), node('td', '', String((item.folders || []).map(folder => folder.name).join(', ') || '—')), node('td', '', item.writeAccess == null ? 'Unknown' : item.writeAccess ? 'Allowed' : 'Read only'));
        body.append(row);
    }
    table.append(head, body);
    area.append(table);
} return area; }

async function serverPage() {
    const area = node('div');
    area.append(pageHeader('Server', 'The Engram server this device captures to and reads from.'));
    let current, info = null;
    try {
        current = await api('/api/client/server');
    }
    catch (error) {
        area.append(node('p', 'empty', 'Server configuration unavailable: ' + error.message));
        return area;
    }
    info = await api('/api/client/status').catch(() => null);
    const connection = panel('Connection');
    const checks = node('ul', 'check-list');
    for (const check of info?.checks || []) {
        const line = node('li'), mark = node('span', 'status-icon state-' + statusState(check.state), icons[statusState(check.state)]);
        line.append(mark, node('span', '', check.text));
        checks.append(line);
    }
    if (!checks.children.length)
        checks.append(node('li', 'muted', 'No connection checks available.'));
    connection.append(checks);
    const list = node('dl', 'metric-list');
    addMetric(list, 'Server URL', current.url || 'Not configured');
    addMetric(list, 'Token file', current.tokenFile || 'Not configured');
    connection.append(list);
    area.append(connection);
    const card = panel('Change server');
    card.append(node('p', '', 'Updates the capture endpoint used by hooks, the outbox and agent configuration on this machine. You review the exact targets before anything is written.'));
    const form = node('div', 'connector-card'), url = document.createElement('input'), tokenFile = document.createElement('input');
    url.type = 'url';
    url.required = true;
    url.value = current.url || '';
    url.placeholder = 'https://engram.example/mcp';
    url.setAttribute('aria-label', 'Server URL');
    tokenFile.type = 'text';
    tokenFile.required = true;
    tokenFile.value = current.tokenFile || '';
    tokenFile.placeholder = '~/.config/engram/client.token';
    tokenFile.setAttribute('aria-label', 'Token file path');
    const urlLabel = node('label', '', 'Server URL');
    urlLabel.append(url);
    const tokenLabel = node('label', '', 'Token file path');
    tokenLabel.append(tokenFile, node('small', 'muted', 'The token itself is never entered or shown here.'));
    form.append(urlLabel, tokenLabel);
    const controls = node('div', 'action-row'), previewButton = node('button', 'secondary', 'Review changes');
    previewButton.type = 'button';
    controls.append(previewButton);
    card.append(form, controls);
    area.append(card);
    const previewBox = node('section', 'panel');
    previewBox.hidden = true;
    area.append(previewBox);
    let previewData = null;
    const clearPreview = () => { previewData = null; previewBox.hidden = true; };
    url.addEventListener('input', clearPreview);
    tokenFile.addEventListener('input', clearPreview);
    previewButton.onclick = async () => {
        previewButton.disabled = true;
        try {
            previewData = await api('/api/client/server/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value, tokenFile: tokenFile.value }) });
            previewBox.replaceChildren(node('h2', '', 'What will change'), node('p', 'muted', 'Targets that are not configured on this machine are skipped and never created.'));
            const table = node('table', 'data-table'), headRow = node('tr'), thead = node('thead'), tbody = node('tbody');
            for (const text of ['Target', 'Current', 'New', 'Action'])
                headRow.append(node('th', '', text));
            thead.append(headRow);
            for (const change of previewData.changes) {
                const row = node('tr');
                for (const value of [change.target, change.current || 'Not configured', change.next, change.action])
                    row.append(node('td', '', String(value)));
                tbody.append(row);
            }
            table.append(thead, tbody);
            const wrap = node('div', 'table-wrap');
            wrap.append(table);
            previewBox.append(wrap);
            const actions = node('div', 'action-row'), apply = node('button', 'primary', 'Apply changes'), cancel = node('button', 'ghost', 'Cancel');
            apply.type = 'button';
            cancel.type = 'button';
            cancel.onclick = clearPreview;
            apply.onclick = async () => {
                apply.disabled = true;
                try {
                    const result = await api('/api/client/server/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value, tokenFile: tokenFile.value, digest: previewData.digest }) });
                    const results = node('ul');
                    for (const item of result.results || [])
                        results.append(node('li', '', item.target + ': ' + item.status + (item.reason ? ' · ' + item.reason : '')));
                    if (result.ok === false)
                        results.append(node('li', 'state-problem', 'Failed at ' + result.failedTarget + '; rolled back: ' + (result.rolledBack || []).join(', ')));
                    previewBox.replaceChildren(node('h2', '', result.ok ? 'Server updated' : 'Change rolled back'), results);
                    notify(result.ok ? 'Server settings applied' : 'Server change rolled back');
                }
                catch (error) {
                    notify(error.message);
                    apply.disabled = false;
                }
            };
            actions.append(apply, cancel);
            previewBox.append(actions);
            previewBox.hidden = false;
        }
        catch (error) {
            notify(error.message);
        }
        finally {
            previewButton.disabled = false;
        }
    };
    return area;
}`;
