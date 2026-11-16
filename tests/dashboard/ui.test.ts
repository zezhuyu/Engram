import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDashboardServer } from '../../packages/dashboard/server.js';
import { disposableVault } from './helpers.js';
import { assets, deriveAttention, deriveCards, extractHttpUrl, formatKeyPointLines, parseKeyPointLines } from '../../packages/dashboard/ui/view-model.js';

test('dashboard view models summarize health and name actionable attention items', () => {
  const data = {
    doctor: { state: 'attention', checks: ['vault', 'journal'] },
    index: { available: false, problem: true, manifest: { entries: 12 }, journalSequence: 9 },
    jobs: { pending: 3, running: 1, failed: 1, dead_letter: 0 },
    scheduler: { enabled: true, paused: false, mode: 'adaptive' },
    provider: { configured: true, ready: false, allowNetwork: false },
    storage: { pressureState: 'WARNING' },
  };
  const cards = deriveCards(data);
  assert.equal(cards.length, 8);
  assert.equal(cards.find(card => card.key === 'jobs')?.state, 'problem');
  assert.equal(cards.find(card => card.key === 'provider')?.state, 'attention');
  assert.deepEqual(deriveAttention(data).map(item => item.next), [
    'Run mdb doctor for details.',
    'Run mdb index verify; rebuild with mdb index rebuild if needed.',
    'Run mdb jobs status to inspect job state.',
  ]);
});

test('dashboard embeds a CSP-compatible UI without inline code or unsafe DOM sinks', () => {
  assert.match(assets['/']!.body, /<main/);
  assert.match(assets['/']!.body, /<script type="module" src="\/assets\/app\.js"><\/script>/);
  assert.doesNotMatch(assets['/']!.body, /<script(?! type="module" src=)|<style\b|\son[a-z]+=/i);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /\beval\s*\(|\.innerHTML\b|\.outerHTML\b/);
  assert.match(assets['/assets/app.js']!.body, /Retrieved context \(not individually cited\)/);
  assert.match(assets['/assets/app.js']!.body, /chat-context-source/);
  assert.match(assets['/assets/app.css']!.body, /\.chat-context-heading/);
  assert.match(assets['/assets/app.js']!.body, /location\.hash/);
  assert.match(assets['/assets/app.js']!.body, /Profile domains/);
  assert.match(assets['/assets/app.js']!.body, /expectedRevisionId:item\.revisionId/);
  assert.match(assets['/assets/app.js']!.body, /history\.replaceState/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /engram-chat-use-model|useModel/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /localStorage/);
  assert.match(assets['/assets/app.js']!.body, /Welcome back/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /Sign-in link needed/);
  assert.match(assets['/assets/app.js']!.body, /Sign-in temporarily locked/);
  assert.match(assets['/assets/app.js']!.body, /token changes on every restart/i);
  assert.match(assets['/assets/app.js']!.body, /Open the Engram Client menu and choose Open dashboard, or Copy first-time sign-in link/);
  assert.match(assets['/assets/app.js']!.body, /Your session ended. Enter your dashboard password to continue/);
  assert.match(assets['/assets/app.js']!.body, /password-strength/);
  assert.match(assets['/assets/app.js']!.body, /password-reveal/);
  assert.match(assets['/assets/app.js']!.body, /file-chip/);
  assert.match(assets['/assets/app.js']!.body, /Add as source/);
  assert.match(assets['/assets/app.js']!.body, /knowledge-filters/);
  assert.match(assets['/assets/app.js']!.body, /workspace-create-row/);
  assert.match(assets['/assets/app.js']!.body, /Scheduler cycles/);
  assert.match(assets['/assets/app.js']!.body, /Set/);
  assert.match(assets['/assets/app.js']!.body, /X-Engram-Dashboard/);
  assert.match(assets['/assets/app.js']!.body, /autocomplete='current-password'/);
  assert.match(assets['/assets/app.js']!.body, /autocomplete='new-password'/);
  assert.match(assets['/assets/app.js']!.body, /OpenAI \/ ChatGPT/);
  assert.match(assets['/assets/app.js']!.body, /Workspace access/);
  assert.match(assets['/assets/app.js']!.body, /api\/connectors\/openai\/status/);
  assert.match(assets['/assets/app.js']!.body, /api\/connectors\/openai\/workspaces/);
  assert.match(assets['/assets/app.js']!.body, /data-key','client-/);
  assert.match(assets['/assets/app.js']!.body, /Every holder of this token loses access immediately/);
  assert.match(assets['/assets/app.js']!.body, /Queued writes remain on client machines/);
  assert.match(assets['/assets/app.js']!.body, /'Connected'/);
  assert.match(assets['/assets/app.js']!.body, /Running, not ready/);
  assert.match(assets['/assets/app.js']!.body, /Status unavailable, retrying/);
  assert.match(assets['/assets/app.js']!.body, /status\.gateway\?\.state==='unknown'/);
  const pillLabel = new vm.Script(`${assets['/assets/app.js']!.body.match(/function tunnelStatusLabel\([^}]+}/)?.[0]}; tunnelStatusLabel`).runInNewContext() as (state: string, reason?: string) => string;
  assert.equal(pillLabel('unknown'), 'Status unavailable, retrying');
  const actionDisabled = new vm.Script(`${assets['/assets/app.js']!.body.match(/function tunnelActionDisabled\([^}]+}/)?.[0]}; tunnelActionDisabled`).runInNewContext() as (action: string, state: string, statusUnknown: boolean) => boolean;
  assert.equal(actionDisabled('start', 'connected', true), false);
  assert.equal(actionDisabled('stop', 'stopped', true), false);
  assert.equal(actionDisabled('start', 'connected', false), true);
  assert.equal(actionDisabled('stop', 'stopped', false), true);
  assert.match(assets['/assets/app.js']!.body, /connector-tunnel-details/);
  assert.match(assets['/assets/app.js']!.body, /Tunnel connected/);
  assert.match(assets['/assets/app.js']!.body, /Starting…/);
  assert.match(assets['/assets/app.js']!.body, /api\/connectors\/openai\/writes/);
  assert.match(assets['/assets/app.js']!.body, /name-only access means anyone who can reach the tunnel/);
  assert.match(assets['/assets/app.js']!.body, /Recent ChatGPT writes/);
  assert.match(assets['/assets/app.js']!.body, /personal\/chat/);
  assert.match(assets['/assets/app.js']!.body, /Personal is shared memory for all chat AIs/);
  assert.match(assets['/assets/app.js']!.body, /personal\/preferences/);
  assert.match(assets['/assets/app.js']!.body, /New chats start in personal\/chat/);
  assert.match(assets['/assets/app.js']!.body, /conversationId only when the user explicitly asks to continue/);
  assert.match(assets['/assets/app.js']!.body, /profile, user-insight and wiki/);
  assert.match(assets['/assets/app.js']!.body, /Global accepted wiki/);
  assert.match(assets['/assets/app.js']!.body, /no deletion tool/);
  assert.match(assets['/assets/app.js']!.body, /apiKeySet/);
  assert.match(assets['/assets/app.js']!.body, /connector-start-reason/);
  assert.match(assets['/assets/app.js']!.body, /for\(const action of \['start','stop','restart'\]\)/);
  assert.match(assets['/assets/app.js']!.body, /Remove saved API key/);
  assert.match(assets['/assets/app.js']!.body, /cfg\.tunnelId\|\|''/);
  assert.match(assets['/assets/app.js']!.body, /cfg\.organizationId\|\|''/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /authentication:'OAuth'|memory\.example\.com\/mcp/);
  assert.match(assets['/assets/app.js']!.body, /Claude Code \/ Claude Desktop/);
  assert.match(assets['/assets/app.js']!.body, /Add to Claude Code/);
  assert.match(assets['/assets/app.js']!.body, /claude.ai custom connector/);
  assert.match(assets['/assets/app.js']!.body, /public HTTPS MCP URL that you operate/);
  assert.match(assets['/assets/app.js']!.body, /Check configured URL reachability/);
  assert.match(assets['/assets/app.js']!.body, /Anthropic MCP Tunnels/);
  assert.match(assets['/assets/app.js']!.body, /NOT available as a claude.ai custom connector/);
  assert.match(assets['/assets/app.js']!.body, /not verified live/i);
  assert.match(assets['/assets/app.js']!.body, /PULL AND START/);
  assert.match(assets['/assets/app.js']!.body, /GATEWAY_BIND/);
  assert.match(assets['/assets/app.js']!.body, /Copy reachability test command/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /claude.ai requires OAuth|Save Claude connector|Test Claude endpoint/);
  assert.match(assets['/assets/app.js']!.body, /Remote dashboard credentials/);
  const appScript = assets['/assets/app.js']!.body;
  assert.match(appScript, /modelSettingsPanel/);
  assert.match(appScript, /Model name/);
  assert.match(appScript, /model-name-select/);
  assert.match(appScript, /Provider default \(recommended\)/);
  assert.match(appScript, /Custom…/);
  assert.match(appScript, /This model name was chosen for a different provider/);
  assert.match(appScript, /api\/models\/list/);
  assert.match(appScript, /Refresh list/);
  assert.match(appScript, /embedding-model-select/);
  assert.match(appScript, /api\/embedding\/models/);
  assert.match(appScript, /name\.id='model-name'/);
  assert.match(appScript, /base\.id='model-base-url'/);
  assert.match(appScript, /Optional\. Overrides the CLI/);
  assert.match(appScript, /Key saved/);
  assert.match(appScript, /No key/);
  assert.match(appScript, /Test model/);
  assert.match(appScript, /Your questions, retrieved wiki excerpts and Dream\/profile content go to this vendor or host/);
  assert.match(appScript, /model-secret/);
  assert.doesNotMatch(appScript, /keyInput\.value\s*=\s*(?:settings|value)/);
  const source = readFileSync(new URL('../../../packages/dashboard/ui/view-model.ts', import.meta.url), 'utf8');
  const templateStart = source.indexOf('export const js = String.raw`${browserModels}');
  const templateBodyStart = templateStart + 'export const js = String.raw`${browserModels}'.length;
  const templateEnd = source.indexOf('`;', templateBodyStart);
  assert.ok(templateStart >= 0 && templateEnd > templateBodyStart, 'dashboard served script remains one String.raw template');
  assert.doesNotMatch(source.slice(templateBodyStart, templateEnd), /`|\$\{/);
  assert.match(assets['/assets/app.js']!.body, /No credentials yet/);
  assert.match(assets['/assets/app.js']!.body, /Access level/);
  assert.ok(assets['/assets/app.js']!.body.includes('Remote administration: '));
  assert.ok(assets['/assets/app.js']!.body.includes('aria-haspopup'));
  assert.doesNotMatch(assets['/assets/app.js']!.body, /const composer=panel\('Message'\)/);
  assert.ok(assets['/assets/app.css']!.body.includes('.file-chip[hidden]{display:none!important}'));
  assert.ok(assets['/assets/app.css']!.body.includes('.chat-composer.is-dragging .chat-drop-hint{display:block}'));
  assert.ok(assets['/assets/app.css']!.body.includes('input[type=date],select{appearance:none'));
  assert.ok(assets['/assets/app.css']!.body.includes('.credentials-form,.proposal-fields{display:grid;grid-template-columns:repeat(2'));
  assert.ok(assets['/assets/app.css']!.body.includes('.switch input:checked+.track'));
  assert.ok(assets['/assets/app.css']!.body.includes('.switch:hover .track'));
  assert.ok(assets['/assets/app.css']!.body.includes('prefers-reduced-motion:reduce){.switch'));
  assert.match(assets['/assets/app.js']!.body, /Client settings/);
  assert.match(assets['/assets/app.js']!.body, /X-Engram-Reauth-Password/);
  assert.match(assets['/']!.body!, /ONE-TIME CREDENTIAL/);
  assert.match(assets['/']!.body!, /\/assets\/logo-64\.png/);
  assert.match(assets['/']!.body!, /theme-color/);
  assert.match(assets['/assets/app.js']!.body, /Retry in '\+error.retryAfter\+' seconds/);
  assert.match(assets['/assets/app.js']!.body, /\['Security','Password access/);
  assert.match(assets['/assets/app.js']!.body, /document\.hidden/);
  assert.match(assets['/assets/app.js']!.body, /\['Server','Effective listener address/);
  assert.match(assets['/assets/app.js']!.body, /Restart with --host and --port flags/);
  assert.match(assets['/assets/app.css']!.body, /prefers-color-scheme/);
  assert.match(assets['/assets/app.css']!.body, /prefers-reduced-motion/);
  assert.match(assets['/assets/app.css']!.body, /overflow-x:auto;overscroll-behavior-x:contain/);
  assert.match(assets['/assets/app.css']!.body, /\.nav-link\{flex:0 0 92px;min-width:92px;white-space:nowrap/);
  assert.match(assets['/assets/app.css']!.body, /\.data-table td\{overflow-wrap:anywhere\}/);
  assert.match(assets['/assets/app.css']!.body, /textarea\{font:inherit/);
  assert.match(assets['/assets/app.css']!.body, /#content:focus-visible\{outline:none\}/);
  assert.match(assets['/assets/app.js']!.body, /previousScroll=nav\.querySelector\?\.\('\.nav-list'\)\?\.scrollLeft\?\?0/);
  assert.match(assets['/assets/app.js']!.body, /list\.scrollLeft=previousScroll/);
  assert.match(assets['/assets/app.js']!.body, /url-note-controls/);
  assert.match(assets['/assets/app.js']!.body, /node\('div','editor-page'\)/);
  assert.match(assets['/assets/app.css']!.body, /\.url-note-controls\{display:grid/);
  assert.match(assets['/assets/app.css']!.body, /\.url-note-controls\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(assets['/assets/app.css']!.body, /\.page-head\{display:block\}/);
  assert.match(assets['/assets/app.css']!.body, /#content input:not\(\[type=checkbox\]\):not\(\[type=file\]\)/);
  assert.match(assets['/assets/app.css']!.body, /--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px/);
  assert.match(assets['/assets/app.css']!.body, /--accent-grad:linear-gradient/);
  assert.match(assets['/assets/app.css']!.body, /\.data-table tbody tr:nth-child\(even\)/);
  assert.match(assets['/assets/app.css']!.body, /input\[type=file\]::file-selector-button/);
  assert.match(assets['/assets/app.js']!.body, /function svgIcon\(pathData\)/);
  assert.match(assets['/assets/app.js']!.body, /Live preview/);
  assert.match(assets['/assets/app.js']!.body, /No '\+title\.toLowerCase\(\)\+' yet/);
  assert.match(assets['/assets/app.css']!.body, /\.nav-link\{flex:0 0 calc\(\(100vw - 40px\)\/5\);min-width:0;white-space:normal\}/);
  assert.match(assets['/assets/app.css']!.body, /\.nav-list::after\{content:"";position:sticky/);
});

test('Dream Schedule UI has run states, keyed status patching, relative ticks, history, and read-only polling', () => {
  const app = assets['/assets/app.js']!.body;
  assert.match(app, /api\('\/api\/dream\/run-status'\)/);
  assert.match(app, /No Dream run yet/);
  assert.match(app, /No run predicted/);
  assert.match(app, /Dream scheduling is off \(enable in Settings\)/);
  assert.match(app, /Worker not running/);
  assert.match(app, /data-key','dream-schedule/);
  assert.match(app, /data-connector-live','true/);
  assert.match(app, /data-relative-time/);
  assert.match(app, /setInterval\(tickRelativeTimes,60000\)/);
  assert.match(app, /View cycle history/);
  assert.match(app, /Last five runs/);
  assert.doesNotMatch(app, /api\('\/api\/dream\/run-status',\s*\{\s*method:\s*'POST'/);
});

test('connector polling patches only changed keyed status nodes and preserves typed form values', () => {
  class TrackedNode {
    nodeType: number; tagName: string; private text = ''; value = ''; attributes: Array<{ name: string; value: string }> = []; childNodes: TrackedNode[] = []; parentNode?: TrackedNode; writes = 0;
    constructor(tag: string, text = '') { this.nodeType = tag === '#text' ? 3 : 1; this.tagName = tag; this.data = text; }
    get data() { return this.text; }
    set data(value: string) { if (this.text !== value) { this.text = value; this.writes++; } }
    getAttribute(name: string) { return this.attributes.find(attr => attr.name === name)?.value ?? null; }
    hasAttribute(name: string) { return this.attributes.some(attr => attr.name === name); }
    setAttribute(name: string, value: string) { this.writes++; const attr = this.attributes.find(item => item.name === name); if (attr) attr.value = value; else this.attributes.push({ name, value }); }
    removeAttribute(name: string) { this.writes++; this.attributes = this.attributes.filter(attr => attr.name !== name); }
    append(...nodes: TrackedNode[]) { for (const node of nodes) { node.parentNode = this; this.childNodes.push(node); this.writes++; } }
    replaceWith(node: TrackedNode) { if (!this.parentNode) return; const list = this.parentNode.childNodes, index = list.indexOf(this); list[index] = node; node.parentNode = this.parentNode; this.parentNode.writes++; }
    remove() { if (!this.parentNode) return; this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode.writes++; }
  }
  const app = assets['/assets/app.js']!.body, start = app.indexOf('function hasConnector('), end = app.indexOf('\nfunction patchContent', start);
  assert.ok(start >= 0 && end > start, 'connector patch helpers are available in the served dashboard script');
  const nodeSig = (node: TrackedNode): string => node.nodeType === 3 ? 't:' + node.data : node.tagName + JSON.stringify(node.attributes) + (node.tagName === 'INPUT' ? node.value : '') + '(' + node.childNodes.map(nodeSig).join('|') + ')';
  const controlDirty = (node: TrackedNode): boolean => node.tagName === 'INPUT' && node.value !== node.getAttribute('value');
  const context = { nodeSig, isFormControl: (node: TrackedNode) => node.tagName === 'INPUT', controlDirty, containsDirty: (node: TrackedNode) => node.tagName === 'INPUT' && controlDirty(node) };
  const patchNode = vm.runInNewContext(`${app.slice(start, end)}; patchNode`, context) as (oldNode: TrackedNode, newNode: TrackedNode) => void;
  const el = (tag: string, key?: string, text = '') => { const node = new TrackedNode(tag, text); if (key) node.setAttribute('data-key', key); node.writes = 0; return node; };
  const current = el('SECTION'); current.setAttribute('data-connector-live', 'true'); const input = el('INPUT'); input.setAttribute('value', ''); input.value = 'half typed'; const status = el('SPAN', 'connector-status-gateway'); const statusText = el('#text', undefined, 'Gateway: Stopped'); status.append(statusText); const unrelated = el('DETAILS', 'connector-details'); current.append(input, status, unrelated);
  current.writes = input.writes = status.writes = statusText.writes = unrelated.writes = 0;
  const unchanged = el('SECTION'); unchanged.setAttribute('data-connector-live', 'true'); const nextInput = el('INPUT'); nextInput.setAttribute('value', ''); nextInput.value = ''; const sameStatus = el('SPAN', 'connector-status-gateway'); sameStatus.append(el('#text', undefined, 'Gateway: Stopped')); unchanged.append(nextInput, sameStatus, el('DETAILS', 'connector-details'));
  patchNode(current, unchanged);
  assert.equal(current.writes + input.writes + status.writes + statusText.writes + unrelated.writes, 0, 'unchanged polling performs zero section DOM writes');
  const changed = el('SECTION'); changed.setAttribute('data-connector-live', 'true'); const freshInput = el('INPUT'); freshInput.setAttribute('value', ''); const changedStatus = el('SPAN', 'connector-status-gateway'); changedStatus.append(el('#text', undefined, 'Gateway: Running')); changed.append(freshInput, changedStatus, el('DETAILS', 'connector-details'));
  patchNode(current, changed);
  assert.equal(current.childNodes[0], input, 'form control node stays mounted'); assert.equal(input.value, 'half typed', 'half-typed form value survives refresh');
  assert.equal(current.childNodes[1], status, 'the status badge node is patched in place'); assert.equal(status.childNodes[0]!.data, 'Gateway: Running');
  assert.equal(current.childNodes[2], unrelated, 'open details node remains mounted');
});

class MockElement {
  children: MockElement[] = [];
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  value = '';
  type = '';
  hidden = false;
  rows = 0;
  onclick?: () => unknown;
  classList = { add: (...names: string[]) => { this.className += ` ${names.join(' ')}`; } };
  append(...items: MockElement[]) { this.children.push(...items); }
  replaceChildren(...items: MockElement[]) { this.children = [...items]; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  addEventListener() {}
  remove() {}
  querySelector(selector: string): MockElement | null { return this.walk().find(item => selector === '.edit-conflict' ? item.className.split(' ').includes('edit-conflict') : false) ?? null; }
  walk(): MockElement[] { return [this, ...this.children.flatMap(child => child.walk())]; }
}

function editorHarness(apiHandler: (path: string, init?: any) => Promise<any>) {
  const content = new MockElement(), calls: Array<{ path: string; init?: any }> = [], notices: string[] = [], routes: string[] = [];
  const context = {
    document: { createElement: () => new MockElement() },
    crypto: { randomUUID: (() => { let next = 0; return () => `key-${++next}`; })() },
    node: (tag: string, className: string, text?: string) => { const element = new MockElement(); element.className = className; element.textContent = text ?? ''; return element; },
    panel: (title: string) => { const element = new MockElement(); element.textContent = title; return element; },
    pageHeader: (title: string) => { const element = new MockElement(); element.textContent = title; return element; },
    api: async (path: string, init?: any) => { calls.push({ path, init }); return apiHandler(path, init); },
    notify: (message: string) => notices.push(message), go: (route: string) => routes.push(route), showDocument: () => {}, content,
    encodeURIComponent, JSON,
  };
  const app = assets['/assets/app.js']!.body;
  const start = app.indexOf('function editDocument(current){'), end = app.indexOf('\nasync function workspacesPage()', start);
  assert.ok(start >= 0 && end > start, 'editor function is available in served app');
  const editDocument = vm.runInNewContext(`${app.slice(start, end)}; editDocument`, context) as (current?: any) => void;
  return { editDocument, content, calls, notices, routes };
}
function field(root: MockElement, label: string): MockElement {
  const result = root.walk().find(item => item.attributes['aria-label'] === label);
  assert.ok(result, `field ${label} exists`);
  return result;
}
function button(root: MockElement, text: string): MockElement {
  const result = root.walk().find(item => item.textContent === text && item.onclick);
  assert.ok(result, `button ${text} exists`);
  return result;
}

 test('dashboard editor preserves revision preconditions across create, conflict, reapply, reload, delete, and restore', async () => {
  const current = { id: 'doc-1', revisionId: 'rev-current', revisionNumber: 1, kind: 'note', title: 'Current title', body: 'Current body', tags: [], evidence: [], scope: { type: 'global', area: 'wiki' } };
  let latest = { document: { ...current, revisionId: 'rev-latest', revisionNumber: 2, title: 'Latest title', body: 'Latest body' } };
  const harness = editorHarness(async (path, init) => {
    if (init?.method === 'PATCH' && init.body.includes('rev-current')) throw Object.assign(new Error('conflict'), { status: 409 });
    if (init?.method === 'PATCH') return { document: {} };
    if (path.endsWith('/doc-1')) return latest;
    return { document: {} };
  });
  harness.editDocument(current);
  const revision = field(harness.content, 'Expected revision');
  assert.equal(revision.type, 'hidden'); assert.equal(revision.value, current.revisionId);
  field(harness.content, 'Markdown body').value = 'My draft';
  await button(harness.content, 'Save').onclick?.();
  const conflict = harness.content.querySelector('.edit-conflict');
  assert.ok(conflict); assert.match(conflict.walk().map(item => item.textContent).join(' '), /Latest body/);
  assert.equal(field(harness.content, 'Markdown body').value, 'My draft', 'conflict retains the unsaved draft');
  assert.equal(button(conflict, 'Reload current').textContent, 'Reload current');
  assert.equal(button(conflict, 'Back').textContent, 'Back');
  await button(conflict, 'Reapply my draft on current version').onclick?.();
  const reapply = harness.calls.find(call => call.init?.method === 'PATCH' && call.init.body.includes('rev-latest'));
  assert.ok(reapply, 'reapply sends the latest expected revision');
  assert.equal(JSON.parse(reapply.init!.body).body, 'My draft');
  assert.deepEqual(harness.routes, ['knowledge']); assert.equal(harness.notices.at(-1), 'Draft reapplied as a new revision');

  const reloadHarness = editorHarness(async (path, init) => { if (init?.method === 'PATCH') throw Object.assign(new Error('conflict'), { status: 409 }); return path.endsWith('/doc-1') ? latest : { document: {} }; });
  reloadHarness.editDocument(current); field(reloadHarness.content, 'Markdown body').value = 'discard by reload';
  await button(reloadHarness.content, 'Save').onclick?.();
  await button(reloadHarness.content.querySelector('.edit-conflict')!, 'Reload current').onclick?.();
  assert.equal(field(reloadHarness.content, 'Expected revision').value, 'rev-latest');
  assert.equal(field(reloadHarness.content, 'Markdown body').value, 'Latest body');

  const createHarness = editorHarness(async (_path, init) => ({ document: JSON.parse(init?.body ?? '{}') }));
  createHarness.editDocument(); await button(createHarness.content, 'Save').onclick?.();
  const createCall = createHarness.calls[0]!;
  assert.equal(createCall.init?.method, 'POST'); assert.equal('expectedRevisionId' in JSON.parse(createCall.init!.body), false);

  const app = assets['/assets/app.js']!.body;
  const calls: Array<{ path: string; init?: any }> = [];
  const viewerContext = {
    document: { createElement: () => new MockElement() }, crypto: { randomUUID: () => 'viewer-key' },
    node: (tag: string, className: string, text?: string) => { const element = new MockElement(); element.className = className; element.textContent = text ?? ''; return element; },
    pageHeader: (title: string) => { const element = new MockElement(); element.textContent = title; return element; },
    dataTable: () => new MockElement(), encodeURIComponent, window: { confirm: () => true }, content: new MockElement(),
    notify: () => {}, api: async (path: string, init?: any) => { calls.push({ path, init }); if (init) return {}; if (path.endsWith('/history')) return [{ revisionId: 'rev-old-revision', updatedAt: '', status: 'active' }]; if (path.endsWith('/links')) return { links: [], backlinks: [] }; return { document: current }; },
  };
  const showStart = app.indexOf('async function showDocument(id){'), showEnd = app.indexOf('\nfunction editDocument(current){', showStart);
  assert.ok(showStart >= 0 && showEnd > showStart, 'document view function is available in served app');
  const showDocument = vm.runInNewContext(`${app.slice(showStart, showEnd)}; showDocument`, viewerContext) as (id: string) => Promise<void>;
  await showDocument(current.id);
  await button(viewerContext.content as MockElement, 'Delete').onclick?.();
  const deletion = calls.find(call => call.init?.method === 'DELETE');
  assert.equal(JSON.parse(deletion!.init!.body).expectedRevisionId, current.revisionId);
  await button(viewerContext.content as MockElement, 'Restore rev-old-revi').onclick?.();
  const restoration = calls.find(call => call.init?.method === 'POST' && call.path.endsWith('/restore'));
  assert.equal(JSON.parse(restoration!.init!.body).expectedRevisionId, current.revisionId);
  assert.equal(JSON.parse(restoration!.init!.body).revisionId, 'rev-old-revision');
});

test('dashboard semantic status colors keep readable contrast in light and dark themes', () => {
  const ratio = (foreground: string, background: string) => {
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/.{2}/g)!.map(channel => parseInt(channel, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
    };
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  const pairs: Array<[string, string]> = [['#17633c','#eaf7ef'],['#754500','#fff5e3'],['#8c2525','#ffeded'],['#244e86','#eaf2ff'],['#b6f0c8','#183629'],['#ffdfa0','#3b2d15'],['#ffc4bd','#422323'],['#c6dcff','#1d3049']];
  for (const [foreground, background] of pairs) assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background} must meet WCAG AA text contrast`);
  const css = assets['/assets/app.css']!.body;
  for (const [foreground, background] of pairs) { assert.ok(css.includes(foreground)); assert.ok(css.includes(background)); }
});


test('served dashboard assets parse and browser helpers preserve URL and line behavior', async t => {
  const vault = await disposableVault();
  const dashboard = await createDashboardServer({ engram: vault.engram, idleMs: 60_000 });
  t.after(async () => { await dashboard.close(); await vault.cleanup(); });
  const app = await fetch(`http://127.0.0.1:${dashboard.port}/assets/app.js`);
  assert.equal(app.status, 200);
  const script = await app.text();
  assert.doesNotThrow(() => new vm.Script(script, { filename: '/assets/app.js' }));
  const css = await fetch(`http://127.0.0.1:${dashboard.port}/assets/app.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type') || '', /text\/css/);
  const styles = await css.text();
  assert.match(styles, /prefers-color-scheme/);
  assert.equal((styles.match(/{/g) || []).length, (styles.match(/}/g) || []).length, 'served CSS rules are balanced');
  assert.equal(extractHttpUrl('Look https://example.com/a). and javascript:alert(1)'), 'https://example.com/a');
  assert.equal(extractHttpUrl('javascript://example.com is not a web URL'), '');
  const points = ['first point', 'second point'];
  assert.deepEqual(parseKeyPointLines(formatKeyPointLines(points)), points);
  assert.deepEqual(parseKeyPointLines('first\n\nsecond\n'), ['first', 'second']);
});

test('settings navigation loads effective settings and has an actionable failure state', () => {
  const script = assets['/assets/app.js']!.body;
  assert.match(script, /case'settings':if\(!settings\)\{try\{await loadSettings\(\)\}catch\(error\)\{view=settingsError\(error\);break\}\}view=await settingsPage\(\);break;/);
  assert.match(script, /Effective settings could not be loaded:/);
  assert.match(script, /node\('button','primary','Retry'\)/);
  assert.match(script, /await loadSettings\(\);render\(\)/);
  assert.match(script, /Command line/);
  assert.match(script, /api\/shim\/status/);
  assert.match(script, /navigator\.clipboard\.writeText\(info\.pathSuggestion\)/);
});

test('served dashboard script completes its first refresh and renders every screen', async () => {
  class Element {
    children: Element[] = [];
    nodeType = 1;
    tagName = 'DIV';
    textContent = '';
    className = '';
    hidden = false;
    value = '';
    dataset: Record<string, string> = {};
    checked = false;
    disabled = false;
    classList = { add: (_name: string) => undefined, remove: (_name: string) => undefined };
    listeners = new Map<string, Function>();
    append(...items: Element[]) { this.children.push(...items); }
    replaceChildren(...items: Element[]) { this.children = items; }
    addEventListener(name: string, fn: Function) { this.listeners.set(name, fn); }
    setAttribute(_name: string, _value: string) {}
    getAttribute(_name: string) { return null; }
    get attributes() { return []; }
    get childNodes() { return this.children; }
    focus() {}
    appendChild(item: Element) { this.append(item); return item; }
    querySelectorAll(_selector: string) { return []; }
    get childElementCount() { return this.children.length; }
    get firstChild(): Element | null { return this.children[0] ?? null; }
    get innerText(): string { return this.textContent + this.children.map(item => item.innerText).join(''); }
  }
  const screens = ['overview','storage','jobs','dream','capture','clients','connections','client-settings','settings','audit','knowledge','chat','workspaces','wiki-review','settings-error','client-first-setup'];
  for (const screen of screens) {
    const elements = new Map<string, Element>();
    const document = {
      body: new Element(),
      hidden: false,
      querySelector(selector: string) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector)!; },
      createElement(_tag: string) { return new Element(); },
      createElementNS(_namespace: string, _tag: string) { return new Element(); },
      addEventListener() {},
    };
    const response = (body: any, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
    const fetch = async (path: string) => {
      if (path === '/api/auth/status') return response({ passwordSet: screen !== 'client-first-setup', clientMode: screen === 'client-first-setup' });
      if (path === '/api/status') return response({ generatedAt: new Date().toISOString(), doctor:{state:'ok',checks:[]}, index:{available:true,journalSequence:1,manifest:{entries:0}}, jobs:{}, scheduler:{}, capture:{}, storage:{}, dream:{}, wiki:{}, proposals:{} });
      if (path === '/api/connectors/openai/status') return response({config:{profileName:'engram-keyed',apiKeySet:false,workspaces:[]},status:{gateway:{healthy:false,state:screen==='settings'?'unknown':'stopped'},keyedGateway:{loaded:false,running:false,statusUnknown:screen==='settings'},tunnelClient:{loaded:false,state:screen==='settings'?'unknown':'stopped'},binaryFound:false,profilePresent:false}});
      if (path === '/api/connectors/claude/local') return response({node:'/usr/bin/node',mdbMcp:'/app/mdb-mcp.js',root:'/tmp/vault',claudeCode:{state:{engramPresent:false}},desktop:{file:'/tmp/Claude/claude_desktop_config.json',state:{engramPresent:false}},entry:{command:'/usr/bin/node',args:['/app/mdb-mcp.js','--root','/tmp/vault'],env:{MDB_ACTOR_ID:'local-dashboard'}},command:'claude mcp add',snippets:{desktopJson:'{}',remote:'{}'}});
      if (path === '/api/connectors/claude/web') return response({config:{url:'',mode:'authless',headerName:'x-api-key',keySet:false}});
      if (path === '/api/connectors') return response({connectors:{claude:Object.fromEntries(['publicUrl','tunnelName','tunnelId','tunnelToken','oauthClientId','oauthClientSecret'].map(key=>[key,{set:false,value:null}]))},credentials:[],authMode:'scoped MCP credentials'});
      if (path === '/api/settings') return response({ etag:'test', settings:{}, security:{passwordSet:true}, server:{host:'127.0.0.1',port:1} }, screen === 'settings-error' ? 500 : 200);
      if (path === '/api/shim/status') return response({ path:'/tmp/home/.local/bin/mdb', installed:true, onPath:false, pathSuggestion:'export PATH="/tmp/home/.local/bin:$PATH"' });
      if (path === '/api/url-notes/settings') return response({ enabled:false, readiness:{claude:{found:false},codex:{found:false}} });
      if (path === '/api/chat/capabilities') return response({ modelConfigured:false, ready:false, remote:false, consentGiven:false });
      if (path.startsWith('/api/documents')) return response({ items:[], cursor:null });
      if (path.startsWith('/api/clients')) return response({ total:1, rows:[{credential:{id:'cred_01234567890123456789',actorId:'studio',permissions:['workspace:proj:read'],lastUsedAt:'2026-11-10T12:00:00Z'},expectedDigest:'digest',clients:[{clientId:'00000000-0000-4000-8000-000000000001',displayName:'Studio Air',hostLabel:'macOS',mode:'cached',state:'Connected',serverReceivedAt:'2026-11-10T12:00:00Z',appVersion:'1.0',lastSync:{serverContactAt:null,outboxDeliveredAt:null,fileSyncCommittedAt:null,contextFetchedAt:null},queues:{outbox:0,fileSync:0,capture:0,queuedBytes:0},projects:[]}]}]});
      if (path === '/api/proposals' || path === '/api/audit' || path === '/api/workspaces') return response([]);
      return response({});
    };
    const sandbox: any = { document, fetch, location:{hash:'#'+(screen==='settings-error'?'settings':screen),pathname:'/',search:''}, history:{replaceState(){}}, URLSearchParams, URL, Intl, Date, Map, Set, Event: class {}, console, setTimeout: () => 1, clearTimeout() {}, window:{addEventListener(){},confirm:()=>true}, confirm:()=>true, prompt:()=>null, crypto:{randomUUID:()=> 'test-id'} };
    new vm.Script(assets['/assets/app.js']!.body).runInNewContext(sandbox);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    if (screen === 'client-first-setup') {
      assert.match(document.body.innerText, /Open the Engram Client menu and choose Open dashboard, or Copy first-time sign-in link/);
      continue;
    }
    const rendered = document.querySelector('#content').innerText;
    assert.notEqual(rendered, 'Waiting for first refresh', `${screen} should refresh`);
    assert.doesNotMatch(rendered, /Loading effective settings…/, `${screen} should not remain in a loading state`);
    if (screen === 'clients') { assert.match(rendered, /Studio Air/); assert.match(rendered, /Revoke credential/); }
    if (screen === 'settings-error') assert.match(rendered, /Effective settings could not be loaded/);
    assert.equal(document.querySelector('#updated').textContent.startsWith('Updated '), true, `${screen} should show refresh completion`);
  }
});

test('Domains panel shows its evidence threshold, pending candidates, and no-model behavior', async () => {
  const source = assets['/assets/app.js']!.body;
  assert.match(source, /Minimum evidence:/);
  assert.match(source, /pendingDomainCandidates/);
  assert.match(source, /pending\.evidence\|\|\[\]\)\.join/);
  assert.match(source, /discovery is unavailable/);
});

test('client refresh uses client status and leaves Connecting on success or failure', async t => {
  const vault = await disposableVault();
  const client = await createDashboardServer({ engram: vault.engram, clientMode: true, host: '127.0.0.1', port: 0, authLocation: { env: {}, homeDir: vault.root, platform: 'linux' } });
  t.after(async () => { await client.close(); await vault.cleanup(); });
  const script = await fetch(`http://127.0.0.1:${client.port}/assets/app.js`).then(response => response.text());
  const clientScreens = script.match(/^const screens=.*;$/m)?.[0] ?? '';
  assert.doesNotMatch(clientScreens, /['"]clients['"]/);
  assert.match(script, /api\('\/api\/client\/status'\)/);
  assert.match(script, /textContent='DEVICE'/);
  assert.match(script, /This device'\+\(result\.captureHost/);
  const start = script.indexOf('async function refresh(){'), end = script.indexOf('\npause.addEventListener', start);
  assert.ok(start >= 0 && end > start, 'client script contains the rewritten refresh implementation');
  const fields = new Map<string, any>();
  const document = { hidden: false, querySelector(selector: string) { if (!fields.has(selector)) fields.set(selector, { hidden: false, textContent: '', title: '', className: '', replaceChildren() {} }); return fields.get(selector); } };
  let response: any = { state: 'ok', generatedAt: '2026-01-01T00:00:00Z', checks: [{ id: 'server', state: 'ok', text: 'Syncing to studio.example' }], captureHost: 'studio.example' };
  const requested: string[] = []; let rendered = 0, notified = '';
  const context: any = {
    timer: 0, paused: false, backoff: 10000, status: null, health: document.querySelector('#health'), updated: document.querySelector('#updated'), disconnect: document.querySelector('#disconnect'),
    document, clearTimeout() {}, setHealth() { context.health.textContent = context.status?.doctor?.state ?? 'unknown'; },
    api: async (route: string) => { requested.push(route); if (route !== '/api/client/status') throw Object.assign(new Error('Not found'), { status: 404 }); if (response instanceof Error) throw response; return response; },
    render: async () => { rendered++; }, schedulePoll() {}, notify(message: string) { notified = message; }, Math, Date,
  };
  const refresh = new vm.Script(`${script.slice(start, end)}; refresh`).runInNewContext(context) as () => Promise<void>;
  await refresh();
  assert.deepEqual(requested, ['/api/client/status']); assert.equal(context.health.textContent, 'ok');
  assert.equal(context.updated.textContent.startsWith('Updated '), true); assert.equal(rendered, 1);
  assert.match(context.health.title, /Syncing to studio.example/); assert.equal(document.querySelector('.eyebrow').textContent, 'DEVICE');
  assert.equal(document.querySelector('#vault-path').textContent, 'This device · studio.example');
  response = { state: 'attention', generatedAt: '2026-01-01T00:00:01Z', checks: [{ id: 'server', state: 'attention', text: 'Cannot reach the server: events are queued on this Mac' }], captureHost: 'studio.example' };
  await refresh(); assert.equal(context.health.textContent, 'attention'); assert.equal(rendered, 2);
  response = new Error('client status route failed'); await refresh();
  assert.equal(context.health.textContent, 'problem'); assert.match(context.health.title, /client status route failed/);
  assert.match(notified, /Client status unavailable/); assert.equal(rendered, 2);
});

test('dashboard boolean settings use accessible switch markup and persistent hover fill rules', () => {
  const js = assets['/assets/app.js']!.body, css = assets['/assets/app.css']!.body;
  assert.match(js, /function switchLabel\(input,label,description='',className=''\)/);
  assert.match(js, /input\.setAttribute\('role','switch'\)/);
  assert.doesNotMatch(assets['/']!.body, /Allow the model to read your wiki excerpts/);
  assert.match(js, /model\.allowNetwork/);
  assert.match(js, /Local model: your question, recent chat, and retrieved excerpts stay on this machine/); assert.match(js, /Vendor-hosted CLI\/API: your question, recent chat, and retrieved excerpts are sent to that vendor/);
  assert.match(js, /Answered by/); assert.match(js, /The model was not used:/); assert.match(js, /Open Settings/);
  assert.match(css, /\.switch input:checked\+\.track\{[^}]*background-image:var\(--accent-grad\)/);
  assert.match(css, /\.switch:hover \.track\{filter:brightness\(1\.08\)/);
  assert.match(css, /\.switch input:focus-visible\+\.track/);
});

// Poll-driven refresh must update only what changed and never discard what the user is typing.
class FakeText { nodeType = 3; parent: FakeEl | null = null; constructor(public data: string) {} replaceWith(next: FakeText | FakeEl) { const siblings = this.parent!.childNodes; next.parent = this.parent; siblings[siblings.indexOf(this)] = next; } }
class FakeEl {
  nodeType = 1; parent: FakeEl | null = null; childNodes: Array<FakeEl | FakeText> = []; attrs = new Map<string, string>(); value = ''; type = 'text'; files: unknown[] = [];
  constructor(public tagName: string) {}
  get parentNode() { return this.parent; }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  hasAttribute(name: string) { return this.attrs.has(name); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  append(...items: Array<FakeEl | FakeText>) { for (const item of items) { item.parent = this; this.childNodes.push(item); } }
  insertBefore(item: FakeEl | FakeText, before: FakeEl | FakeText | null) { item.parent = this; const index = before ? this.childNodes.indexOf(before) : -1; if (index < 0) this.childNodes.push(item); else this.childNodes.splice(index, 0, item); }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(item => item !== this); }
  replaceChildren(...items: Array<FakeEl | FakeText>) { this.childNodes = []; this.append(...items); }
  replaceWith(next: FakeEl | FakeText) { const siblings = this.parent!.childNodes; next.parent = this.parent; siblings[siblings.indexOf(this)] = next; }
  querySelectorAll(): FakeEl[] { const found: FakeEl[] = []; const walk = (el: FakeEl) => { for (const child of el.childNodes) if (child.nodeType === 1) { if (['INPUT', 'TEXTAREA', 'SELECT'].includes((child as FakeEl).tagName)) found.push(child as FakeEl); walk(child as FakeEl); } }; walk(this); return found; }
}
const h = (tag: string, attrs: Record<string, string>, ...kids: Array<FakeEl | string>) => { const el = new FakeEl(tag.toUpperCase()); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); el.append(...kids.map(kid => typeof kid === 'string' ? new FakeText(kid) : kid)); return el; };
function patchHarness() {
  const content = new FakeEl('MAIN'), document = { activeElement: null as FakeEl | null };
  const app = assets['/assets/app.js']!.body;
  const start = app.indexOf('function isFormControl(el){'), end = app.indexOf('\nasync function render(force=false,poll=false)', start);
  assert.ok(start >= 0 && end > start, 'patch helpers are available in served app');
  const code = app.slice(start, end).replace(/content\.addEventListener\([^;]*;/g, '');
  const api = vm.runInNewContext(`${code}; ({ patchContent, markTouched })`, { document, content }) as { patchContent: (view: FakeEl) => void; markTouched: (event: { target: FakeEl }) => void };
  return { content, document, ...api };
}

test('poll refresh updates changed sections and keeps text typed into an input', () => {
  const t = patchHarness();
  const stats = h('p', { class: 'stat' }, 'Jobs: 1'), field = h('input', { id: 'note' }), form = h('section', {}, h('label', {}, 'Note'), field), same = h('p', {}, 'unchanged');
  const page = h('div', {}, stats, form, same);
  t.content.append(page);
  field.value = 'my draft'; t.markTouched({ target: field });
  t.patchContent(h('div', {}, h('p', { class: 'stat' }, 'Jobs: 2'), h('section', {}, h('label', {}, 'Note'), h('input', { id: 'note' })), h('p', {}, 'unchanged')));
  assert.equal(t.content.childNodes[0], page, 'the page wrapper is kept');
  assert.equal(page.childNodes[0] === stats, false, 'the changed section is replaced');
  assert.equal(((page.childNodes[0] as FakeEl).childNodes[0] as FakeText).data, 'Jobs: 2');
  assert.equal(page.childNodes[1], form, 'the section holding the draft is not replaced');
  assert.equal(field.value, 'my draft', 'the typed text survives the refresh');
  assert.equal(page.childNodes[2], same, 'unchanged sections keep their elements');
});

test('poll refresh protects a focused input and still refreshes changed text beside it', () => {
  const t = patchHarness();
  const status = h('p', {}, 'idle'), field = h('textarea', {}), page = h('div', {}, h('section', {}, status, field));
  t.content.append(page);
  field.value = 'typing'; t.document.activeElement = field;
  t.patchContent(h('div', {}, h('section', {}, h('p', {}, 'running'), h('textarea', {}))));
  const section = page.childNodes[0] as FakeEl;
  assert.equal(section.childNodes[1], field, 'the focused field is the same element');
  assert.equal(field.value, 'typing');
  assert.equal((section.childNodes[0] as FakeEl).childNodes.map(n => (n as FakeText).data).join(''), 'running', 'text next to it still refreshes');
});

test('poll refresh keeps typed model name and base URL fields', () => {
  const t = patchHarness();
  const modelName = h('input', { id: 'model-name' }), baseUrl = h('input', { id: 'model-base-url' }), page = h('div', {}, h('section', {}, modelName, baseUrl));
  t.content.append(page);
  modelName.value = 'typed-model'; baseUrl.value = 'http://127.0.0.1:1234/v1'; t.markTouched({ target: modelName }); t.markTouched({ target: baseUrl });
  t.patchContent(h('div', {}, h('section', {}, h('input', { id: 'model-name' }), h('input', { id: 'model-base-url' }))));
  assert.equal((t.content.childNodes[0] as FakeEl).childNodes[0], page.childNodes[0]);
  assert.equal(modelName.value, 'typed-model'); assert.equal(baseUrl.value, 'http://127.0.0.1:1234/v1');
});

test('poll refresh replaces everything that changed when nothing has been typed', () => {
  const t = patchHarness();
  const field = h('input', {}), page = h('div', {}, h('p', {}, 'a'), h('section', {}, field));
  t.content.append(page);
  t.patchContent(h('div', {}, h('p', {}, 'b'), h('section', {}, h('input', {}), h('p', {}, 'extra'))));
  const current = t.content.childNodes[0] as FakeEl;
  assert.notEqual(current, page, 'with nothing typed the changed page is replaced as a whole');
  assert.equal(((current.childNodes[0] as FakeEl).childNodes[0] as FakeText).data, 'b');
  assert.equal(((current.childNodes[1] as FakeEl).childNodes.length), 2, 'new structure is applied when no input is dirty');
});

test('replica poll leaves unchanged area untouched, patches only changed keyed rows, and preserves conflict textarea focus and typing', () => {
  const t = patchHarness();
  const textarea = h('textarea', { 'aria-label': 'Resolve with edited text' }); textarea.value = 'draft from user';
  const stable = h('tr', { 'data-key': 'replica-b-proj' }, h('td', {}, 'unchanged'));
  const changed = h('tr', { 'data-key': 'replica-a-proj' }, h('td', {}, 'Syncing'));
  const area = h('div', { 'data-connector-live': 'true' }, stable, changed, textarea); t.content.append(area);
  t.document.activeElement = textarea;
  t.patchContent(h('div', { 'data-connector-live': 'true' }, h('tr', { 'data-key': 'replica-b-proj' }, h('td', {}, 'unchanged')), h('tr', { 'data-key': 'replica-a-proj' }, h('td', {}, 'Conflict')), h('textarea', { 'aria-label': 'Resolve with edited text' })));
  const current = t.content.childNodes[0] as FakeEl;
  assert.equal(current, area, 'the replica area is not rebuilt');
  assert.equal(current.childNodes[0], stable, 'unchanged workspace row remains the same element');
  assert.equal(current.childNodes[1], changed, 'only the changed row is patched in place');
  assert.equal(((changed.childNodes[0] as FakeEl).childNodes[0] as FakeText).data, 'Conflict');
  assert.equal(current.childNodes[2], textarea, 'the focused conflict editor stays mounted');
  assert.equal(textarea.value, 'draft from user');
});

test('Cached projects renders folders while replica sync is disabled and patches folder rows by key', async () => {
  const js = assets['/assets/app.js']!.body, start = js.indexOf('let clientFoldersSnapshot=null'), end = js.indexOf("setInterval(()=>{for(const age", start);
  assert.ok(start >= 0 && end > start);
  const makePage = async (folders: unknown[]) => {
    const makeNode = (tag: string, className = '', text = '') => ({ tag, className, text, children: [] as any[], attrs: {} as Record<string,string>, append(...nodes: any[]) { this.children.push(...nodes); }, setAttribute(name: string, value: string) { this.attrs[name] = value; } });
    const api = async (route: string) => route === '/api/client/folders' ? { rows: folders, approximate: false } : { enabled: false, state: 'disabled', replicas: [] };
    const pageHeader = (_title: string, description: string) => makeNode('header', '', description), panel = (title: string) => makeNode('section', 'panel', title);
    const factory = vm.runInNewContext(`${js.slice(start,end)}; cachedProjectsPage`, { node: makeNode, panel, pageHeader, api, notify: () => undefined, render: () => undefined, Date }) as () => Promise<any>;
    return factory();
  };
  const folder = { folderName: '../<script>', path: '/tmp/very-long-project-path', workspaceId: 'ws', mode: 'remote', trusted: true, mounted: true, domains: [], hooksInstalled: false, contextCache: { ageMs: 60000, stale: true }, queuedWrites: 2, queuedBytes: 30, replica: { state: null, pending: 0, conflicts: 0 } };
  const view = await makePage([folder]);
  const collect = (item: any): string => [item.text, ...(item.children || []).map(collect)].join(' ');
  assert.match(collect(view), /Project folders on this device/); assert.match(collect(view), /Enable replica sync/); assert.match(collect(view), /STALE/); assert.match(collect(view), /\.\.\/<script>/);
  const empty = await makePage([]); assert.match(collect(empty), /No project folders are bound on this machine\. Run mdb init --project in a project folder, or enable replica sync below\./);
  const t = patchHarness(), stable = h('tr', { 'data-key': 'folder-/tmp/stable' }, h('td', {}, 'stable')), changed = h('tr', { 'data-key': 'folder-/tmp/changed' }, h('td', {}, 'offline'));
  const initial = h('div', { 'data-connector-live': 'true' }, stable, changed); t.content.append(initial);
  t.patchContent(h('div', { 'data-connector-live': 'true' }, h('tr', { 'data-key': 'folder-/tmp/stable' }, h('td', {}, 'stable')), h('tr', { 'data-key': 'folder-/tmp/changed' }, h('td', {}, 'offline'))));
  assert.equal(t.content.childNodes[0], initial); assert.equal(initial.childNodes[0], stable); assert.equal(initial.childNodes[1], changed, 'an unchanged poll does not mutate folder rows');
  t.patchContent(h('div', { 'data-connector-live': 'true' }, h('tr', { 'data-key': 'folder-/tmp/stable' }, h('td', {}, 'stable')), h('tr', { 'data-key': 'folder-/tmp/changed' }, h('td', {}, 'stale'))));
  const patched = t.content.childNodes[0] as FakeEl;
  assert.equal(patched, initial); assert.equal(patched.childNodes[0], stable); assert.equal(patched.childNodes[1], changed);
  assert.equal(((changed.childNodes[0] as FakeEl).childNodes[0] as FakeText).data, 'stale');
  assert.match(js, /Date\.now\(\)-clientFoldersFetchedAt>=10000/); assert.match(js, /folder-context-age.*1000/s);
});

test('replica UI exposes every state, capped size, and plain-text conflict rendering', () => {
  const js = assets['/assets/app.js']!.body;
  const start = js.indexOf('function updateReplicaHeader(data){'), end = js.indexOf('\nasync function refresh()', start); assert.ok(start >= 0 && end > start);
  const pill: { className?: string; label?: { textContent?: string; }; querySelector: () => { textContent?: string } } = { querySelector: () => pill.label! };
  const updated = { textContent: '' }, labels: string[] = [], clock = { value: 1_000_000 }; let tick: () => void = () => {};
  class FakeDate extends Date { static now() { return clock.value; } }
  const update = vm.runInNewContext(`let replicaTick=0; ${js.slice(start, end)}; updateReplicaHeader`, { document: { querySelector: () => pill }, updated, Date: FakeDate, setInterval: (fn: () => void) => { tick = fn; return 1; }, clearInterval: () => undefined }) as (data: { enabled: boolean; state: string; lastSyncAt: string | null }) => void;
  for (const state of ['Sync mode','Syncing','Cache mode (offline)','Conflict','Access refused','Paused','Epoch changed','Daemon stopped']) { pill.label = { textContent: '' }; update({ enabled: true, state, lastSyncAt: null }); labels.push(pill.label.textContent!); }
  assert.deepEqual(labels, ['Sync mode','Syncing','Cache mode (offline)','Conflict','Access refused','Paused','Epoch changed','Daemon stopped']);
  update({ enabled: true, state: 'Sync mode', lastSyncAt: new Date(clock.value - 1000).toISOString() }); assert.match(updated.textContent, /just now/); clock.value += 120_000; tick(); assert.match(updated.textContent, /2 min ago/);
  assert.match(js, /diskSizeBytes/); assert.match(js, /item\.diskSizeApproximate/);
  assert.match(js, /node\('pre','',String\(item\.server\.text\)\)/); assert.match(js, /node\('pre','',String\(item\.local\.text\)\)/);
  assert.match(js, /setInterval\(paint,60000\)/); assert.match(js, /Replica · /); assert.match(js, /enrolledScopes/); assert.doesNotMatch(js, /\.innerHTML\b/);
});

test('served dashboard formats durations and renders Dream previous run and history precisely', async () => {
  const app = assets['/assets/app.js']!.body;
  const formatterStart = app.indexOf('function formatDuration('), formatterEnd = app.indexOf('\n', formatterStart);
  assert.ok(formatterStart >= 0 && formatterEnd > formatterStart, 'duration formatter is in served app.js');
  assert.match(app, /formatDuration\(Date\.now\(\)-chatPending\.startedAt\)/, 'chat action elapsed time uses the shared duration formatter');
  const formatDuration = vm.runInNewContext(`${app.slice(formatterStart, formatterEnd)}; formatDuration`) as (ms: number | null | undefined) => string;
  for (const [ms, expected] of [[37934, '38 s'], [999, '<1 s'], [59999, '59 s'], [60000, '1 min'], [65000, '1 min 05 s'], [189 * 60000, '3 h 09 min'], [3600000, '1 h'], [90000000, '1 d 01 h'], [null, '—'], [-1, '—'], [NaN, '—']] as Array<[number | null, string]>) {
    assert.equal(formatDuration(ms), expected, `formatDuration(${ms})`);
  }

  const makeNode = (tag: string, className = '', text = '') => ({ tag, className, text, children: [] as any[], attrs: {} as Record<string, string>, get lastChild() { return this.children.at(-1); }, append(...nodes: any[]) { this.children.push(...nodes); }, setAttribute(name: string, value: string) { this.attrs[name] = value; } });
  const startedAt = '2026-11-16T08:31:00.000Z';
  const runStatus = { lastRun: { id: 'last', kind: 'adaptive', startedAt, finishedAt: startedAt, timezone: 'UTC', durationMs: 37934, status: 'completed', provider: 'local', documentsConsidered: 1, proposalsCreated: 0, insightsAccepted: 0, failureReason: null }, currentRun: null, runs: [ { id: 'active', kind: 'adaptive', startedAt, finishedAt: null, timezone: 'UTC', durationMs: null, status: 'running' }, { id: 'long', kind: 'adaptive', startedAt, finishedAt: startedAt, timezone: 'UTC', durationMs: 153 * 60000, status: 'completed' } ], nextRun: { time: null, timezone: 'UTC', trigger: null, whyLater: 'No schedule configured' }, scheduler: { configured: false, enabled: false, worker: { loaded: false, running: false } } };
  const collect = (item: any): string => [item.text, ...(item.children ?? []).map(collect)].filter(Boolean).join(' ');
  const pageStart = app.indexOf('async function dreamPage(){'), pageEnd = app.indexOf('\nconst groups=', pageStart);
  assert.ok(pageStart >= 0 && pageEnd > pageStart, 'Dream renderer is available in served app.js');
  const page = vm.runInNewContext(`${app.slice(formatterStart, formatterEnd)}; let dreamRelativeTimer; function tickRelativeTimes(){} ${app.slice(pageStart, pageEnd)}; dreamPage`, {
    node: makeNode,
    api: async (route: string) => { assert.equal(route, '/api/dream/run-status'); return runStatus; },
    pageHeader: (title: string, description: string) => makeNode('header', '', `${title} ${description}`),
    panel: (title: string) => makeNode('section', 'panel', title),
    relativeTimeNode: (iso: string) => makeNode('span', '', iso),
    dataTable: (title: string, headers: string[], rows: unknown[][]) => makeNode('table', 'data-table', `${title} ${headers.join(' ')} ${rows.map(row => row.join(' ')).join(' ')}`),
    fmt: (value: unknown) => String(value ?? '—'), metricPanel: () => makeNode('section'), runAction: () => makeNode('button'), status: { dream: {}, wiki: {}, config: {}, proposals: {} },
    setInterval: () => 1, clearInterval: () => undefined, Date,
  }) as () => Promise<any>;
  const rendered = collect(await page());
  assert.match(rendered, /Previous run[\s\S]*38 s/);
  assert.match(rendered, /Running/);
  assert.match(rendered, /2 h 33 min/);
});
