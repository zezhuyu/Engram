import type { Document, ModelProposal, ModelProvider, ModelRequest } from '../../packages/sdk/index.js';

export const modeOf = (req: ModelRequest): string => /MODE:(micro|deep|strategic)/.exec(req.instruction)?.[1] ?? 'micro';
export interface Hint { kind: string; why: string; via: string; distance: string; objects: string[] }
export function hintsOf(req: ModelRequest): Hint[] { try { return JSON.parse(/Search hints \(deterministic, may be ignored\): (\[.*\])\n/.exec(req.instruction)![1]!) as Hint[]; } catch { return []; } }
const span = (d: Document) => d.body.replace(/\s+/g, ' ').slice(0, 40).trim();
const domainTag = (d: Document) => d.tags.find(t => t.startsWith('domain:'))?.slice(7) ?? d.tags[0] ?? d.kind;
export interface DreamerOptions { override?: (out: ModelProposal, req: ModelRequest) => ModelProposal | Promise<ModelProposal>; throws?: (req: ModelRequest) => Error | undefined; title?: (docs: Document[], mode: string) => string }
/**
 * A deterministic stand-in for a model that follows the dream prompt: it reads the retrieval hints, writes a hedged connection between objects of different
 * domains, and fills in the schema that matches the mode. Tests bend it (override) to produce bad output.
 */
export function dreamer(options: DreamerOptions = {}): ModelProvider & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return { id: 'fake-dreamer', calls, async generate(req) {
    calls.push(req); const err = options.throws?.(req); if (err) throw err;
    const mode = modeOf(req); const hint = hintsOf(req)[0]; const goal = req.documents.find(d => d.kind === 'user_insight');
    const knowledge = req.documents.filter(d => d.kind !== 'user_insight'); const byDomain: Document[] = []; for (const d of knowledge) if (!byDomain.some(x => domainTag(x) === domainTag(d))) byDomain.push(d);
    const picked = (byDomain.length >= 2 ? byDomain : knowledge).slice(0, 3); const [a, b] = picked;
    const why = hint?.why ?? 'they share vocabulary';
    const title = options.title?.(picked, mode) ?? `${mode}: ${a!.title} with ${b!.title}`;
    const out: ModelProposal = {
      kind: 'discovery', title, status: 'hypothesis',
      body: `Hypothesis: ${a!.title} from ${domainTag(a!)} and ${b!.title} from ${domainTag(b!)} may combine, because ${why}. Building a small prototype would show whether the combination holds.`,
      evidence: [...(goal && mode === 'strategic' ? [{ uri: goal.uri, revisionId: goal.revisionId }] : []), ...picked.map(d => ({ uri: d.uri, revisionId: d.revisionId, span: span(d) }))],
      metadata: {
        subtype: hint?.kind ?? 'composition', novelty: 'new_to_user', reasoningSummary: `Connection suggested by search: ${why}.`,
        limitations: ['Only the written descriptions were compared; nothing was run.'], proposedValidation: `Build the smallest possible prototype combining ${a!.title} and ${b!.title} and record whether it works.`,
        testPlan: [`Write one example for ${a!.title}`, `Feed it into ${b!.title} and compare the result`], counterarguments: ['The link may be superficial vocabulary overlap rather than a real mechanism.'],
        ...(mode === 'deep' ? { mechanism: `They connect through ${hint?.via ?? 'a shared concept'} even though they sit in different domains.`, distance: hint?.distance === 'distant' ? 'distant' : 'complementary' } : {}),
        ...(mode === 'strategic' && goal ? { goalRefs: [goal.uri], prerequisites: ['A working data source', 'A place to host the result'] } : {})
      }
    };
    return options.override ? options.override(out, req) : out;
  } };
}
