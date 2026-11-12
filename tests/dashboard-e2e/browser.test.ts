import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Engram } from '../../packages/sdk/index.js';
import { Cdp, browserExecutable, freePort, removeTree, tempDirectory, terminate, waitFor } from './cdp.js';

const executable = browserExecutable();
const skipReason = process.env.MDB_E2E_BROWSER !== '1'
  ? 'Set MDB_E2E_BROWSER=1 to opt in to the real-browser dashboard suite'
  : executable ? false : 'Chrome not found: expected /Applications/Google Chrome.app/Contents/MacOS/Google Chrome on macOS or google-chrome/chromium on Linux';
const repository = process.cwd();
const reportPath = process.env.MDB_E2E_REPORT_PATH || path.join(repository, 'verification/ga-readiness/dashboard-browser-e2e.json');
const secret = 'E2E_TUNNEL_TOKEN_SHOULD_NEVER_LEAK_48dfe1';
type Flow = { id: string; status: 'PASS' | 'FAIL'; assertions: string[]; observedFacts: Record<string, unknown>; error?: string };
function localFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8_000) });
}

test('dashboard browser end-to-end security and workflow flows', { skip: skipReason, timeout: 180_000 }, async t => {
  const flows: Flow[] = [];
  let vaultRoot: string | undefined, profile: string | undefined, browser: ChildProcess | undefined, dashboard: ChildProcess | undefined;
  let cdp: Cdp | undefined, csrfServer: Server | undefined;
  let browserPort = 0;
  const writeReport = async () => {
    const consoleMessages = cdp?.events.filter(event => event.method === 'Runtime.consoleAPICalled').map(event => event.params) ?? [];
    const cspReports = cdp?.events.filter(event => /content security policy|violat(?:ed|ion)|refused to (?:load|execute|frame)/i.test(JSON.stringify(event.params ?? {})) && /Log.entryAdded|Runtime.consoleAPICalled|Security\./.test(event.method)).map(event => ({ method: event.method, params: event.params })) ?? [];
    const securityEvents = cdp?.events.filter(event => event.method.startsWith('Security.')).map(event => ({ method: event.method, params: event.params })) ?? [];
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), browser: executable, flows, observations: { networkRequests: network, consoleMessages, cspReports, securityEvents } }, null, 2)}\n`);
  };
  const run = async (id: string, assertions: string[], work: () => Promise<Record<string, unknown>>) => {
    process.stdout.write(`[dashboard-e2e] ${id}: started\n`);
    try {
      if (flows.length) await ensureSignedIn();
      const observedFacts = await work();
      const finding = typeof observedFacts.finding === 'string' ? observedFacts.finding : undefined;
      flows.push({ id, status: finding ? 'FAIL' : 'PASS', assertions, observedFacts, ...(finding ? { error: finding } : {}) });
    }
    catch (error) { flows.push({ id, status: 'FAIL', assertions, observedFacts: {}, error: error instanceof Error ? error.stack ?? error.message : String(error) }); }
    process.stdout.write(`[dashboard-e2e] ${id}: ${flows.at(-1)?.status}\n`);
  };
  t.after(async () => {
    if (cdp) await cdp.close().catch(() => undefined);
    await terminate(browser);
    await terminate(dashboard);
    if (csrfServer?.listening) await new Promise<void>(resolve => csrfServer!.close(() => resolve()));
    await removeTree(profile); await removeTree(vaultRoot);
    await writeReport();
  });

  vaultRoot = await tempDirectory('engram-dashboard-e2e-vault-');
  profile = await tempDirectory('engram-dashboard-e2e-chrome-');
  const authFile = path.join(vaultRoot, 'auth', 'dashboard.json');
  const engram = new Engram(vaultRoot);
  const fakeBin = path.join(vaultRoot, 'fake-bin'); await mkdir(fakeBin, { recursive: true });
  const fakeCli = path.join(fakeBin, 'claude'); await writeFile(fakeCli, '#!/bin/sh\nexit 0\n'); await chmod(fakeCli, 0o755);
  await engram.init({ sqlite: false });
  await engram.vault.setConfig(config => { config.model = { ...config.model, provider: 'claude-cli', command: fakeCli, locality: 'remote', allowNetwork: false }; });
  await engram.close();
  const dashboardPort = await freePort(); browserPort = await freePort();
  dashboard = spawn(process.execPath, [path.join(repository, 'bin/mdb.js'), 'dashboard', '--root', vaultRoot, '--host', '127.0.0.1', '--port', String(dashboardPort)], {
    cwd: repository, env: { ...process.env, MDB_DASHBOARD_ALERT: 'false', PATH: fakeBin + path.delimiter + (process.env.PATH || ''), MDB_DASHBOARD_AUTH_FILE: authFile, MDB_DASHBOARD_ENABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  dashboard.stdout?.on('data', chunk => { stdout += String(chunk); });
  dashboard.stderr?.on('data', chunk => { stderr += String(chunk); });
  const dashboardUrl = await waitFor(async () => stdout, text => /http:\/\/127\.0\.0\.1:\d+\/#t=[a-f0-9]{64}/.test(text), `Dashboard did not print its bootstrap URL: ${stderr}`);
  const tokenUrl = /http:\/\/127\.0\.0\.1:\d+\/#t=[a-f0-9]{64}/.exec(dashboardUrl)![0];
  const origin = new URL(tokenUrl).origin;
  browser = spawn(executable!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--disable-sync', '--no-pings', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${browserPort}`, '--remote-allow-origins=*', 'about:blank'], { stdio: 'ignore' });
  await waitFor(async () => localFetch(`http://127.0.0.1:${browserPort}/json/version`).then(r => r.ok), Boolean, 'Chrome DevTools endpoint did not start');
  const targetResponse = await localFetch(`http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent(tokenUrl)}`, { method: 'PUT' });
  assert.equal(targetResponse.status, 200, 'Chrome opened the bootstrap token URL');
  const target = await targetResponse.json() as { webSocketDebuggerUrl: string };
  cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.command('Page.enable'); await cdp.command('Runtime.enable'); await cdp.command('Network.enable'); await cdp.command('Log.enable'); await cdp.command('Security.enable');
  const network: Array<{ url: string; status?: number; method?: string; resourceType?: string; headers?: Record<string, string>; requestId?: string }> = [];
  const responseBodies = new Map<string, string>();
  const responseBodyRequested = new Set<string>();
  let eventCursor = 0;
  const pollEvents = setInterval(() => {
    for (const event of cdp!.events.slice(eventCursor)) {
      if (event.method === 'Network.requestWillBeSent') {
        const params = event.params as { requestId?: string; request?: { url?: string; method?: string }; type?: string };
        if (params.request) network.push({ url: params.request.url ?? '', method: params.request.method, resourceType: params.type, requestId: params.requestId });
      }
      if (event.method === 'Network.responseReceived') {
        const params = event.params as { requestId?: string; response?: { url?: string; status?: number; headers?: Record<string, string> } };
        if (params.response) network.push({ url: params.response.url ?? '', status: params.response.status, headers: params.response.headers, requestId: params.requestId });
      }
    }
    eventCursor = cdp!.events.length;
    for (const response of network) if (response.requestId && !responseBodyRequested.has(response.requestId)) {
      responseBodyRequested.add(response.requestId);
      void cdp!.command('Network.getResponseBody', { requestId: response.requestId }).then(body => { responseBodies.set(response.requestId!, String(body.body ?? '')); }).catch(() => { responseBodies.set(response.requestId!, ''); });
    }
  }, 20);
  t.after(() => clearInterval(pollEvents));

  const pageFacts = () => cdp!.evaluate<{ title: string; hash: string; text: string; path: string }>(`({title:document.title,hash:location.hash,text:document.body.innerText,path:location.pathname})`);
  const loginWith = async (password: string) => {
    await cdp!.evaluate(`(async()=>{const p=document.querySelector('input[aria-label="Password"]');if(!p)return false;p.value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();return true})()`);
    return waitFor(pageFacts, facts => /Overview/.test(facts.text) && !/Welcome back/.test(facts.text), 'Password login did not reach Overview');
  };
  const ensureSignedIn = async () => {
    const current = await pageFacts();
    if (/Overview/.test(current.text) && !/Welcome back/.test(current.text)) return;
    if (/Welcome back/.test(current.text)) await loginWith('A strong browser test passphrase 2026!');
    else throw new Error(`Expected a dashboard login screen or Overview, got: ${current.text.slice(0, 160)}`);
  };
  const clickSelector = async (target: Cdp, selector: string) => {
    const point = await target.evaluate<{ x: number; y: number } | null>(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    assert.ok(point, `No element matched ${selector}`);
    await target.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await target.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await target.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const clickText = async (target: Cdp, text: string) => {
    const point = await target.evaluate<{ x: number; y: number } | null>(`(()=>{const e=[...document.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    assert.ok(point, `No button has text ${text}`);
    await target.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await target.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await target.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const setPassword = async (password: string) => cdp!.evaluate(`(async()=>{const p=document.querySelector('input[aria-label="New password"]'), c=document.querySelector('input[aria-label="Confirm password"]');p.value=${JSON.stringify(password)};c.value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();return true})()`);
  await waitFor(pageFacts, facts => /Set a password/.test(facts.text), 'First-run password page did not appear');
  await run('first-run-password-session', ['Token URL opens set-password', 'weak password receives a visible rejection', 'valid password establishes session', 'reload retains session and removes token hash'], async () => {
    await setPassword('            ');
    const weak = await waitFor(pageFacts, facts => /12|password|invalid/i.test(facts.text) && !/Overview/.test(facts.text), 'Weak password was not rejected visibly');
    assert.match(weak.text, /12|password|invalid/i);
    await setPassword('A strong browser test passphrase 2026!');
    await waitFor(pageFacts, facts => /Welcome back/.test(facts.text), 'Password setup did not return to login');
    const overview = await loginWith('A strong browser test passphrase 2026!');
    await cdp!.command('Page.reload', { ignoreCache: true });
    const afterReload = await waitFor(pageFacts, facts => /Overview|Welcome back/.test(facts.text), 'Page did not reload');
    assert.equal(afterReload.hash, '', 'bootstrap token fragment is removed');
    assert.match(afterReload.text, /Overview/, 'cookie session survives reload');
    const cookies = await cdp!.command('Network.getAllCookies');
    const cookie = (cookies.cookies as Array<{ name: string; httpOnly: boolean; sameSite: string; secure: boolean }>).find(item => item.name === 'engram_dash_session');
    assert.ok(cookie); assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict'); assert.equal(cookie.secure, false);
    return { weakPasswordMessage: weak.text.slice(-200), landedAt: overview.path, reloadHash: afterReload.hash, reloadShowsOverview: /Overview/.test(afterReload.text), cookie: { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, secure: cookie.secure } };
  });

  const browserApi = async <T>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => cdp!.evaluate<{ status: number; body: T }>(`(async()=>{const r=await fetch(${JSON.stringify(url)}, {...${JSON.stringify(init)}, headers:{'X-Engram-Dashboard':'1',...((${JSON.stringify(init.headers ?? {})})||{})}});let body;try{body=await r.json()}catch{body=await r.text()}return {status:r.status,body}})()`);
  await run('logout-login-lockout', ['logout ends session', 'wrong password is visible', 'repeated failures show lockout', 'right password restores session'], async () => {
    const logout = await browserApi<{ ok: boolean }>('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(logout.status, 200);
    await cdp!.command('Page.reload', { ignoreCache: true });
    const login = async (password: string) => cdp!.evaluate(`(async()=>{const p=document.querySelector('input[aria-label="Password"]');p.value=${JSON.stringify(password)};document.querySelector('form').requestSubmit();return true})()`);
    await waitFor(pageFacts, facts => /Welcome back/.test(facts.text), 'Logout did not require sign-in');
    await login('incorrect password');
    const firstFailure = await waitFor(pageFacts, facts => /Sign-in failed/.test(facts.text), 'Wrong password was not shown');
    for (let index = 0; index < 4; index++) { await login('incorrect password'); await new Promise(resolve => setTimeout(resolve, 350)); }
    const locked = await waitFor(pageFacts, facts => /Too many sign-in attempts|temporarily locked/i.test(facts.text), 'Repeated failures did not show a lockout message');
    await new Promise(resolve => setTimeout(resolve, 1200)); await cdp!.command('Page.reload', { ignoreCache: true });
    await waitFor(pageFacts, facts => /Welcome back/.test(facts.text), 'Login form did not return after lockout');
    await login('A strong browser test passphrase 2026!');
    const overview = await waitFor(pageFacts, facts => /Overview/.test(facts.text), 'Correct password failed after lockout');
    return { wrongPasswordMessage: firstFailure.text.slice(-200), lockoutMessage: locked.text.slice(-200), successfulLogin: /Overview/.test(overview.text) };
  });

  await run('knowledge-crud-conflict-history', ['UI creates and edits a document', 'second tab observes it', 'stale UI save shows conflict dialog', 'delete tombstones and history restores through UI'], async () => {
    await cdp!.evaluate(`location.hash='#knowledge'`); await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Knowledge', 'Knowledge route did not render');
    await clickSelector(cdp!, '.page-head button.primary');
    await waitFor(() => cdp!.evaluate<boolean>(`!!document.querySelector('input[aria-label="Title"]')`), Boolean, 'Knowledge create form did not open');
    await cdp!.evaluate(`(()=>{const fill=(label,value)=>{const x=document.querySelector('[aria-label="'+label+'"]');x.value=value;x.dispatchEvent(new Event('input',{bubbles:true}))};fill('Title','Browser E2E knowledge');fill('Scope (wiki/shared/discoveries/profile/workspace:id)','wiki');fill('Tags, comma separated','e2e');fill('Body','Original evidence')})()`);
    await clickSelector(cdp!, '.editor-fields button.primary');
    await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content')?.innerText||''`), text => text.includes('Browser E2E knowledge'), 'UI did not create the Knowledge document; content: ' + (await cdp!.evaluate<string>(`document.querySelector('#content')?.innerText||''`)).slice(0, 400) + '; notice: ' + await cdp!.evaluate<string>(`document.querySelector('#toast')?.innerText||''`));
    const docs = await browserApi<{ items: Array<{ id: string; title: string }> }>('/api/documents?limit=100');
    const listed = docs.body.items.find(item => item.title === 'Browser E2E knowledge'); assert.ok(listed);
    const loaded = await browserApi<{ document: { id: string; revisionId: string; title: string; body: string } }>(`/api/documents/${encodeURIComponent(listed.id)}`); const doc = loaded.body.document;
    const tab2 = await localFetch(`http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent(origin)}`, { method: 'PUT' }).then(r => r.json()) as { webSocketDebuggerUrl: string };
    const second = await Cdp.connect(tab2.webSocketDebuggerUrl); await second.command('Page.enable'); await second.command('Runtime.enable');
    try {
      const secondFacts = () => second.evaluate<string>('document.body.innerText');
      await waitFor(secondFacts, text => /Overview/.test(text), 'Second tab shell did not load');
      await clickSelector(second, 'a.nav-link[href="#knowledge"]');
      await waitFor(() => second.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Knowledge', 'Second tab Knowledge route did not render');
      await second.evaluate(`([...document.querySelectorAll('button')].find(button=>button.textContent==='Search'))?.click()`);
      const visible = await waitFor(() => second.evaluate<string>(`document.querySelector('#content')?.innerText||''`), text => /Browser E2E knowledge/.test(text), 'Second tab did not see the saved document');
      await clickText(cdp!, doc.title); await waitFor(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(button=>button.textContent==='Edit')`), Boolean, 'First tab document detail did not open');
      await clickText(second, doc.title); await waitFor(() => second.evaluate<boolean>(`[...document.querySelectorAll('button')].some(button=>button.textContent==='Edit')`), Boolean, 'Second tab document detail did not open');
      await clickText(cdp!, 'Edit'); await waitFor(() => cdp!.evaluate<boolean>(`!!document.querySelector('input[aria-label="Expected revision"]')`), Boolean, 'First tab editor did not open');
      const firstExpected = await cdp!.evaluate<string>(`document.querySelector('[aria-label="Expected revision"]')?.value||''`);
      assert.equal(firstExpected, doc.revisionId, 'first tab editor pre-fills the loaded revision');
      await cdp!.evaluate(`(()=>{const body=document.querySelector('[aria-label="Markdown body"]');body.value='First tab saved';body.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await clickText(cdp!, 'Save');
      await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#toast')?.innerText||''`), text => text.includes('Saved'), 'First tab UI edit did not save');
      await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Knowledge', 'First tab edit did not return to Knowledge');

      await clickText(second, 'Edit'); await waitFor(() => second.evaluate<boolean>(`!!document.querySelector('input[aria-label="Expected revision"]')`), Boolean, 'Second tab editor did not open');
      const secondExpected = await second.evaluate<string>(`document.querySelector('[aria-label="Expected revision"]')?.value||''`);
      assert.equal(secondExpected, doc.revisionId, 'second tab retains its originally loaded revision');
      await second.evaluate(`(()=>{const body=document.querySelector('[aria-label="Markdown body"]');body.value='Second tab draft';body.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await clickText(second, 'Save');
      const conflict = await waitFor(() => second.evaluate<string>(`document.querySelector('#content')?.innerText||''`), text => text.includes('Edit conflict · current version is newer'), 'Stale second-tab save did not show the conflict panel');
      const preservedDraft = await second.evaluate<string>(`document.querySelector('[aria-label="Markdown body"]')?.value||''`);
      assert.equal(preservedDraft, 'Second tab draft', 'the stale draft remains in the editor');
      assert.match(conflict, /First tab saved/, 'conflict panel shows the current saved body');
      const unchanged = await browserApi<{ document: { body: string } }>(`/api/documents/${encodeURIComponent(doc.id)}`);
      assert.equal(unchanged.body.document.body, 'First tab saved', 'stale save did not overwrite current body');
      await clickText(second, 'Reapply my draft on current version');
      await waitFor(() => second.evaluate<string>(`document.querySelector('#toast')?.innerText||''`), text => text.includes('Draft reapplied as a new revision'), 'Reapply did not report success');
      await waitFor(() => second.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Knowledge', 'Reapply did not return to Knowledge');
      const reapplied = await browserApi<{ document: { body: string } }>(`/api/documents/${encodeURIComponent(doc.id)}`);
      assert.equal(reapplied.body.document.body, 'Second tab draft', 'reapply creates a new revision with the preserved draft');

      await clickText(cdp!, doc.title); await waitFor(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(button=>button.textContent==='Delete')`), Boolean, 'First tab document view did not open for delete');
      await cdp!.evaluate(`window.confirm=()=>true`); await clickText(cdp!, 'Delete');
      await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#toast')?.innerText||''`), text => text.includes('Document tombstoned'), 'UI delete did not tombstone document');
      const afterDelete = await browserApi<{ items: Array<{ id: string }> }>('/api/documents?limit=100');
      assert.equal(afterDelete.body.items.some(item => item.id === doc.id), false, 'deleted document disappears from the default list');
      const deletedList = await browserApi<{ items: Array<{ id: string; status: string }> }>('/api/documents?includeDeleted=true&limit=100');
      assert.equal(deletedList.body.items.find(item => item.id === doc.id)?.status, 'deleted', 'include-deleted list exposes tombstone');
      await cdp!.evaluate(`(()=>{const checkbox=document.querySelector('.toolbar-check input');checkbox.checked=true;checkbox.dispatchEvent(new Event('change',{bubbles:true}));[...document.querySelectorAll('button')].find(button=>button.textContent==='Search')?.click()})()`);
      await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content')?.innerText||''`), text => text.includes(doc.title), 'UI include-deleted list did not show tombstone');
      await clickText(cdp!, doc.title); await waitFor(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(button=>button.textContent.startsWith('Restore '))`), Boolean, 'Tombstone history did not expose restore action');
      await cdp!.evaluate(`window.confirm=()=>true`); await clickText(cdp!, 'Restore ' + doc.revisionId.slice(0, 12));
      const restoreToast = await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#toast')?.innerText||''`), text => text.includes('Restored as a new revision') || !!text, 'UI restore did not report a result');
      assert.match(restoreToast, /Restored as a new revision/, 'history restore action succeeded');
      const restored = await waitFor(() => browserApi<{ document: { status: string; body: string } }>(`/api/documents/${encodeURIComponent(doc.id)}`).then(result => result.body.document), document => document.status === 'active' && document.body === doc.body, 'UI restore did not create an active revision with the original body');
      return { secondTabSawDocument: visible.includes(doc.title), firstTabExpectedRevisionPrefilled: firstExpected === doc.revisionId, secondTabExpectedRevisionPrefilled: secondExpected === doc.revisionId, staleSaveConflictPanel: conflict.includes('Edit conflict · current version is newer'), currentBodyShown: conflict.includes('First tab saved'), draftPreserved: preservedDraft === 'Second tab draft', noStaleOverwrite: unchanged.body.document.body === 'First tab saved', reapplyBody: reapplied.body.document.body, tombstoneAbsentFromDefaultList: !afterDelete.body.items.some(item => item.id === doc.id), tombstoneVisibleWhenIncluded: deletedList.body.items.find(item => item.id === doc.id)?.status === 'deleted', restoredStatus: restored.status };
    } finally { await second.close(); }
  });

  await run('chat-provenance-and-settings-hint', ['chat has no model switch', 'capability hint explains locality and Settings navigation', 'screenshots capture chat and model settings'], async () => {
    const screenshot = async (name: string) => {
      const captured = await cdp!.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await mkdir(path.join(repository, 'docs/dashboard-screenshots'), { recursive: true });
      await writeFile(path.join(repository, 'docs/dashboard-screenshots', name), Buffer.from(String(captured.data), 'base64'));
    };
    await cdp!.evaluate("location.hash='#chat'");
    await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Wiki chat', 'Chat did not render');
    const capabilities = await browserApi<{ ready:boolean; locality?:string; remote:boolean; consentGiven:boolean }>('/api/chat/capabilities');
    const ui = await cdp!.evaluate<{ switchPresent:boolean; hint:string }>(`(()=>({switchPresent:!!document.querySelector('.chat-model input'),hint:document.querySelector('.chat-model-note')?.innerText||''}))()`);
    assert.equal(capabilities.status, 200); assert.equal(ui.switchPresent, false);
    assert.match(ui.hint, /Local model:|Vendor-hosted CLI\/API:|No chat model is ready/);
    await screenshot('t14-chat-before-light.png');
    await cdp!.evaluate("location.hash='#settings'");
    await waitFor(() => cdp!.evaluate<string>(`document.querySelector('#content h1')?.textContent||''`), title => title === 'Settings', 'Settings did not render');
    await screenshot('t14-settings-model-group.png');
    return { capabilities: capabilities.body, switchPresent: ui.switchPresent, hint: ui.hint };
  });

  await run('stored-xss-csp', ['hostile markdown remains inert across routes', 'no injected elements or script execution', 'document/script/style responses carry CSP', 'eval is blocked', 'no CSP violation events'], async () => {
    const payload = '<img src=x onerror=window.__pwned=1><script>window.__pwned=1</script> [link](javascript:window.__pwned=1)';
    const created = await browserApi<{ document: { id: string } }>('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: payload, body: payload, kind: 'note', scope: { type: 'global', area: 'wiki' }, tags: [payload] }) });
    assert.equal(created.status, 201);
    const workspace = await browserApi('/api/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'xss-workspace', description: payload }) });
    assert.equal(workspace.status, 201);
    const credential = await browserApi('/api/dashboard/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: '<img src=x onerror=window.__pwned=1>', mode: 'view' }) });
    assert.equal(credential.status, 201);
    const connector = await browserApi('/api/connectors/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connector: 'openai', values: { tunnelName: payload }, confirm: 'SAVE OPENAI CONNECTOR' }) });
    assert.equal(connector.status, 410);
    for (const route of ['overview', 'knowledge', 'chat', 'workspaces', 'wiki-review', 'storage', 'jobs', 'dream', 'capture', 'connections', 'client-settings', 'settings', 'audit']) {
      await cdp!.evaluate(`location.hash=${JSON.stringify(`#${route}`)}`);
      await new Promise(resolve => setTimeout(resolve, 120));
      if (route === 'knowledge') {
        await cdp!.evaluate(`[...document.querySelectorAll('button.quiet-button')].find(button=>button.textContent===${JSON.stringify(payload)})?.click()`);
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      const safety: { pwned: unknown; image: boolean; scripts: number; text: string } = await cdp!.evaluate<{ pwned: unknown; image: boolean; scripts: number; text: string }>(`({pwned:window.__pwned,image:!!document.querySelector('img[src="x"]'),scripts:[...document.scripts].filter(s=>!s.src).length,text:document.body.innerText})`);
      assert.equal(safety.pwned, undefined, `payload executed on ${route}`); assert.equal(safety.image, false); assert.equal(safety.scripts, 0);
      if (route === 'knowledge') assert.ok(safety.text.includes(payload), 'payload is rendered as inert text');
    }
    const cspEvents = cdp!.events.filter(event => /csp|content security/i.test(JSON.stringify(event)));
    assert.equal(cspEvents.length, 0, 'no CSP violations occurred during page navigation or rendering');
    const evaluation = await cdp!.command('Runtime.evaluate', { expression: "(()=>{try{eval('1');return 'allowed'}catch(error){return error.name+': '+error.message}})()", returnByValue: true, allowUnsafeEvalBlockedByCSP: false });
    const evalResult = (evaluation.result as { value?: string }).value ?? '';
    assert.match(evalResult, /EvalError|unsafe-eval|Content Security Policy/i, `eval is blocked by CSP (Runtime.evaluate returned ${evalResult || JSON.stringify(evaluation)})`);
    const responseHeaders = network.filter(item => item.status !== undefined && (item.url === origin + '/' || /\/assets\/app\.(js|css)$/.test(item.url)));
    assert.ok(responseHeaders.some(item => item.url === origin + '/'));
    for (const response of responseHeaders) assert.match(response.headers?.['content-security-policy'] ?? response.headers?.['Content-Security-Policy'] ?? '', /default-src 'none'.*frame-ancestors 'none'/);
    const externalRequests = network.filter(item => item.method && !item.url.startsWith(origin + '/') && !item.url.startsWith('data:') && !item.url.startsWith('blob:'));
    assert.deepEqual(externalRequests, [], 'browser made no external network requests');
    return { routeCount: 13, payloadVisibleAsText: true, injectedImage: false, injectedInlineScript: false, evalBlocked: true, evalResult, cspResponseCount: responseHeaders.length, cspEvents: cspEvents.length, externalRequests };
  });

  await run('csrf-and-clickjacking', ['second-origin form and credentialed fetch receive 403', 'document count is unchanged', 'cross-origin iframe is blocked'], async () => {
    const before = await browserApi<{ items: unknown[] }>('/api/documents?limit=100');
    const csrfPort = await freePort();
    csrfServer = createServer((request, response) => {
      if (request.url === '/frame') return response.end(`<!doctype html><iframe id="target" src="${origin}/"></iframe>`);
      response.end(`<!doctype html><form id="f" action="${origin}/api/documents" method="post"><input name="title" value="CSRF"><button>submit</button></form><script>f.submit();fetch('${origin}/api/documents',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'CSRF fetch'})}).catch(()=>{});</script>`);
    });
    await new Promise<void>(resolve => csrfServer!.listen(csrfPort, '127.0.0.1', resolve));
    const secondOrigin = `http://127.0.0.1:${csrfPort}`;
    const csrfTarget = await localFetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()) as { webSocketDebuggerUrl: string };
    const attacker = await Cdp.connect(csrfTarget.webSocketDebuggerUrl); await attacker.command('Page.enable'); await attacker.command('Network.enable');
    try { await attacker.command('Page.navigate', { url: secondOrigin }); await waitFor(() => attacker.evaluate<string>('document.readyState'), state => state === 'complete', 'Cross-origin page did not load'); await new Promise(resolve => setTimeout(resolve, 800)); }
    finally { await attacker.close(); }
    const csrfResponses = attacker.events.filter(event => event.method === 'Network.responseReceived').map(event => (event.params as { response?: { url?: string; status?: number } }).response).filter(response => response?.url?.startsWith(origin + '/api/documents') && response.status === 403);
    assert.equal(csrfResponses.length, 2, 'cross-origin form and credentialed fetch each receive 403');
    const after = await browserApi<{ items: unknown[] }>('/api/documents?limit=100');
    assert.equal(after.body.items.length, before.body.items.length);
    assert.ok(csrfResponses.length >= 1, `dashboard rejected cross-origin mutation with 403; responses: ${JSON.stringify(attacker.events.filter(event => event.method === 'Network.responseReceived').map(event => (event.params as { response?: { url?: string; status?: number } }).response))}`);
    const frameTarget = await localFetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json()) as { webSocketDebuggerUrl: string };
    const framing = await Cdp.connect(frameTarget.webSocketDebuggerUrl); await framing.command('Page.enable'); await framing.command('Log.enable'); await framing.command('Network.enable');
    try { await framing.command('Page.navigate', { url: secondOrigin + '/frame' }); await new Promise(resolve => setTimeout(resolve, 500)); }
    finally { await framing.close(); }
    const frameTree = await cdp!.command('Page.getFrameTree');
    const frameLog = framing.events.filter(event => /frame-ancestors|refused to frame/i.test(JSON.stringify(event)));
    assert.ok(frameLog.length > 0, `cross-origin iframe navigation is refused by CSP/X-Frame-Options; frame tree: ${JSON.stringify(frameTree)}`);
    return { secondOrigin, csrf403Responses: csrfResponses.map(item => item?.status), documentsBefore: before.body.items.length, documentsAfter: after.body.items.length, iframeRefusalEvents: frameLog.length };
  });

  await run('chat-and-model-unavailable', ['unavailable model returns deterministic degraded answers', 'matching answer has Knowledge citation', 'degraded state is shown without an opt-in switch'], async () => {
    const ask = (question: string) => browserApi<{ answer: string; citations?: Array<{ uri: string }>; mode:string; degradedReason?:{code:string} }>('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
    const empty = await ask('What is in this vault?'); assert.equal(empty.status, 200);
    const greeting = await ask('hi'); assert.equal(greeting.status, 200);
    const doc = await browserApi('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Marmot habitat', body: 'Marmots live in alpine meadows and rocky slopes.', kind: 'note', scope: { type: 'global', area: 'wiki' } }) }); assert.equal(doc.status, 201);
    const matching = await ask('Where do marmots live?'); assert.equal(matching.status, 200); assert.match(matching.body.answer, /alpine meadows/i); assert.ok(matching.body.citations?.length);
    const capabilities = await browserApi<{ ready: boolean; remote:boolean; consentGiven:boolean }>('/api/chat/capabilities');
    assert.equal(capabilities.status, 200);
    await cdp!.evaluate("location.hash='#chat'"); await waitFor(pageFacts, facts => /Wiki chat/.test(facts.text), 'Chat screen not rendered');
    const ui = await waitFor(() => cdp!.evaluate<{ switchPresent:boolean; reason:string }>(`(()=>({switchPresent:!!document.querySelector('.chat-model input'),reason:document.querySelector('.chat-model-note')?.innerText||''}))()`), value => value.reason !== 'Checking model…', 'Model capability hint did not render');
    assert.equal(ui.switchPresent, false); assert.match(ui.reason, /No chat model is ready/);
    await cdp!.evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message"]');input.value='Where do marmots live?';document.querySelector('.chat-send').click()})()`);
    const citedUi = await waitFor(() => cdp!.evaluate<string>('document.querySelectorAll(".citation-chip").length+"|"+(document.querySelector(".chat-feed")?.innerText||"")'), value => value.startsWith('1|') && /alpine meadows/i.test(value), 'Chat UI did not render the cited answer');
    // The sent message must appear at once and a status indicator must show while the answer is pending; Stop must work. The chat response is delayed in the page to make the pending window observable.
    await cdp!.evaluate(`(()=>{window.__origFetch=window.fetch;window.__chatDelay=1500;window.fetch=(u,o)=>String(u).includes('/api/chat')&&o&&o.method==='POST'?new Promise((resolve,reject)=>{const t=setTimeout(()=>resolve(window.__origFetch(u,o)),window.__chatDelay);if(o.signal)o.signal.addEventListener('abort',()=>{clearTimeout(t);reject(new DOMException('Aborted','AbortError'))})}):window.__origFetch(u,o)})()`);
    await cdp!.evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message"]');input.value='Where do marmots live second time?';document.querySelector('.chat-send').click()})()`);
    const pendingJson = await waitFor(() => cdp!.evaluate<string>('JSON.stringify({user:[...document.querySelectorAll(".chat-turn.user .chat-text")].map(x=>x.innerText).at(-1)||"",pending:document.querySelector(".chat-pending")?.innerText||"",sendDisabled:!!document.querySelector(".chat-send")?.disabled,stop:!!document.querySelector(".chat-stop")})'), value => /second time/.test(value) && /Asking the configured model/.test(value), 'The sent message and the pending status must show before the answer arrives');
    const pendingFacts = JSON.parse(pendingJson) as { user: string; pending: string; sendDisabled: boolean; stop: boolean };
    assert.equal(pendingFacts.sendDisabled, true, 'Send is disabled while a request is running'); assert.equal(pendingFacts.stop, true, 'a Stop button is offered while pending');
    await waitFor(() => cdp!.evaluate<boolean>('!document.querySelector(".chat-pending")'), done => done === true, 'the pending status must clear after the answer arrives');
    await cdp!.evaluate('window.__chatDelay=8000');
    await cdp!.evaluate(`(()=>{const input=document.querySelector('textarea[aria-label="Message"]');input.value='Where do marmots live third time?';document.querySelector('.chat-send').click()})()`);
    await waitFor(() => cdp!.evaluate<boolean>('!!document.querySelector(".chat-stop")'), shown => shown === true, 'Stop button must appear');
    await cdp!.evaluate('document.querySelector(".chat-stop").click()');
    const stopped = await waitFor(() => cdp!.evaluate<string>('JSON.stringify({pending:!!document.querySelector(".chat-pending"),feed:document.querySelector(".chat-feed")?.innerText||""})'), value => !JSON.parse(value).pending && /Stopped\./.test(value), 'Stop must end the pending state with a visible note');
    assert.match(JSON.parse(stopped).feed, /third time/);
    await cdp!.evaluate('(()=>{window.fetch=window.__origFetch})()');
    return { emptyReply: empty.body.answer, smallTalk: greeting.body.answer, citation: matching.body.citations?.[0], capability: capabilities.body, degraded: matching.body.degradedReason, modelSwitchPresent: ui.switchPresent, citedUi: citedUi.slice(0, 400) };
  });

  await run('settings-audit-secret-redaction', ['scheduler preview/apply uses confirmation', 'audit values are redacted', 'connector secret absent from DOM and responses'], async () => {
    const settings = await browserApi<{ etag: string; settings: Record<string, unknown> }>('/api/settings');
    const desired = !settings.body.settings['scheduler.enabled'];
    const preview = await browserApi<{ etag: string; confirm?: string }>('/api/settings/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'scheduler.enabled', value: desired, etag: settings.body.etag }) });
    assert.equal(preview.status, 200);
    const applied = await browserApi('/api/settings/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'scheduler.enabled', value: desired, etag: settings.body.etag, confirm: preview.body.confirm }) }); assert.equal(applied.status, 200);
    const audit = await browserApi<unknown[]>('/api/audit');
    const connector = await browserApi('/api/connectors/openai/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: secret }) });
    const allText = await cdp!.evaluate<string>('document.body.innerText');
    const responses = network.filter(item => item.url.startsWith(origin + '/api/'));
    assert.equal(allText.includes(secret), false); assert.equal(JSON.stringify(responses).includes(secret), false); assert.equal([...responseBodies.values()].join('\n').includes(secret), false);
    return { settingPreviewStatus: preview.status, settingApplyStatus: applied.status, auditStatus: audit.status, connectorStatus: connector.status, auditRows: audit.body.length, secretInDom: allText.includes(secret), secretInNetworkMetadata: JSON.stringify(responses).includes(secret), secretInNetworkBodies: [...responseBodies.values()].join('\n').includes(secret) };
  });

  await run('mobile-overflow-and-keyboard-focus', ['every screen route has no horizontal overflow at 390x844', 'Tab reaches main actions', 'focus-visible ring is present'], async () => {
    await cdp!.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const routes = ['overview', 'knowledge', 'chat', 'workspaces', 'wiki-review', 'storage', 'jobs', 'dream', 'capture', 'connections', 'client-settings', 'settings', 'audit'];
    const overflows: string[] = [];
    for (const route of routes) {
      await cdp!.evaluate(`location.hash=${JSON.stringify(`#${route}`)}`); await new Promise(resolve => setTimeout(resolve, 100));
      const dimensions = await cdp!.evaluate<{ scroll: number; client: number }>('({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})');
      if (dimensions.scroll > dimensions.client) overflows.push(`${route}:${dimensions.scroll}>${dimensions.client}`);
    }
    assert.deepEqual(overflows, [], 'mobile screen routes do not overflow horizontally');
    await cdp!.evaluate("location.hash='#overview';document.activeElement.blur()");
    for (let i = 0; i < 12; i++) await cdp!.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    const focus = await cdp!.evaluate<{ tag: string; label: string; outline: string }>(`(()=>{const e=document.activeElement,s=getComputedStyle(e);return {tag:e.tagName,label:e.getAttribute('aria-label')||e.innerText||e.getAttribute('title')||'',outline:s.outlineStyle+' '+s.outlineWidth}})()`);
    assert.match(focus.outline, /solid 3px|solid 0.1875rem/);
    return { viewport: '390x844', routesChecked: routes, horizontalOverflowRoutes: overflows, focusedElement: focus, focusVisibleRing: focus.outline };
  });

  assert.equal(flows.length, 9, 'all browser flow groups were executed');
  await writeReport();
  for (const [index, flow] of flows.filter(item => item.status === 'FAIL').entries()) t.todo(`FINDING-${String(index + 1).padStart(2, '0')}: ${flow.id} — ${flow.error?.split('\n')[0] ?? 'browser assertion failed'}`);
  assert.equal(dashboard?.exitCode, null, `dashboard stayed alive${stderr}`);
});
