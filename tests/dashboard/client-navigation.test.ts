import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { disposableVault } from './helpers.js';
import { createDashboardServer } from '../../packages/dashboard/server.js';

const expected = ['This device', 'Server', 'Workspaces', 'Cached projects', 'Connections', 'Client settings'];
class Element {
  children: Element[] = []; listeners = new Map<string, () => void>(); attrs = new Map<string, string>(); textContent = '';
  href = ''; scrollLeft = 0; clientWidth = 1000; offsetLeft = 0; offsetWidth = 100; className = '';
  constructor(public tagName: string) {}
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = [...items]; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  querySelector(selector: string) { return selector === '.nav-list' ? this.children[0] : null; }
  get offsetHeight() { return 20; }
}
const flatten = (el: Element): Element[] => [el, ...el.children.flatMap(flatten)];

test('served client rewrite keeps one six-tab nav and routes Workspaces and Cached projects', async t => {
  const vault = await disposableVault();
  const server = await createDashboardServer({ engram: vault.engram, clientMode: true, host: '127.0.0.1', port: 0, idleMs: 60_000 });
  t.after(async () => { await server.close(); await vault.cleanup(); });
  const origin = `http://127.0.0.1:${server.port}`;
  const html = await fetch(origin + '/').then(r => r.text());
  const source = await fetch(origin + '/assets/app.js').then(r => r.text());
  assert.match(html, /Engram Client/);
  assert.doesNotMatch(html, /#overview|#knowledge|#settings/);
  assert.match(source, /const screens=clientScreens;/);
  assert.match(source, /clientScreens=\[\['this-device','This device','⌂'\],\['server','Server','⇄'\],\['workspaces','Workspaces','▦'\],\['cached-projects','Cached projects','▤'\],\['connections','Connections','⇄'\],\['client-settings','Client settings','⚙'\]\]/);
  assert.doesNotMatch(source.match(/^const screens=.*;$/m)?.[0] ?? '', /overview|knowledge|settings|clients/);
  assert.match(source, /page=clientScreens\.some\(\(\[id\]\)=>id===location\.hash\.slice\(1\)\)\?location\.hash\.slice\(1\):'this-device'/);

  // Run the actual served navRender implementation against the minimal fake DOM used by the UI tests.
  const nav = new Element('nav');
  const node = (tag: string, className = '', text = '') => { const el = new Element(tag); el.className = className; el.textContent = text; return el; };
  const start = source.indexOf('function navRender(){'), end = source.indexOf('\nasync function refresh()', start);
  assert.ok(start >= 0 && end > start, 'served nav renderer is available');
  const declaration = source.match(/const clientScreens=\[[\s\S]*?\];/)?.[0];
  assert.ok(declaration, 'served client screen definition is available');
  const harness = vm.runInNewContext(`${declaration};const screens=clientScreens;let page='this-device';let clientMode=true;${source.slice(start, source.indexOf('\nfunction go(', start))};function go(id){page=id;navRender()}navRender();({go})`, {
    nav, navIcons: {}, node, svgIcon: () => new Element('svg')
  }) as { go: (id: string) => void };
  const navLabels = () => flatten(nav).filter(el => el.tagName === 'span' && !el.className).map(el => el.textContent);
  assert.deepEqual(navLabels(), expected, 'initial client nav');
  for (const [index, id] of ['this-device','server','workspaces','cached-projects','connections','client-settings'].entries()) {
    if (index > 0) flatten(nav).find(el => el.tagName === 'a' && el.href === `#${id}`)!.listeners.get('click')!();
    assert.deepEqual(navLabels(), expected, `nav labels after navigating to ${id}`);
  }
  harness.go('cached-projects');
  assert.deepEqual(navLabels(), expected, 'nav labels after refresh render');

  const renderStart = source.indexOf('async function render(){'), renderEnd = source.indexOf('\nasync function serverPage()', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  const override = source.slice(renderStart, renderEnd);
  assert.match(override, /page==='cached-projects'\)view=await cachedProjectsPage\(\)/);
  assert.match(override, /else view=await thisDevicePage\(\)/);
  assert.match(override, /patchContent\(view\)/);

  const foldersStart = source.indexOf('async function cachedProjectsPage(){'), foldersEnd = source.indexOf('\nasync function ', foldersStart + 1);
  assert.ok(foldersStart >= 0 && foldersEnd > foldersStart, 'served Cached projects page is available');
  const pageCode = source.slice(foldersStart, foldersEnd);
  const makePage = async (rows: unknown[]) => {
    const node = (tag: string, _className = '', text = '') => ({ tag, text, children: [] as any[], attrs: {} as Record<string,string>, append(...items: any[]) { this.children.push(...items); }, setAttribute(name: string, value: string) { this.attrs[name] = value; } });
    const api = async (route: string) => route === '/api/client/folders' ? { rows, approximate: false } : { enabled: false, state: 'disabled', replicas: [] };
    const pageHeader = (_title: string, text: string) => node('header', '', text), panel = (text: string) => node('section', 'panel', text);
    const page = vm.runInNewContext(`let clientFoldersSnapshot=null,clientFoldersFetchedAt=0; ${pageCode}; cachedProjectsPage`, { node, api, pageHeader, panel, notify() {}, render() {}, Date }) as () => Promise<any>;
    return page();
  };
  const collect = (item: any): string => [item.text, ...(item.children ?? []).map(collect)].join(' ');
  const fixture = [{ folderName: 'mounted-local', path: '/projects/mounted-local', workspaceId: 'ws-local', mode: 'local', mounted: true, hooksInstalled: false, queuedWrites: 0, replica: { conflicts: 0 } }, { folderName: 'offline-volume', path: '/Volumes/offline/project', workspaceId: 'ws-offline', mode: 'remote', mounted: false, hooksInstalled: false, queuedWrites: 0, replica: { conflicts: 0 } }];
  const populated = collect(await makePage(fixture));
  assert.match(populated, /Project folders on this device/);
  assert.match(populated, /mounted-local/);
  assert.match(populated, /offline-volume/);
  assert.match(populated, /Enable replica sync/);
  const empty = collect(await makePage([]));
  assert.match(empty, /No project folders are bound on this machine/);

  const workspaceStart = source.indexOf('async function clientWorkspacesPage(){'), workspaceEnd = source.indexOf('return area}', source.indexOf('return area}', workspaceStart) + 1) + 'return area}'.length;
  assert.ok(workspaceStart >= 0 && workspaceEnd > workspaceStart, 'served Workspaces page is available');
  const workspaceCode = source.slice(workspaceStart, workspaceEnd);
  const makeWorkspacePage = async (data: unknown) => {
    const node = (tag: string, className = '', text = '') => { const el = new Element(tag); el.className = className; el.textContent = text; return el; };
    const api = async () => data;
    const pageHeader = (title: string, text: string) => node('header', '', title + ' ' + text);
    const page = vm.runInNewContext(`${workspaceCode};clientWorkspacesPage`, { node, api, pageHeader }) as () => Promise<Element>;
    return page();
  };
  const workspaces = await makeWorkspacePage({ rows: [{ id:'alpha', name:'Alpha', connection:'connected', lastContactAt:'now', modes:['remote','cache-only'], cache:{ageMs:90000,stale:true}, queuedWrites:2, queuedBytes:40, replica:{state:'synced',pendingPush:1,pendingPull:0,conflicts:0}, folders:[{name:'alpha-project'}], writeAccess:null }] });
  const workspaceText = (el: Element): string => [el.textContent, ...el.children.map(workspaceText)].join(' ');
  assert.match(workspaceText(workspaces), /alpha-project.*STALE|STALE.*alpha-project/);
  assert.equal(flatten(workspaces).find(el => el.getAttribute('data-key') === 'workspace-alpha')?.getAttribute('data-key'), 'workspace-alpha');
  assert.match(workspaceText(await makeWorkspacePage({ rows:[] })), /No workspaces yet/);
  assert.match(workspaceText(await makeWorkspacePage({ rows:[], error:'offline' })), /Workspace status unavailable/);
});
