# ADR 0002: Use TypeScript, YAML and optional native SQLite

Accepted: Node >=22.13, TypeScript ESM, one runtime dependency (`yaml`) and the Node test runner. Prefer Node 24 LTS for local use. Node's dynamically imported `node:sqlite` supplies optional FTS5 without a mandatory third-party native addon. Pure-file operations do not import SQLite.

YAML avoids inventing an unsafe/incomplete frontmatter parser. TypeScript is a build dependency; published runtime files are JavaScript. No external agent SDK, ripgrep executable, vector database or hosted model is mandatory. Unsupported SQLite, missing/stale indexes and absent providers must report their limitation and retain deterministic operation. SQLite native APIs can be experimental in older supported Node releases.
