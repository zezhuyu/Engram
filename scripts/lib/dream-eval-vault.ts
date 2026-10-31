import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Vault } from '../../packages/core/vault.js';

/** Apply the same explicit opt-in to scenario and negative-control evaluation vaults. */
export async function configureDreamEvalVault(vault: Vault, root: string): Promise<void> {
  const config = await vault.config();
  config.dream.enabled = true;
  config.dream.eventDriven = false;
  config.dream.modes = ['micro', 'deep', 'strategic'];
  config.dream.maxProposalsPerRun = 2;
  config.model.critic = true;
  config.model.allowPrivateContentToRemote = true;
  await fs.writeFile(path.join(root, 'mdb.yaml'), YAML.stringify(config));
}
