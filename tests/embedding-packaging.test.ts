import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

test('standalone runtime has the dedicated embedding child entry and pinned dependencies, without bundled model weights', async () => {
  const root = process.cwd();
  await access(path.join(root, 'dist/packages/search-semantic/builtin-worker.js'));
  await access(path.join(root, 'dist/packages/search-semantic/bge-m3-manifest.json'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(pkg.dependencies['onnxruntime-node'], '1.30.0'); assert.equal(pkg.dependencies['@huggingface/tokenizers'], '0.2.0');
  await assert.rejects(access(path.join(root, 'dist/packages/search-semantic/onnx/model_int8.onnx')));
});
