// Purpose-built indexed SQLite comparator (independent of Engram's own index): one database with a documents table, a tag table and an FTS5 trigram index over title+body.
// Trigram MATCH of a quoted phrase is a case-insensitive SUBSTRING test (>=3 characters), the same match rule as Engram's grep/keyword terms. Build time and size are reported.
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadCorpus } from './lib.mjs';

const corpus = process.argv[2], dbPath = process.argv[3]; if (!corpus || !dbPath) throw new Error('usage: build-sqlite.mjs CORPUS DBFILE');
await fs.rm(dbPath, { force: true }); await fs.rm(dbPath + '-wal', { force: true }); await fs.rm(dbPath + '-shm', { force: true });
const t0 = performance.now(); const docs = await loadCorpus(corpus); const tParse = performance.now() - t0;
const db = new DatabaseSync(dbPath); db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
 CREATE TABLE docs(rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, kind TEXT, status TEXT, workspace TEXT, scope TEXT, title TEXT, body TEXT);
 CREATE TABLE tags(doc INTEGER NOT NULL, tag TEXT NOT NULL);
 CREATE VIRTUAL TABLE fts USING fts5(text, tokenize='trigram', content='', contentless_delete=0, detail=full);`);
const t1 = performance.now(); db.exec('BEGIN');
const ins = db.prepare('INSERT INTO docs(rowid,id,kind,status,workspace,scope,title,body) VALUES(?,?,?,?,?,?,?,?)'), insFts = db.prepare('INSERT INTO fts(rowid,text) VALUES(?,?)'), insTag = db.prepare('INSERT INTO tags VALUES(?,?)');
docs.forEach((d, i) => { const rid = i + 1; ins.run(rid, d.id, d.kind, d.status, d.workspaceId ?? '', d.scope, d.title, d.body); insFts.run(rid, `${d.title}\n${d.body}`); for (const t of d.tags) insTag.run(rid, t); });
db.exec('COMMIT'); const tLoad = performance.now() - t1;
const t2 = performance.now(); db.exec('CREATE UNIQUE INDEX docs_id ON docs(id); CREATE INDEX tags_tag ON tags(tag, doc); CREATE INDEX docs_kind_ws ON docs(kind, workspace); ANALYZE; PRAGMA optimize;'); const tIndex = performance.now() - t2;
db.close(); const st = await fs.stat(dbPath);
const report = { documents: docs.length, parseMs: Math.round(tParse), insertAndFtsBuildMs: Math.round(tLoad), secondaryIndexMs: Math.round(tIndex), totalBuildMs: Math.round(tParse + tLoad + tIndex), dbBytes: st.size, sqlite: new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v, note: 'parseMs is reading the Markdown corpus; an index builder pays it once' };
await fs.writeFile(dbPath + '.build.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
