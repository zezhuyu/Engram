import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
  assert.match(assets['/assets/app.js']!.body, /location\.hash/);
  assert.match(assets['/assets/app.js']!.body, /history\.replaceState/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /sessionStorage|localStorage/);
  assert.match(assets['/assets/app.js']!.body, /Welcome back/);
  assert.doesNotMatch(assets['/assets/app.js']!.body, /Sign-in link needed/);
  assert.match(assets['/assets/app.js']!.body, /Sign-in temporarily locked/);
  assert.match(assets['/assets/app.js']!.body, /token changes on every restart/i);
  assert.match(assets['/assets/app.js']!.body, /Your session ended. Enter your dashboard password to continue/);
  assert.match(assets['/assets/app.js']!.body, /password-strength/);
  assert.match(assets['/assets/app.js']!.body, /password-reveal/);
  assert.match(assets['/assets/app.js']!.body, /file-chip/);
  assert.match(assets['/assets/app.js']!.body, /Add as source/);
  assert.match(assets['/assets/app.js']!.body, /knowledge-filters/);
  assert.match(assets['/assets/app.js']!.body, /workspace-create-row/);
  assert.match(assets['/assets/app.js']!.body, /Scheduler cycles/);
  assert.match(assets['/assets/app.js']!.body, /connector-steps/);
  assert.match(assets['/assets/app.js']!.body, /Set/);
  assert.match(assets['/assets/app.js']!.body, /clear-secret/);
  assert.match(assets['/assets/app.js']!.body, /X-Engram-Dashboard/);
  assert.match(assets['/assets/app.js']!.body, /autocomplete='current-password'/);
  assert.match(assets['/assets/app.js']!.body, /autocomplete='new-password'/);
  assert.match(assets['/assets/app.js']!.body, /OpenAI \/ ChatGPT \(Secure MCP Tunnel\)/);
  assert.match(assets['/assets/app.js']!.body, /claude mcp add --transport http engram/);
  assert.match(assets['/assets/app.js']!.body, /Allow private address \(unsafe\)/);
  assert.match(assets['/assets/app.js']!.body, /Remote dashboard credentials/);
  assert.match(assets['/assets/app.js']!.body, /No credentials yet/);
  assert.match(assets['/assets/app.js']!.body, /Access level/);
  assert.ok(assets['/assets/app.js']!.body.includes('Remote administration: '));
  assert.ok(assets['/assets/app.js']!.body.includes('aria-haspopup'));
  assert.doesNotMatch(assets['/assets/app.js']!.body, /const composer=panel\('Message'\)/);
  assert.ok(assets['/assets/app.css']!.body.includes('.file-chip[hidden]{display:none!important}'));
  assert.ok(assets['/assets/app.css']!.body.includes('.chat-composer.is-dragging .chat-drop-hint{display:block}'));
  assert.ok(assets['/assets/app.css']!.body.includes('input[type=date],select{appearance:none'));
  assert.ok(assets['/assets/app.css']!.body.includes('.credentials-form,.proposal-fields{display:grid;grid-template-columns:repeat(2'));
  assert.ok(assets['/assets/app.css']!.body.includes('.chat-model input[type=checkbox]::before'));
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
  assert.match(script, /case'settings':if\(!settings\)\{try\{await loadSettings\(\)\}catch\(error\)\{view=settingsError\(error\);break\}\}view=settingsPage\(\);break;/);
  assert.match(script, /Effective settings could not be loaded:/);
  assert.match(script, /node\('button','primary','Retry'\)/);
  assert.match(script, /await loadSettings\(\);render\(\)/);
});

test('served dashboard script completes its first refresh and renders every screen', async () => {
  class Element {
    children: Element[] = [];
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
    focus() {}
    appendChild(item: Element) { this.append(item); return item; }
    querySelectorAll(_selector: string) { return []; }
    get childElementCount() { return this.children.length; }
    get firstChild(): Element | null { return this.children[0] ?? null; }
    get innerText(): string { return this.textContent + this.children.map(item => item.innerText).join(''); }
  }
  const screens = ['overview','storage','jobs','dream','capture','connections','client-settings','settings','audit','knowledge','chat','workspaces','wiki-review','settings-error'];
  for (const screen of screens) {
    const elements = new Map<string, Element>();
    const document = {
      hidden: false,
      querySelector(selector: string) { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector)!; },
      createElement(_tag: string) { return new Element(); },
      createElementNS(_namespace: string, _tag: string) { return new Element(); },
      addEventListener() {},
    };
    const response = (body: any, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
    const fetch = async (path: string) => {
      if (path === '/api/auth/status') return response({ passwordSet: true });
      if (path === '/api/status') return response({ generatedAt: new Date().toISOString(), doctor:{state:'ok',checks:[]}, index:{available:true,journalSequence:1,manifest:{entries:0}}, jobs:{}, scheduler:{}, capture:{}, storage:{}, dream:{}, wiki:{}, proposals:{} });
      if (path === '/api/connectors') return response({connectors:{openai:Object.fromEntries(['publicUrl','tunnelName','tunnelId','tunnelToken','oauthClientId','oauthClientSecret'].map(key=>[key,{set:false,value:null}])),claude:Object.fromEntries(['publicUrl','tunnelName','tunnelId','tunnelToken','oauthClientId','oauthClientSecret'].map(key=>[key,{set:false,value:null}]))},credentials:[],authMode:'scoped MCP credentials'});
      if (path === '/api/settings') return response({ etag:'test', settings:{}, security:{passwordSet:true}, server:{host:'127.0.0.1',port:1} }, screen === 'settings-error' ? 500 : 200);
      if (path === '/api/url-notes/settings') return response({ enabled:false, readiness:{claude:{found:false},codex:{found:false}} });
      if (path === '/api/chat/capabilities') return response({ available:false, reason:'Unavailable' });
      if (path.startsWith('/api/documents')) return response({ items:[], cursor:null });
      if (path === '/api/proposals' || path === '/api/audit' || path === '/api/workspaces') return response([]);
      return response({});
    };
    const sandbox: any = { document, fetch, location:{hash:'#'+(screen==='settings-error'?'settings':screen),pathname:'/',search:''}, history:{replaceState(){}}, URLSearchParams, URL, Intl, Date, Map, Set, Event: class {}, console, setTimeout: () => 1, clearTimeout() {}, window:{addEventListener(){},confirm:()=>true}, confirm:()=>true, prompt:()=>null, crypto:{randomUUID:()=> 'test-id'} };
    new vm.Script(assets['/assets/app.js']!.body).runInNewContext(sandbox);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const rendered = document.querySelector('#content').innerText;
    assert.notEqual(rendered, 'Waiting for first refresh', `${screen} should refresh`);
    assert.doesNotMatch(rendered, /Loading effective settings…/, `${screen} should not remain in a loading state`);
    if (screen === 'settings-error') assert.match(rendered, /Effective settings could not be loaded/);
    assert.equal(document.querySelector('#updated').textContent.startsWith('Updated '), true, `${screen} should show refresh completion`);
  }
});
