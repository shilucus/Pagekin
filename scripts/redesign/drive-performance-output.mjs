import { createHash } from 'node:crypto'
import path from 'node:path'
import { projectPerformanceSelection } from './performance-baseline.mjs'
import { PERFORMANCE_METRICS } from '../../src/shared/performance-baseline.ts'

const SAFE_CODES = new Set(['ERR_ASSERTION', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EIO', 'ENOENT', 'EACCES', 'EPERM',
  'PERFORMANCE_OBSERVATION_TIMEOUT', 'PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE', 'PERFORMANCE_PROBE_ALREADY_RUNNING',
  'PERFORMANCE_RENDERER_PROBE_ALREADY_RUNNING', 'PERFORMANCE_RENDERER_PROBE_START_FAILED', 'PERFORMANCE_IMPORT_DRAIN_TIMEOUT',
  'PERFORMANCE_DRAFT_READ_UNAVAILABLE', 'PERFORMANCE_BLUEPRINT_READ_UNAVAILABLE', 'PERFORMANCE_REQUEST_SUMMARY_UNAVAILABLE',
  'PERFORMANCE_EVENT_COVERAGE_MISSING', 'PERFORMANCE_REQUEST_CUTOFF_CHANGED', 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED',
  'PERFORMANCE_FINAL_REQUEST_SUMMARY_FAILED', 'PERFORMANCE_PRESSURE_TIMEOUT', 'PERFORMANCE_PRESSURE_FINAL_REQUEST_EVIDENCE_FAILED',
  'DRIVE_FINAL_OBSERVATION_TIMEOUT', 'DRIVE_EXTERNAL_REQUEST_LOG_UNAVAILABLE', 'PERFORMANCE_REQUESTS_DURING_QUIT', 'ISOLATION_CLEANUP_BOUNDARY',
  'GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED',
  'GENERATION_CONTEXT_LENGTH_EXCEEDED', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE',
  'HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE',
  'TIMEOUT', 'UNCLASSIFIED_ERROR'])
const ERROR_CLASSES = new Set(['Error', 'TimeoutError', 'AssertionError', 'AggregateError', 'TypeError', 'RangeError'])
const SCENARIOS = new Set(['perf-import-10', 'perf-import-100', 'perf-import-1000', 'perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit',
  'perf-parse-author-10', 'perf-parse-author-100', 'perf-parse-author-1000',
  'perf-parse-reference-10', 'perf-parse-reference-100', 'perf-parse-reference-1000',
  'perf-parse-author-close-1000', 'perf-parse-reference-close-1000', 'perf-parse-reference-cancel-1000'])
const IMPORT_STAGES = ['parsing', 'prepared', 'knowledge', 'global', 'style', 'blueprints', 'author-commit',
  'author-publish', 'author-postprocess', 'refresh', 'completed']
const OPERATIONS = ['import-global-facts', 'import-blueprints', 'import-inference', 'import-inference:endpoint-card-recovery',
  'draft', 'chapter-draft', 'chapter-draft-short-outline', 'finalized-chapter-notes', 'finalized-character-state',
  'analyze-writing-style', 'generate-plot-outline', 'generate-world-building', 'unknown']
const FAILURE_STAGES = ['fixture', 'runtime', 'session', 'probe_start', 'preview', 'import', 'workflow', 'verify', 'producer',
  'evidence', 'drain', 'probe_stop', 'probe_coverage', 'request_summary', 'event_coverage', 'final_request_summary',
  'driver_finalize', 'network_observation', 'quit', 'cleanup', 'quit_request_cutoff', 'unclassified']
const RUN_STATUSES = ['active', 'paused', 'sealed', 'running', 'completed', 'failed', 'cancelled', 'ready', 'unknown']
const ROUTES = ['/v1/chat/completions', '/v1/embeddings', '/v1/messages']
const PROBE_COVERAGE = ['unavailable', 'insufficient_samples', 'observed_metrics', 'live_zero_events']
const DIAGNOSTIC_COVERAGE = ['unavailable', 'not_entered', 'observed', 'partial']
const FINGERPRINTS = ['chapterBriefHash', 'authorGuidanceHash', 'dependencyHash', 'contextSnapshotHash',
  'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash']

function opaque(value) {
  return `opaque:${createHash('sha256').update(String(value)).digest('hex')}`
}

export function performanceError(error) {
  const errorClass = ERROR_CLASSES.has(error?.name) ? error.name : 'Error'
  const code = SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message
    : errorClass === 'TimeoutError' ? 'TIMEOUT' : 'UNCLASSIFIED_ERROR'
  return `PERFORMANCE_FAILURE:${errorClass}:${code}`
}

function projectError(value) {
  return value.split('\n').map(line => {
    if (SAFE_CODES.has(line)) return `PERFORMANCE_FAILURE:Error:${line}`
    const match = /^PERFORMANCE_FAILURE:(?:(?:scenario|cleanup|unclassified):[a-z_]+:)?([A-Za-z]+):([A-Z0-9_]+)$/.exec(line)
    return match && ERROR_CLASSES.has(match[1]) && SAFE_CODES.has(match[2])
      ? `PERFORMANCE_FAILURE:${match[1]}:${match[2]}` : performanceError(null)
  }).join('\n')
}

/** Relative output is allowed only after both lexical and caller-supplied realpath containment. */
export function performanceArtifactPath(value, out, { pathApi = path, contained = () => false } = {}) {
  if (typeof value !== 'string' || typeof out !== 'string' || !pathApi.isAbsolute(value) || !pathApi.isAbsolute(out)) return opaque(value)
  const relative = pathApi.relative(out, value)
  if (!relative || relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative)) return opaque(value)
  try { if (!contained(value, out)) return opaque(value) } catch { return opaque(value) }
  return relative.split(pathApi.sep).join('/')
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const temperature = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const boolean = value => typeof value === 'boolean' ? value : null
const member = values => value => values.includes(value) ? value : null
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : null
const sourceSha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/i.test(value) ? value : null
const version = value => typeof value === 'string' && /^v?\d+(?:\.\d+){1,3}$/.test(value) ? value : null
const privateString = value => typeof value === 'string' ? opaque(value) : null
const error = value => typeof value === 'string' ? projectError(value) : null
const code = value => SAFE_CODES.has(value) ? value : null
const model = value => ['gpt-4.1', 'text-embedding-3-small'].includes(value) ? value
  : typeof value === 'string' && /^opaque:[a-f0-9]{64}$/.test(value) ? value : privateString(value)
const array = project => value => Array.isArray(value) ? value.map(project) : null

// Only declared keys are read. Missing observations stay missing; poisoned leaves become null, never zero.
function fields(value, leaves) {
  if (!record(value)) return null
  return Object.fromEntries(Object.entries(leaves).filter(([key]) => Object.hasOwn(value, key) && value[key] !== undefined)
    .map(([key, project]) => [key, project(value[key])]))
}
const numbers = keys => Object.fromEntries(keys.map(key => [key, number]))
const counts = keys => Object.fromEntries(keys.map(key => [key, count]))
const summary = value => fields(value, { count, ...numbers(['sum', 'min', 'max', 'p50UpperBound', 'p95UpperBound']) })
const metrics = value => fields(value, Object.fromEntries(PERFORMANCE_METRICS.map(key => [key, summary])))
const routeCounts = value => fields(value, Object.fromEntries(ROUTES.map(route => [route, count])))
const requestSummary = value => fields(value, { coverage: member(['unavailable', 'guarded_fetch_attempts']),
  byRoute: rows => fields(rows, Object.fromEntries(ROUTES.map(route => [route, row => fields(row,
    { ...counts(['count', 'failed', 'http429']), ...numbers(['totalMs', 'maxMs']) })]))) })
const failureDiagnostic = value => fields(value, { source: member(['scenario', 'cleanup', 'unclassified']),
  stage: member(FAILURE_STAGES), errorClass: member([...ERROR_CLASSES]), code })
const parameter = value => fields(value, { model, maxTokens: count, temperature, messagesSha256: hash })
const fixtureParameters = value => fields(value, { coverage: member(['unavailable', 'observed_http_requests', 'not_available_http429', 'not_applicable_embedding']),
  ...counts(['observed', 'retained', 'omitted', 'grouped', 'overflow']), groupLimit: member([32]), items: array(parameter),
  groups: array(value => fields(value, { model, maxTokens: count, temperature, count })) })
const probeCoverage = value => fields(value, { main: member(PROBE_COVERAGE), renderer: member(PROBE_COVERAGE) })
const costAttribution = value => fields(value, {
  coverage: probeCoverage, ownership: member(['main-plus-renderer-owned-metrics']), categories: value => fields(value, {
    schemaVersion: member([2]),
    localPreparation: value => fields(value, numbers(['inspectMs', 'importReadMs', 'sourceCaptureMs', 'sourceReadMs',
      'sourceSelectMs', 'sourceValidateMs', 'importReadUtf8Bytes', 'sourceReadUtf8Bytes', 'readArchiveBytes',
      'inspectCalls', 'inspectFailed', 'inspectCancelled'])),
    queueWait: value => fields(value, { ...numbers(['snapshotQueueMs', 'schedulerAcquireCalls', 'schedulerAdmitted',
      'schedulerRejected', 'schedulerAdmittedWaitMs', 'schedulerRejectedWaitMs']), pendingSamples: summary,
    snapshotQueueSamples: summary, schedulerQueueSamples: summary }),
    modelExecution: value => fields(value, numbers(['providerMs', 'firstResponseMinMs', 'firstVisibleMinMs',
      'firstReasoningMinMs', 'transportVisibleEvents', 'generationVisibleEvents', 'transportReasoningEvents',
      'generationReasoningEvents', 'physicalRequests', 'http429Count', 'inputTokens', 'completionTokens', 'reasoningTokens', 'totalTokens'])),
    parsingComputation: value => fields(value, numbers(['parseMs', 'importHashMs', 'rendererSnapshotHashMs', 'rendererSnapshotProcessingMs'])),
    persistenceSave: value => fields(value, numbers(['saveMs', 'snapshotMs', 'receiptMs', 'snapshotUtf8Bytes',
      'publishUtf8Bytes', 'snapshotCalls', 'snapshotFailed'])),
    provenance: value => fields(value, { corpusHash: hash, ...counts(['sampleChapters', 'sampleBooks', 'attempted', 'failed']),
      sourceSha, environment: privateString,
      multiBookStatus: array(value => fields(value, { books: count, status: member(['executed', 'not_executed']) })) }),
  }),
})
const measurements = value => fields(value, {
  main: value => fields(value, { metrics: value => fields(value, { schemaVersion: member([1]),
    quantiles: member(['fixed-histogram-upper-bounds']), metrics }),
  memory: value => fields(value, { ...numbers(['rssStart', 'rssEnd', 'rssMax', 'rssIntervalMs']), rssSamples: count }),
  cpu: value => fields(value, numbers(['userUs', 'systemUs', 'windowMs'])),
  eventLoop: value => fields(value, { count, ...numbers(['minMs', 'maxMs', 'meanMs', 'p50Ms', 'p95Ms']) }) }),
  renderer: value => fields(value, { metrics,
    heartbeat: value => fields(value, { intervalMs: member([100]), count, ...numbers(['sumDelayMs', 'maxDelayMs']) }) }),
  coverage: value => fields(value, { main: member(PROBE_COVERAGE), renderer: member(PROBE_COVERAGE), cpu: member(['observed', 'unavailable']) }),
  stopFailures: value => fields(value, { main: count, renderer: count }), costAttribution,
})
const transport = value => fields(value, { ...numbers(['elapsedMs', 'firstResponseMs', 'lastResponseMs', 'lastOutputMs']),
  httpStatus: value => Number.isSafeInteger(value) && value >= 100 && value <= 599 ? value : null,
  phase: member(['request', 'response', 'stream', 'complete']), endReason: member(['completed', 'cancelled', 'failed']),
  errorName: member([...ERROR_CLASSES, 'AbortError', 'SocketError', 'BodyTimeoutError', 'HeadersTimeoutError', 'ConnectTimeoutError']),
  errorCode: code, causeCode: code, ...counts(['visibleEvents', 'reasoningEvents']) })
const attempts = value => fields(value, { ...counts(['observed', 'retained', 'omitted']), items: array(value => fields(value, {
  attemptId: privateString, status: member(['reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch']),
  purpose: member(OPERATIONS), requestedOutputTokens: count, failureCode: code,
  actual: value => fields(value, counts(['input', 'completion', 'reasoning', 'total'])), transport,
})) })
const generationRun = value => fields(value, { coverage: member(['observed', 'unavailable']), runId: privateString,
  rootActionId: privateString, operation: member(OPERATIONS), status: member(RUN_STATUSES),
  source: value => fields(value, { modelIdHash: hash, modelReceiptHash: hash,
    fingerprint: value => fields(value, Object.fromEntries(FINGERPRINTS.map(key => [key, hash]))) }),
  selection: projectPerformanceSelection,
  importSlot: value => fields(value, { runId: privateString, stage: member(IMPORT_STAGES), batchId: privateString }),
  finalizationSlot: value => fields(value, { stepKey: member(['chapter_notes', 'character_cards']),
    source: value => fields(value, { draftId: count, finalizationId: privateString, chapterNumber: count, contentHash: hash }) }),
  initialDraftTaskHash: hash, parametersCoverage: member(['not_recorded']), attempts,
})
const diagnostics = value => fields(value, { sampleBoundary: member(['after_probe_stop_attempt']),
  ...counts(['sampleStartedAt', 'sampleEndedAt']),
  generation: value => fields(value, { scope: member(['isolated_project']), coverage: member(DIAGNOSTIC_COVERAGE),
    ...counts(['observed', 'retained', 'omitted']), samplingRule: member(['operation-head-tail-failed-v1']),
    operationCounts: array(value => fields(value, { operation: member(OPERATIONS), count })), cutoff: boolean, runs: array(generationRun) }),
  importRun: value => fields(value, { coverage: member(DIAGNOSTIC_COVERAGE), ...counts(['observed', 'retained']),
    runs: array(value => fields(value, { coverage: member(['observed', 'unavailable']), id: privateString, rootRunId: privateString,
      purpose: member(['reference', 'author-manuscript']), stage: member(IMPORT_STAGES), status: member(RUN_STATUSES),
      checkpointCounts: value => fields(value, counts(IMPORT_STAGES)) })) }),
})
const fixture = value => fields(value, { kind: member(['local-openai-compatible-fiction']), protocol: member(['openai']), model,
  temperature, configuredMaxTokens: count, skill: member(['isolated-fixture-default-no-custom-install']), corpusSha256: hash,
  ...counts(['visibleChunks', 'reasoningChunks', 'dispatchedParametersObserved', 'dispatchedParametersRetained']),
  ...numbers(['intervalMs', 'embeddingHoldMs', 'postProducerObservationMs']),
  usage: member(['not_available_http429', 'not_available_from_embedding_fixture',
    'fixed-fictional-400-input-200-completion-32-reasoning-when-present-not-real-billing']),
  independentSkillDigest: member(['not_available_from_public_readback']), dispatchedParameters: array(parameter),
  dispatchedParametersCoverage: member(['unavailable', 'observed_http_requests', 'not_available_http429', 'not_applicable_embedding']),
})
const measured = value => fields(value, {
  metadata: value => fields(value, { platform: member(['win32', 'darwin', 'linux']), arch: member(['x64', 'arm64']),
    cpu: privateString, ramBytes: count, driverNode: version,
    appRuntime: value => fields(value, { electron: version, node: version, chrome: version }),
    sourceSha, ...counts(['chapters', 'books']), cache: member(['uncontrolled']) }),
  scenario: member([...SCENARIOS]), corpusSha256: hash, corpusBytes: count,
  inspection: value => fields(value, {
    purpose: member(['author-manuscript', 'reference']), classification: member(['new', 'resumable', 'exact-duplicate', 'conflict']),
    stage: member(IMPORT_STAGES), status: member(['ready', 'running', 'failed', 'cancelled', 'completed']),
    ...counts(['sourceCount', 'chapterCount', 'totalBytes', 'totalWords', 'completedSources', 'totalSources',
      'newCount', 'duplicateCount', 'conflictCount']),
  }),
  lifecycle: value => fields(value, {
    mode: member(['close-drain', 'chooser-cancel']), closeRequested: boolean, closeWaitMs: number,
    settledBeforeReload: boolean, runtimeClosed: boolean, reopened: boolean, sessionRotated: boolean,
    chooserResult: member(['selected', 'cancelled']), runReadback: member(['prepared', 'absent']),
  }),
  ...counts(['importedChapters', 'blueprintChapters', 'fixtureAcceptedRequests', 'finalFixtureAcceptedRequests',
    'cleanupFailures', 'attempted', 'failed', 'stopFailures']), elapsedMs: number,
  requestSummary, finalRequestSummary: requestSummary,
  countCoverage: value => fields(value, { importedChapters: member(['unavailable', 'observed']), blueprintChapters: member(['unavailable', 'observed']) }),
  failureDiagnostics: array(failureDiagnostic),
  drain: value => fields(value, { status: member(['not_needed', 'not_started', 'drained', 'unavailable']), cancellationRequested: boolean }),
  eventCoverage: value => fields(value, { importInspection: member(['observed', 'not_observed']), rendererSnapshots: member(['observed', 'not_observed']) }),
  diagnostics, fixtureParameters, fixture,
  requestSummaryCutoff: member(['after_drain_and_probe_stop', 'after_drain_probe_stop', 'before_quit']),
  requestsAfterMeasurement: value => record(value) ? routeCounts(value) : count(value),
  requestEvidence: member(['local_observation_not_proof_of_remote_execution', 'local-guarded-fetch-observation-not-remote-execution']),
  success: boolean, failureStage: member(FAILURE_STAGES), measurements,
  task: value => fields(value, { ...counts(['attempted', 'failed', 'settled', 'unknown', 'reserved', 'artifactCount',
    'physicalRequests', 'importedDocuments', 'importedChunks']), frozenInitialTaskSha256: hash }),
  notApplicable: array(member(['generation-snapshots', 'renderer-snapshot-queue', 'reasoning', 'first-visible',
    'generation-token-usage', 'successful-generation-token-usage', 'visible-artifact'])),
  limitations: array(member(['fixed-fictional-provider-output-not-literary-quality', 'cache-uncontrolled', 'no-real-model', 'single-book-only'])),
  concurrency: value => fields(value, { 1: member(['executed']), 2: member(['unsupported_not_executed']), 4: member(['unsupported_not_executed']) }),
  thresholds: value => fields(value, { target100Ms: member(['candidate_only']), target500Ms: member(['candidate_only']) }),
})

/** Performance scenes export only their known report tree, never arbitrary diagnostic keys. */
export function projectPerformanceResult(result, out, options = {}) {
  return fields(result, { scenario: member([...SCENARIOS]), theme: member(['light', 'dark']), session: member([...SCENARIOS]),
    shell: member(['writer', 'stage']), screenshot: value => typeof value === 'string' ? performanceArtifactPath(value, out, options) : null,
    failureScreenshot: value => typeof value === 'string' ? performanceArtifactPath(value, out, options) : null,
    video: value => typeof value === 'string' ? performanceArtifactPath(value, out, options) : null,
    error, measured, selection: projectPerformanceSelection, isolationRoot: privateString,
    timing: value => fields(value, numbers(['launchToInteractiveMs', 'readyToShowToInteractiveMs', 'navigationToInteractiveMs',
      'renderInteractiveMs', 'renderShelfMs', 'renderIdleMs'])),
    externalRequests: array(privateString),
    externalRequestsCoverage: member(['observed_before_quit', 'unavailable']), quit: value => fields(value, { forced: boolean }),
    ...counts(['modelRequests', 'modelRequestsAfterFinalCutoff', 'removedModelConfigs']),
    modelRequestSummary: value => fields(value, { count,
      byPath: value => fields(value, Object.fromEntries(ROUTES.map(route => [route, value => fields(value,
        { count, failed: count, maxMs: number, totalMs: number })]))),
      failures: array(value => fields(value, { path: member(ROUTES), status: count, ms: number })) }),
    residualProcesses: array(count), externalWrites: array(privateString), externalWritesIgnored: array(privateString),
    failureDiagnostics: array(failureDiagnostic), secretRedacted: boolean,
    keyScan: value => fields(value, { scanned: count, hits: array(privateString), unreadable: array(privateString), error,
      removeFailures: array(value => fields(value, { file: privateString, reason: error })) }),
  })
}
