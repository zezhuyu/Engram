/**
 * Engram dashboard design system ("Framed sheet"): one tinted frame holds the sidebar and a slim top bar, the work sits on a white
 * sheet with a hairline edge and no shadow. Colour is for data, not chrome; one filled primary per screen; true neutral darks.
 * Shared by the server dashboard and the client dashboard. Contains no gradients, glows, glass or external resources.
 */
export const designCss = String.raw`
:root{
  color-scheme:light dark;
  --ground:#f9fbfc;--surface:#ffffff;--raised:#f4f6f8;--active:#ebedee;--border:#e8eaec;--rule:#f0f1f2;--control:#cdced1;
  --text:#131416;--muted:#5d5f60;--accent:#1b6c80;--accent-ink:#ffffff;--positive:#1e7b4f;--negative:#c4242a;--warning:#92400e;--info:#2f70bb;
  --primary-bg:#131416;--primary-ink:#ffffff;--primary-hover:#2a2c2f;
  --pill-positive-bg:#dcfae5;--pill-positive-ink:#04250e;--pill-negative-bg:#ffedea;--pill-negative-ink:#831c1e;
  --pill-warning-bg:#fffbeb;--pill-warning-ink:#92400e;--pill-neutral-bg:#ebedee;--pill-neutral-ink:#353736;--pill-info-bg:#e8f0fb;--pill-info-ink:#1b3f73;
  --radius-card:8px;--radius-control:6px;--radius-sheet:16px;--sheet-inset:8px;--sidebar-width:228px;--topbar-height:48px;
  --control-height:34px;--gap:24px;--pad:24px;--shadow-pop:0 10px 30px rgba(0,0,0,.14);
  --font:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  /* aliases kept for the feature families carried over from the previous stylesheet */
  --bg:var(--ground);--ink:var(--text);--line:var(--border);--ok:var(--positive);--bad:var(--negative);--warn:var(--warning);
  --ok-bg:var(--pill-positive-bg);--bad-bg:var(--pill-negative-bg);--warn-bg:var(--pill-warning-bg);--info-bg:var(--pill-info-bg);
  --shadow:var(--shadow-pop);--shadow-card:none;--radius:8px;--r1:6px;--r2:8px;--r3:16px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#0f1011;--surface:#151618;--raised:#1b1c1f;--active:#26282b;--border:#26282b;--rule:#1f2124;--control:#3a3d42;
  --text:#ececed;--muted:#a0a3a8;--accent:#62b9cd;--accent-ink:#0b1d22;--positive:#5fc994;--negative:#ff8c86;--warning:#e5a95e;--info:#8ab8f0;
  --primary-bg:#ececed;--primary-ink:#111214;--primary-hover:#ffffff;
  --pill-positive-bg:#14301f;--pill-positive-ink:#a8e8c3;--pill-negative-bg:#3a1a19;--pill-negative-ink:#ffb3ae;
  --pill-warning-bg:#35280f;--pill-warning-ink:#f1c98d;--pill-neutral-bg:#26282b;--pill-neutral-ink:#d0d2d5;--pill-info-bg:#17263a;--pill-info-ink:#b6d4f7;
  --shadow-pop:0 10px 30px rgba(0,0,0,.55);
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--text);font:400 14px/1.5 var(--font);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
h1,h2,h3,p,dl,dd,ul,ol,figure{margin:0}
ul,ol{padding-left:20px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd,.mono{font-family:var(--mono);font-size:12.5px}
pre{background:var(--raised);border:1px solid var(--border);border-radius:var(--radius-control);padding:10px 12px;overflow:auto;white-space:pre-wrap;word-break:break-word}
small,.muted,.help{color:var(--muted)}small,.help{font-size:12px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* ---- frame: sidebar + top bar on the tinted ground, the page is a white sheet ---- */
.app{display:grid;grid-template-columns:var(--sidebar-width) minmax(0,1fr);min-height:100vh;background:var(--ground)}
.rail{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:14px 12px 12px;min-height:0}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px;color:var(--text);font-weight:600;font-size:15px}
.brand:hover{text-decoration:none}
.brand img{width:26px;height:26px;border-radius:6px}
.scope{display:block;margin:2px 8px 14px 44px;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#nav{flex:1;min-height:0;display:flex;flex-direction:column}
.nav-scroll{flex:1;min-height:0;overflow:auto}
.nav-label{margin:18px 10px 4px;color:var(--muted);font-size:12px}
.nav-label:first-child{margin-top:4px}
.nav-link{display:flex;align-items:center;gap:10px;height:32px;margin:1px 0;padding:0 10px;border-radius:8px;color:var(--text);font-size:14px}
.nav-link:hover{background:var(--active);text-decoration:none}
.nav-link[aria-current=page]{background:var(--active);font-weight:500}
.nav-icon{display:inline-flex;width:16px;height:16px;color:var(--muted)}
.nav-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.nav-link[aria-current=page] .nav-icon{color:var(--text)}
.nav-foot{border-top:1px solid var(--border);margin-top:8px;padding-top:8px}
.column{display:flex;flex-direction:column;min-width:0}
.topbar{height:var(--topbar-height);flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 var(--pad) 0 0}
.crumb{font-size:14px;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.crumb strong{color:var(--text);font-weight:500}
.top-actions{display:flex;align-items:center;gap:12px;flex:none}
.updated{color:var(--muted);font-size:12px}
.menu-button{display:none}
.scrim{display:none}
.sheet{flex:1;min-width:0;margin:0 var(--sheet-inset) var(--sheet-inset) 0;padding:28px 32px 56px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-sheet)}
#content{max-width:1120px;margin:0 auto;outline:none}
#content>div>*+*,#content>*+*{margin-top:16px}

/* ---- page head, panels, KPI strip, metric lists, tables ---- */
.page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
.page-head h1{font-size:22px;line-height:1.25;font-weight:600;letter-spacing:-.01em}
.page-head p{margin-top:4px;color:var(--muted);max-width:68ch}
.page-head>button,.page-head>.action-row{flex:none}
.eyebrow{display:none}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-card);padding:16px 20px}
.panel>h2,.panel>header h2{font-size:16px;font-weight:600;margin-bottom:12px}
.panel>p{color:var(--muted)}.panel>h2+p{margin:-6px 0 12px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border);border-radius:var(--radius-card);overflow:hidden;background:var(--surface)}
.card{display:block;min-width:0;padding:16px 20px;color:var(--text);background:var(--surface);border-right:1px solid var(--border);border-bottom:1px solid var(--border);margin:0 -1px -1px 0}
a.card:hover{background:var(--raised);text-decoration:none}
.card-label{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px}
.card-value{margin-top:6px;font-size:26px;line-height:1.2;font-weight:400;letter-spacing:-.01em;overflow-wrap:anywhere}
.card-value.long{font-size:19px;line-height:1.3;padding-top:3px}
.card-detail{margin-top:4px;font-size:12px;color:var(--muted);overflow-wrap:anywhere}
.status-icon{display:inline-block;width:8px;height:8px;border-radius:50%;font-size:0;line-height:0;background:var(--muted);flex:none}
.status-icon.state-ok{background:var(--positive)}.status-icon.state-attention{background:var(--warning)}.status-icon.state-problem{background:var(--negative)}
.attention{border:1px solid var(--border);border-left:3px solid var(--warning);border-radius:var(--radius-card);padding:12px 16px;background:var(--surface)}
.attention h2{font-size:14px;font-weight:600}.attention ul{margin:6px 0 0;padding-left:18px}.attention li+li{margin-top:6px}.attention p{color:var(--muted)}
.metric-list{display:grid;grid-template-columns:minmax(140px,240px) minmax(0,1fr)}
.metric-list dt,.metric-list dd{padding:8px 0;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.metric-list dt{color:var(--muted)}.metric-list dd{margin:0;padding-left:16px}
.metric-list dt:nth-last-of-type(1),.metric-list dd:nth-last-of-type(1){border-bottom:0}
.table-wrap{overflow-x:auto;max-width:100%}
.panel,#content>*{min-width:0}
.help,small{overflow-wrap:anywhere}
small.help{display:block;margin-top:2px}
.panel .connector-card{padding:0;margin:12px 0 0;border:0;background:transparent;display:grid;gap:14px}
:not(.table-wrap)>.data-table{display:block;max-width:100%;overflow-x:auto}
.data-table{width:100%;border-collapse:collapse}
.data-table th{padding:8px 12px;text-align:left;font-size:12px;font-weight:500;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap}
.data-table td{padding:10px 12px;border-bottom:1px solid var(--rule);vertical-align:top;overflow-wrap:anywhere}
.data-table tbody tr:last-child td{border-bottom:0}
.data-table th:first-child,.data-table td:first-child{padding-left:0}
.data-table .num{text-align:right}
.data-table td button{height:auto;padding:0;border:0;background:none;justify-content:flex-start;font-weight:500;color:var(--text);text-align:left;white-space:normal}
.data-table td button:hover{background:none;text-decoration:underline}
.knowledge-filters button{width:auto;justify-self:start}
.empty,.empty-state{color:var(--muted)}
.empty-state{display:grid;justify-items:center;gap:6px;padding:28px 12px;text-align:center}
.empty-state svg{width:28px;height:28px;fill:none;stroke:var(--muted);stroke-width:1.4}
.empty-state div{display:none}
p.empty{padding:20px 0;text-align:center}
.skeleton{height:120px;border:1px solid var(--rule);border-radius:var(--radius-card);background:var(--raised)}
.action-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.detail-grid,.connector-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}

/* frame, sheet and card are the only nesting levels: a panel inside a panel becomes a plain section */
.panel .panel{border:0;padding:0;background:transparent;border-radius:0}
.panel .panel>h2{font-size:13px;font-weight:500;color:var(--muted);margin-bottom:6px}
.panel .detail-grid{gap:40px}
.panel>a{display:inline-block;margin-top:12px}

/* ---- controls ---- */
button{font:500 14px/1 var(--font);height:var(--control-height);padding:0 12px;border-radius:var(--radius-control);border:1px solid var(--control);background:var(--surface);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
button:hover{background:var(--raised)}
button.primary{background:var(--primary-bg);border-color:var(--primary-bg);color:var(--primary-ink)}
button.primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
button.secondary{background:var(--surface);border-color:var(--control);color:var(--text)}
button.ghost,.quiet-button{background:transparent;border-color:transparent;color:var(--muted);padding:0 8px}
button.ghost:hover,.quiet-button:hover{background:var(--active);color:var(--text)}
button.danger{color:var(--negative);border-color:var(--negative);background:transparent}
button.danger:hover{background:var(--pill-negative-bg)}
button:disabled,button[aria-disabled=true]{opacity:.5;cursor:not-allowed}
.icon-button{width:var(--control-height);padding:0}
.icon-button svg,.chat-attach svg,.chat-send svg,.chat-stop svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.is-busy{opacity:.7;pointer-events:none}
input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]),select,textarea{font:400 14px/1.4 var(--font);height:var(--control-height);width:100%;padding:0 10px;border:1px solid var(--control);border-radius:var(--radius-control);background:var(--surface);color:var(--text)}
textarea{height:auto;min-height:88px;padding:8px 10px;resize:vertical}
select{appearance:none;padding-right:30px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5 6 6.5 11 1.5' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
input::placeholder,textarea::placeholder{color:var(--muted);opacity:.8}
input:disabled,select:disabled,textarea:disabled{opacity:.6;cursor:not-allowed}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);width:16px;height:16px;margin:0}
label{display:grid;gap:6px;font-weight:500}
label>small,label>.help{font-weight:400}
.field-error,.auth-error{color:var(--negative);font-size:12px}
.risk{color:var(--warning)}
.pill,.badge,.status-badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:11px;font-size:12px;font-weight:500;background:var(--pill-neutral-bg);color:var(--pill-neutral-ink);white-space:nowrap}
.pill.state-ok,.status-badge.state-ok{background:var(--pill-positive-bg);color:var(--pill-positive-ink)}
.pill.state-attention,.status-badge.state-attention{background:var(--pill-warning-bg);color:var(--pill-warning-ink)}
.pill.state-problem,.status-badge.state-problem,.state-problem{color:var(--pill-negative-ink)}
.pill.state-problem,.status-badge.state-problem{background:var(--pill-negative-bg)}
.pill.state-unknown{background:var(--pill-neutral-bg);color:var(--pill-neutral-ink)}
.banner{margin:0 0 16px;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-card);background:var(--raised)}
#disconnect{border-color:var(--warning);color:var(--pill-warning-ink);background:var(--pill-warning-bg)}
.toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:60;max-width:min(560px,92vw);padding:10px 14px;border-radius:var(--radius-control);background:var(--primary-bg);color:var(--primary-ink);box-shadow:var(--shadow-pop)}
.toast:empty{display:none}
dialog{border:1px solid var(--border);border-radius:12px;padding:0;background:var(--surface);color:var(--text);box-shadow:var(--shadow-pop);width:min(560px,92vw)}
dialog::backdrop{background:rgba(0,0,0,.45)}
.dialog-card{position:relative;display:grid;gap:12px;padding:20px 22px}
.dialog-card h2{font-size:16px;font-weight:600}
.dialog-actions{display:flex;justify-content:flex-end;gap:8px}
.dialog-close{position:absolute;top:10px;right:10px;width:30px;height:30px;padding:0;border:0;background:transparent;color:var(--muted);font-size:18px}

/* ---- settings: label column + control, one view per area, quiet save bar ---- */
.setting-groups{display:grid;gap:16px}
.setting-group>p{color:var(--muted)}
.setting-row{display:grid;grid-template-columns:minmax(180px,1fr) minmax(220px,1.3fr) auto;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--rule)}
.setting-row:last-child{border-bottom:0}
.setting-name strong{display:block;font-weight:500}.setting-name small{display:block;margin-top:2px}
.setting-control{display:grid;gap:6px;min-width:0}
.setting-row .switch-label>span:first-child{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.setting-row .switch-label:empty{display:none}
.source{color:var(--muted);font-size:12px;white-space:nowrap}
.savebar{position:sticky;bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border:1px solid var(--control);border-radius:var(--radius-card);background:var(--surface);box-shadow:var(--shadow-pop)}
.switch{position:relative;display:inline-flex;align-items:center;gap:12px;min-height:34px;cursor:pointer;font-weight:500}
.switch>input{position:absolute;opacity:0;width:40px;height:24px;margin:0;cursor:pointer}
.switch .track{flex:none;width:34px;height:20px;border-radius:10px;background:var(--control);position:relative;transition:background .15s}
.switch .thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--surface);transition:transform .15s}
.switch>input:checked~.track{background:var(--positive)}
.switch>input:checked~.track .thumb{transform:translateX(14px)}
.switch>input:focus-visible~.track{outline:2px solid var(--accent);outline-offset:2px}
.switch>input:disabled~.track{opacity:.5}
.switch-label{display:grid;gap:2px}.switch-description{font-weight:400;color:var(--muted);font-size:12px}
.connector-card{display:grid;gap:12px}
.setting-groups>.page-head{display:none}
.setting-tabs{display:flex;gap:4px;margin:-4px 0 18px;border-bottom:1px solid var(--border);overflow-x:auto}
.setting-tabs a{padding:8px 12px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--muted);font-weight:500;white-space:nowrap}
.setting-tabs a:hover{color:var(--text);text-decoration:none}
.setting-tabs a[aria-current=page]{color:var(--text);border-bottom-color:var(--text)}

.all-clear{display:flex;align-items:center;gap:8px;margin:0;color:var(--muted)}
.check-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.check-list li{display:flex;align-items:center;gap:10px}
.check-list+.metric-list{margin-top:12px}
.danger-zone{border-color:color-mix(in srgb,var(--negative) 35%,var(--border))}
.danger-zone>h2{color:var(--negative)}

/* ---- sign-in ---- */
.login-page{min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--ground)}
.login-card{width:min(420px,100%);display:grid;gap:14px;padding:28px;background:var(--surface);border:1px solid var(--border);border-radius:12px}
.login-card h1{font-size:22px;font-weight:600}.login-card p{color:var(--muted)}
.auth-logo{width:36px;height:36px;border-radius:8px}
.auth-form{display:grid;gap:12px}
.password-field{position:relative;display:block}.password-field input{padding-right:40px}
.password-reveal{position:absolute;right:4px;top:3px;height:28px;width:30px;padding:0;border:0;background:transparent;color:var(--muted)}
.password-strength{color:var(--muted)}

/* ---- phone: the frame disappears, the sheet becomes the screen ---- */
@media (max-width:900px){
  .app{display:block}
  .rail{position:fixed;inset:0 auto 0 0;z-index:40;width:min(86vw,300px);height:100dvh;background:var(--ground);border-right:1px solid var(--border);transform:translateX(-102%);transition:transform .18s ease;padding-bottom:16px}
  body.nav-open .rail{transform:none}
  body.nav-open .scrim{display:block;position:fixed;inset:0;z-index:35;background:rgba(0,0,0,.4)}
  .topbar{position:sticky;top:0;z-index:20;background:var(--ground);padding:0 12px;gap:8px}
  .menu-button{display:inline-flex}
  .updated{display:none}
  .sheet{margin:0;padding:18px 16px 48px;border-radius:0;border-width:1px 0 0}
  .page-head{flex-direction:column;gap:10px}
  .detail-grid,.connector-grid{grid-template-columns:1fr}
  .setting-row{grid-template-columns:1fr;gap:8px}
  .metric-list{grid-template-columns:1fr}.metric-list dt{border-bottom:0;padding-bottom:0}.metric-list dd{padding-left:0}
  button,input:not([type=checkbox]):not([type=radio]),select{min-height:44px}
  .cards{grid-template-columns:repeat(2,minmax(0,1fr))}
}
@media (max-width:1180px) and (min-width:901px){.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:900px){.card{padding:12px 14px}.card-value{font-size:20px}.card-value.long{font-size:16px}.crumb-group{display:none}#pause{display:none}.top-actions{gap:8px}.page-head>button{align-self:flex-start}}
@media (max-width:340px){.cards{grid-template-columns:1fr}}
`;
