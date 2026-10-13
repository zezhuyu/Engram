import { Vault } from '../core/vault.js';
import { resolveRoot } from '../core/root.js';
import { MemoryRecall } from '../memory/recall.js';
import { capabilities as discoverCapabilities } from '../memory/capabilities.js';
import { OWNER, type EmbeddingProvider, type ActorContext, type ModelProvider, type ObjectStore, type PatchInput, type PutInput, type SearchInput } from '../core/types.js';
import { SearchEngine } from '../search-files/index.js';
import { QueryApi } from '../query/index.js';
import { AdaptiveIntelligence } from '../adaptive/index.js';
import { IntelligenceEngine } from '../intelligence/index.js';
import { listSkills, getSkill, runSkill } from '../skills/index.js';
export * from '../core/types.js';
export { QueryApi, QueryEngine, VaultCandidateSource, runLocal, normalize as normalizeQuery, type QueryAst, type QueryContext, type QueryResult, type QueryPlanSummary, type CandidateSource, type CandidateRequest } from '../query/index.js';
export { LifecycleAdapter, type CaptureOptions, type CaptureEvent } from '../../integrations/lifecycle.js';
export { Vault } from '../core/vault.js';
export { S3ObjectStore, createS3ObjectStoreFromEnv } from '../storage-s3/index.js';
export * from '../memory/index.js';
export { CATEGORIES as INSIGHT_CATEGORIES, evaluateInsight, correctInsight, projectProfile, commitInsight, isInsight, type InsightCategory, type InsightEval } from '../intelligence/insights.js';
export { rateDiscovery, resetLearning, learnedParams, readFeedbackLog, type RankingLabel, type FeedbackEvent, type LearnedParams } from '../intelligence/dream/learning.js';
export { recordFeedback, familyOf, staleDiscoveries, readStats, successRate, type DiscoveryOutcome } from '../intelligence/dream/lifecycle.js';
export { budgetsFor, planMicro, planDeep, planStrategic, domainOf, KNOWLEDGE_KINDS } from '../intelligence/dream/plan.js';
export type { DreamMode, Trace as DreamTrace } from '../intelligence/dream/types.js';
export { classifySource, SOURCE_PRIORITY, type SourceClass } from '../core/evidence.js';
export { resolveRoot, DATA_DIR_ENV, DEFAULT_DATA_DIR_NAME } from '../core/root.js';
export { OpenAICompatibleProvider, isLoopbackHost, type HttpProviderOptions } from '../models/openai.js';
export { createProviderFromConfig, describeModel, isBuiltinProvider, effectiveProvider, PROVIDER_NAMES, MODEL_DEFAULTS } from '../models/factory.js';
export { refreshRelevance, readRanking, clearRanking, relevanceStatus, type RefreshResult } from '../memory/relevance.js';
export { showModel, setModel, testModel, applyModelSet, providerKind, type ModelSetInput } from '../models/switch.js';
export { CliAgentProvider, cliArguments, findExecutable, type CliProviderOptions } from '../models/cli.js';
export { parseModelProposal, parseVerdict, extractJson } from '../models/schema.js';
export { ProviderError, CancelledError } from '../models/errors.js';
export { criticize, isSensitive, type CriticResult } from '../intelligence/critic.js';

/** Actor-bound API: hosts assign identity once, never from document/model arguments. */
export { AdaptiveIntelligence, touchActivity } from '../adaptive/index.js';
export class Engram {
  readonly vault: Vault;
  readonly search: SearchEngine;
  readonly intelligence: IntelligenceEngine;
  /** Secondary, on-demand historical recall (recent, timeline, time range, lexical search, batch fetch). */
  readonly memory: MemoryRecall;
  /** Typed query AST engine (operators, joins, graph, time, saved queries). Same engine behind `mdb query` and the MCP mdb_query tool. */
  readonly queries: QueryApi;
  private readonly modelProvider: ModelProvider | undefined; private adaptiveCache: AdaptiveIntelligence | undefined;
  /** Adaptive background intelligence (daily sealed-snapshot cycles). Owner only. */
  get adaptive(): AdaptiveIntelligence { return this.adaptiveCache ??= new AdaptiveIntelligence(this.vault, this.modelProvider); }
  constructor(root: string = resolveRoot(), actor: ActorContext = OWNER, provider?: ModelProvider, options: { embedder?: EmbeddingProvider; store?: ObjectStore; env?: Record<string,string|undefined> } = {}) {
    this.modelProvider = provider;
    this.vault = new Vault(root, actor, options.store ? { store: options.store } : {});
    this.search = new SearchEngine(this.vault, options);
    this.intelligence = new IntelligenceEngine(this.vault, provider);
    this.memory = new MemoryRecall(this.vault, this.search);
    this.queries = new QueryApi(this.vault, this.search);
  }
  init(options?: { sqlite?: boolean; postgres?: boolean }) { return this.vault.init(options); }
  capabilities() { return discoverCapabilities(this); }
  config() { return this.vault.config(); }
  doctor() { return this.vault.doctor(); }
  async close() { await Promise.all([this.search.close(),this.vault.close()]); }
  verify() { return this.vault.verify(); }
  recover() { return this.vault.recover(); }
  reconcile() { return this.vault.reconcile(); }
  createWorkspace(...args: Parameters<Vault['createWorkspace']>) { return this.vault.createWorkspace(...args); }
  listWorkspaces() { return this.vault.listWorkspaces(); }
  createCollection(...args: Parameters<Vault['createCollection']>) { return this.vault.createCollection(...args); }
  listCollections(...args: Parameters<Vault['listCollections']>) { return this.vault.listCollections(...args); }
  grant(...args: Parameters<Vault['grant']>) { return this.vault.grant(...args); }
  revoke(...args: Parameters<Vault['revoke']>) { return this.vault.revoke(...args); }
  diff(...args: Parameters<Vault['diff']>) { return this.vault.diff(...args); }
  promote(...args: Parameters<Vault['promote']>) { return this.vault.promote(...args); }
  purge(...args: Parameters<Vault['purge']>) { return this.vault.purge(...args); }
  listDocuments(...args: Parameters<Vault['listDocuments']>) { return this.vault.listDocuments(...args); }
  events() { return this.vault.events(); }
  backup(...args: Parameters<Vault['backup']>) { return this.vault.backup(...args); }
  links(...args: Parameters<SearchEngine['links']>) { return this.search.links(...args); }
  backlinks(...args: Parameters<SearchEngine['backlinks']>) { return this.search.backlinks(...args); }
  related(...args: Parameters<SearchEngine['related']>) { return this.search.related(...args); }
  sessionStart(...args: Parameters<IntelligenceEngine['sessionStart']>) { return this.intelligence.sessionStart(...args); }
  observe(...args: Parameters<IntelligenceEngine['observe']>) { return this.intelligence.observe(...args); }
  sessionEnd(...args: Parameters<IntelligenceEngine['sessionEnd']>) { return this.intelligence.sessionEnd(...args); }
  jobs() { return this.intelligence.jobs(); }
  proposals() { return this.intelligence.proposals(); }
  runIntelligence(...args: Parameters<IntelligenceEngine['run']>) { return this.intelligence.run(...args); }
  put(input: PutInput) { return this.vault.put(input); }
  get(...args: Parameters<Vault['get']>) { return this.vault.get(...args); }
  patch(input: PatchInput) { return this.vault.patch(input); }
  delete(...args: Parameters<Vault['delete']>) { return this.vault.delete(...args); }
  history(...args: Parameters<Vault['history']>) { return this.vault.history(...args); }
  restore(...args: Parameters<Vault['restore']>) { return this.vault.restore(...args); }
  ingest(...args: Parameters<Vault['ingest']>) { return this.vault.ingest(...args); }
  query(input: SearchInput) { return this.search.query(input); }
  context(...args: Parameters<SearchEngine['context']>) { return this.search.context(...args); }
  skills() { return listSkills(); }
  skill(name: string) { return getSkill(name); }
  runSkill(name: string, input: Record<string, unknown> = {}) { return runSkill(name, input, { vault: this.vault, search: this.search, intelligence: this.intelligence }); }
}
export { OpenAICompatibleEmbedder, createEmbedder, describeEmbedding } from '../search-semantic/embedder.js';
export { Engram as MDB };
