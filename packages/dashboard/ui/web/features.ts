/** Styles of the feature areas carried over from the previous stylesheet (chat, document editor, source menu, file chips, citations, URL notes, knowledge filters, workspace form). They use the aliased tokens of design.ts. */
export const featureCss = String.raw`
.card-detail{font-size:12px;color:var(--muted);margin-top:3px}
.detail-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.connector-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.connector-card{min-height:0}
.connector-card label{display:grid;gap:5px;margin:12px 0}
.connector-card pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--raised);border:1px solid var(--line);border-radius:8px;padding:12px;font-size:12px}
.connector-note{color:var(--muted);font-size:13px}
.connector-card h3{font-size:14px;margin:18px 0 4px}
@media(max-width:850px){.connector-grid{grid-template-columns:1fr}}
.chat-feed{display:grid;gap:10px;max-height:48vh;overflow:auto;margin-bottom:8px}
.chat-pending{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.chat-dots{display:inline-flex;gap:4px}
.chat-dots i{width:7px;height:7px;border-radius:50%;background:var(--accent);animation:chatdot 1.2s infinite ease-in-out}
.chat-dots i:nth-child(2){animation-delay:.15s}
.chat-dots i:nth-child(3){animation-delay:.3s}
@keyframes chatdot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
.chat-pending-label{color:var(--muted)}
.chat-stop{margin-left:auto}
.chat-send.is-busy{opacity:.6;cursor:progress}
@media (prefers-reduced-motion:reduce){.chat-dots i{animation:none;opacity:.7}}
.chat-turn{padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--raised);overflow-wrap:anywhere}
.chat-turn.user{border-color:color-mix(in srgb,var(--accent) 45%,var(--line))}
.chat-turn.system{border-style:dashed}
.chat-turn p{white-space:pre-wrap;margin:5px 0}
.citation-chip{margin:4px 5px 0 0;font-size:12px;overflow-wrap:anywhere}
.chat-feed:empty:after{content:"Ask a question to search authorized knowledge.";color:var(--muted);padding:12px}
.chat-turn button{max-width:100%}
.chat-turn button{display:inline-block}
@keyframes shimmer{to{background-position:-200% 0}}
@media(max-width:720px){.detail-grid{grid-template-columns:1fr}}
.cards,.detail-grid,.connector-grid{gap:var(--s4)}
.connector-grid{gap:var(--s5)}
.connector-card{padding:var(--s5)}
.connector-card label,.setting-row{margin-block:var(--s3)}
.chat-feed{max-height:min(54vh,540px);padding:6px 2px 12px}
.chat-turn{max-width:88%;border-radius:14px;background:var(--raised);padding:14px 16px;box-shadow:0 2px 8px #0918200b}
.chat-turn.user{justify-self:end;background:color-mix(in srgb,#6557c8 10%,var(--surface));border-color:color-mix(in srgb,#6557c8 30%,var(--line))}
.chat-turn.system{justify-self:center;max-width:100%;font-size:13px}
.chat-turn p{line-height:1.65}
.chat-feed:empty:after{content:"";display:block;min-height:160px;background:center/contain no-repeat url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='150' viewBox='0 0 240 150'%3E%3Crect x='62' y='20' width='116' height='78' rx='14' fill='%23eef0ff' stroke='%23715fd0' stroke-width='2'/%3E%3Cpath d='M87 47h66M87 61h50M87 75h37' stroke='%23715fd0' stroke-width='5' stroke-linecap='round'/%3E%3Cpath d='m120 99-14 18 30-14' fill='%23eef0ff' stroke='%23715fd0' stroke-width='2'/%3E%3C/svg%3E")}
.connector-note{padding:10px 12px;border-radius:8px;background:var(--raised)}
.editor-page{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--s5)}
.editor-page>.page-head{grid-column:1/-1}
.editor-preview{position:sticky;top:100px;align-self:start;max-height:calc(100vh - 120px);overflow:auto;background:var(--raised);border:1px solid var(--line);border-radius:var(--r2);padding:var(--s5)}
.editor-preview pre{white-space:pre-wrap;overflow-wrap:anywhere}
.url-note-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--s3);align-items:center;margin-top:var(--s3)}
.url-note-controls input{min-width:0}
@media(prefers-color-scheme:dark){.chat-turn.user{background:#6759ba30;border-color:#7566d36b}}
@media(max-width:720px){.chat-feed{max-height:55vh}.chat-turn{max-width:96%}.editor-page{grid-template-columns:1fr}.editor-preview{position:static;max-height:none}.url-note-controls{grid-template-columns:minmax(0,1fr)}}
#content>div.chat-page>.panel:last-child{position:sticky;bottom:12px;z-index:2;box-shadow:var(--shadow-pop)}
.attach-picker.is-dragging{border-style:solid;border-color:#695bd2;background:color-mix(in srgb,#695bd2 10%,var(--surface))}
.connector-card .secret-row{align-items:center}
.connector-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}
.connector-steps{display:flex;list-style:none;gap:8px;margin:0 0 14px;padding:0}
.connector-steps li{flex:1;padding:7px 9px;border-radius:8px;background:var(--raised);color:var(--muted);font-size:12px;font-weight:650}
.set-chip{flex:0 0 auto;padding:4px 7px;border-radius:999px;background:var(--raised);border:1px solid var(--line);font-size:11px;color:var(--muted)}
.connector-card .secret-row button{min-height:36px}
.connector-card label{line-height:1.4}
.chat-feed+*{margin-top:var(--s3)}
.chat-feed:empty:after{color:var(--muted)}
@media(max-width:720px){#content>div.chat-page>.panel:last-child{bottom:76px}.chat-feed{max-height:50vh}.chat-turn{max-width:100%}}
.chat-page{height:calc(100vh - 210px);min-height:520px;display:flex;flex-direction:column;gap:16px}
.chat-conversation{flex:1 1 auto;min-height:240px;display:flex;flex-direction:column}
.chat-feed{flex:1;min-height:200px;max-height:none;overflow:auto;display:flex;flex-direction:column;gap:12px}
.chat-turn{align-self:flex-start;border:1px solid var(--line);max-width:min(78%,760px)}
.chat-turn.user{align-self:flex-end}
.chat-turn.system{align-self:center}
.chat-text{overflow-wrap:anywhere}
.chat-composer{position:relative;bottom:auto;z-index:2;flex:0 0 auto;display:grid;gap:10px;margin-top:auto;background:var(--surface)}
.chat-composer input[type=file][hidden]{display:none!important}
.chat-toolbar{display:flex;align-items:center;gap:10px}
.chat-toolbar textarea{flex:1 1 auto;min-width:180px;min-height:44px;max-height:120px;resize:vertical;margin:0!important}
.chat-attach{background:var(--raised);border:1px solid var(--line);color:var(--ink)}
.chat-send{background:var(--accent);color:white}
.chat-model{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-size:13px}
.chat-model-note{display:none}
.source-menu{height:40px;max-width:170px;padding:0 9px!important;font-size:12px}
.chat-drop-hint{font-size:12px;color:var(--muted);padding:5px 0}
.chat-composer.is-dragging{outline:2px dashed var(--accent);outline-offset:3px}
.file-chip{display:inline-flex;align-items:center;gap:8px;max-width:100%;width:max-content;padding:5px 8px 5px 11px;border:1px solid var(--line);border-radius:999px;background:var(--raised);font-size:12px}
.file-chip span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(70vw,460px)}
.file-remove{width:24px;height:24px;min-height:24px;flex-basis:24px;background:transparent;border:0;font-size:17px}
.knowledge-filters{display:grid;grid-template-columns:minmax(220px,2.2fr) repeat(3,minmax(110px,1fr)) auto auto;gap:12px;align-items:end}
.filter-field{display:grid;gap:5px;min-width:0;font-size:12px;color:var(--muted);font-weight:600}
.filter-field input{width:100%;height:40px;min-height:40px!important}
.knowledge-filters .toolbar-check{display:flex;align-items:center;gap:8px;white-space:nowrap;height:40px;color:var(--ink);font-size:13px}
.knowledge-filters .switch{grid-column:1/-1;justify-self:start;white-space:normal;height:auto;min-height:44px}
.knowledge-filters>button{height:40px;min-width:88px}
.workspace-create-row{display:grid;grid-template-columns:minmax(150px,.8fr) minmax(240px,1.8fr) auto;gap:12px;align-items:end}
.workspace-field{display:grid;gap:5px;min-width:0;font-size:13px;color:var(--muted);font-weight:600}
.workspace-field input{height:40px;min-height:40px!important;width:100%}
.workspace-create-row button{height:40px}
.workspace-field input[aria-invalid=true]{border-color:var(--bad)!important;box-shadow:0 0 0 2px color-mix(in srgb,var(--bad) 15%,transparent)}
.jobs-section{display:grid;gap:10px}
.jobs-section h2{font-size:16px;margin:0}
.jobs-section .table-wrap{margin:0}
.jobs-section .data-table{width:100%}
.jobs-section .empty{padding:18px}
@media(max-width:1099px){.knowledge-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.knowledge-filters .filter-field:first-child{grid-column:1/-1}.knowledge-filters .toolbar-check{justify-content:flex-start}.knowledge-filters>button{width:100%}}
@media(max-width:720px){.chat-page{height:calc(100vh - 330px);min-height:440px}.chat-toolbar{flex-wrap:wrap}.chat-toolbar textarea{flex:1 1 100%;order:0}.chat-attach{order:1}.chat-model{order:2;margin-right:auto}.source-menu{order:3;flex:1 1 135px;max-width:none}.chat-send{order:4}.chat-conversation{min-height:210px}.chat-feed{min-height:150px}.chat-turn{max-width:100%}.workspace-create-row{grid-template-columns:1fr}.workspace-create-row button{width:100%}.knowledge-filters{grid-template-columns:repeat(2,minmax(0,1fr));padding:16px}.knowledge-filters .filter-field{min-width:0}.knowledge-filters .filter-field input{min-width:0}.chat-composer{bottom:auto}.chat-drop-hint{padding:0}}
@media(prefers-reduced-motion:reduce){.chat-turn,.chat-composer *{scroll-behavior:auto!important;transition:none!important}}
#content>div.chat-page>.panel:last-child{position:relative;bottom:auto;z-index:2;box-shadow:var(--shadow-card)}
.chat-url-actions[hidden]{display:none!important}
.chat-page{min-height:0;height:calc(100dvh - 210px)}
.chat-conversation{min-height:0;overflow:hidden}
.chat-feed{min-height:0;overscroll-behavior:contain;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;padding:12px 8px 16px;scroll-behavior:auto}
.chat-turn{flex:0 0 auto}
.chat-empty{margin:auto;color:var(--muted);text-align:center;padding:24px}
.chat-text{white-space:pre-wrap;margin:6px 0 8px;line-height:1.65}
.citation-chip{display:inline-block;max-width:100%;white-space:normal}
.chat-conversation>h2{flex:0 0 auto}
@media(max-width:720px){.chat-page{height:calc(100dvh - 290px);min-height:0;gap:12px}.chat-page>.page-head{margin-bottom:4px}.chat-conversation{flex:1 1 150px;min-height:140px}.chat-composer{padding:12px}.chat-drop-hint{display:none}.chat-feed{flex:1 1 0}.chat-composer{flex:0 0 auto}}
.help,.connector-note{font-size:13px!important;line-height:1.5;color:var(--muted);margin:0 0 14px}
.credentials-form,.proposal-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px;align-items:end}
.credentials-form .primary{width:max-content;min-width:164px;height:40px;min-height:40px;grid-column:2;grid-row:2}
.remote-credentials-form .primary{grid-column:2;grid-row:2}
.credential-heading{display:flex;align-items:center;justify-content:flex-end;margin:-4px 0 12px}
.section-subheading{font-size:15px;margin:24px 0 10px}
.credential-list{margin-top:24px}
.credential-list .section-subheading{margin:0 0 10px}
.credentials-form+.section-subheading{margin-top:24px}
.proposal-fields textarea{width:100%;min-height:96px;resize:vertical}
.proposal-fields .field{margin:0}
.credential-empty{min-height:88px;padding:20px;align-content:center;justify-items:start;text-align:left}
.credential-empty p{margin:0}
.chat-composer{position:relative;z-index:2;display:grid;gap:10px;margin-top:auto;padding:14px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.chat-composer[hidden],.file-chip[hidden]{display:none!important}
.chat-drop-hint{display:none;margin:0;padding:7px 9px;border-radius:7px;background:color-mix(in srgb,var(--accent) 10%,var(--surface));font-size:12px;color:var(--muted)}
.chat-composer.is-dragging{outline:2px solid var(--accent);outline-offset:1px}
.chat-composer.is-dragging .chat-drop-hint{display:block}
.chat-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:9px}
.chat-toolbar textarea{order:0;flex:0 0 100%;width:100%;height:auto;min-height:48px;max-height:180px;resize:none;overflow-y:auto;padding:10px 12px;border:0!important;box-shadow:none!important;background:transparent!important}
.chat-toolbar .chat-attach{order:1}
.chat-toolbar .chat-model{order:2;margin-right:auto}
.chat-toolbar .source-menu-wrap{order:3}
.chat-toolbar .chat-send{order:4}
.source-menu-wrap{position:relative}
.source-menu{width:auto;max-width:none;height:36px;min-height:36px;padding:6px 10px;border:0;border-radius:7px;background:transparent;color:var(--ink);font-size:13px}
.source-menu:hover{background:var(--raised)}
.source-options{display:none;position:absolute;right:0;bottom:calc(100% + 6px);z-index:4;min-width:174px;padding:5px;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:var(--shadow-pop)}
.source-menu-wrap.is-open .source-options{display:grid}
.source-options button{text-align:left;min-height:36px}
.chat-send{background:var(--accent);border:0}
.chat-empty{display:grid;justify-items:center;gap:8px;margin:auto;padding:10px;text-align:center}
.chat-empty-mark{display:grid;place-items:center;width:36px;height:36px;color:var(--muted)}
.chat-empty-mark svg{width:25px;height:25px;stroke:currentColor;stroke-width:1.5;fill:none;stroke-linecap:round;stroke-linejoin:round}
.chat-examples{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.chat-example{border:1px solid var(--line);border-radius:999px;padding:5px 9px;color:var(--muted);font-size:12px}
.chat-page{height:calc(100dvh - 178px);gap:14px}
.chat-conversation{flex:1 1 auto;min-height:180px}
.chat-conversation>h2{display:none}
.chat-feed{display:flex;flex:1;flex-direction:column;min-height:0}
.chat-url-actions[hidden]{display:none!important}
@media(min-width:900px){.credentials-form{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:899px){.credentials-form,.proposal-fields{grid-template-columns:1fr}.credentials-form .primary,.remote-credentials-form .primary{grid-column:1;grid-row:auto;width:max-content}.chat-page{height:calc(100dvh - 260px)}}
@media(max-width:720px){.chat-page{height:calc(100dvh - 290px);min-height:0}.chat-toolbar{flex-wrap:wrap}.chat-toolbar textarea{flex:1 1 100%;order:0}.chat-toolbar .chat-attach{order:1}.chat-toolbar .chat-model{order:2;margin-right:auto}.chat-toolbar .source-menu-wrap{order:3}.chat-toolbar .chat-send{order:4}.chat-conversation{min-height:140px}.credentials-form .primary{grid-column:1}.chat-drop-hint{padding:6px 8px}}
.chat-model-note{display:block;font-size:12px;max-width:100%;line-height:1.4}
.chat-model-note button{color:var(--accent);padding:0 3px}
.chat-meta{display:flex;align-items:center;justify-content:flex-end;gap:8px;color:var(--muted);font-size:11px}
.chat-meta time{font-variant-numeric:tabular-nums}
.chat-copy{min-height:24px!important;padding:2px 6px!important}
.chat-provider{display:block;color:var(--muted);font-size:11px;margin-top:6px}
.chat-model-hint{display:block;color:var(--muted);font-size:12px;margin-top:6px}
.setting-control:has(.switch){display:flex;align-items:center}
.setting-control:has(.switch) .switch{margin:0;padding:0}
.chat-toolbar .switch{order:2;margin-right:auto}
.chat-model-note{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 3px}
.chat-model-note .reason-text{color:var(--muted)}
.chat-model-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border:1px solid color-mix(in srgb,#6557c8 35%,var(--line));border-radius:999px;background:color-mix(in srgb,#6557c8 9%,var(--surface));font-size:11px;font-weight:650}
.chat-answer-mode{display:block;margin-top:5px;color:var(--muted);font-size:11px}
.chat-context-heading,.chat-context-source{display:block;color:var(--muted);font-size:11px}
.chat-context-heading{margin-top:6px;font-weight:650}
.chat-context-source{padding-left:8px}
.chat-toolbar{align-items:center}
.chat-model-note button{min-height:30px}
`;
