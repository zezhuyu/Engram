import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

test('Engram tunnel review profile isolates control-plane credentials and targets private HTTP only', () => {
  const text = readFileSync('deploy/engram-beta.tunnel.yaml.example', 'utf8');
  const profile = YAML.parse(text);
  assert.equal(profile.config_version, 1);
  assert.equal(profile.control_plane.base_url, 'https://api.openai.com');
  assert.equal(profile.control_plane.tunnel_id, '${ENGRAM_TUNNEL_ID}');
  assert.equal(profile.control_plane.api_key, 'env:ENGRAM_TUNNEL_RUNTIME_KEY');
  assert.equal(profile.health.listen_addr, '127.0.0.1:0');
  assert.equal(profile.admin_ui.open_browser, false);
  assert.deepEqual(profile.mcp, { server_urls: [{ channel: 'main', url: 'http://127.0.0.1:3335/mcp' }] });
  assert.doesNotMatch(text, /agent-slack|8899|extra_headers|client_key|sk-/);
});
