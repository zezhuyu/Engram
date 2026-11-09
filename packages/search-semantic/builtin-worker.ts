import { createInterface } from 'node:readline';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-node';
import { BGE_M3 } from './builtin-model.js';

const modelPath = process.argv[2];
if (!modelPath) { process.stderr.write('Model cache path is required\n'); process.exit(2); }
const cachePath = modelPath!;
let session: ort.InferenceSession;
let tokenizer: Tokenizer;
let padId = 1;
const idleMs = Number(process.env.ENGRAM_EMBED_IDLE_MS || 120_000);
let idle: NodeJS.Timeout;
function resetIdle() { clearTimeout(idle); idle = setTimeout(() => { void session?.release(); process.exit(0); }, idleMs); idle.unref(); }
async function initialize() {
  const { readFile } = await import('node:fs/promises');
  const tokenizerConfig = JSON.parse(await readFile(path.join(cachePath, 'tokenizer_config.json'), 'utf8')) as { pad_token_id?: number };
  padId = tokenizerConfig.pad_token_id ?? 1;
  const config = JSON.parse(await readFile(path.join(cachePath, 'tokenizer.json'), 'utf8'));
  tokenizer = new Tokenizer(config, tokenizerConfig);
  session = await ort.InferenceSession.create(path.join(cachePath, 'onnx/model_int8.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 4 });
}
async function embed(texts: string[], maxTokens: number): Promise<number[][]> {
  const encoded = texts.map(text => tokenizer.encode(text).ids.slice(0, maxTokens));
  const width = Math.max(1, ...encoded.map(row => row.length));
  const ids = new BigInt64Array(encoded.length * width), mask = new BigInt64Array(encoded.length * width);
  for (let row = 0; row < encoded.length; row++) for (let col = 0; col < width; col++) { const valid = col < encoded[row]!.length; ids[row * width + col] = BigInt(valid ? encoded[row]![col]! : padId); mask[row * width + col] = valid ? 1n : 0n; }
  const output = (await session.run({ input_ids: new ort.Tensor('int64', ids, [encoded.length, width]), attention_mask: new ort.Tensor('int64', mask, [encoded.length, width]) })).last_hidden_state!;
  const vectors: number[][] = [];
  for (let row = 0; row < encoded.length; row++) { const v = new Array<number>(BGE_M3.dimensions); let norm = 0; const offset = row * width * BGE_M3.dimensions; for (let d = 0; d < v.length; d++) { v[d] = output.data[offset + d] as number; norm += v[d]! * v[d]!; } norm = Math.sqrt(norm); if (!norm) throw new Error('Model returned a zero vector'); vectors.push(v.map(x => x / norm)); }
  return vectors;
}
try { await initialize(); process.stdout.write(JSON.stringify({ ready: true, dimensions: BGE_M3.dimensions }) + '\n'); } catch (error) { process.stdout.write(JSON.stringify({ ready: false, error: (error as Error).message }) + '\n'); process.exit(1); }
const input = createInterface({ input: process.stdin }); resetIdle();
input.on('line', line => { resetIdle(); void (async () => { try { const request = JSON.parse(line) as { id?: number; texts?: string[]; maxTokens?: number; shutdown?: boolean }; if (request.shutdown) { clearTimeout(idle); input.close(); await session.release(); process.exit(0); } if (request.id === undefined || !Array.isArray(request.texts)) throw new Error('Invalid worker request'); process.stdout.write(JSON.stringify({ id: request.id, vectors: await embed(request.texts, request.maxTokens ?? 512) }) + '\n'); } catch (error) { process.stdout.write(JSON.stringify({ error: (error as Error).message }) + '\n'); } })(); });
