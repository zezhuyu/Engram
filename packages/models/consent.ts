import type { ModelConfig } from '../core/types.js';
import { isLoopbackHost } from './openai.js';

export function isRemoteProvider(config: Pick<ModelConfig, 'provider' | 'baseUrl' | 'locality'>, locality?: 'local' | 'remote'): boolean {
  // A host-supplied provider can be more remote than the built-in config
  // suggests (for example, a remote SDK provider attached to an Ollama config).
  // Its declared locality is trusted when it makes the provider more restrictive.
  if (locality === 'remote') return true;
  const provider = config.provider;
  if (provider === 'claude-cli' || provider === 'codex-cli' || provider === 'openai') return true;
  if (provider === 'auto') return locality !== 'local';
  if (provider === 'ollama' || provider === 'openai-compatible') {
    try { return !isLoopbackHost(new URL(config.baseUrl ?? (provider === 'ollama' ? 'http://127.0.0.1:11434' : '')).hostname); }
    catch { return true; }
  }
  if (locality === 'local') return false;
  return config.locality === 'remote';
}

export function modelConsent(config: ModelConfig, sendsPrivateContent = true, locality?: 'local' | 'remote'): { remote: boolean; consentGiven: boolean } {
  const remote = isRemoteProvider(config, locality);
  return { remote, consentGiven: !remote || (config.allowNetwork === true && (!sendsPrivateContent || config.allowPrivateContentToRemote === true)) };
}
