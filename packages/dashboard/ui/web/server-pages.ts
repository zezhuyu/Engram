/** Pages of the SERVER dashboard only. Never included in the client dashboard script. */
export const serverPagesJs = String.raw`function cardGrid() { const grid = node('div', 'cards'); for (const card of deriveCards(status)) {
    const link = node('a', 'card');
    link.href = '#' + card.target;
    link.addEventListener('click', () => go(card.target));
    const row = node('span', 'card-label');
    row.append(node('span', 'status-icon state-' + card.state, icons[card.state]), node('span', '', card.label));
    link.append(row, node('div', 'card-value' + (String(card.value).length > 9 ? ' long' : ''), card.value), node('div', 'card-detail', card.detail));
    grid.append(link);
} return grid; }

function attentionBlock() {
    const items = deriveAttention(status);
    if (!items.length) {
        const clear = node('p', 'all-clear');
        clear.append(node('span', 'status-icon state-ok', icons.ok), node('span', '', 'Nothing needs attention.'));
        return clear;
    }
    const section = node('section', 'attention'), ul = node('ul');
    section.append(node('h2', '', items.length === 1 ? '1 thing needs attention' : items.length + ' things need attention'));
    for (const item of items) {
        const li = node('li');
        li.append(node('strong', '', item.title), node('p', '', item.next));
        ul.append(li);
    }
    section.append(ul);
    return section;
}
function dreamSummary(run) {
    const box = panel('Dream'), list = node('dl', 'metric-list'), last = run?.lastRun, next = run?.nextRun;
    if (!run)
        box.append(node('p', 'empty', 'Dream status is unavailable right now.'));
    else {
        const lastCell = node('dd');
        if (last) {
            lastCell.append(node('span', 'pill ' + (last.status === 'completed' ? 'state-ok' : last.status === 'failed' ? 'state-problem' : 'state-attention'), last.status), node('span', 'muted', ' · '), relativeTimeNode(last.startedAt), node('span', 'muted', ' · took ' + formatDuration(last.durationMs)));
        }
        else
            lastCell.append(node('span', 'muted', 'No run yet'));
        const nextCell = node('dd');
        if (next?.time)
            nextCell.append(node('span', '', new Date(next.time).toLocaleString()), node('span', 'muted', ' · '), relativeTimeNode(next.time));
        else
            nextCell.append(node('span', 'muted', !run.scheduler?.configured ? 'No schedule configured' : !run.scheduler?.enabled ? 'Scheduling is off (enable in Settings)' : (next?.whyLater || 'Not predictable yet')));
        list.append(node('dt', '', 'Last run'), lastCell, node('dt', '', 'Next run'), nextCell);
        if (last)
            list.append(node('dt', '', 'Result'), node('dd', '', last.documentsConsidered + ' documents · ' + last.proposalsCreated + ' proposals · ' + last.insightsAccepted + ' accepted'));
        if (last?.failureReason)
            list.append(node('dt', '', 'Reason'), node('dd', '', last.failureReason));
        box.append(list);
    }
    const link = node('a', '', 'Open Dream & wiki');
    link.href = '#dream';
    box.append(link);
    return box;
}
async function overview() {
    const area = node('div'), head = pageHeader('Overview', 'Is your memory healthy, and is it learning?');
    head.append(runAction('verify-vault', 'Verify vault', 'secondary'));
    area.append(head, attentionBlock(), cardGrid());
    let run = null;
    try {
        run = await api('/api/dream/run-status');
    }
    catch { }
    area.append(dreamSummary(run));
    return area;
}
function runAction(name, label, kind = 'primary') { const button = node('button', kind, label); button.type = 'button'; button.addEventListener('click', async () => { if (name === 'verify-vault' && !window.confirm('Full vault verification can take several minutes on a large vault. Continue?'))
    return; if (name === 'test-model' && !window.confirm('A synthetic connectivity prompt will be sent to the configured model provider. No vault documents or snippets are sent. Continue?'))
    return; button.disabled = true; button.textContent = 'Starting…'; try {
    const action = await api('/api/actions/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    notify('Action started: ' + action.id.slice(0, 8));
    let cancelled = false, tries = 0;
    const cancel = node('button', 'secondary', 'Cancel action');
    cancel.type = 'button';
    cancel.addEventListener('click', async () => { cancelled = true; try {
        await api('/api/actions/' + action.id, { method: 'DELETE' });
        notify('Cancellation requested');
    }
    catch (error) {
        notify(error.message);
    } });
    button.after(cancel);
    while (tries++ < 120 && !cancelled) {
        await new Promise(r => setTimeout(r, 1000));
        const result = await api('/api/actions/' + action.id);
        if (result.state !== 'running') {
            notify(result.state === 'complete' ? 'Action completed' : result.error || 'Action ' + result.state);
            await refresh();
            break;
        }
    }
    cancel.remove();
}
catch (error) {
    notify(error.message);
}
finally {
    button.disabled = false;
    button.textContent = label;
} }); return button; }

async function clientsPage() {
    const area = node('div');
    area.setAttribute('data-connector-live', 'true');
    area.append(pageHeader('Clients', 'Machines that report to this server. Reports are informational and do not affect access; dashboard sign-in uses a separate local password.'));
    let result;
    try {
        result = await api('/api/clients?limit=100');
    }
    catch (error) {
        area.append(node('p', 'empty', 'Client inventory unavailable: ' + error.message));
        return area;
    }
    const when = value => value ? new Date(value).toLocaleString() : '—';
    const shortId = credential => credential.id.slice(0, 13);
    const rows = result.rows || [];
    const reporting = rows.filter(entry => (entry.clients || []).length), silent = rows.filter(entry => !(entry.clients || []).length);
    function revokeButton(entry) {
        const button = node('button', 'danger', 'Revoke');
        button.type = 'button';
        button.setAttribute('aria-label', 'Revoke credential ' + entry.credential.actorId);
        button.onclick = () => revoke(entry.credential, entry.clients || [], entry.expectedDigest);
        return button;
    }
    function detailList(entry, client) {
        const list = node('dl', 'metric-list');
        const add = (name, value) => list.append(node('dt', '', name), node('dd', '', value));
        add('Server contact', when(client.lastSync?.serverContactAt));
        add('Outbox delivered', when(client.lastSync?.outboxDeliveredAt));
        add('File sync committed', when(client.lastSync?.fileSyncCommittedAt));
        add('Context fetched', when(client.lastSync?.contextFetchedAt));
        add('Queues', String(client.queues?.outbox || 0) + ' outbox · ' + String(client.queues?.fileSync || 0) + ' file · ' + String(client.queues?.capture || 0) + ' capture · ' + String(client.queues?.queuedBytes || 0) + ' bytes');
        add('Credential', String(entry.credential.actorId) + ' · ' + entry.credential.id);
        if (client.replication) {
            const r = client.replication;
            add('Replica', String(r.state) + ' · epoch ' + String(r.epochState));
            for (const scope of r.enrolledWorkspaces || [])
                add('Workspace ' + String(scope.workspaceId), scope.pendingPush + ' pending · ' + scope.diverged + ' diverged · pulled ' + String(scope.lastPullAt || '—') + ' · pushed ' + String(scope.lastPushAt || '—'));
        }
        for (const project of client.projects || [])
            add('Project ' + String(project.folderName) + ' · ' + String(project.workspaceId), (project.contextStale ? 'STALE · ' : '') + String(project.fileSyncState) + ' · context ' + (project.contextFetchedAt ? Math.floor(Math.max(0, Date.now() - Date.parse(project.contextFetchedAt)) / 60000) + ' min ago' : 'not fetched') + ' · queued ' + String(project.queuedWrites) + ' · conflicts ' + String(project.conflicts));
        return list;
    }
    function deviceBlock(entry) {
        const wrap = node('div', 'device-list');
        for (const device of entry.replicaDevices || []) {
            const group = node('div', 'action-row');
            group.append(node('span', '', String(device.label) + ' · ' + String(device.deviceId)));
            for (const workspaceId of device.enrolledScopes || []) {
                const unenroll = node('button', 'ghost', 'Unenroll ' + workspaceId);
                unenroll.type = 'button';
                unenroll.onclick = async () => { if (!confirm('Unenroll ' + workspaceId + ' from ' + device.label + '? The device will receive a generic forbidden response on its next fetch.'))
                    return; const password = prompt('Re-enter the dashboard password to authorize workspace unenrollment'); if (!password)
                    return; try {
                    await api('/api/clients/unenroll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: JSON.stringify({ credentialId: entry.credential.id, deviceId: device.deviceId, workspaceId }) });
                    notify('Workspace unenrolled from device');
                    void render(true);
                }
                catch (error) {
                    notify(error.message);
                } };
                group.append(unenroll);
            }
            wrap.append(group);
        }
        return wrap;
    }
    if (reporting.length) {
        const box = panel('Reporting clients'), wrap = node('div', 'table-wrap'), table = node('table', 'data-table stack'), head = node('thead'), header = node('tr'), body = node('tbody');
        for (const label of ['Client', 'Credential', 'Status', 'Last sync', ''])
            header.append(node('th', '', label));
        head.append(header);
        for (const entry of reporting) {
            for (const client of entry.clients) {
                const row = node('tr');
                row.setAttribute('data-key', 'client-' + entry.credential.id + '-' + client.clientId);
                const identity = node('td');
                identity.append(node('strong', '', String(client.displayName)), node('small', 'help', String(client.hostLabel) + ' · ' + String(client.appVersion)));
                const actor = node('td');
                actor.append(node('span', '', String(entry.credential.actorId)), node('small', 'help', shortId(entry.credential)));
                const state = node('td'), good = String(client.state).toLowerCase().startsWith('connected');
                state.append(node('span', 'pill ' + (good ? 'state-ok' : 'state-attention'), String(client.state)), node('small', 'help', String(client.mode) + ' · seen ' + when(client.serverReceivedAt)));
                const sync = node('td'), contact = client.lastSync?.serverContactAt;
                const first = node('span');
                if (contact)
                    first.append(relativeTimeNode(contact));
                else
                    first.textContent = 'No contact yet';
                const queued = Number(client.queues?.outbox || 0) + Number(client.queues?.fileSync || 0) + Number(client.queues?.capture || 0);
                sync.append(first, node('small', 'help', (queued ? queued + ' queued' : 'Nothing queued') + (client.replication ? ' · replica ' + String(client.replication.state) : '')));
                const action = node('td', 'row-actions');
                action.append(revokeButton(entry));
                row.append(identity, actor, state, sync, action);
                body.append(row);
                const detailRow = node('tr', 'detail-row');
                detailRow.setAttribute('data-key', 'client-detail-' + entry.credential.id + '-' + client.clientId);
                const cell = node('td');
                cell.colSpan = 5;
                const details = document.createElement('details');
                details.append(node('summary', '', 'Details'), detailList(entry, client));
                if ((entry.replicaDevices || []).length) {
                    details.append(node('h3', '', 'Replica devices (' + entry.replicaDevices.length + ')'), deviceBlock(entry));
                }
                cell.append(details);
                detailRow.append(cell);
                body.append(detailRow);
            }
        }
        table.append(head, body);
        wrap.append(table);
        box.append(wrap);
        area.append(box);
    }
    if (silent.length) {
        const box = panel('Credentials without a reporting client'), wrap = node('div', 'table-wrap'), table = node('table', 'data-table stack'), head = node('thead'), header = node('tr'), body = node('tbody');
        box.append(node('p', 'help', 'These credentials exist, but no client app has sent a report for them. They can still be used by agents.'));
        for (const label of ['Actor', 'Credential', 'Last used', ''])
            header.append(node('th', '', label));
        head.append(header);
        for (const entry of silent) {
            const row = node('tr'), action = node('td', 'row-actions');
            row.setAttribute('data-key', 'credential-' + entry.credential.id);
            action.append(revokeButton(entry));
            row.append(node('td', '', String(entry.credential.actorId)), node('td', 'mono', shortId(entry.credential)), node('td', '', entry.credential.lastUsedAt ? when(entry.credential.lastUsedAt) : 'Never'), action);
            body.append(row);
        }
        table.append(head, body);
        wrap.append(table);
        box.append(wrap);
        area.append(box);
    }
    if (!rows.length)
        area.append(node('p', 'empty', 'No scoped credentials or client reports yet. Client app heartbeats appear here after a client installation connects.'));
    async function revoke(credential, clients, digest) {
        const clientNames = clients.length ? clients.map(item => String(item.displayName) + ' (' + String(item.hostLabel) + ')').join(', ') : 'No reporting clients';
        const message = 'Actor: ' + credential.actorId + '\nCredential: ' + credential.id + '\nPermissions: ' + credential.permissions.join(', ') + '\nLast used: ' + (credential.lastUsedAt || 'Not recorded') + '\nReporting clients: ' + clientNames + '\n\nEvery holder of this token loses access immediately, including unreported agents or machines. Queued writes remain on client machines. Revoke this credential?';
        if (!confirm(message))
            return;
        const password = prompt('Re-enter the dashboard password to authorize credential revocation');
        if (!password)
            return;
        try {
            await api('/api/clients/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: JSON.stringify({ credentialId: credential.id, expectedDigest: digest }) });
            notify('Credential revoked');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        }
    }
    return area;
}

function storagePage() { const i = status.index || {}, s = status.storage || {}; const area = node('div'); area.append(pageHeader('Storage & index', 'Storage pressure, journal position and derived index health.')); const grid = node('div', 'detail-grid'); grid.append(metricPanel('Storage', Object.entries(s.usageBytes || {}).map(([k, v]) => [k + ' bytes', fmt(v)]).concat([['Pressure', s.pressureState], ['Available bytes', fmt(s.availableBytes)], ['Deferred operations', fmt(s.deferredOperations)]])), metricPanel('Index manifest', [['Backend', i.backend], ['Available', i.available ? 'Yes' : 'No'], ['Journal sequence', fmt(i.journalSequence)], ['Manifest entries', fmt(i.manifest?.entries)], ['Manifest sequence', fmt(i.manifest?.journalSequence)], ['Persisted', i.manifest?.persisted ? 'Yes' : 'No'], ['Vector index', i.vector?.ready ? 'Ready' : 'Unavailable']])); const actions = node('div', 'action-row'); actions.append(runAction('verify-index', 'Verify index')); area.append(grid, actions, node('p', 'muted', 'To rebuild a derived index, run: mdb index rebuild')); return area; }

async function profileDomainsPage() {
    const area = node('div');
    area.append(pageHeader('Profile domains', 'Task-specific tags that decide which accepted preferences apply to a project. Changes create a revision and keep each claim.'));
    let result;
    try {
        result = await api('/api/profile/domains');
    }
    catch (error) {
        area.append(node('p', 'empty', 'Profile domains are unavailable: ' + error.message));
        return area;
    }
    const minEvidence = result.minEvidence || 2;
    async function saveDomainAction(payload) {
        try {
            await api('/api/profile/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, expectedRegistryRevisionId: result.registryRevisionId }) });
            notify('Domain registry updated');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        }
    }
    const registry = panel('Domains');
    registry.setAttribute('data-key', 'profile-domain-registry');
    registry.append(node('p', 'help', 'Preferences marked General apply to every project. A separate model pass proposes new domains, and a domain is adopted after ' + minEvidence + ' accepted items support it. Without a configured model, discovery is unavailable.'));
    const auto = document.createElement('input');
    auto.type = 'checkbox';
    auto.checked = result.autoApply !== false;
    auto.setAttribute('data-key', 'profile-domains-auto-apply');
    auto.onchange = async () => { try {
        await api('/api/profile/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'autoApply', enabled: auto.checked, expectedRegistryRevisionId: result.registryRevisionId }) });
        notify('Dream tag auto-apply setting saved');
        void render(true);
    }
    catch (error) {
        auto.checked = !auto.checked;
        notify(error.message);
    } };
    registry.append(switchLabel(auto, 'Auto-discover and apply domains', 'Dream looks for new topics in your accepted preferences each night and applies tags it is confident about, unless you set an item yourself. Turn this off to review every suggestion.'));
    const pendingList = result.pendingDomainCandidates || [];
    const wrap = node('div', 'table-wrap'), table = node('table', 'data-table stack'), head = node('thead'), header = node('tr'), body = node('tbody');
    for (const label of ['Domain', 'Items', 'Evidence', ''])
        header.append(node('th', '', label));
    head.append(header);
    for (const domain of result.domains || []) {
        const row = node('tr');
        row.setAttribute('data-key', 'domain-registry-' + domain.slug);
        const name = node('td');
        const title = node('div', 'action-row');
        title.append(node('strong', '', '' + domain.label), node('span', 'pill state-unknown', String(domain.origin)));
        name.append(title, node('small', 'help mono', domain.slug));
        const actions = node('td', 'row-actions');
        if (domain.slug !== 'general') {
            const rename = node('button', 'ghost', 'Rename'), merge = node('button', 'ghost', 'Merge into'), retire = node('button', 'ghost danger-text', 'Retire');
            for (const button of [rename, merge, retire])
                button.type = 'button';
            rename.onclick = async () => { const label = prompt('New domain label', domain.label); if (!label)
                return; await saveDomainAction({ operation: 'rename', slug: domain.slug, label }); };
            merge.onclick = async () => { const into = prompt('Merge into active domain slug'); if (!into)
                return; await saveDomainAction({ operation: 'merge', slug: domain.slug, into, retag: true }); };
            retire.onclick = async () => { if (!confirm('Retire ' + domain.label + ' and re-tag affected automatic items as general?'))
                return; await saveDomainAction({ operation: 'retire', slug: domain.slug, retag: true }); };
            actions.append(rename, merge, retire);
        }
        row.append(name, node('td', '', String(domain.itemCount)), node('td', '', String((domain.evidence || []).length)), actions);
        body.append(row);
    }
    table.append(head, body);
    wrap.append(table);
    registry.append(wrap);
    const add = node('button', 'primary', 'Add domain');
    add.type = 'button';
    add.onclick = async () => { const slug = prompt('Domain slug (lowercase, 2–24 characters)'); if (!slug)
        return; const label = prompt('Domain label'); if (!label)
        return; const description = prompt('One-line description'); if (!description)
        return; const keywords = prompt('Keywords, comma separated'); if (!keywords)
        return; const evidence = (result.items || []).find(item => (item.domains || []).includes('general')); if (!evidence) {
        notify('An accepted preference is required as evidence');
        return;
    } await saveDomainAction({ operation: 'add', slug, label, description, keywords: keywords.split(',').map(x => x.trim()), evidence: [evidence.id] }); };
    const discover = node('button', 'secondary', 'Discover now');
    discover.type = 'button';
    discover.onclick = async () => {
        discover.disabled = true;
        discover.textContent = 'Discovering…';
        try {
            const reply = await api('/api/profile/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'discover' }) });
            const found = reply.discovery || {};
            if (found.status === 'unavailable')
                notify('Discovery unavailable: ' + found.reason);
            else
                notify('Discovery finished: ' + found.classified + ' preferences checked, ' + (found.promoted || []).length + ' new topics' + ((found.rejections || []).length ? ', ' + found.rejections.length + ' need another try' : ''));
            void render(true);
        }
        catch (error) {
            notify(error.message);
            discover.disabled = false;
            discover.textContent = 'Discover now';
        }
    };
    const addRow = node('div', 'action-row');
    addRow.append(add, discover);
    registry.append(addRow);
    area.append(registry);
    const found = panel('Discovered topics');
    found.setAttribute('data-key', 'profile-discovered-topics');
    found.append(node('p', 'help', 'Every topic found by discovery, including ones that are waiting for evidence or were retired or merged.'));
    const discovered = (result.registry || []).filter(domain => domain.origin === 'discovered');
    if (discovered.length || pendingList.length) {
        const foundWrap = node('div', 'table-wrap'), foundTable = node('table', 'data-table stack'), foundHead = node('thead'), foundHeader = node('tr'), foundBody = node('tbody');
        for (const label of ['Topic', 'State', 'Evidence', 'First seen'])
            foundHeader.append(node('th', '', label));
        foundHead.append(foundHeader);
        for (const domain of discovered) {
            const row = node('tr'), name = node('td'), stateCell = node('td');
            row.setAttribute('data-key', 'discovered-' + domain.slug);
            name.append(node('strong', '', String(domain.label)), node('small', 'help mono', domain.slug + (domain.description ? ' · ' + domain.description : '')));
            stateCell.append(node('span', 'pill ' + (domain.status === 'active' ? 'state-ok' : 'state-unknown'), domain.status === 'merged' && domain.mergedInto ? 'merged into ' + domain.mergedInto : String(domain.status)));
            row.append(name, stateCell, node('td', '', String((domain.evidence || []).length) + ' items'), node('td', '', domain.firstSeen ? new Date(domain.firstSeen).toLocaleDateString() : '—'));
            foundBody.append(row);
        }
        for (const candidate of pendingList) {
            const row = node('tr'), name = node('td'), stateCell = node('td');
            row.setAttribute('data-key', 'pending-' + candidate.proposal.slug);
            name.append(node('strong', '', String(candidate.proposal.label)), node('small', 'help mono', candidate.proposal.slug + (candidate.reason ? ' · ' + candidate.reason : '')));
            stateCell.append(node('span', 'pill state-attention', 'waiting ' + candidate.count + ' / ' + minEvidence));
            row.append(name, stateCell, node('td', '', String((candidate.evidence || []).length) + ' items'), node('td', '', candidate.firstSeen ? new Date(candidate.firstSeen).toLocaleDateString() : '—'));
            foundBody.append(row);
        }
        foundTable.append(foundHead, foundBody);
        foundWrap.append(foundTable);
        found.append(foundWrap);
    }
    else {
        const empty = node('div', 'empty-state');
        empty.append(node('strong', '', 'No discovered topics yet'), node('p', '', 'Dream checks for new topics every night once a model is configured. You can also run Discover now.'));
        found.append(empty);
    }
    area.append(found);
    const list = panel('Accepted preferences');
    list.setAttribute('data-key', 'profile-domain-list');
    list.append(node('p', 'help', 'Choose which domains each preference belongs to, then save that preference.'));
    for (const item of result.items || []) {
        const row = node('article', 'insight-row');
        row.setAttribute('data-key', 'profile-domain-' + item.id);
        row.append(node('p', 'claim', item.claim));
        if (item.rejectedReason)
            row.append(node('p', 'help', 'Domain classification pending retry: ' + item.rejectedReason));
        const controls = node('div', 'domain-chips');
        const selected = new Set(item.domains || ['general']);
        for (const domain of result.domains) {
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = selected.has(domain.slug);
            input.setAttribute('data-key', 'domain-' + item.id + '-' + domain.slug);
            input.setAttribute('aria-label', domain.slug);
            const label = node('label', 'chip');
            label.append(input, node('span', '', domain.label));
            controls.append(label);
        }
        const save = node('button', 'secondary', 'Save domains');
        save.type = 'button';
        save.setAttribute('data-key', 'save-domains-' + item.id);
        save.onclick = async () => { try {
            const domains = [...controls.querySelectorAll('input:checked')].map(input => input.getAttribute('aria-label'));
            if (!domains.length)
                throw new Error('Choose at least one domain');
            await api('/api/profile/domains', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, expectedRevisionId: item.revisionId, domains }) });
            notify('Preference domains saved');
            void render(true);
        }
        catch (error) {
            notify(error.message);
        } };
        const foot = node('div', 'chip-row');
        foot.append(controls, save);
        row.append(foot);
        list.append(row);
    }
    if (!(result.items || []).length) {
        const empty = node('div', 'empty-state');
        empty.append(node('strong', '', 'No accepted preferences to tag yet'), node('p', '', 'Preferences appear here after you accept them from Dream or the wiki review.'));
        list.append(empty);
    }
    area.append(list);
    return area;
}

function jobsPage() { const area = node('div'); area.append(pageHeader('Jobs & scheduler', 'Queue state and adaptive schedule activity.')); const s = status.scheduler || {}, grid = node('div', 'detail-grid'); grid.append(metricPanel('Queue', [['Queued', fmt(status.jobs?.pending)], ['Running', fmt(status.jobs?.running)], ['Failed', fmt(status.jobs?.failed)], ['Dead letter', fmt(status.jobs?.dead_letter)], ['Completed', fmt(status.jobs?.complete)]]), metricPanel('Scheduler', [['Enabled', s.enabled ? 'Yes' : 'No'], ['Paused', s.paused ? 'Yes' : 'No'], ['Mode', s.mode], ['Recent events', fmt(s.events)], ['Cycles', fmt(s.cycles)]])); const section = (title, table) => { const block = node('section', 'jobs-section'); block.append(node('h2', '', title), table); return block; }; const jobs = dataTable('Recent jobs', ['Job', 'Kind', 'State', 'Attempts', 'Next run'], (status.jobItems || []).slice().reverse().map(item => [item.id, item.kind, item.status, item.attempts, item.nextAt ? new Date(item.nextAt).toLocaleString() : '—'])); const events = dataTable('Recent schedule events', ['Time', 'Event', 'Trigger'], (s.recentEvents || []).slice().reverse().map(item => [new Date(item.at).toLocaleString(), item.type, item.trigger || '—'])); const cycles = dataTable('Recent cycles', ['Cycle', 'State', 'Started', 'Completed', 'Workspaces', 'Global', 'Dream'], (s.recentCycles || []).slice().reverse().map(item => [item.id, item.state, new Date(item.createdAt).toLocaleString(), item.completedAt ? new Date(item.completedAt).toLocaleString() : '—', item.workspaceCount, item.globalStatus, item.dreamStatus])); area.append(grid, section('Job queue', jobs), section('Schedule activity', events), section('Scheduler cycles', cycles)); return area; }

let dreamRelativeTimer;

async function dreamPage() { const area = node('div'); area.append(pageHeader('Dream & wiki', 'Learning summaries and review counts.')); let run; try {
    run = await api('/api/dream/run-status');
}
catch (error) {
    run = { lastRun: null, currentRun: null, runs: [], nextRun: { time: null, timezone: '', trigger: null, whyLater: 'Dream schedule details are unavailable: ' + error.message }, scheduler: { enabled: false, configured: false, worker: { loaded: false, running: false }, summary: 'Unavailable' } };
} const schedule = node('section', 'panel'); schedule.setAttribute('data-key', 'dream-schedule'); schedule.setAttribute('data-connector-live', 'true'); schedule.append(node('h2', '', 'Schedule')); const gridRun = node('div', 'detail-grid'); const previous = panel('Previous run'); if (run.lastRun) {
    const last = run.lastRun, local = new Date(last.startedAt).toLocaleString(), scheduleLocal = new Date(last.startedAt).toLocaleString(undefined, { timeZone: last.timezone });
    const badge = node('span', 'pill ' + (last.status === 'completed' ? 'state-ok' : last.status === 'failed' ? 'state-problem' : 'state-attention'), last.status);
    const lines = node('dl', 'metric-list');
    const startedCell = node('dd');
    startedCell.append(node('span', '', local + (scheduleLocal !== local ? ' · ' + last.timezone + ': ' + scheduleLocal : '')), node('span', 'muted', ' · '), relativeTimeNode(last.startedAt));
    lines.append(node('dt', '', 'Started'), startedCell, node('dt', '', 'Status'), node('dd'));
    lines.lastChild.append(badge);
    lines.append(node('dt', '', 'Duration'), node('dd', '', formatDuration(last.durationMs)), node('dt', '', 'Provider'), node('dd', '', last.provider || 'Unavailable'), node('dt', '', 'Counts'), node('dd', '', last.documentsConsidered + ' documents · ' + last.proposalsCreated + ' proposals · ' + last.insightsAccepted + ' accepted'));
    if (last.failureReason)
        lines.append(node('dt', '', 'Reason'), node('dd', '', last.failureReason));
    previous.append(lines);
}
else
    previous.append(node('p', 'empty', 'No Dream run yet')); const next = panel('Next run'), nextRun = run.nextRun; if (nextRun?.time) {
    const userTime = new Date(nextRun.time).toLocaleString(), scheduleTime = new Date(nextRun.time).toLocaleString(undefined, { timeZone: nextRun.timezone });
    const time = node('p', '', userTime + (scheduleTime !== userTime ? ' · ' + nextRun.timezone + ': ' + scheduleTime : ''));
    const rel = relativeTimeNode(nextRun.time);
    time.append(node('span', 'muted', ' · '), rel);
    next.append(time, node('p', 'muted', (nextRun.trigger || 'scheduled') + (nextRun.whyLater ? ' · ' + nextRun.whyLater : '')));
}
else if (!run.scheduler?.configured)
    next.append(node('p', 'empty', 'No schedule configured'));
else if (!run.scheduler?.enabled)
    next.append(node('p', 'empty', 'Dream scheduling is off (enable in Settings)'));
else {
    next.append(node('p', 'empty', 'No run predicted'));
    next.append(node('p', 'muted', nextRun?.whyLater || 'No eligible run time is predictable within the search horizon'));
} next.append(node('p', 'muted', 'Worker: ' + (run.scheduler?.worker?.running ? 'Running' : run.scheduler?.worker?.loaded ? 'Loaded, not running' : 'Worker not running'))); if (run.currentRun) {
    const current = panel('Current run');
    current.append(node('p', '', run.currentRun.state + ' · started ' + new Date(run.currentRun.startedAt).toLocaleString() + ' · ' + run.currentRun.timezone));
    gridRun.append(previous, next, current);
}
else
    gridRun.append(previous, next); schedule.append(gridRun); const historyLink = node('a', '', 'View cycle history'); historyLink.href = '#jobs'; const runs = run.runs || []; if (runs.length) {
    const table = dataTable('Last five runs', ['Time', 'Kind', 'Status', 'Duration'], runs.map(item => [new Date(item.startedAt).toLocaleString() + ' · ' + item.timezone, item.kind, item.status, item.durationMs === null ? 'Running' : formatDuration(item.durationMs)]));
    schedule.append(table);
} schedule.append(historyLink); if (dreamRelativeTimer)
    clearInterval(dreamRelativeTimer); dreamRelativeTimer = setInterval(tickRelativeTimes, 60000); const d = status.dream || {}, w = status.wiki || {}; const grid = node('div', 'detail-grid'); grid.append(metricPanel('Dream', [['Learning families', fmt(d.families)], ['Recorded outcomes', fmt(d.outcomes)], ['Configured', status.config?.dreamEnabled ? 'Enabled' : 'Disabled']]), metricPanel('Wiki', [['Pages checked', fmt(w.checked)], ['Errors', fmt(w.bySeverity?.error)], ['Warnings', fmt(w.bySeverity?.warning)], ['Pending proposals', fmt(status.proposals?.pending)]])); const action = node('div', 'action-row'); action.append(runAction('test-model', 'Test model connection', 'secondary')); area.append(schedule, grid, action, node('p', 'muted', 'Testing sends a synthetic connectivity prompt to the configured provider. No vault content is sent.')); return area; }

function capturePage() { const c = status.capture || {}; const area = node('div'); area.append(pageHeader('Capture', 'Local capture spool and owner registration state.')); const grid = node('div', 'detail-grid'); grid.append(metricPanel('Spool', [['Queued', fmt(c.queued ?? c.pending)], ['Oldest item age', safe(c.oldestAge)], ['Outbox state', safe(c.outboxState)]]), metricPanel('Registration', [['Registered', c.registered ? 'Yes' : 'No'], ['Server', c.serverConfigured ? 'Configured' : 'Not configured'], ['Server URL', 'Redacted']])); area.append(grid); return area; }

const groups = [['Server', 'Effective listener address and environment-controlled availability.', []], ['Security', 'Password access for this dashboard.', []], ['URL notes', 'Read a submitted URL with a local Claude or Codex CLI. The selected CLI receives the URL and page content.', []], ['Scheduler', 'Adaptive background scheduling.', [['scheduler.enabled', 'Enabled'], ['scheduler.paused', 'Paused'], ['scheduler.mode', 'Mode'], ['scheduler.timezone', 'Time zone'], ['scheduler.targetLocalTime', 'Target local time'], ['scheduler.quietStart', 'Quiet window starts'], ['scheduler.quietEnd', 'Quiet window ends'], ['scheduler.micro.enabled', 'Micro runs enabled']]], ['Dream', 'Dreaming and event-driven learning.', [['dream.enabled', 'Enabled'], ['dream.eventDriven', 'Event driven'], ['dream.autoAccept', 'Auto accept']]], ['Auto-accept & workspaces', 'Semantic writes and workspace scope.', [['adaptive.autoAccept', 'Auto accept mode'], ['adaptive.workspaces.include', 'Included workspaces'], ['adaptive.workspaces.exclude', 'Excluded workspaces']]], ['Embeddings', 'Semantic search uses a local SQLite index. Remote endpoints receive eligible text only with explicit network consent; private workspace documents need the separate private-content consent.', [['embedding.provider', 'Provider'], ['embedding.model', 'Model'], ['embedding.baseUrl', 'Base URL'], ['embedding.apiKeyEnv', 'API key environment variable'], ['embedding.dimensions', 'Dimensions'], ['embedding.batchSize', 'Batch size'], ['embedding.allowNetwork', 'Allow network'], ['embedding.allowPrivateContentToRemote', 'Allow private workspace text to remote embeddings']]]];

function switchLabel(input, label, description = '', className = '') { input.setAttribute('role', 'switch'); input.setAttribute('aria-label', label); const wrapper = node('label', 'switch ' + className); const track = node('span', 'track'); track.setAttribute('aria-hidden', 'true'); track.append(node('span', 'thumb')); const text = node('span', 'switch-label'); text.append(node('span', '', label)); if (description)
    text.append(node('small', 'switch-description', description)); wrapper.append(input, track, text); return wrapper; }

function makeControl(key, label, value, locked) {
    const wrap = node('div', 'setting-control');
    let input, custom;
    if (key === 'embedding.model') {
        input = document.createElement('select');
        input.id = 'embedding-model-select';
        input.setAttribute('aria-label', 'Embedding model');
        const defaultOption = node('option', '', 'Provider default (recommended)');
        defaultOption.value = '';
        input.append(defaultOption);
        custom = node('option', '', 'Custom…');
        custom.value = '__custom';
        input.append(custom);
        const text = document.createElement('input');
        text.type = 'text';
        text.id = 'embedding-model';
        text.setAttribute('aria-label', 'Custom embedding model');
        text.value = value || '';
        text.hidden = true;
        const help = node('small', 'help', 'Loading embedding models…'), refresh = node('button', 'secondary', 'Refresh list');
        refresh.type = 'button';
        const getProvider = () => changed.has('embedding.provider') ? changed.get('embedding.provider') : settings?.settings?.['embedding.provider'];
        const load = async (force = false) => { try {
            const result = await api('/api/embedding/models?provider=' + encodeURIComponent(getProvider() || '') + (force ? '&refresh=1' : ''));
            for (const option of [...input.options].slice(1, -1))
                option.remove();
            for (const model of result.models || []) {
                const option = node('option', '', model.label || model.id);
                option.value = model.id;
                input.insertBefore(option, custom);
            }
            if (text.value) {
                input.value = Array.from(input.options).some(item => item.value === text.value) ? text.value : '__custom';
                text.hidden = input.value !== '__custom';
            }
            help.textContent = result.reason || ((result.models || []).length + ' embedding models available');
        }
        catch (error) {
            help.textContent = 'Embedding model list unavailable: ' + error.message;
        } };
        refresh.onclick = () => void load(true);
        input.addEventListener('change', () => { if (input.value === '__custom') {
            text.hidden = false;
            text.focus();
            changed.set(key, text.value || '');
        }
        else {
            text.hidden = true;
            text.value = input.value;
            changed.set(key, input.value);
        } });
        text.addEventListener('input', () => changed.set(key, text.value));
        input.disabled = !!locked;
        refresh.disabled = !!locked;
        wrap.append(input, text, refresh, help);
        void load();
        const providerSelect = document.querySelector('#embedding-provider');
        if (providerSelect)
            providerSelect.addEventListener('change', () => void load(true));
        return wrap;
    }
    if (typeof value === 'boolean') {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = value;
        input.title = '';
    }
    else if (key === 'scheduler.mode' || key === 'adaptive.autoAccept' || key.endsWith('.provider')) {
        input = document.createElement('select');
        if (key === 'embedding.provider')
            input.id = 'embedding-provider';
        const opts = key === 'scheduler.mode' ? ['adaptive', 'fixed'] : key === 'adaptive.autoAccept' ? ['none', 'low-risk'] : key.startsWith('embedding.') ? [null, ...(value === 'builtin' ? ['builtin'] : []), 'ollama', 'openai', 'openai-compatible'] : [null, 'none', 'openai', 'ollama', 'openai-compatible', 'claude-cli', 'codex-cli', 'auto'];
        for (const option of opts) {
            const opt = node('option', '', option ?? 'None');
            opt.value = option === null ? '' : option;
            input.append(opt);
        }
        input.value = value ?? '';
    }
    else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
        input.setAttribute('aria-label', label);
        if (key.includes('timezone'))
            input.placeholder = 'America/Toronto';
        if (key.includes('LocalTime') || key.includes('quiet'))
            input.placeholder = 'HH:MM';
    }
    input.disabled = !!locked;
    input.addEventListener('input', () => { let next = input.type === 'checkbox' ? input.checked : input.value; if (key.endsWith('.include') || key.endsWith('.exclude')) {
        const values = String(next).split(',').map(s => s.trim()).filter(Boolean);
        next = key.endsWith('.include') && !values.length ? null : values;
    } if (key === 'model.provider' || key === 'embedding.provider' || next === '')
        next = next === '' ? null : next; changed.set(key, next); if (key === 'embedding.provider') {
        changed.set('embedding.model', '');
        const model = document.querySelector('#embedding-model');
        if (model)
            model.value = '';
    } savebar.hidden = changed.size === 0; savecount.textContent = changed.size + ' unsaved ' + (changed.size === 1 ? 'change' : 'changes'); });
    input.addEventListener('change', () => input.dispatchEvent(new Event('input')));
    if (input.type === 'checkbox') {
        const toggle = switchLabel(input, label, '');
        if (locked)
            toggle.title = locked;
        wrap.append(toggle);
    }
    else
        wrap.append(input);
    return wrap;
}

let savebar, savecount;

async function copyValue(value) { try {
    await navigator.clipboard.writeText(value);
    notify('Copied to clipboard');
}
catch {
    notify('Clipboard unavailable');
} }

function tunnelStatusLabel(state, reason) { return state === 'unknown' ? 'Status unavailable, retrying' : state === 'connected' ? 'Connected' : state === 'starting' ? 'Starting…' : state === 'running-not-ready' ? 'Running, not ready' : state === 'failing' ? 'Failing: ' + (reason || 'check tunnel logs') : 'Stopped'; }

function tunnelActionDisabled(action, state, statusUnknown) { return action === 'start' && state === 'connected' && !statusUnknown || action === 'stop' && state === 'stopped' && !statusUnknown; }

async function builtinEmbeddingPanel() { const box = panel('System default (bge-m3)'); box.append(node('p', 'help', 'Downloads the pinned multilingual model from Hugging Face only after you choose Download. The download is verified and cached outside the vault and app. Indexing uses about 1.8 GiB RAM and can take several minutes; enabling semantic search turns on the SQLite index.')); let info; try {
    info = await api('/api/embedding/builtin');
}
catch (error) {
    box.append(node('p', 'empty', 'Built-in model status unavailable: ' + error.message));
    return box;
} const p = info.preview; if (!p) {
    box.append(node('p', 'help', 'Built-in model preview is unavailable.'));
    return box;
} box.append(node('p', 'help', p.repo + ' @ ' + p.revision + ' · ' + p.license + ' · ' + (p.totalBytes / 1024 / 1024).toFixed(1) + ' MiB · ' + p.destination)); for (const file of p.files)
    box.append(node('small', 'help', file.name + ' · ' + file.bytes + ' bytes · SHA-256 ' + file.sha256)); const state = node('p', 'status-badge state-' + (info.status.state === 'ready' ? 'ok' : 'unknown'), info.status.state === 'ready' ? 'Ready, loaded' : info.status.state); box.append(state); const progress = node('progress'); progress.max = 100; progress.value = 0; progress.hidden = true; box.append(progress); const statusLine = node('p', 'help', ''); box.append(statusLine); const controls = node('div', 'action-row'); const select = node('button', 'primary', info.status.state === 'ready' ? 'Activate and index' : 'Download and select'); select.type = 'button'; select.addEventListener('click', async () => { if (info.status.state !== 'ready' && !window.confirm('Download and verify the pinned bge-m3 model (' + (p.totalBytes / 1024 / 1024).toFixed(1) + ' MiB)? It stays on this device and no vault text is sent.'))
    return; const password = window.prompt('Re-enter the dashboard password to authorize this model change'); if (password === null)
    return; select.disabled = true; try {
    if (info.status.state !== 'ready') {
        await api('/api/embedding/builtin/download', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: JSON.stringify({ confirm: 'DOWNLOAD BGE-M3' }) });
        progress.hidden = false;
        let done = false;
        while (!done) {
            await new Promise(r => setTimeout(r, 1000));
            const current = await api('/api/embedding/builtin/progress');
            if (current.state === 'downloading') {
                progress.value = current.totalBytes ? 100 * current.bytes / current.totalBytes : 0;
                statusLine.textContent = 'Downloading ' + current.file + ' · ' + Math.round(progress.value) + '%';
            }
            else if (current.state === 'verifying') {
                statusLine.textContent = 'Verifying ' + current.file + '…';
            }
            else if (current.state === 'failed')
                throw new Error(current.reason);
            else if (current.state === 'ready')
                done = true;
        }
    }
    await api('/api/embedding/builtin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: '{}' });
    statusLine.textContent = 'Model loaded. Building the semantic index…';
    const action = await api('/api/actions/embed-sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    let result;
    do {
        await new Promise(r => setTimeout(r, 1000));
        result = await api('/api/actions/' + action.id);
    } while (result.state === 'running');
    if (result.state !== 'complete')
        throw new Error(result.error || 'Embedding sync failed');
    statusLine.textContent = 'Ready, loaded · semantic index built';
    notify('Built-in embeddings are ready');
    await refresh();
}
catch (error) {
    notify(error.message);
    statusLine.textContent = 'Failed: ' + error.message;
}
finally {
    select.disabled = false;
} }); controls.append(select); const cancel = node('button', 'secondary', 'Cancel download'); cancel.type = 'button'; cancel.addEventListener('click', async () => { try {
    await api('/api/embedding/builtin/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    statusLine.textContent = 'Cancellation requested';
}
catch (error) {
    notify(error.message);
} }); controls.append(cancel); box.append(controls); const test = node('button', 'secondary', 'Test embedding'); test.type = 'button'; test.addEventListener('click', async () => { try {
    const result = await api('/api/actions/test-embedding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    notify(result.dimensions + ' dimensions · ' + result.latencyMs + ' ms · ' + result.locality);
}
catch (error) {
    notify(error.message);
} }); box.append(test); const secretInput = document.createElement('input'); secretInput.type = 'password'; secretInput.autocomplete = 'new-password'; secretInput.placeholder = settings?.settings?.['embedding.apiKeySet'] ? 'Key saved; enter a replacement' : 'Optional API key'; secretInput.setAttribute('aria-label', 'Embedding API key'); const saveSecret = node('button', 'secondary', 'Save embedding key'); saveSecret.type = 'button'; saveSecret.addEventListener('click', async () => { if (!secretInput.value)
    return notify('Enter a key first'); const password = window.prompt('Re-enter the dashboard password to save this key'); if (password === null)
    return; try {
    await api('/api/settings/embedding-secret', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: JSON.stringify({ value: secretInput.value, etag: settings.etag }) });
    secretInput.value = '';
    notify('Embedding key saved');
    await loadSettings();
    void settingsPage();
}
catch (error) {
    notify(error.message);
} }); const removeSecret = node('button', 'secondary', 'Remove embedding key'); removeSecret.type = 'button'; removeSecret.disabled = !settings?.settings?.['embedding.apiKeySet']; removeSecret.addEventListener('click', async () => { const password = window.prompt('Re-enter the dashboard password to remove this key'); if (password === null)
    return; try {
    await api('/api/settings/embedding-secret', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Engram-Reauth-Password': password }, body: JSON.stringify({ etag: settings.etag }) });
    notify('Embedding key removed');
    await loadSettings();
    void settingsPage();
}
catch (error) {
    notify(error.message);
} }); box.append(secretInput, saveSecret, removeSecret); return box; }

function tokenDialog(token) { const dialog = document.querySelector('#credential-modal'), field = document.querySelector('#credential-token'); field.value = token; dialog.showModal(); const clear = () => { field.value = ''; dialog.close(); }; document.querySelector('#credential-modal-close').onclick = clear; document.querySelector('#credential-done').onclick = clear; document.querySelector('#credential-copy').onclick = () => void copyValue(field.value); dialog.addEventListener('close', () => { field.value = ''; }, { once: true }); }

async function connectorsPanel() { const wrap = node('section', 'setting-groups'), head = pageHeader('Connectors', 'Configure the private ChatGPT tunnel and workspace-keyed gateway.'); wrap.setAttribute('data-connector-live', 'true'); wrap.append(head); let response; try {
    response = await api('/api/connectors/openai/status');
}
catch (error) {
    wrap.append(node('p', 'empty', 'Connector settings unavailable: ' + error.message));
    return wrap;
} const cfg = response.config, status = response.status, card = panel('OpenAI / ChatGPT'), form = node('div', 'connector-card'), tunnel = document.createElement('input'), key = document.createElement('input'), org = document.createElement('input'), profile = document.createElement('input'); for (const [input, label, value, type] of [[tunnel, 'Tunnel ID', cfg.tunnelId || '', 'text'], [key, 'Tunnel API key', '', 'password'], [org, 'Organization ID', cfg.organizationId || '', 'text'], [profile, 'Profile name', cfg.profileName || 'engram-keyed', 'text']]) {
    input.type = type;
    input.value = value;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', label);
    input.placeholder = label === 'Tunnel API key' ? (cfg.apiKeySet ? 'Set · enter to replace' : 'Not set') : label;
    const field = node('label', 'field', label);
    field.append(input);
    if (label === 'Tunnel API key')
        field.append(node('small', 'muted', cfg.apiKeySet ? 'Key is write only. Replace or remove it.' : 'Stored in a private file; never returned.'));
    form.append(field);
} const removeKey = document.createElement('input'); removeKey.type = 'checkbox'; form.append(node('p', 'set-chip', 'API key: ' + (cfg.apiKeySet ? 'Set' : 'Not set'))); const replaceKey = node('button', 'secondary', 'Replace API key'); replaceKey.type = 'button'; replaceKey.onclick = () => key.focus(); form.append(replaceKey, switchLabel(removeKey, 'Remove saved API key', 'Deletes the local key from its private environment file.')); const save = node('button', 'primary', 'Save tunnel settings'); save.type = 'button'; save.onclick = async () => { try {
    await api('/api/connectors/openai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnelId: tunnel.value, ...(key.value ? { apiKey: key.value } : removeKey.checked ? { apiKey: null } : {}), organizationId: org.value, profileName: profile.value || 'engram-keyed' }) });
    notify('Tunnel settings saved');
    void render(true);
}
catch (error) {
    notify(error.message);
} }; form.append(save); card.append(form); const statusLine = node('div', 'connector-status'), tunnelState = status.tunnelClient?.state || (status.tunnelClient?.loaded ? 'starting' : 'stopped'), tunnelText = tunnelStatusLabel(tunnelState, status.tunnelClient?.failureReason); for (const [label, value, tone] of [['Gateway', status.gateway?.state === 'unknown' ? 'Status unavailable, retrying' : status.gateway?.failureReason || (status.gateway?.healthy ? 'Healthy' : status.keyedGateway?.loaded ? 'Stopped' : 'Stopped'), status.gateway?.healthy ? 'state-ok' : 'state-unknown'], ['Tunnel', tunnelText, tunnelState === 'connected' ? 'state-ok' : tunnelState === 'failing' ? 'state-problem' : 'state-unknown'], ['Binary', status.binaryFound ? 'Found' : 'Not found', status.binaryFound ? 'state-ok' : 'state-unknown'], ['Profile', status.profilePresent ? 'Ready' : 'Missing', status.profilePresent ? 'state-ok' : 'state-unknown']]) {
    const badge = node('span', 'status-badge ' + tone, label + ': ' + value);
    badge.setAttribute('data-key', 'connector-status-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    statusLine.append(badge);
} card.append(statusLine); const tunnelDetails = document.createElement('details'); tunnelDetails.setAttribute('data-key', 'connector-tunnel-details'); const detailSummary = node('summary', '', 'Details'); tunnelDetails.append(detailSummary); const tunnelDetailText = ['Uptime: ' + (status.tunnelClient?.uptimeSeconds === null || status.tunnelClient?.uptimeSeconds === undefined ? 'Unknown' : status.tunnelClient.uptimeSeconds + ' seconds'), 'Local health URL: ' + (status.tunnelClient?.healthUrl || 'Unavailable'), 'Last log time: ' + (status.tunnelClient?.lastLogAt || 'Unknown')]; for (const line of tunnelDetailText)
    tunnelDetails.append(node('p', 'muted', line)); const recentLogs = node('pre', 'panel'); recentLogs.setAttribute('data-key', 'connector-tunnel-recent-logs'); recentLogs.textContent = (status.tunnelClient?.recentLogLines || []).join('\n') || 'No recent non-noise tunnel log lines.'; tunnelDetails.append(recentLogs); card.append(tunnelDetails); if (!status.binaryFound)
    card.append(node('p', 'help', 'Install tunnel-client in the agent-slack tools directory, ~/.config/engram/tunnel-client, or PATH.')); const statusUnknown = status.gateway?.state === 'unknown' || tunnelState === 'unknown', service = node('div', 'action-row'); for (const action of ['start', 'stop', 'restart']) {
    const button = node('button', action === 'start' ? 'primary' : 'secondary', action[0].toUpperCase() + action.slice(1));
    button.type = 'button';
    button.setAttribute('data-key', 'connector-action-' + action);
    button.disabled = tunnelActionDisabled(action, tunnelState, statusUnknown);
    if (action === 'start' && !cfg.workspaces.length) {
        button.disabled = true;
        button.setAttribute('aria-describedby', 'connector-start-reason');
    }
    button.onclick = async () => { const label = action[0].toUpperCase() + action.slice(1); button.disabled = true; button.textContent = action === 'stop' ? 'Stopping…' : action === 'restart' ? 'Restarting…' : 'Starting…'; notify(button.textContent + ' tunnel'); try {
        const result = await api('/api/connectors/openai/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let current = result.status?.tunnelClient;
        for (let attempt = 0; action !== 'stop' && attempt < 60 && current?.state !== 'connected' && current?.state !== 'failing'; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            current = (await api('/api/connectors/openai/status')).status?.tunnelClient;
        }
        if (action === 'stop')
            notify('Tunnel stopped');
        else if (result.message === 'Tunnel services are already running.')
            notify('Tunnel is already running · ' + (current?.state === 'connected' ? 'connected' : current?.state === 'running-not-ready' ? 'running, not ready' : 'starting'));
        else if (current?.state === 'connected')
            notify('Tunnel connected');
        else
            notify(current?.failureReason || (current?.state === 'running-not-ready' ? 'Tunnel is running, not ready' : 'Tunnel status: ' + (current?.state || 'unavailable')));
        void render(true);
    }
    catch (error) {
        notify(error.message);
    }
    finally {
        button.textContent = label;
        button.disabled = tunnelActionDisabled(action, tunnelState, statusUnknown) || action === 'start' && !cfg.workspaces.length;
    } };
    service.append(button);
} if (!cfg.workspaces.length) {
    const reason = node('p', 'help', 'Start needs at least one workspace row. Add a name, Engram workspace ID, optional collection, and choose whether writes are allowed.');
    reason.id = 'connector-start-reason';
    service.append(reason);
} card.append(service); const instructions = panel('ChatGPT setup'), info = node('p', 'help', 'Use the tunnel connection provided by OpenAI. Personal is shared memory for all chat AIs. New chats start in personal/chat; the model passes a returned conversationId only when the user explicitly asks to continue. Accepted preferences use personal/preferences. Dream processes personal chat and preferences under its review and evidence rules. Use engram_project_projection to request relevant project context; the server ranks, scopes, deduplicates and enforces the token budget. Reserved names: profile, user-insight and wiki.'); instructions.append(info); const workspaceNames = [...new Set([...(cfg.reachableWorkspaces || []).map(row => row.name), ...cfg.workspaces.map(row => row.name)])].join(', ') || 'None configured'; instructions.append(node('p', 'muted', 'Reachable workspace names: ' + workspaceNames)); const copyNames = node('button', 'secondary', 'Copy workspace names'); copyNames.type = 'button'; copyNames.onclick = () => void copyValue(workspaceNames); instructions.append(copyNames); instructions.append(node('p', 'muted', 'No public URL or OAuth client is used.')); wrap.append(card, instructions); const work = panel('Workspace access'), explain = node('p', 'help', 'The default personal row stores live conversations in personal/chat and accepted preference insights in personal/preferences for all chat AIs. Name profile or user-insight to read or update accepted profile memory. The reserved wiki name reads global accepted wiki pages and permits normal create or patch revisions when connector writes are enabled; no deletion tool is exposed. Name any reachable workspace for project memory.'); work.append(explain); const chatWrite = document.createElement('input'); chatWrite.type = 'checkbox'; chatWrite.checked = cfg.chatGPTMayWrite !== false; chatWrite.setAttribute('data-key', 'connector-chatgpt-may-write'); chatWrite.onchange = async () => { try {
    await api('/api/connectors/openai/writes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: chatWrite.checked }) });
    notify('ChatGPT write setting saved');
    void render(true);
}
catch (error) {
    chatWrite.checked = !chatWrite.checked;
    notify(error.message);
} }; work.append(switchLabel(chatWrite, 'ChatGPT may write', 'Turns off every ChatGPT write tool while keeping read access.')); work.append(node('p', 'help', 'Warning: name-only access means anyone who can reach the tunnel can read and write all memory, protected only by the tunnel and its inbound key.')); const byName = document.createElement('input'); byName.type = 'checkbox'; byName.checked = cfg.allowAnyWorkspaceByName !== false; byName.setAttribute('data-key', 'connector-any-workspace-by-name'); const byNameLabel = switchLabel(byName, 'Allow any workspace by name', 'When enabled, ChatGPT can select any listed reachable workspace without a row per project.'); byName.onchange = async () => { try {
    await api('/api/connectors/openai/by-name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: byName.checked }) });
    notify('Workspace-by-name setting saved');
    void render(true);
}
catch (error) {
    notify(error.message);
} }; work.append(byNameLabel); const accessTable = node('table', 'data-table'), accessBody = node('tbody'); for (const item of cfg.reachableWorkspaces || []) {
    const tr = node('tr');
    tr.setAttribute('data-key', 'reachable-workspace-' + item.name);
    tr.append(node('td', '', item.name), node('td', '', item.name === 'personal' ? 'Shared chat AI memory · chat and preferences' : item.name === 'wiki' ? 'Global accepted wiki' : 'Project memory'));
    const cell = node('td'), toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = !!item.allowWrites;
    toggle.disabled = item.name === 'wiki';
    toggle.setAttribute('aria-label', 'Allow ChatGPT to write to ' + item.name);
    toggle.onchange = async () => { try {
        await api('/api/connectors/openai/workspaces/' + encodeURIComponent(item.name) + '/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ allowWrites: toggle.checked }) });
        notify('Workspace write access saved');
        void render(true);
    }
    catch (error) {
        toggle.checked = !toggle.checked;
        notify(error.message);
    } };
    cell.append(switchLabel(toggle, 'Allow writes', 'Default on; toggle off for read-only access'));
    tr.append(cell);
    accessBody.append(tr);
} accessTable.append(accessBody); work.append(accessTable); if (!cfg.workspaces.length) {
    const empty = node('div', 'empty-state connector-empty');
    empty.append(node('strong', '', 'No gateway rows configured'), node('p', 'help', 'The owner removed all rows. Add a workspace row below before starting the connector.'));
    const helper = node('button', 'secondary', 'Add my first workspace');
    helper.type = 'button';
    helper.onclick = () => { name.value = 'personal'; workspace.value = 'personal'; collection.value = 'chat'; writes.checked = true; name.focus(); };
    empty.append(helper);
    work.append(empty);
} const rowForm = node('div', 'credentials-form'), name = document.createElement('input'), workspace = document.createElement('input'), collection = document.createElement('input'), writes = document.createElement('input'), add = node('button', 'primary', 'Add workspace'); for (const [input, label] of [[name, 'Workspace name (lowercase slug)'], [workspace, 'Engram workspace ID'], [collection, 'Collection ID (optional)']]) {
    input.setAttribute('aria-label', label);
    input.setAttribute('data-key', 'connector-input-' + label.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    input.placeholder = label;
    rowForm.append(input);
} writes.type = 'checkbox'; writes.checked = true; rowForm.append(switchLabel(writes, 'Allow writes', 'On by default. Turn off to make this workspace read-only.')); add.type = 'button'; add.onclick = async () => { try {
    await api('/api/connectors/openai/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.value, workspace: workspace.value, ...(collection.value ? { collection: collection.value } : {}), allowWrites: writes.checked }) });
    notify('Workspace added');
    void render(true);
}
catch (error) {
    notify(error.message);
} }; rowForm.append(add); work.append(rowForm); const table = node('table', 'data-table'), body = node('tbody'); for (const item of cfg.workspaces) {
    const tr = node('tr');
    tr.setAttribute('data-key', 'workspace-' + item.name);
    for (const value of [item.name, item.workspace, item.collection || 'All collections', item.allowWrites ? 'Writes allowed' : 'Read only'])
        tr.append(node('td', '', value));
    const cell = node('td'), edit = node('button', 'secondary', 'Edit'), remove = node('button', 'secondary', 'Remove');
    edit.type = 'button';
    edit.disabled = !!item.isDefault;
    edit.textContent = item.isDefault ? 'Default chat row' : 'Edit';
    edit.onclick = () => { name.value = item.name; workspace.value = item.workspace; collection.value = item.collection || ''; writes.checked = !!item.allowWrites; add.textContent = 'Update workspace'; };
    remove.type = 'button';
    remove.onclick = async () => { try {
        await api('/api/connectors/openai/workspaces/' + encodeURIComponent(item.name), { method: 'DELETE' });
        notify('Workspace credential revoked');
        void render(true);
    }
    catch (error) {
        notify(error.message);
    } };
    cell.append(edit, remove);
    tr.append(cell);
    body.append(tr);
} table.append(body); work.append(table); const writesPanel = panel('Recent ChatGPT writes'), writesTable = node('table', 'data-table'), writesHead = node('thead'), writesHeader = node('tr'); for (const label of ['Time', 'Target', 'Revision'])
    writesHeader.append(node('th', '', label)); writesHead.append(writesHeader); writesTable.append(writesHead); const writesBody = node('tbody'); for (const item of cfg.recentWrites || []) {
    const row = node('tr');
    for (const value of [item.at ? new Date(item.at).toLocaleString() : '—', item.target, item.revisionId])
        row.append(node('td', '', safe(value)));
    writesBody.append(row);
} if (!(cfg.recentWrites || []).length) {
    const row = node('tr'), cell = node('td', 'empty', 'No ChatGPT writes recorded yet.');
    cell.colSpan = 3;
    row.append(cell);
    writesBody.append(row);
} writesTable.append(writesBody); writesPanel.append(writesTable); work.append(writesPanel); wrap.append(work); wrap.append(await claudePanel(), await anthropicTunnelPanel()); return wrap; }

async function anthropicTunnelPanel() { const card = panel('Anthropic MCP Tunnels'), status = node('p', 'help', 'Loading local tunnel state…'); card.append(node('p', 'help', 'Research preview. For Claude Managed Agents and the Messages API MCP connector. NOT available as a claude.ai custom connector. Needs Anthropic Console access (Manage tunnels permission), a Console-created tunnel, a registered CA certificate, Docker with Compose, and outbound access to Anthropic and Cloudflare. Engram reports local state only: it cannot verify your account or a real Claude tool call.'), node('p', 'muted', 'Docs: https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview')); const form = node('div', 'connector-card'), fields = {}; for (const [key, label, value] of [['tunnelId', 'Tunnel ID', ''], ['tunnelDomain', 'Tunnel domain', ''], ['route', 'Route name', ''], ['upstream', 'Upstream', 'http://host.docker.internal:3336'], ['listenPort', 'Proxy listen port', '8080'], ['token', 'Tunnel token (write only)', '']]) {
    const input = document.createElement('input');
    input.type = key === 'token' ? 'password' : 'text';
    input.value = value;
    input.placeholder = label;
    input.setAttribute('aria-label', label);
    input.autocomplete = 'off';
    fields[key] = input;
    const field = node('label', 'field', label);
    field.append(input);
    form.append(field);
} const saved = node('button', 'primary', 'Save tunnel settings'); saved.type = 'button'; saved.onclick = async () => { try {
    await api('/api/connectors/anthropic-tunnel/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tunnelId: fields.tunnelId.value, tunnelDomain: fields.tunnelDomain.value, route: fields.route.value, upstream: fields.upstream.value, listenPort: Number(fields.listenPort.value), ...(fields.token.value ? { token: fields.token.value } : {}) }) });
    fields.token.value = '';
    notify('Tunnel settings saved');
    void render(true);
}
catch (e) {
    notify(e.message);
} }; form.append(saved); card.append(form); const topology = node('p', 'help', 'Inside the proxy container, localhost is the proxy itself. The default upstream targets host.docker.internal:3336, but the Claude gateway binds loopback by default and is not reachable there. The owner must explicitly start it with GATEWAY_BIND set to a container-reachable address and inbound authentication; this exposes it on that interface. Protect it with the firewall and prefer the Docker bridge/host-gateway address. Engram never changes GATEWAY_BIND.'); card.append(topology); const reachCommand = 'docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl:latest -fsS http://host.docker.internal:3336/health', command = node('pre', 'panel', reachCommand), copyCommand = node('button', 'secondary', 'Copy reachability test command'); copyCommand.type = 'button'; copyCommand.onclick = () => void copyValue(reachCommand); card.append(node('p', 'muted', 'User-run container reachability test:'), command, copyCommand); let current; try {
    current = await api('/api/connectors/anthropic-tunnel/status');
    const c = current.config;
    if (c) {
        fields.tunnelId.value = c.tunnelId;
        fields.tunnelDomain.value = c.tunnelDomain;
        fields.route.value = c.route;
        fields.upstream.value = c.upstream;
        fields.listenPort.value = String(c.listenPort);
    }
}
catch (e) {
    status.textContent = 'Local tunnel status unavailable: ' + e.message;
} const refresh = async () => { try {
    const s = await api('/api/connectors/anthropic-tunnel/status');
    status.textContent = 'Docker: ' + (s.docker.found ? (s.docker.daemonRunning ? 'running' : 'found, daemon stopped') : 'not found') + ' · token: ' + (s.tokenSet ? 'set' : 'not set') + ' · certificates: ' + (s.certificates['ca.crt'].present ? 'present' : 'missing') + ' · ' + s.notVerifiedLive;
}
catch (e) {
    status.textContent = 'Local status unavailable: ' + e.message;
} }; void refresh(); card.append(status); const cert = node('button', 'secondary', 'Generate certificates'); cert.type = 'button'; cert.onclick = async () => { try {
    const result = await api('/api/connectors/anthropic-tunnel/certs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const dialog = node('pre', 'panel', result.caCertificate + '\n' + result.note + '\nCA expires: ' + result.caExpires + '\nServer expires: ' + result.serverExpires);
    card.append(dialog);
    void copyValue(result.caCertificate);
}
catch (e) {
    notify(e.message);
} }; const actionRow = node('div', 'action-row'), start = node('button', 'primary', 'Start stack'), stop = node('button', 'secondary', 'Stop stack'); start.type = stop.type = 'button'; start.onclick = async () => { const confirmation = prompt('Starting downloads the pinned third-party images:\n' + 'us-docker.pkg.dev/anthropic-public-registry/images/mcp-proxy@sha256:d243d30642d39857a0579e465cb3b9bf3ae7c1141e83143bb6856777a31467a5\ncloudflare/cloudflared@sha256:0e56c13c7058fcef9c4f0e7d83372f82330548dbf8f8b366f3d8b506526d93b2\nType PULL AND START'); if (confirmation !== 'PULL AND START')
    return; try {
    await api('/api/connectors/anthropic-tunnel/up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: confirmation }) });
    notify('Anthropic tunnel stack started');
    void refresh();
}
catch (e) {
    notify(e.message);
} }; stop.onclick = async () => { try {
    await api('/api/connectors/anthropic-tunnel/down', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    notify('Anthropic tunnel stack stopped');
    void refresh();
}
catch (e) {
    notify(e.message);
} }; const url = node('pre', 'panel', 'https://<route>.<domain>/<path>'); const copyUrl = node('button', 'secondary', 'Copy MCP URL template'); copyUrl.type = 'button'; copyUrl.onclick = () => { const c = current && current.config; void copyValue(c ? 'https://' + c.route + '.' + c.tunnelDomain + '/<path>' : 'https://<route>.<domain>/<path>'); }; actionRow.append(cert, start, stop, copyUrl); card.append(actionRow, node('p', 'muted', '1 Console: create tunnel and copy ID, domain, token. 2 Save values here. 3 Generate certificates and upload ca.crt in Console > Certificates. 4 Make upstream reachable. 5 Start stack after confirmation. 6 Attach in Managed Agents or Messages API mcp_servers using the URL above. Console tunnel registration, CA acceptance, and a real API tool call are not verified live.')); return card; }

async function claudePanel() { const wrap = node('section', 'setting-groups'), local = panel('Claude Code / Claude Desktop · local'), state = node('p', 'help', 'Checking this machine’s local Claude configuration…'); local.append(node('p', 'help', 'Local stdio uses this machine’s vault and needs no public URL.'), state); const snippets = node('pre', 'panel', ''); local.append(snippets); let localState; try {
    localState = await api('/api/connectors/claude/local');
    state.textContent = 'Node: ' + localState.node + ' · MCP server: ' + localState.mdbMcp + ' · vault: ' + localState.root + ' · Claude Code entry: ' + (localState.claudeCode.state.engramPresent ? 'present' : 'not present') + ' · Desktop entry: ' + (localState.desktop.state.engramPresent ? 'present' : 'not present');
    snippets.textContent = 'Claude Code command:\n' + localState.command + '\n\nClaude Desktop JSON:\n' + localState.snippets.desktopJson + '\n\nRemote stdio proxy (token env name only):\n' + localState.snippets.remote + (localState.desktop.note ? '\n' + localState.desktop.note : '');
}
catch (error) {
    state.textContent = 'Local Claude configuration unavailable: ' + error.message;
} const copyCode = node('button', 'secondary', 'Copy local command'); copyCode.type = 'button'; copyCode.onclick = () => localState && void copyValue(localState.command); local.append(copyCode); for (const [target, label, enabled] of [['claude-code', 'Add to Claude Code', true], ['claude-desktop', 'Add to Claude Desktop (macOS/Windows)', !!localState?.desktop.file]]) {
    const button = node('button', 'primary', label);
    button.type = 'button';
    button.disabled = !enabled;
    button.onclick = async () => { try {
        const preview = await api('/api/connectors/claude/local/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }) }), review = panel('Review local config change');
        review.append(node('p', 'help', 'Target: ' + preview.file + (preview.backupPath ? ' · backup: ' + preview.backupPath : ' · no existing file to back up')), node('pre', 'panel', preview.diff));
        const apply = node('button', 'primary', 'Apply changes'), cancel = node('button', 'secondary', 'Cancel');
        apply.type = cancel.type = 'button';
        cancel.onclick = () => review.remove();
        apply.onclick = async () => { if (!window.confirm('Apply this exact preview to ' + preview.file + '?'))
            return; try {
            const result = await api('/api/connectors/claude/local/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId: preview.previewId, digest: preview.digest }) });
            notify('Claude config updated' + (result.restartRequired ? '; restart Claude Desktop' : '') + (result.backupPath ? '; backup created' : ''));
            review.remove();
            void render(true);
        }
        catch (error) {
            notify(error.message);
        } };
        review.append(apply, cancel);
        wrap.append(review);
    }
    catch (error) {
        notify(error.message);
    } };
    local.append(button);
} wrap.append(local); const web = panel('claude.ai custom connector'), help = 'Claude calls this connector from Anthropic’s cloud and requires a public HTTPS MCP URL that you operate. Engram does not open ports, create DNS, run Cloudflare/ngrok, or publish this machine. Fixed request headers are a limited beta in Claude; anyone holding the key can use the configured gateway scopes.'; web.append(node('p', 'help', help)); let webState = { config: { url: '', mode: 'authless', headerName: 'x-api-key', keySet: false } }; try {
    webState = await api('/api/connectors/claude/web');
}
catch (error) {
    web.append(node('p', 'empty', 'Claude connector settings unavailable: ' + error.message));
} const url = document.createElement('input'); url.type = 'url'; url.value = webState.config?.url || ''; url.placeholder = 'https://your-public-host.example/mcp'; url.setAttribute('aria-label', 'Optional public HTTPS MCP URL'); const mode = document.createElement('select'); for (const [value, label] of [['authless', 'No authentication'], ['fixed-header', 'Fixed request header (limited beta)']]) {
    const option = node('option', '', label);
    option.value = value;
    mode.append(option);
} mode.value = webState.config?.mode || 'authless'; const header = document.createElement('select'); for (const value of ['x-api-key', 'authorization', 'x-auth-token']) {
    const option = node('option', '', value);
    option.value = value;
    header.append(option);
} header.value = webState.config?.headerName || 'x-api-key'; const field = (label, input) => { const item = node('label', 'field', label); item.append(input); return item; }; web.append(field('Optional public HTTPS MCP URL ending /mcp', url), field('Authentication', mode), field('Public header name', header), node('p', 'muted', 'Key status: ' + (webState.config?.keySet ? 'Set · never displayed again' : 'Not set'))); if (webState.config?.gateway) {
    web.append(node('p', 'help', 'This separate Claude gateway listens on loopback at ' + webState.config.gateway.url + '. Run its launcher manually and point your owner-operated HTTPS ingress to it. OpenAI keeps its existing gateway on port 3335.'));
    const launch = node('button', 'secondary', 'Copy Claude gateway launcher path');
    launch.onclick = () => void copyValue(webState.config.gateway.launcher);
    web.append(launch);
} const reveal = (key) => { if (!key)
    return; const box = panel('Copy this key now · shown once'), value = document.createElement('textarea'); value.readOnly = true; value.value = key; value.setAttribute('aria-label', 'One-time Claude connector key'); const copy = node('button', 'secondary', 'Copy key'); copy.onclick = () => void copyValue(key); box.append(node('p', 'help', 'Paste this value into Claude’s fixed request header now. Engram will not show it again.'), value, copy); web.append(box); }; const save = node('button', 'primary', 'Save claude.ai connector'); save.type = 'button'; save.onclick = async () => { try {
    const result = await api('/api/connectors/claude/web', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.value, mode: mode.value, headerName: header.value }) });
    webState = { config: result.config };
    if (result.oneTimeKey)
        reveal(result.oneTimeKey);
    notify('claude.ai connector settings saved');
    web.querySelector('.claude-key-state')?.remove();
}
catch (error) {
    notify(error.message);
} }; web.append(save); if (webState.config?.mode === 'fixed-header') {
    const rotate = node('button', 'secondary', 'Generate / rotate key');
    rotate.type = 'button';
    rotate.onclick = async () => { try {
        const result = await api('/api/connectors/claude/web/rotate-key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        webState.config = result.config;
        reveal(result.key);
        notify('New key generated; restart the local Claude gateway to apply it');
    }
    catch (error) {
        notify(error.message);
    } };
    const remove = node('button', 'secondary', 'Remove key and use no authentication');
    remove.type = 'button';
    remove.onclick = async () => { try {
        webState = await api('/api/connectors/claude/web/key', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        notify('Claude connector key removed');
    }
    catch (error) {
        notify(error.message);
    } };
    web.append(rotate, remove);
} const probe = node('button', 'secondary', 'Check configured URL reachability'); probe.type = 'button'; probe.onclick = async () => { try {
    const result = await api('/api/connectors/claude/web/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    notify('One HTTPS reachability request: HTTP ' + result.statusCode + ' · ' + result.latencyMs + ' ms');
}
catch (error) {
    notify(error.message);
} }; web.append(probe); wrap.append(web); return wrap; }

function dashboardCredentialPanel() { const wrap = panel('Remote dashboard credentials'), header = node('div', 'credential-heading'), badge = node('span', 'status-badge ' + (settings?.server?.remoteAdminEnabled ? 'state-ok' : 'state-unknown'), 'Remote administration: ' + (settings?.server?.remoteAdminEnabled ? 'enabled' : 'disabled')); header.append(badge); wrap.append(header, node('p', 'help', 'Create short-lived client access. Credentials are shown once; remote administration stays disabled until MDB_DASHBOARD_REMOTE_ADMIN=true and the listener is configured safely.')); const form = node('form', 'credentials-form remote-credentials-form'), label = document.createElement('input'), mode = document.createElement('select'); label.required = true; label.setAttribute('aria-label', 'Credential label'); const labelField = node('label', 'field', 'Credential label'); labelField.append(label); for (const value of ['admin', 'view']) {
    const option = node('option', '', value === 'admin' ? 'Admin' : 'View only');
    option.value = value;
    mode.append(option);
} const modeField = node('label', 'field', 'Access level'); modeField.append(mode); const create = node('button', 'primary', 'Create credential'); create.type = 'submit'; form.append(labelField, modeField, create); form.onsubmit = async (event) => { event.preventDefault(); try {
    const item = await api('/api/dashboard/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: label.value, mode: mode.value }) });
    document.querySelector('#credential-token').value = item.token;
    document.querySelector('#credential-modal').showModal();
    label.value = '';
    void render(true);
}
catch (error) {
    notify(error.message);
} }; wrap.append(form); void api('/api/dashboard/credentials').then(items => { const section = node('div', 'credential-list'), heading = node('h3', 'section-subheading', 'Existing credentials'), table = node('div', 'table-wrap'); section.append(heading); if (!items.length) {
    const empty = node('div', 'empty-state credential-empty');
    empty.append(node('strong', '', 'No credentials yet'), node('p', 'help', 'Create a short-lived credential to connect a remote client.'));
    table.append(empty);
}
else {
    const rows = node('table', 'data-table'), body = node('tbody');
    for (const item of items) {
        const row = node('tr');
        for (const value of [item.label, item.mode, new Date(item.expiresAt).toLocaleDateString(), item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : 'Never'])
            row.append(node('td', '', value));
        const cell = node('td'), button = node('button', 'secondary', 'Revoke');
        button.onclick = async () => { const confirmText = prompt('Type REVOKE ' + item.id + ' to revoke'); if (confirmText !== 'REVOKE ' + item.id)
            return; await api('/api/dashboard/credentials/' + encodeURIComponent(item.id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: confirmText }) }); void render(true); };
        cell.append(button);
        row.append(cell);
        body.append(row);
    }
    rows.append(body);
    table.append(rows);
} section.append(table); wrap.append(section); }).catch(error => wrap.append(node('p', 'empty', 'Credential list unavailable: ' + error.message))); return wrap; }

async function settingsPage() { const area = node('div'); area.append(pageHeader('Settings', 'Review every validated change before applying it.')); if (!settings) {
    area.append(node('p', 'empty', 'Loading effective settings…'));
    return area;
} const groupsEl = node('div', 'setting-groups'); groupsEl.append(modelSettingsPanel()); const commandLine = panel('Command line'); commandLine.setAttribute('data-key', 'command-line'); commandLine.setAttribute('data-connector-live', 'true'); void api('/api/shim/status').then(info => { const rows = node('dl', 'metric-list'); rows.append(node('dt', '', 'Installed command'), node('dd', '', info.path + (info.installed ? ' · installed' : ' · not installed')), node('dt', '', 'PATH'), node('dd', '', info.onPath ? 'Available in PATH' : 'Not in PATH')); commandLine.append(rows); if (!info.onPath && info.pathSuggestion) {
    const suggestion = node('pre', '', info.pathSuggestion), copy = node('button', 'secondary', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => { await navigator.clipboard.writeText(info.pathSuggestion); copy.textContent = 'Copied'; };
    commandLine.append(suggestion, copy);
} }).catch(() => commandLine.append(node('p', 'muted', 'Command-line status unavailable. Run mdb shim status for details.'))); groupsEl.append(commandLine); for (const [title, description, fields] of groups) {
    const card = panel(title);
    card.id = 'group-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    card.classList.add('setting-group');
    card.append(node('p', '', description));
    if (title === 'Server') {
        for (const [label, value, lock] of [['Bind address', settings.server?.host, 'Read only'], ['Port', settings.server?.port, 'Read only'], ['Enabled', settings.server?.dashboardEnabled ? 'Yes' : 'No', settings.server?.dashboardEnvOverride ? '🔒 env override' : 'Default'], ['Change requires', 'Restart with --host and --port flags', 'Read only']]) {
            const row = node('div', 'setting-row'), name = node('div', 'setting-name');
            name.append(node('strong', '', label));
            row.append(name, node('div', 'setting-control', safe(value)), node('span', 'source', lock));
            card.append(row);
        }
    }
    if (title === 'URL notes') {
        const status = node('p', 'muted', 'Checking CLI readiness…');
        card.append(status);
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        const confirm = document.createElement('input');
        confirm.placeholder = 'Type the requested confirmation phrase';
        confirm.setAttribute('aria-label', 'Type enable or disable confirmation');
        const save = node('button', 'primary', 'Save URL notes setting');
        save.onclick = async () => { try {
            await api('/api/url-notes/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled.checked, confirm: confirm.value }) });
            notify('URL notes setting saved');
            void settingsPage();
        }
        catch (e) {
            notify(e.message);
        } };
        enabled.addEventListener('change', () => { confirm.placeholder = 'Type ' + (enabled.checked ? 'ENABLE' : 'DISABLE') + ' URL NOTES'; confirm.value = ''; });
        const controls = node('div', 'url-note-controls');
        controls.append(confirm, save);
        card.append(switchLabel(enabled, 'Enable URL notes', 'Off by default. Reads submitted URLs only after you click the action.'), controls);
        void api('/api/url-notes/settings').then(value => { enabled.checked = value.enabled; status.textContent = 'Claude: ' + (value.readiness.claude.found ? value.readiness.claude.version + ' · ' + (value.readiness.claude.loggedIn === null ? 'login unknown' : value.readiness.claude.loggedIn ? 'logged in' : 'not logged in') : 'not found') + ' · Codex: ' + (value.readiness.codex.found ? value.readiness.codex.version + ' · ' + (value.readiness.codex.loggedIn === null ? 'login unknown' : value.readiness.codex.loggedIn ? 'logged in' : 'not logged in') : 'not found'); }).catch(e => status.textContent = 'CLI readiness unavailable: ' + e.message);
    }
    if (title === 'Security') {
        const rows = [['Password set', settings.security?.passwordSet ? 'Yes' : 'No']];
        for (const [label, value] of rows) {
            const row = node('div', 'setting-row'), name = node('div', 'setting-name');
            name.append(node('strong', '', label));
            row.append(name, node('div', 'setting-control', value), node('span', 'source', 'Read only'));
            card.append(row);
        }
        const current = document.createElement('input');
        current.type = 'password';
        current.autocomplete = 'current-password';
        current.setAttribute('aria-label', 'Current password');
        current.placeholder = 'Current password';
        const next = document.createElement('input');
        next.type = 'password';
        next.autocomplete = 'new-password';
        next.minLength = 12;
        next.maxLength = 256;
        next.setAttribute('aria-label', 'New password');
        next.placeholder = 'New password (12–256 characters)';
        const confirm = document.createElement('input');
        confirm.type = 'password';
        confirm.autocomplete = 'new-password';
        confirm.setAttribute('aria-label', 'Confirm new password');
        confirm.placeholder = 'Confirm new password';
        const change = node('button', 'primary', 'Change password');
        change.type = 'button';
        change.addEventListener('click', async () => { try {
            await api('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: current.value, password: next.value, confirm: confirm.value }) });
            sessionMode = false;
            document.querySelector('#logout').hidden = true;
            passwordSet = true;
            showLogin();
        }
        catch (error) {
            notify(error.message);
        } });
        const everywhere = node('button', 'secondary', 'Sign out everywhere');
        everywhere.type = 'button';
        everywhere.addEventListener('click', async () => { try {
            await api('/api/auth/logout-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            sessionMode = false;
            showLogin();
        }
        catch (error) {
            notify(error.message);
        } });
        const form = node('div', 'auth-form');
        form.append(current, next, confirm, change, everywhere);
        card.append(form);
    }
    for (const [key, label] of fields) {
        const row = node('div', 'setting-row'), name = node('div', 'setting-name'), locked = settings.locks?.[key], source = settings.sources?.[key] || 'file';
        name.append(node('strong', '', label));
        if (source === 'env')
            name.append(node('small', '', 'Set by an environment variable'));
        row.append(name, makeControl(key, label, settings.settings?.[key], locked));
        if (locked || source !== 'file') {
            const badge = node('span', 'source ' + (locked ? 'lock' : ''), locked ? '🔒 ' + locked : source);
            row.append(badge);
        }
        card.append(row);
    }
    groupsEl.append(card);
} savebar = node('div', 'savebar'); savebar.hidden = changed.size === 0; savecount = node('span', '', changed.size + ' unsaved changes'); const buttons = node('div', 'action-row'); const discard = node('button', 'secondary', 'Discard'); discard.type = 'button'; discard.addEventListener('click', () => { changed.clear(); settings = null; loadSettings().then(render); }); const review = node('button', 'primary', 'Review changes'); review.type = 'button'; review.addEventListener('click', reviewChanges); buttons.append(discard, review); savebar.append(savecount, buttons); area.append(groupsEl, savebar); const [embedding, connectors] = await Promise.all([builtinEmbeddingPanel(), connectorsPanel()]); if (page === 'settings') {
    embedding.dataset.section = 'model';
    connectors.dataset.section = 'connectors';
    const credentials = dashboardCredentialPanel();
    credentials.dataset.section = 'access';
    area.append(embedding, connectors, credentials);
}
organizeSettings(area, groupsEl);
return area; }
const SETTINGS_SECTIONS = [['model', 'Model'], ['learning', 'Learning'], ['connectors', 'Connectors'], ['access', 'Access'], ['system', 'System']];
const SETTINGS_PANEL_SECTION = { 'Model': 'model', 'Embeddings': 'model', 'URL notes': 'model', 'Scheduler': 'learning', 'Dream': 'learning', 'Auto-accept & workspaces': 'learning', 'Security': 'access', 'Server': 'system', 'Command line': 'system' };
function settingsSection() {
    const wanted = location.hash.slice(1).split('/')[1];
    return SETTINGS_SECTIONS.some(item => item[0] === wanted) ? wanted : SETTINGS_SECTIONS[0][0];
}
/** One view per area: each settings panel belongs to a section; only the active section is shown, chosen with #settings/<section>. */
function organizeSettings(area, groupsEl) {
    const active = settingsSection();
    for (const element of [...groupsEl.children]) {
        const title = element.querySelector(':scope > h2')?.textContent || '';
        element.dataset.section = SETTINGS_PANEL_SECTION[title] || element.dataset.section || 'system';
    }
    for (const element of area.querySelectorAll('[data-section]'))
        element.hidden = element.dataset.section !== active;
    const tabs = node('nav', 'setting-tabs');
    tabs.setAttribute('aria-label', 'Settings sections');
    for (const [id, label] of SETTINGS_SECTIONS) {
        const link = node('a', '', label);
        link.href = '#settings/' + id;
        link.setAttribute('aria-current', id === active ? 'page' : 'false');
        tabs.append(link);
    }
    area.firstChild.after(tabs);
}

function modelSettingsPanel() {
    const box = panel('Model'), value = key => changed.has(key) ? changed.get(key) : settings?.settings?.[key], locked = settings?.locks?.['model.provider'], agents = modelDetection?.agents || [], ollama = modelDetection?.ollama || { reachable: false, models: [] };
    const field = (labelText, input, help) => { const label = node('label', 'field', labelText); label.append(input); if (help)
        label.append(node('small', 'help', help)); return label; };
    const provider = document.createElement('select');
    provider.setAttribute('aria-label', 'Model provider');
    const names = [...(modelDetection?.providers || ['auto', 'claude-cli', 'codex-cli', 'openai', 'ollama', 'openai-compatible']), 'none'];
    for (const id of names) {
        let suffix = '';
        if (id === 'ollama')
            suffix = ollama.reachable ? ' · reachable (' + ollama.models.length + ' models)' : ' · unreachable';
        if (id === 'claude-cli' || id === 'codex-cli') {
            const agent = agents.find(item => item.id === id);
            suffix = agent?.found ? ' · ' + agent.path + ' · ' + (agent.version || 'version unknown') : ' · not found (install the CLI or add it to PATH)';
        }
        if (id === 'openai')
            suffix = value('model.provider') === 'openai' && value('model.modelName') && value('model.apiKeySet') ? ' · configured; test to verify' : ' · needs model and key';
        if (id === 'openai-compatible')
            suffix = value('model.provider') === 'openai-compatible' && value('model.modelName') && value('model.baseUrl') ? ' · configured; test to verify' : ' · needs URL and model';
        const option = node('option', '', id === 'none' ? 'No provider' : id + suffix);
        option.value = id;
        provider.append(option);
    }
    provider.value = value('model.provider') || 'none';
    provider.disabled = !!locked;
    provider.addEventListener('change', () => { queue('model.provider', provider.value === 'none' ? null : provider.value); name.value = ''; modelSelect.value = ''; name.hidden = true; queue('model.modelName', ''); void previewPrivacy(provider.value === 'none' ? null : provider.value); void fetchModelList(); });
    const modelSelect = document.createElement('select');
    modelSelect.id = 'model-name-select';
    modelSelect.setAttribute('aria-label', 'Model');
    const defaultModel = node('option', '', 'Provider default (recommended)');
    defaultModel.value = '';
    modelSelect.append(defaultModel);
    const name = document.createElement('input');
    name.type = 'text';
    name.id = 'model-name';
    name.maxLength = 200;
    name.setAttribute('aria-label', 'Custom model name');
    name.value = value('model.modelName') || '';
    const customOpt = node('option', '', 'Custom…');
    customOpt.value = '__custom';
    modelSelect.append(customOpt);
    let listedModels = [];
    let modelSource = '';
    const fillModels = (items, source) => { for (const option of [...modelSelect.options].slice(1, -1))
        option.remove(); listedModels = items || []; modelSource = source || ''; for (const item of listedModels) {
        const option = node('option', '', item.label || item.id);
        option.value = item.id;
        modelSelect.insertBefore(option, customOpt);
    } const selected = name.value; if (selected && listedModels.some(item => item.id === selected)) {
        modelSelect.value = selected;
        name.hidden = true;
    }
    else if (selected) {
        modelSelect.value = '__custom';
        name.hidden = false;
    }
    else {
        modelSelect.value = '';
        name.hidden = true;
    } };
    const fetchModelList = async (refresh = false) => { try {
        const query = '?provider=' + encodeURIComponent(provider.value) + (refresh ? '&refresh=1' : '');
        const result = await api('/api/models/list' + query);
        fillModels(result.models, result.source);
        modelListHelp.textContent = result.reason || ((result.source === 'provider' || result.source === 'curated') ? result.models.length + ' models available' : 'Model list unavailable');
        if (result.source === 'unavailable')
            modelListHelp.textContent = result.reason || 'Model list unavailable';
        checkStale();
    }
    catch (error) {
        modelListHelp.textContent = 'Model list unavailable: ' + error.message;
    } };
    const modelListHelp = node('small', 'help', 'Loading models…');
    const refreshModels = node('button', 'secondary', 'Refresh list');
    refreshModels.type = 'button';
    refreshModels.onclick = () => void fetchModelList(true);
    modelSelect.addEventListener('change', () => { if (modelSelect.value === '__custom') {
        name.hidden = false;
        name.focus();
        queue('model.modelName', name.value || '');
    }
    else {
        name.hidden = true;
        name.value = modelSelect.value;
        queue('model.modelName', modelSelect.value);
    } });
    name.addEventListener('input', () => { if (!name.hidden)
        queue('model.modelName', name.value); });
    const staleName = node('p', 'help', 'This model name was chosen for a different provider. Choose a listed model or Provider default.');
    staleName.hidden = true;
    const checkStale = () => { const saved = value('model.modelName') || ''; staleName.hidden = changed.has('model.modelName') || !saved || !modelSource || modelSource === 'unavailable' || listedModels.some(item => item.id === saved); };
    modelSelect.addEventListener('change', checkStale);
    fillModels([], '');
    void fetchModelList();
    const base = document.createElement('input');
    base.type = 'url';
    base.id = 'model-base-url';
    base.maxLength = 2048;
    base.setAttribute('aria-label', 'Base URL');
    base.value = value('model.baseUrl') || '';
    base.required = provider.value === 'openai-compatible';
    base.addEventListener('input', () => queue('model.baseUrl', base.value || null));
    const baseHelp = () => provider.value === 'claude-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (maps to ANTHROPIC_BASE_URL for Claude Code).' : provider.value === 'codex-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (uses the Codex base URL option).' : provider.value === 'ollama' ? 'Optional. Defaults to the local Ollama server.' : provider.value === 'openai-compatible' ? 'Required. Use an HTTP or HTTPS OpenAI-compatible endpoint.' : 'Optional. Uses the provider default when blank.';
    const baseField = field('Base URL', base, baseHelp());
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.autocomplete = 'new-password';
    keyInput.setAttribute('aria-label', 'API key');
    keyInput.placeholder = 'Enter a key to replace the saved key';
    const keySource = value('model.apiKeySource'), keyBadge = node('span', 'status-badge ' + (value('model.apiKeySet') ? 'state-ok' : 'state-unknown'), keySource === 'secret' ? 'Key saved' : keySource === 'env' ? 'Key supplied by environment' : 'No key');
    const keyButtons = node('div', 'action-row'), saveKey = node('button', 'secondary', 'Replace key'), removeKey = node('button', 'ghost', 'Remove key');
    saveKey.type = removeKey.type = 'button';
    removeKey.disabled = keySource !== 'secret';
    saveKey.addEventListener('click', async () => { if (!keyInput.value) {
        notify('Enter an API key to replace the saved key');
        return;
    } try {
        const result = await api('/api/settings/model-secret', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: keyInput.value, etag: settings.etag }) });
        keyInput.value = '';
        settings = result;
        notify('Model key saved securely');
        render(true);
    }
    catch (error) {
        keyInput.value = '';
        notify(error.message);
    } });
    removeKey.addEventListener('click', async () => { if (!window.confirm('Remove the saved model key?'))
        return; try {
        const result = await api('/api/settings/model-secret', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ etag: settings.etag }) });
        settings = result;
        notify('Saved model key removed');
        render(true);
    }
    catch (error) {
        notify(error.message);
    } });
    keyButtons.append(keyBadge, saveKey, removeKey);
    const cliKeyHelp = provider.value === 'claude-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (maps to ANTHROPIC_API_KEY for Claude Code).' : provider.value === 'codex-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (maps to OPENAI_API_KEY for Codex).' : 'Optional. Stored in a private secret file and never shown again.';
    const keyField = field('API key', keyInput, cliKeyHelp);
    keyField.append(keyButtons);
    const remoteNotice = node('p', 'remote-disclosure', settings?.settings?.['model.remote'] ? 'Your questions, retrieved wiki excerpts and Dream/profile content go to this vendor or host. Network and private-content consent are ' + (settings.settings['model.consentGiven'] ? 'enabled' : 'required before remote content is sent.') : 'Local provider selected. No remote content consent is needed.');
    remoteNotice.hidden = !settings?.settings?.['model.remote'];
    const consent = node('p', 'help', 'Consent: ' + (settings?.settings?.['model.remote'] ? (settings?.settings?.['model.consentGiven'] ? 'enabled' : 'not granted') : 'not required for this local provider') + '. Revoke consent at any time.');
    const revoke = node('button', 'secondary', 'Revoke remote consent');
    revoke.type = 'button';
    revoke.disabled = !(settings?.settings?.['model.allowNetwork'] || settings?.settings?.['model.allowPrivateContentToRemote']);
    revoke.addEventListener('click', async () => { try {
        for (const key of ['model.allowNetwork', 'model.allowPrivateContentToRemote']) {
            const result = await api('/api/settings/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: false, etag: settings.etag }) });
            if (result.conflict)
                throw new Error('Settings changed elsewhere; reload Settings');
            settings.etag = result.etag;
            settings.settings = result.settings;
        }
        await loadSettings();
        notify('Remote consent revoked');
        render(true);
    }
    catch (error) {
        notify(error.message);
    } });
    const test = node('button', 'primary', 'Test model'), testResult = node('p', 'help', 'Testing sends a synthetic prompt only. No vault content is sent.');
    test.type = 'button';
    test.addEventListener('click', async () => { if (!window.confirm('Send a synthetic connectivity prompt to the configured model? No vault content is sent.'))
        return; test.disabled = true; testResult.textContent = 'Testing configured model…'; try {
        const action = await api('/api/actions/test-model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        let state;
        for (let i = 0; i < 120; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            state = await api('/api/actions/' + action.id);
            if (state.state !== 'running')
                break;
        }
        const result = state?.result;
        if (state?.state === 'complete' && result) {
            testResult.textContent = result.ok ? 'Provider: ' + result.provider + ' · ' + result.locality + ' · ' + result.latencyMs + ' ms' : 'Test failed: ' + (result.error || 'Provider call failed');
        }
        else
            testResult.textContent = 'Test failed: ' + (state?.error || 'Model unavailable or request failed');
    }
    catch (error) {
        testResult.textContent = 'Test failed: ' + error.message;
    }
    finally {
        test.disabled = false;
    } });
    function queue(key, next) { changed.set(key, next); if (savebar) {
        savebar.hidden = changed.size === 0;
        savecount.textContent = changed.size + ' unsaved ' + (changed.size === 1 ? 'change' : 'changes');
    } }
    async function previewPrivacy(next) { base.required = next === 'openai-compatible'; baseField.querySelector('small').textContent = baseHelp(); keyField.querySelector('small').textContent = next === 'claude-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (maps to ANTHROPIC_API_KEY for Claude Code).' : next === 'codex-cli' ? 'Optional. Overrides the CLI\'s own login/endpoint (maps to OPENAI_API_KEY for Codex).' : 'Optional. Stored in a private secret file and never shown again.'; try {
        const response = await api('/api/settings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'model.provider', value: next, etag: settings.etag }) });
        remoteNotice.hidden = !response.remote;
        remoteNotice.textContent = response.remote ? 'Your questions, retrieved wiki excerpts and Dream/profile content go to this vendor or host. Typed confirmation enables both network and private-content consent.' : 'Local provider selected. No remote content consent is needed.';
    }
    catch { } }
    const modelField = field('Model name', modelSelect, 'Provider default leaves the model option unset.');
    modelField.append(name, refreshModels, modelListHelp, staleName);
    box.append(field('Provider', provider, modelDetection?.overriddenByEnvironment ? 'ENGRAM_MODEL_PROVIDER overrides this setting. The provider is locked until that environment variable is removed.' : 'Auto selects a runnable local provider. Detected CLI paths and Ollama reachability are shown in the choices.'), modelField, baseField, keyField, remoteNotice, consent, revoke, test, testResult);
    return box;
}

function settingsError(error) { const area = node('div'); area.append(pageHeader('Settings', 'Review every validated change before applying it.'), node('p', 'empty', 'Effective settings could not be loaded: ' + error.message)); const retry = node('button', 'primary', 'Retry'); retry.onclick = () => { retry.disabled = true; loadSettings().then(() => render(true)).catch(nextError => { content.replaceChildren(settingsError(nextError)); }).finally(() => { retry.disabled = false; }); }; area.append(retry); return area; }

async function loadSettings() { settings = await api('/api/settings'); modelDetection = await api('/api/models/detect').catch(() => null); }

async function reviewChanges() { if (!changed.size)
    return; try {
    if (!settings)
        await loadSettings();
    let [key, value] = changed.entries().next().value;
    if (changed.get('model.provider') === 'openai-compatible' && changed.has('model.baseUrl')) {
        key = 'model.baseUrl';
        value = changed.get('model.baseUrl');
    }
    const pairedModelName = key === 'model.provider' && changed.has('model.modelName') ? changed.get('model.modelName') : undefined;
    const paired = pairedModelName === undefined ? {} : { modelName: pairedModelName };
    preview = await api('/api/settings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value, etag: settings.etag, ...paired }) });
    if (preview.conflict) {
        await loadSettings();
        notify('Settings changed elsewhere. Review the current values again.');
        render();
        return;
    }
    document.querySelector('#review-diff').textContent = preview.diff + (preview.remote === true ? '\n\nYour questions, retrieved wiki excerpts and Dream/profile content go to this vendor or host. Typed confirmation enables both network and private-content consent.' : '');
    document.querySelector('#review-risk').textContent = 'Risk: ' + preview.risk;
    const row = document.querySelector('#confirm-row'), word = document.querySelector('#confirm-word'), input = document.querySelector('#confirm-input'), apply = document.querySelector('#apply');
    const needs = !!preview.confirm;
    row.hidden = !needs;
    word.textContent = preview.confirm || '';
    input.value = '';
    apply.disabled = needs;
    input.oninput = () => apply.disabled = needs && input.value !== preview.confirm;
    apply.onclick = async (event) => { event.preventDefault(); try {
        const payload = { key, value, etag: settings.etag, ...paired, ...(preview.confirm ? { confirm: input.value } : {}) };
        const result = await api('/api/settings/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        settings = { ...settings, settings: result.settings, etag: result.etag };
        changed.delete(key);
        if (pairedModelName !== undefined)
            changed.delete('model.modelName');
        document.querySelector('#review').close();
        notify('Setting applied and recorded in audit.');
        await loadSettings();
        render();
    }
    catch (error) {
        document.querySelector('#review').close();
        notify(error.message);
        await loadSettings().catch(() => { });
        render();
    } };
    document.querySelector('#review').showModal();
}
catch (error) {
    notify(error.message);
} }

async function auditPage() { const area = node('div'); area.append(pageHeader('Audit', 'The latest 200 dashboard setting changes. Values are redacted.')); try {
    const entries = await api('/api/audit'), wrap = node('div', 'panel table-wrap'), table = node('table', 'data-table'), head = node('thead'), tr = node('tr');
    for (const label of ['Time', 'Setting', 'Old value', 'New value', 'Result'])
        tr.append(node('th', '', label));
    head.append(tr);
    table.append(head);
    const body = node('tbody');
    for (const item of entries.slice(-200).reverse()) {
        const row = node('tr');
        for (const value of [new Date(item.at).toLocaleString(), item.key, safe(item.oldValue), safe(item.newValue), item.result])
            row.append(node('td', '', value));
        body.append(row);
    }
    if (!entries.length) {
        const row = node('tr'), cell = node('td', 'empty', 'No dashboard changes recorded yet.');
        cell.colSpan = 5;
        row.append(cell);
        body.append(row);
    }
    table.append(body);
    wrap.append(table);
    area.append(wrap);
}
catch (error) {
    area.append(node('p', 'empty', 'Audit unavailable: ' + error.message));
} return area; }

async function knowledgePage() { const area = node('div'), head = pageHeader('Knowledge', 'Search and edit versioned Markdown knowledge.'); const add = node('button', 'primary', 'Create document'); add.type = 'button'; add.onclick = () => editDocument(); head.append(add); area.append(head); const filters = node('div', 'panel knowledge-filters'), q = document.createElement('input'), kind = document.createElement('input'), tag = document.createElement('input'), scope = document.createElement('input'), deleted = document.createElement('input'), search = node('button', 'secondary', 'Search'); const field = (label, input, placeholder) => { const wrap = node('label', 'filter-field'); wrap.append(node('span', '', label)); input.placeholder = placeholder; if (input.type === 'checkbox') {
    const toggle = switchLabel(input, label, '');
    if (locked)
        toggle.title = locked;
    wrap.append(toggle);
}
else
    wrap.append(input); return wrap; }; q.type = 'search'; deleted.type = 'checkbox'; search.type = 'button'; const deletedLabel = switchLabel(deleted, 'Include deleted', 'Show tombstoned documents in search results.', 'toolbar-check'); filters.append(field('Search text', q, 'Title or content'), field('Kind', kind, 'Any kind'), field('Tag', tag, 'Any tag'), field('Scope', scope, 'Wiki or workspace'), deletedLabel, search); const results = node('div'); area.append(filters, results); let cursor = ''; async function load(next = false) { try {
    if (!next)
        cursor = '';
    const params = new URLSearchParams({ limit: '100' });
    if (cursor)
        params.set('cursor', cursor);
    if (q.value)
        params.set('q', q.value);
    if (kind.value)
        params.set('kind', kind.value);
    if (tag.value)
        params.set('tag', tag.value);
    if (scope.value)
        params.set('scope', scope.value);
    if (deleted.checked)
        params.set('includeDeleted', 'true');
    const data = await api('/api/documents?' + params);
    cursor = data.cursor || '';
    const wrap = node('div', 'panel table-wrap'), table = document.createElement('table'), tbody = document.createElement('tbody');
    table.className = 'data-table';
    for (const label of ['Title', 'Kind', 'Scope', 'Status', 'Updated']) {
        const th = node('th', '', label);
        (table.querySelector('thead') || table.createTHead()).append(th);
    }
    for (const d of data.items) {
        const tr = document.createElement('tr'), title = node('button', 'quiet-button', d.title);
        title.type = 'button';
        title.onclick = () => showDocument(d.id);
        for (const value of [title, d.kind, d.scope.type === 'global' ? d.scope.area : 'workspace:' + d.scope.workspaceId, d.status, new Date(d.updatedAt).toLocaleString()]) {
            const td = document.createElement('td');
            td.append(value instanceof Node ? value : node('span', '', value));
            tr.append(td);
        }
        tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
    if (next && results.firstChild)
        results.firstChild.append(table);
    else
        results.replaceChildren(wrap);
    if (cursor) {
        const more = node('button', 'secondary', 'Load more');
        more.onclick = () => load(true);
        results.append(more);
    }
}
catch (e) {
    results.replaceChildren(node('p', 'empty', e.message));
} } deleted.addEventListener('change', () => load()); search.onclick = () => load(); void load(); return area; }

async function showDocument(id) { try {
    const { document: d } = await api('/api/documents/' + encodeURIComponent(id)), [hist, graph] = await Promise.all([api('/api/documents/' + encodeURIComponent(id) + '/history'), api('/api/documents/' + encodeURIComponent(id) + '/links').catch(() => ({ links: [], backlinks: [] }))]);
    const area = node('div'), deleteKey = crypto.randomUUID(), head = pageHeader(d.title, d.kind + ' · ' + d.status + ' · revision ' + d.revisionNumber), back = node('button', 'secondary', 'Back to Knowledge'), edit = node('button', 'primary', 'Edit'), del = node('button', 'secondary', 'Delete');
    back.onclick = () => go('knowledge');
    edit.onclick = () => editDocument(d);
    del.onclick = async () => { const count = graph.backlinks?.length || 0; if (!window.confirm('Delete “' + d.title + '” (' + d.kind + ', ' + d.revisionId + ') as a restorable tombstone? ' + count + ' visible backlinks will remain.'))
        return; try {
        await api('/api/documents/' + encodeURIComponent(id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevisionId: d.revisionId, idempotencyKey: deleteKey }) });
        notify('Document tombstoned');
        go('knowledge');
    }
    catch (e) {
        notify(e.message);
    } };
    head.append(back, edit, del);
    area.append(head, node('pre', 'panel', d.body), dataTable('Links and backlinks', ['Type', 'Target'], [...(graph.links || []), ...(graph.backlinks || [])].map(x => [x.type, x.source || x.target])), dataTable('Revision history', ['Revision', 'Updated', 'Status'], hist.map(x => [x.revisionId, x.updatedAt, x.status])));
    for (const rev of hist) {
        const button = node('button', 'secondary', 'Restore ' + String(rev.revisionId).slice(0, 12)), restoreKey = crypto.randomUUID();
        button.onclick = async () => { if (!window.confirm('Restore this version as a new revision?'))
            return; try {
            await api('/api/documents/' + encodeURIComponent(id) + '/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revisionId: rev.revisionId, expectedRevisionId: d.revisionId, idempotencyKey: restoreKey }) });
            notify('Restored as a new revision');
            void showDocument(id);
        }
        catch (e) {
            notify(e.message);
        } };
        area.append(button);
        if (rev.revisionId !== d.revisionId) {
            const diff = node('button', 'secondary', 'Diff ' + String(rev.revisionId).slice(0, 12) + ' → current');
            diff.onclick = async () => { try {
                const result = await api('/api/documents/' + encodeURIComponent(id) + '/diff?from=' + encodeURIComponent(rev.revisionId) + '&to=' + encodeURIComponent(d.revisionId));
                area.append(node('pre', 'panel', result.diff));
            }
            catch (e) {
                notify(e.message);
            } };
            area.append(diff);
        }
    }
    content.replaceChildren(area);
}
catch (e) {
    notify(e.message);
} }

function editDocument(current) {
    const area = node('div', 'editor-page'), idempotencyKey = crypto.randomUUID(), isEdit = !!current;
    area.append(pageHeader(isEdit ? 'Edit document' : 'Create document', current?.kind === 'wiki_page' ? 'Direct owner edit. Add evidence where appropriate.' : 'Markdown is stored as inert text.'));
    const form = node('div', 'editor-fields'), preview = panel('Live preview'), previewText = node('pre', 'muted');
    preview.classList.add('editor-preview');
    preview.append(previewText);
    const fields = {};
    for (const [key, label, multi] of [['title', 'Title', false], ['kind', 'Kind', false], ['scope', 'Scope (wiki/shared/discoveries/profile/workspace:id)', false], ['tags', 'Tags, comma separated', false], ['evidence', 'Evidence JSON array (optional)', true], ['body', 'Markdown body', true]]) {
        const labelEl = node('label', '', label), input = document.createElement(multi ? 'textarea' : 'input');
        input.value = key === 'scope' ? (current?.scope.type === 'global' ? current.scope.area : current ? 'workspace:' + current.scope.workspaceId : 'wiki') : key === 'evidence' ? JSON.stringify(current?.evidence || [], null, 2) : key === 'tags' ? (current?.tags || []).join(', ') : current?.[key] || '';
        input.setAttribute('aria-label', label);
        input.style.width = '100%';
        input.style.margin = '6px 0 14px';
        if (multi)
            input.rows = 12;
        fields[key] = input;
        labelEl.append(input);
        form.append(labelEl);
    }
    fields.expectedRevisionId = document.createElement('input');
    fields.expectedRevisionId.type = 'hidden';
    fields.expectedRevisionId.value = current?.revisionId || '';
    fields.expectedRevisionId.setAttribute('aria-label', 'Expected revision');
    form.append(fields.expectedRevisionId);
    fields.kind.value = current?.kind || 'note';
    fields.body.addEventListener('input', () => previewText.textContent = fields.body.value);
    previewText.textContent = fields.body.value;
    const draft = () => { const scopeText = fields.scope.value, scope = scopeText.startsWith('workspace:') ? { type: 'workspace', workspaceId: scopeText.slice(10) } : { type: 'global', area: scopeText }, body = { title: fields.title.value, kind: fields.kind.value, scope, tags: fields.tags.value.split(',').map(x => x.trim()).filter(Boolean), body: fields.body.value }; if (fields.evidence.value.trim())
        body.evidence = JSON.parse(fields.evidence.value); if (isEdit)
        delete body.scope; return body; };
    const showConflict = latest => {
        const conflict = panel('Edit conflict · current version is newer'), currentVersion = node('div', 'conflict-current');
        const renderCurrent = () => { currentVersion.replaceChildren(node('p', 'muted', 'Current version · ' + latest.document.title + ' · revision ' + latest.document.revisionId), node('pre', 'panel', latest.document.body)); };
        const reapply = node('button', 'primary', 'Reapply my draft on current version'), reload = node('button', 'secondary', 'Reload current'), back = node('button', 'secondary', 'Back');
        renderCurrent();
        reapply.onclick = async () => { fields.expectedRevisionId.value = latest.document.revisionId; await save(true); };
        reload.onclick = () => editDocument(latest.document);
        back.onclick = () => void showDocument(current.id);
        const row = node('div', 'action-row');
        row.append(reapply, reload, back);
        conflict.append(currentVersion, row);
        const existing = area.querySelector('.edit-conflict');
        if (existing)
            existing.remove();
        conflict.classList.add('edit-conflict');
        area.append(conflict);
    };
    const save = async (reapply) => { try {
        const body = draft();
        if (isEdit)
            await api('/api/documents/' + encodeURIComponent(current.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, expectedRevisionId: fields.expectedRevisionId.value, idempotencyKey: reapply ? crypto.randomUUID() : idempotencyKey }) });
        else
            await api('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, idempotencyKey }) });
        notify(reapply ? 'Draft reapplied as a new revision' : 'Saved');
        go('knowledge');
    }
    catch (e) {
        if (e.status === 409 && isEdit) {
            try {
                showConflict(await api('/api/documents/' + encodeURIComponent(current.id)));
            }
            catch (loadError) {
                notify(loadError.message);
            }
        }
        else
            notify(e.message);
    } };
    const saveButton = node('button', 'primary', 'Save');
    saveButton.onclick = () => save(false);
    form.append(saveButton);
    area.append(form, preview);
    content.replaceChildren(area);
}

async function workspacesPage() { const area = node('div'); area.append(pageHeader('Workspaces', 'Owner-managed isolated workspaces.')); const id = document.createElement('input'), description = document.createElement('input'), create = node('button', 'primary', 'Create workspace'), error = node('small', 'field-error'); id.placeholder = 'Research'; description.placeholder = 'A short purpose for this workspace'; id.setAttribute('aria-label', 'Workspace ID'); description.setAttribute('aria-label', 'Description'); const field = (label, input) => { const wrap = node('label', 'workspace-field'); wrap.append(node('span', '', label), input); return wrap; }; const fields = node('div', 'workspace-create-row'); fields.append(field('Workspace ID', id), field('Description', description), create); create.type = 'button'; create.onclick = async () => { error.textContent = ''; id.removeAttribute('aria-invalid'); if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id.value.trim())) {
    error.textContent = 'Use 2–63 lowercase letters, numbers, hyphens or underscores.';
    id.setAttribute('aria-invalid', 'true');
    id.focus();
    return;
} try {
    await api('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id.value.trim(), description: description.value.trim() }) });
    notify('Workspace created');
    void workspacesPage();
}
catch (e) {
    error.textContent = e.message;
    id.setAttribute('aria-invalid', 'true');
} }; const form = panel('Create workspace'); form.append(fields, error); area.append(form); const items = await api('/api/workspaces'); area.append(dataTable('Workspaces', ['ID', 'Description'], items.map(x => [x.id, x.description]))); content.replaceChildren(area); }

async function wikiProposalForm() { const area = node('div'); area.append(pageHeader('Propose wiki change', 'Semantic lifecycle changes require owner review.')); const form = panel('Proposal details'), fieldsEl = node('div', 'proposal-fields'), action = document.createElement('select'); for (const value of ['retire', 'rename', 'merge']) {
    const option = node('option', '', value);
    option.value = value;
    action.append(option);
} const actionField = node('label', 'field', 'Change type'); actionField.append(action); fieldsEl.append(actionField); const fields = {}; for (const [key, label] of [['targetPageId', 'Target page ID'], ['targetRevisionId', 'Target revision ID'], ['reason', 'Reason'], ['newTitle', 'New title (rename)'], ['title', 'Merged title'], ['body', 'Merged Markdown body'], ['evidence', 'Evidence JSON array (merge)']]) {
    const input = document.createElement(key === 'body' || key === 'evidence' ? 'textarea' : 'input');
    input.setAttribute('aria-label', label);
    if (key === 'body' || key === 'evidence')
        input.rows = 4;
    fields[key] = input;
    const field = node('label', 'field', label);
    field.append(input);
    fieldsEl.append(field);
} const submit = node('button', 'primary', 'Submit proposal'); submit.type = 'button'; submit.onclick = async () => { try {
    const body = { action: action.value, targetPageId: fields.targetPageId.value, targetRevisionId: fields.targetRevisionId.value, reason: fields.reason.value };
    if (action.value === 'rename')
        body.newTitle = fields.newTitle.value;
    if (action.value === 'merge') {
        body.title = fields.title.value;
        body.body = fields.body.value;
        body.evidence = JSON.parse(fields.evidence.value);
    }
    await api('/api/wiki/proposals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    notify('Proposal submitted');
    void wikiReviewPage();
}
catch (e) {
    notify(e.message);
} }; form.append(fieldsEl, submit); area.append(form); content.replaceChildren(area); }

async function wikiReviewPage() { const area = node('div'), head = pageHeader('Wiki review', 'Review semantic retire, rename, restore and merge proposals.'), propose = node('button', 'primary', 'Propose retire, rename or merge'); propose.onclick = () => wikiProposalForm(); head.append(propose); area.append(head); try {
    const items = await api('/api/proposals');
    for (const p of items) {
        const card = panel(p.input.metadata?.action || 'Wiki proposal'), targetId = p.input.metadata?.targetPageId;
        card.append(node('p', '', p.input.title), node('p', 'muted', p.input.metadata?.reason || ''));
        if (targetId) {
            try {
                const target = (await api('/api/documents/' + encodeURIComponent(targetId))).document;
                card.append(node('p', 'muted', 'Current title: ' + target.title + ' · revision ' + target.revisionId), node('pre', 'panel', target.body), node('p', 'muted', 'Proposed title: ' + p.input.title), node('pre', 'panel', p.input.body || '(lifecycle action; page content is not replaced)'));
            }
            catch (e) {
                card.append(node('p', 'empty', 'Target details are no longer available.'));
            }
        }
        else {
            card.append(node('pre', '', p.input.body));
            for (const evidence of p.input.evidence || []) {
                const reference = node('p', 'muted', 'Evidence revision ' + evidence.revisionId + ' · ' + evidence.uri), openEvidence = node('button', 'secondary', 'Open evidence');
                openEvidence.onclick = async () => { try {
                    const id = evidence.uri.split('/').at(-1);
                    go('knowledge');
                    void showDocument(id);
                }
                catch (e) {
                    notify(e.message);
                } };
                card.append(reference, openEvidence);
            }
        }
        const actions = node('div', 'action-row');
        for (const [label, approve] of [['Approve', true], ['Reject', false]]) {
            const b = node('button', approve ? 'primary' : 'secondary', label);
            b.onclick = async () => { let confirm; if (approve && ['merge', 'retire'].includes(p.input.metadata?.action)) {
                confirm = prompt('Type ' + p.input.metadata.action.toUpperCase() + ' to confirm');
                if (confirm !== p.input.metadata.action.toUpperCase())
                    return;
            } try {
                await api('/api/proposals/' + encodeURIComponent(p.id) + '/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approve, reason: 'Owner dashboard review', confirm }) });
                notify('Proposal reviewed');
                void wikiReviewPage();
            }
            catch (e) {
                notify(e.message);
            } };
            actions.append(b);
        }
        card.append(actions);
        area.append(card);
    }
}
catch (e) {
    area.append(node('p', 'empty', e.message));
} content.replaceChildren(area); }

let chatTurns = [], chatPending = null, chatPendingTimer = 0;

async function readUrlDraft(url, agent, composer) { if (!confirm('The URL and page content will be sent to ' + agent + ' for browsing. Continue?'))
    return; let created; try {
    created = await api('/api/url-notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, agent }) });
}
catch (e) {
    notify(e.message);
    return;
} const card = panel('Reading URL'), cancel = node('button', 'secondary', 'Cancel reading'); card.append(node('p', 'muted', 'The selected CLI is reading ' + url), cancel); composer.append(card); cancel.onclick = async () => { await api('/api/url-notes/' + encodeURIComponent(created.job.id), { method: 'DELETE' }).catch(() => { }); card.remove(); }; for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    let state;
    try {
        state = (await api('/api/url-notes/' + encodeURIComponent(created.job.id))).job;
    }
    catch (e) {
        card.append(node('p', 'empty', e.message));
        return;
    }
    if (state.state === 'running')
        continue;
    if (state.state !== 'complete') {
        card.append(node('p', 'empty', state.error || 'URL reading failed'));
        return;
    }
    card.replaceChildren(node('h3', '', 'Review draft'));
    const title = document.createElement('input');
    title.value = state.draft.title;
    title.setAttribute('aria-label', 'Draft title');
    const summary = document.createElement('textarea');
    summary.value = state.draft.summary;
    summary.rows = 8;
    summary.setAttribute('aria-label', 'Draft summary');
    const points = document.createElement('textarea');
    points.value = formatKeyPointLines(state.draft.keyPoints);
    points.rows = 5;
    points.setAttribute('aria-label', 'Draft key points, one per line');
    const quotes = document.createElement('textarea');
    quotes.value = formatKeyPointLines(state.draft.quotes);
    quotes.rows = 3;
    quotes.setAttribute('aria-label', 'Draft quotes, one per line');
    const wiki = document.createElement('input');
    wiki.type = 'checkbox';
    const wikiLabel = switchLabel(wiki, 'Submit as wiki proposal for review', 'Creates a proposal for owner review.');
    const approve = node('button', 'primary', 'Approve and save');
    approve.onclick = async () => { approve.disabled = true; try {
        const result = await api('/api/url-notes/' + encodeURIComponent(created.job.id) + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: title.value, summary: summary.value, keyPoints: parseKeyPointLines(points.value), quotes: parseKeyPointLines(quotes.value), targetWiki: wiki.checked }) });
        card.replaceChildren(node('p', '', result.document ? 'Note approved: ' + result.document.title : 'Wiki proposal submitted for owner review'));
    }
    catch (e) {
        notify(e.message);
        approve.disabled = false;
    } };
    card.append(node('label', '', 'Title'), title, node('label', '', 'Summary / Markdown'), summary, node('label', '', 'Key points (one per line)'), points, node('label', '', 'Quotes (one per line)'), quotes, wikiLabel, approve);
    return;
} card.append(node('p', 'empty', 'URL reading timed out')); }

async function chatPage() { const area = node('div', 'chat-page'), head = pageHeader('Wiki chat', 'Ask authorized knowledge. Replies and citations remain in this browser session only.'), clear = node('button', 'secondary', 'Clear chat'); clear.onclick = () => { chatTurns = []; void chatPage(); }; head.append(clear); area.append(head); const conversation = panel('Conversation'); conversation.classList.add('chat-conversation'); const feed = node('div', 'chat-feed'); for (const turn of deriveChatMessages(chatTurns)) {
    const item = node('article', 'chat-turn ' + turn.role);
    item.append(node('strong', '', '' + turn.label), node('p', 'chat-text', turn.text));
    const meta = node('div', 'chat-meta'), stamp = node('time', '', new Date(turn.timestamp || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    stamp.dateTime = new Date(turn.timestamp || Date.now()).toISOString();
    meta.append(stamp);
    const copy = node('button', 'ghost chat-copy', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => { await navigator.clipboard.writeText(turn.text); copy.textContent = 'Copied'; };
    meta.append(copy);
    item.append(meta);
    if (turn.mode === 'model')
        item.append(node('small', 'chat-answer-mode', 'Answered by ' + (turn.provider || 'configured provider') + (turn.model ? ' · ' + turn.model : '') + ' · ' + (turn.locality === 'local' ? 'local' : 'vendor-hosted')));
    if (turn.degradedReason) {
        const notice = node('small', 'chat-answer-mode chat-degraded', 'The model was not used: ' + turn.degradedReason.message + ' ');
        const settingsLink = node('button', 'ghost', 'Open Settings');
        settingsLink.type = 'button';
        settingsLink.onclick = () => go('settings');
        notice.append(settingsLink);
        item.append(notice);
    }
    ;
    for (const example of turn.examples || []) {
        const chip = node('button', 'ghost chat-example', example);
        chip.onclick = () => { question.value = example; question.focus(); };
        item.append(chip);
    }
    for (const suggestion of turn.suggestions || []) {
        const chip = node('button', 'ghost chat-example', suggestion.title);
        chip.onclick = () => { go('knowledge'); void showDocument(suggestion.id); };
        item.append(chip);
    }
    for (const action of (turn.kind === 'empty_vault' ? [{ label: 'Create document', target: 'knowledge-create' }, { label: 'Add a source', target: 'composer' }] : [])) {
        const button = node('button', 'secondary', action.label);
        button.onclick = () => { if (action.target === 'knowledge-create') {
            go('knowledge');
            setTimeout(() => document.querySelector('.page-head .primary')?.click(), 0);
        }
        else {
            attach.focus();
        } };
        item.append(button);
    }
    for (const citation of turn.citations) {
        const chip = node('button', 'secondary citation-chip', citation.uri.split('/').at(-1) + ' · ' + citation.revisionId.slice(0, 10));
        chip.onclick = () => { const id = citation.uri.split('/').at(-1); if (id) {
            go('knowledge');
            void showDocument(id);
        } };
        item.append(chip);
    }
    if (!turn.citations.length && turn.contextSources?.length) {
        item.append(node('small', 'chat-context-heading', 'Retrieved context (not individually cited)'));
        for (const source of turn.contextSources)
            item.append(node('small', 'chat-context-source', source.title + ' · ' + source.revisionId.slice(0, 10)));
    }
    if (turn.sourceId) {
        const propose = node('button', 'secondary', 'Propose wiki update from this source');
        propose.onclick = async () => { try {
            const result = await api('/api/sources/' + encodeURIComponent(turn.sourceId) + '/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            notify('Proposal ' + result.proposal.id + ' created for owner review');
            go('wiki-review');
        }
        catch (e) {
            notify(e.message);
        } };
        item.append(propose);
    }
    feed.append(item);
} if (chatPending) {
    const wait = node('article', 'chat-turn assistant chat-pending');
    wait.setAttribute('role', 'status');
    wait.setAttribute('aria-live', 'polite');
    const dots = node('span', 'chat-dots', '');
    dots.setAttribute('aria-hidden', 'true');
    for (let n = 0; n < 3; n++)
        dots.append(node('i', '', ''));
    const label = node('span', 'chat-pending-label', chatPending.label + ' · ' + formatDuration(Date.now() - chatPending.startedAt));
    label.id = 'chat-pending-label';
    const stop = node('button', 'ghost chat-stop', 'Stop');
    stop.type = 'button';
    stop.onclick = () => chatPending?.controller.abort();
    wait.append(node('strong', '', 'Engram'), dots, label, stop);
    feed.append(wait);
} if (!chatTurns.length && !chatPending) {
    const empty = node('div', 'chat-empty'), mark = node('span', 'chat-empty-mark', '');
    mark.setAttribute('aria-hidden', 'true');
    mark.append(svgIcon('M4 5h16v12H8l-4 4V5Zm4 5h8m-8 4h5'));
    const examples = node('div', 'chat-examples');
    for (const promptText of ['What do my notes say about…?', 'Summarize a recent wiki page']) {
        const prompt = node('button', 'ghost chat-example', promptText);
        prompt.type = 'button';
        prompt.onclick = () => { question.value = promptText; question.focus(); };
        examples.append(prompt);
    }
    empty.append(mark, node('p', '', 'Ask a question to search authorized knowledge.'), examples);
    feed.append(empty);
} conversation.append(feed); area.append(conversation); const composer = node('section', 'chat-composer'); const question = document.createElement('textarea'); question.rows = 2; question.maxLength = 8000; question.placeholder = 'Ask about your authorized knowledge…'; question.setAttribute('aria-label', 'Message'); const urlOffers = node('div', 'action-row chat-url-actions'); urlOffers.hidden = true; let offeredUrl = ''; question.addEventListener('input', () => { const lineHeight = parseFloat(getComputedStyle(question).lineHeight) || 24; question.rows = Math.min(6, Math.max(2, Math.ceil(question.scrollHeight / lineHeight))); offeredUrl = extractHttpUrl(question.value); urlOffers.replaceChildren(); urlOffers.hidden = !offeredUrl; if (offeredUrl)
    for (const agent of ['claude', 'codex']) {
        const button = node('button', 'secondary', 'Read this URL with ' + agent);
        button.onclick = () => void readUrlDraft(offeredUrl, agent, composer);
        urlOffers.append(button);
    } }); const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,.txt,.json,.pdf'; input.hidden = true; input.setAttribute('aria-label', 'Attach source file'); const attach = node('button', 'icon-button chat-attach', ''); attach.type = 'button'; attach.setAttribute('aria-label', 'Attach a source file'); attach.title = 'Attach a source file'; attach.append(svgIcon('M21.4 11.1 12.2 20.3a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5')); attach.onclick = () => input.click(); let fileChip = null; const remove = node('button', 'icon-button file-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', 'Remove attached file'); remove.onclick = () => { input.value = ''; fileChip?.remove(); fileChip = null; }; input.addEventListener('change', () => { const file = input.files?.[0]; fileChip?.remove(); fileChip = null; if (file) {
    fileChip = node('span', 'file-chip');
    fileChip.append(node('span', '', file.name + ' · ' + (file.size < 1024 ? file.size + ' B' : (file.size / 1024).toFixed(1) + ' KB')), remove);
    composer.insertBefore(fileChip, toolbar);
} }); const drop = node('div', 'chat-drop-hint', 'Drop a file here or attach one · .md, .txt, .json, .pdf'); composer.addEventListener('dragover', event => { event.preventDefault(); composer.classList.add('is-dragging'); }); composer.addEventListener('dragleave', () => composer.classList.remove('is-dragging')); composer.addEventListener('drop', event => { event.preventDefault(); composer.classList.remove('is-dragging'); if (event.dataTransfer?.files?.length) {
    input.files = event.dataTransfer.files;
    input.dispatchEvent(new Event('change'));
} }); const reason = node('span', 'muted chat-model-note', 'Checking model…'); let capability = null; const openModelSettings = () => go('settings'); const renderCapability = async () => { try {
    capability = await api('/api/chat/capabilities');
    const local = capability.locality === 'local';
    reason.replaceChildren(node('span', 'reason-text', capability.ready ? (local ? 'Local model: your question, recent chat, and retrieved excerpts stay on this machine.' : 'Vendor-hosted CLI/API: your question, recent chat, and retrieved excerpts are sent to that vendor.') : (capability.remote && !capability.consentGiven ? 'Remote model use requires consent in Settings > Model provider.' : 'No chat model is ready. Open Settings to choose or fix one.')));
    if (!capability.ready) {
        const link = node('button', 'ghost', 'Open Settings');
        link.type = 'button';
        link.onclick = openModelSettings;
        reason.append(link);
    }
}
catch {
    capability = { ready: false };
    reason.replaceChildren(node('span', 'reason-text', 'Model capability could not be checked.'));
    const link = node('button', 'ghost', 'Open Settings');
    link.type = 'button';
    link.onclick = openModelSettings;
    reason.append(link);
} }; void renderCapability(); const send = node('button', 'primary icon-button chat-send', ''); send.type = 'button'; send.disabled = !!chatPending; send.classList.toggle('is-busy', !!chatPending); send.setAttribute('aria-label', 'Send message'); send.title = 'Send message'; send.append(svgIcon('m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13')); const sourceMenu = node('div', 'source-menu-wrap'), sourceToggle = node('button', 'ghost source-menu', 'Add as source'), sourceOptions = node('div', 'source-options'); sourceToggle.type = 'button'; sourceToggle.setAttribute('aria-haspopup', 'menu'); sourceToggle.setAttribute('aria-expanded', 'false'); sourceOptions.setAttribute('role', 'menu'); sourceMenu.append(sourceToggle, sourceOptions); const doUpload = async () => { if (!input.files?.[0]) {
    notify('Attach a file first');
    return;
} const form = new FormData(); form.append('file', input.files[0]); try {
    const result = await api('/api/sources', { method: 'POST', body: form });
    chatTurns.push({ role: 'system', text: 'Imported source ' + result.source.title + ' · ' + result.source.uri + ' · revision ' + result.source.revisionId, sourceId: result.source.id, timestamp: new Date().toISOString() });
    void chatPage();
}
catch (e) {
    notify(e.message);
}
finally { } }; const doPaste = async () => { if (!question.value.trim()) {
    notify('Paste source text in the message field first');
    return;
} try {
    const result = await api('/api/sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: question.value, name: 'pasted-source.md' }) });
    chatTurns.push({ role: 'system', text: 'Imported pasted source · ' + result.source.uri + ' · revision ' + result.source.revisionId, sourceId: result.source.id, timestamp: new Date().toISOString() });
    question.value = '';
    void chatPage();
}
catch (e) {
    notify(e.message);
}
finally { } }; sourceToggle.onclick = () => { const open = sourceMenu.classList.toggle('is-open'); sourceToggle.setAttribute('aria-expanded', String(open)); }; sourceMenu.addEventListener('keydown', event => { if (event.key === 'Escape') {
    sourceMenu.classList.remove('is-open');
    sourceToggle.setAttribute('aria-expanded', 'false');
    sourceToggle.focus();
} }); for (const [label, action] of [['Import attached file', doUpload], ['Paste as source', doPaste]]) {
    const option = node('button', 'ghost', label);
    option.type = 'button';
    option.setAttribute('role', 'menuitem');
    option.onclick = () => { sourceMenu.classList.remove('is-open'); sourceToggle.setAttribute('aria-expanded', 'false'); void action(); };
    sourceOptions.append(option);
} const sendMessage = async () => { if (!question.value.trim() || chatPending)
    return; const text = question.value.trim(), history = chatTurns.slice(-6).filter(t => t.role === 'user' || (t.role === 'assistant' && t.mode === 'model')).map(t => ({ role: t.role, content: String(t.text).slice(0, 2000) })); chatTurns.push({ role: 'user', text, timestamp: new Date().toISOString() }); question.value = ''; const controller = new AbortController(); chatPending = { controller, startedAt: Date.now(), label: 'Asking the configured model' }; void chatPage(); clearInterval(chatPendingTimer); chatPendingTimer = setInterval(() => { const l = document.getElementById('chat-pending-label'); if (l && chatPending)
    l.textContent = chatPending.label + ' · ' + formatDuration(Date.now() - chatPending.startedAt); }, 500); try {
    const result = await api('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ question: text, history }) });
    chatTurns.push({ role: 'assistant', text: result.answer, citations: result.citations || [], contextSources: result.contextSources || [], timestamp: new Date().toISOString(), mode: result.mode, provider: result.provider, model: result.model, locality: result.locality, degradedReason: result.degradedReason });
    if (result.kind)
        chatTurns[chatTurns.length - 1].kind = result.kind;
    if (result.examples)
        chatTurns[chatTurns.length - 1].examples = result.examples;
    if (result.suggestions)
        chatTurns[chatTurns.length - 1].suggestions = result.suggestions;
    if (result.modelHint)
        chatTurns[chatTurns.length - 1].modelHint = result.modelHint;
}
catch (e) {
    chatTurns.push({ role: 'system', text: e.name === 'AbortError' ? 'Stopped. No answer was added.' : e.message, timestamp: new Date().toISOString() });
}
finally {
    clearInterval(chatPendingTimer);
    chatPending = null;
    void chatPage();
} }; send.onclick = () => void sendMessage(); question.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
} }); const toolbar = node('div', 'chat-toolbar'); toolbar.append(question, attach, sourceMenu, send); composer.append(urlOffers, drop, reason, toolbar, input); area.append(composer); content.replaceChildren(area); requestAnimationFrame(() => { const newest = feed.lastElementChild; if (!newest)
    return; const feedTop = feed.getBoundingClientRect().top + feed.clientTop + parseFloat(getComputedStyle(feed).paddingTop || '0'); const messageTop = newest.getBoundingClientRect().top - feedTop; feed.scrollTop = newestChatScrollTop(feed.clientHeight, feed.scrollHeight, newest.getBoundingClientRect().height, messageTop); }); return area; }
`;
