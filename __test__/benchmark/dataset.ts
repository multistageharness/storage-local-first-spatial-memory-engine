/**
 * Curated benchmark golden dataset — hand-written, human-annotated cases
 * over a knowledge base describing this engine's own architecture.
 *
 * Distribution (20 cases): 11 common (55%), 5 distractor (25%),
 * 2 multi-hop (10%), 2 no-answer (10%) — inside the recommended bands.
 *
 * The corpus deliberately includes three DISTRACTOR documents describing
 * plausible alternative designs (Last-Write-Wins replication, neural
 * embedding retrieval, Redis queue sync). They look similar to the real
 * documents but contain the wrong answers; distractor cases verify the
 * retriever ranks the authoritative document above the lure, and the
 * generator answers from the right one.
 *
 * Provenance: cases were written and annotated by hand (no model generated
 * the ground truth), so any judge satisfies model separation. The field is
 * still populated to exercise the runner's separation guard.
 */
import type { BenchmarkDataset } from '../eval/benchmark.js';
import type { CorpusDoc } from '../eval/goldens.js';

// ---- knowledge base ---------------------------------------------------------

const corpus: CorpusDoc[] = [
  {
    title: 'wal-concurrency.md',
    originFile: 'docs/wal-concurrency.md',
    text:
      'The engine opens every database connection with PRAGMA journal_mode=WAL, synchronous=NORMAL, and busy_timeout set to 60000 milliseconds. ' +
      'Write transactions always begin with BEGIN IMMEDIATE so writers queue at the operating system level instead of failing on SQLITE_BUSY lock upgrades. ' +
      'Readers continue reading snapshots while the single writer appends to the write-ahead log.',
  },
  {
    title: 'worker-pool.md',
    originFile: 'docs/worker-pool.md',
    text:
      'All better-sqlite3 calls run inside worker_threads, never on the V8 event loop. ' +
      'A WorkerBroker supervises one singleton writer worker and a dynamic pool of reader workers. ' +
      'The broker speaks a JSON message protocol and matches worker responses to promises by a monotonic request id.',
  },
  {
    title: 'fts5-retrieval.md',
    originFile: 'docs/fts5-retrieval.md',
    text:
      'Retrieval uses an external-content FTS5 table with the trigram tokenizer, which buys substring and camelCase matching. ' +
      'Ranking uses the bm25 auxiliary function with column weights 2.0 for title and 1.0 for body, so title hits outrank body hits. ' +
      'AFTER INSERT, UPDATE and DELETE triggers keep the FTS5 index in lock-step with the nodes table.',
  },
  {
    title: 'crdt-sync.md',
    originFile: 'docs/crdt-sync.md',
    text:
      'Each atom owns its own Yjs document, so update blobs stay tiny and merges stay proportional to one atom. ' +
      'Concurrent edits to the same atom are merged mathematically with Y.mergeUpdates, which is order-independent and never discards either side. ' +
      'The engine explicitly avoids Last-Write-Wins timestamp resolution.',
  },
  {
    title: 'outbox-pipeline.md',
    originFile: 'docs/outbox-pipeline.md',
    text:
      'saveAtomic commits the node row, the CRDT blob, and an outbox event in a single BEGIN IMMEDIATE transaction, solving the dual-write problem. ' +
      'The sync pipeline runs a background worker that polls the outbox for DIRTY and CONFLICT rows, performs each merge off-thread, and commits results through the singleton writer. ' +
      'After a sync round every consumed outbox event row is marked SYNCED.',
  },
  {
    title: 'chunking-routing.md',
    originFile: 'docs/chunking-routing.md',
    text:
      'Documents are chunked into 800-character segments with a 100-character overlap. ' +
      'Each chunk is routed to a topical cluster by deterministic keyword-density scoring, with an alphabetical tie-break and a general fallback cluster when no keyword threshold is met. ' +
      'Chunks are stored as immutable verbatim atoms.',
  },
  // ---- deliberate distractors (plausible but WRONG designs) ------------------
  {
    title: 'lww-replication-notes.md',
    originFile: 'docs/notes/lww-replication-notes.md',
    text:
      'A simpler replication design resolves concurrent edits to the same record by comparing wall-clock timestamps and keeping only the newest write. ' +
      'This Last-Write-Wins approach discards the losing edit entirely. ' +
      'Many key-value stores reconcile replicas this way because timestamp comparison is cheap.',
  },
  {
    title: 'embedding-search-notes.md',
    originFile: 'docs/notes/embedding-search-notes.md',
    text:
      'An alternative retrieval design embeds every chunk with a neural model and performs approximate nearest neighbour search over the vectors. ' +
      'Cosine distance between embeddings then ranks the results. ' +
      'Ranking quality depends on the embedding model rather than term statistics.',
  },
  {
    title: 'queue-daemon-notes.md',
    originFile: 'docs/notes/queue-daemon-notes.md',
    text:
      'Some sync designs push every change onto an external Redis queue and let a BullMQ daemon drain the backlog. ' +
      'The daemon retries failed jobs with exponential backoff and keeps job state outside the database, which adds an extra service to operate.',
  },
];

// ---- annotated cases ----------------------------------------------------------

export const benchmarkDataset: BenchmarkDataset = {
  name: 'spatial-memory-engine-architecture-v1',
  provenance: { curatedBy: 'human-sme', generatedBy: 'manual-curation' },
  corpus,
  cases: [
    // ---- common (11 — 55%): direct fact lookups -----------------------------
    {
      id: 'common-01',
      input: 'What journal mode does the engine enable on every database connection?',
      expectedAnswer:
        'The engine opens every database connection with PRAGMA journal_mode=WAL, synchronous=NORMAL, and busy_timeout set to 60000 milliseconds.',
      supportingDocs: ['wal-concurrency.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-02',
      input: 'How do write transactions begin so writers queue instead of failing on lock upgrades?',
      expectedAnswer:
        'Write transactions always begin with BEGIN IMMEDIATE so writers queue at the operating system level instead of failing on SQLITE_BUSY lock upgrades.',
      supportingDocs: ['wal-concurrency.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-03',
      input: 'Which component supervises the singleton writer worker and the reader workers?',
      expectedAnswer: 'A WorkerBroker supervises one singleton writer worker and a dynamic pool of reader workers.',
      supportingDocs: ['worker-pool.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-04',
      input: 'How does the broker match worker responses to promises?',
      expectedAnswer:
        'The broker speaks a JSON message protocol and matches worker responses to promises by a monotonic request id.',
      supportingDocs: ['worker-pool.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-05',
      input: 'Which tokenizer gives the FTS5 table substring and camelCase matching?',
      expectedAnswer:
        'Retrieval uses an external-content FTS5 table with the trigram tokenizer, which buys substring and camelCase matching.',
      supportingDocs: ['fts5-retrieval.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-06',
      input: 'What column weights does the bm25 ranking use for title and body?',
      expectedAnswer:
        'Ranking uses the bm25 auxiliary function with column weights 2.0 for title and 1.0 for body, so title hits outrank body hits.',
      supportingDocs: ['fts5-retrieval.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-07',
      input: 'What keeps the FTS5 index in lock-step with the nodes table?',
      expectedAnswer: 'AFTER INSERT, UPDATE and DELETE triggers keep the FTS5 index in lock-step with the nodes table.',
      supportingDocs: ['fts5-retrieval.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-08',
      input: 'How are documents chunked into segments and how much do the segments overlap?',
      expectedAnswer: 'Documents are chunked into 800-character segments with a 100-character overlap.',
      supportingDocs: ['chunking-routing.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-09',
      input: 'Which cluster receives a chunk when no keyword threshold is met?',
      expectedAnswer:
        'Each chunk is routed to a topical cluster by deterministic keyword-density scoring, with an alphabetical tie-break and a general fallback cluster when no keyword threshold is met.',
      supportingDocs: ['chunking-routing.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-10',
      input: 'What does saveAtomic commit in a single BEGIN IMMEDIATE transaction?',
      expectedAnswer:
        'saveAtomic commits the node row, the CRDT blob, and an outbox event in a single BEGIN IMMEDIATE transaction, solving the dual-write problem.',
      supportingDocs: ['outbox-pipeline.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },
    {
      id: 'common-11',
      input: 'Why does each atom own its own Yjs document?',
      expectedAnswer:
        'Each atom owns its own Yjs document, so update blobs stay tiny and merges stay proportional to one atom.',
      supportingDocs: ['crdt-sync.md'],
      metadata: { answerable: true, queryType: 'common', difficulty: 'easy', allowedVariance: 'moderate' },
    },

    // ---- distractor (5 — 25%): a lure document contains the WRONG answer ----
    {
      id: 'distractor-01',
      input: 'How does the engine merge concurrent edits to the same atom?',
      expectedAnswer:
        'Concurrent edits to the same atom are merged mathematically with Y.mergeUpdates, which is order-independent and never discards either side.',
      supportingDocs: ['crdt-sync.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:lww-replication-notes.md'],
      },
    },
    {
      id: 'distractor-02',
      input: 'Does conflict resolution discard either side of concurrent edits?',
      expectedAnswer:
        'Concurrent edits to the same atom are merged mathematically with Y.mergeUpdates, which is order-independent and never discards either side. The engine explicitly avoids Last-Write-Wins timestamp resolution.',
      supportingDocs: ['crdt-sync.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:lww-replication-notes.md'],
      },
    },
    {
      id: 'distractor-03',
      input: "Does the engine's retrieval use an external-content FTS5 table or neural embeddings?",
      expectedAnswer:
        'Retrieval uses an external-content FTS5 table with the trigram tokenizer, which buys substring and camelCase matching.',
      supportingDocs: ['fts5-retrieval.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:embedding-search-notes.md'],
      },
    },
    {
      id: 'distractor-04',
      input: 'Does the sync pipeline drain changes through a Redis queue or the outbox?',
      expectedAnswer:
        'The sync pipeline runs a background worker that polls the outbox for DIRTY and CONFLICT rows, performs each merge off-thread, and commits results through the singleton writer.',
      supportingDocs: ['outbox-pipeline.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:queue-daemon-notes.md'],
      },
    },
    {
      id: 'distractor-05',
      input: 'How does the engine avoid Last-Write-Wins when it merges concurrent edits?',
      expectedAnswer:
        'Concurrent edits to the same atom are merged mathematically with Y.mergeUpdates, which is order-independent and never discards either side. The engine explicitly avoids Last-Write-Wins timestamp resolution.',
      supportingDocs: ['crdt-sync.md'],
      metadata: {
        answerable: true, queryType: 'distractor', difficulty: 'hard', allowedVariance: 'moderate',
        tags: ['lure:lww-replication-notes.md'],
      },
    },

    // ---- multi-hop (2 — 10%): answer spans two documents ---------------------
    {
      id: 'multihop-01',
      input: 'Where do better-sqlite3 calls run, and how does the singleton writer commit merged sync results?',
      expectedAnswer:
        'All better-sqlite3 calls run inside worker_threads, never on the V8 event loop. The sync pipeline runs a background worker that polls the outbox for DIRTY and CONFLICT rows, performs each merge off-thread, and commits results through the singleton writer.',
      supportingDocs: ['worker-pool.md', 'outbox-pipeline.md'],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    },
    {
      id: 'multihop-02',
      input: 'What chunk segments do documents become, and which tokenizer indexes them for substring matching?',
      expectedAnswer:
        'Documents are chunked into 800-character segments with a 100-character overlap. Retrieval uses an external-content FTS5 table with the trigram tokenizer, which buys substring and camelCase matching.',
      supportingDocs: ['chunking-routing.md', 'fts5-retrieval.md'],
      metadata: { answerable: true, queryType: 'multi-hop', difficulty: 'hard', allowedVariance: 'free' },
    },

    // ---- no-answer (2 — 10%): the corpus cannot answer; refusal required -----
    {
      id: 'noanswer-01',
      input: 'What is the monthly price of the managed hosting plan?',
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'strict' },
    },
    {
      id: 'noanswer-02',
      input: 'Which Kubernetes manifest ships for deploying the cluster autoscaler?',
      expectedAnswer: '',
      supportingDocs: [],
      metadata: { answerable: false, queryType: 'no-answer', difficulty: 'medium', allowedVariance: 'strict' },
    },
  ],
};
