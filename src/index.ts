export { MemoryEngine, sha256Hex } from './engine.js';
export type {
  EngineOptions,
  IngestResult,
  SearchOptions,
  HybridSearchOptions,
  EdgeExpandOptions,
  SupernodeRouteOptions,
  SourceDocumentInput,
  ReplaceDocumentOutcome,
  VectorMode,
} from './engine.js';
export { WorkerBroker } from './workers/broker.js';
export { ClusterRouter, GENERAL_CLUSTER } from './spatial/router.js';
export { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP } from './spatial/chunker.js';
export {
  sanitizeFtsQuery,
  sanitizeWordFtsQuery,
  buildSearchSql,
  buildWordSearchSql,
  DEFAULT_WEIGHTS,
} from './search/query.js';
export { rrfFuse, RRF_K } from './search/rrf.js';
export { assembleContext } from './federation/context.js';
export type { AssembledContext, ContextBlock, AssembleOptions } from './federation/context.js';
export type { FusedHit } from './search/rrf.js';
export {
  HashingEmbedder,
  OllamaEmbedder,
  l2normalize,
  dot,
  embeddingToBuffer,
  bufferToEmbedding,
  DEFAULT_EMBEDDING_DIMS,
} from './search/embedder.js';
export type { Embedder } from './search/embedder.js';
// ---- IDEA.v2 federation layer -------------------------------------------
export { FederatedEngine, shardFileName } from './federated-engine.js';
export type { FederatedEngineOptions, EnsureShardInput, OrgStats } from './federated-engine.js';
export {
  Catalog,
  SPLIT_ATOM_THRESHOLD,
  SPLIT_BYTES_THRESHOLD,
} from './federation/catalog.js';
export type { ShardRow, ShardKind, ShardStatus, IngestTask, IngestTaskKind } from './federation/catalog.js';
export { ShardPool } from './federation/pool.js';
export type { ShardPoolOptions, PoolStats } from './federation/pool.js';
export { ShardRouter, parseHint } from './federation/router.js';
export type { RouteOptions, RouteResult } from './federation/router.js';
export { FederatedSearch } from './federation/search.js';
export type {
  FederatedHit,
  FederatedSearchOptions,
  FederatedSearchResult,
  ShardProbe,
} from './federation/search.js';
export { IngestScheduler } from './federation/scheduler.js';
export type { IngestSchedulerOptions, IngestReport, DocBatchSource } from './federation/scheduler.js';

// ---- IDEA.v2 connector layer ----------------------------------------------
export { runCrawl, runOrgCrawl } from './connectors/runner.js';
export type { CrawlReport, RunCrawlOptions } from './connectors/runner.js';
export { ConfluenceConnector } from './connectors/confluence.js';
export type { ConfluenceConnectorOptions } from './connectors/confluence.js';
export { GitOrgConnector } from './connectors/git-org.js';
export type { GitOrgConnectorOptions, GitRepoRef } from './connectors/git-org.js';
export { FilesystemConnector } from './connectors/filesystem.js';
export type { FilesystemConnectorOptions, FilesystemRootRef } from './connectors/filesystem.js';
export { storageToText } from './connectors/confluence-storage.js';
export type { Connector, CrawlEvent, ShardDescriptor, SourceDocument } from './connectors/types.js';
// (keywordTerms is re-exported below with the demo001 eval surface)

export { CRDTStorageAdapter } from './sync/adapter.js';
export { SyncPipeline } from './sync/pipeline.js';
export { MigrationManager } from './sync/migrations.js';
export type { Migration } from './sync/migrations.js';
export { StabilityTracker } from './federation/stability.js';
export { createAtomBlob, diffUpdate, mergeBlobs, readAtomFields, stateVector } from './sync/crdt.js';
export { openConnection } from './db/connection.js';
export { applySchema } from './db/schema.js';
export type {
  ClusterDef,
  SearchHit,
  HybridSearchHit,
  HybridSource,
  DocumentRow,
  ReplaceDocumentResult,
  // DEMO003 Feature 1 — Edge Type
  EdgeInput,
  EdgeRow,
  EdgeDirection,
  NeighborRow,
  AddEdgesResult,
  // DEMO003 Feature 2 — Supernode
  SupernodeRow,
  ClusterScore,
  RebuildSupernodesResult,
} from './workers/protocol.js';
export {
  contextualPrecision,
  contextualRecall,
  faithfulness,
  answerRelevancy,
  tokenize,
  termVector,
  cosine,
} from '../__test__/eval/metrics.js';
export type { MetricResult } from '../__test__/eval/metrics.js';
export { LexicalJudge, JudgeJury } from '../__test__/eval/judge.js';
export type { Judge } from '../__test__/eval/judge.js';
export { synthesizeGoldens, critiqueInput } from '../__test__/eval/goldens.js';
export type { Golden, CorpusDoc, SynthesizerOptions } from '../__test__/eval/goldens.js';
export {
  extractiveGenerator,
  abstainingGenerator,
  hallucinatingGenerator,
  isRefusal,
  REFUSAL_TEXT,
} from '../__test__/eval/generator.js';
export type { GenerateFn } from '../__test__/eval/generator.js';
export {
  engineRetriever,
  benchmarkRetriever,
  fuseSearchHits,
  keywordTerms,
} from '../__test__/eval/retriever.js';
export type { RetrievedChunk, BenchmarkRetrieveFn } from '../__test__/eval/retriever.js';
export {
  BenchmarkRunner,
  validateDistribution,
  DISTRIBUTION_BANDS,
  DEFAULT_BENCHMARK_THRESHOLDS,
  VARIANCE_THRESHOLDS,
} from '../__test__/eval/benchmark.js';
export type {
  BenchmarkCase,
  BenchmarkDataset,
  BenchmarkReport,
  BenchmarkCaseResult,
  QueryType,
} from '../__test__/eval/benchmark.js';
export { RagEvalHarness, assertCase, DEFAULT_THRESHOLDS } from '../__test__/eval/harness.js';
export type { Thresholds, CaseResult, EvalReport, RetrieveFn } from '../__test__/eval/harness.js';
// ---- IDEA.v2 federated eval/benchmark surface ------------------------------
export {
  FederatedEvalHarness,
  synthesizeFederatedGoldens,
  shardRoutingRecall,
  shardRoutingPrecisionProxy,
  federatedBenchmarkRetriever,
  DEFAULT_FEDERATED_THRESHOLDS,
} from '../__test__/eval/federated.js';
export type {
  FederatedGolden,
  FederatedThresholds,
  FederatedCaseResult,
  FederatedEvalReport,
} from '../__test__/eval/federated.js';
export { FEDERATED_DISTRIBUTION_BANDS } from '../__test__/eval/benchmark.js';
export { buildSyntheticOrg, synthesizeOrgQueries, ORG_DOMAINS } from '../__test__/benchmark/org-dataset.js';
export type { SyntheticOrg, OrgShardSpec, OrgDoc, OrgQuery } from '../__test__/benchmark/org-dataset.js';
export {
  buildOrgSyntheticDataset,
  buildConfluenceFixtureDataset,
  buildRepoOrgDataset,
} from '../__test__/benchmark/org-benchmark.js';
export {
  measureLatency,
  measureThroughput,
  compareToBaseline,
  renderDeltaTable,
  captureEnv,
  hardwareMismatch,
  renderEnvLine,
  renderEnvComparison,
  deriveRunnerClass,
  classBaselinePath,
} from '../__test__/benchmark/perf.js';
export type { PerfMetric, PerfReport, PerfEnv, BaselineComparison } from '../__test__/benchmark/perf.js';
