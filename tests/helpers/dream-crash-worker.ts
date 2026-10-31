import { Vault } from '../../packages/core/vault.js';
import { IntelligenceEngine } from '../../packages/intelligence/index.js';
import { dreamer } from '../dream/helpers.js';

const root = process.argv[2];
if (!root) throw new Error('Expected a disposable vault root');
const provider = dreamer({ override: proposal => {
  // The parent test verifies that the durable seed lease is recoverable after
  // a process is terminated between claiming a cluster and saving its result.
  process.kill(process.pid, 'SIGKILL');
  return proposal;
} });
const engine = new IntelligenceEngine(new Vault(root), provider);
await engine.enqueue('dream', { mode: 'micro', instruction: 'test-owned abrupt interruption' });
await engine.run({ job: 'dream', limit: 1 });
throw new Error('Crash injection did not terminate the child');
