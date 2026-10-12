import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Import this FIRST in any test that runs `init`, a hook or user-level setup. Engram keeps per-user state (trusted projects, user config, context cache, remote spool) outside the
 * repository; without this a test would write it into the real home directory. Each test file runs in its own process, so each gets its own temp directory.
 */
const dir = mkdtempSync(path.join(os.tmpdir(), 'engram-user-state-'));
process.env.ENGRAM_TRUST_FILE ??= path.join(dir, 'trusted-projects.json');
process.env.ENGRAM_USER_CONFIG ??= path.join(dir, 'user.json');
process.env.ENGRAM_CACHE_DIR ??= path.join(dir, 'cache');
process.env.ENGRAM_REMOTE_SPOOL ??= path.join(dir, 'spool');
process.env.ENGRAM_CODEX_PROBE ??= '0'; // ordinary tests never start a real Codex; the Codex trust tests opt in explicitly
export const isolatedUserStateDir = dir;
