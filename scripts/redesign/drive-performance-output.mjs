import { createHash } from 'node:crypto'
import path from 'node:path'
import { projectPerformanceSelection } from './performance-baseline.mjs'
import { GENERATION_DIAGNOSTIC_SOURCE_KINDS, MATERIAL_DECISION_CATEGORIES,
  MATERIAL_DECISION_OMISSION_REASONS, MATERIAL_DECISION_SOURCE_ID } from '../../src/shared/generation-owner-contract.ts'

const SAFE_VALUES = new Set([
  'light', 'dark', 'writer', 'stage', 'observed', 'not_observed', 'unavailable', 'uncontrolled',
  'observed_metrics', 'live_zero_events', 'insufficient_samples', 'guarded_fetch_attempts',
  'executed', 'unsupported_not_executed', 'candidate_only', 'drained', 'not_started',
  'after_drain_and_probe_stop', 'after_drain_probe_stop', 'local_observation_not_proof_of_remote_execution',
  'local-openai-compatible-fiction', 'openai', 'isolated-fixture-default-no-custom-install',
  'not_available_from_public_readback', 'not_available_http429', 'not_available_from_embedding_fixture',
  'not_applicable_embedding', 'observed_http_requests', 'before_quit',
  'fixed-fictional-400-input-200-completion-32-reasoning-when-present-not-real-billing',
  'local-guarded-fetch-observation-not-remote-execution', 'gpt-4.1', 'text-embedding-3-small',
  'generation-snapshots', 'renderer-snapshot-queue', 'reasoning', 'first-visible', 'generation-token-usage',
  'successful-generation-token-usage', 'visible-artifact', 'fixed-fictional-provider-output-not-literary-quality',
  'cache-uncontrolled', 'no-real-model', 'single-book-only',
  'isolated_project', 'after_probe_stop_attempt', 'not_entered', 'partial', 'not_recorded', 'not_needed',
  'active', 'paused', 'sealed', 'running', 'completed', 'failed', 'cancelled', 'ready',
  'reserved', 'dispatch-marked', 'settled', 'unknown', 'cancelled-before-dispatch',
  'request', 'response', 'stream', 'complete', 'parsing', 'prepared', 'knowledge', 'global', 'style',
  'blueprints', 'author-commit', 'author-publish', 'author-postprocess', 'refresh', 'reference', 'author-manuscript',
  'import-global-facts', 'import-blueprints', 'import-inference', 'import-inference:endpoint-card-recovery',
  'draft', 'chapter-draft', 'chapter-draft-short-outline', 'finalized-chapter-notes', 'finalized-character-state',
  'analyze-writing-style', 'generate-plot-outline', 'generate-world-building',
  'chapter_notes', 'character_cards',
  'AbortError', 'SocketError', 'BodyTimeoutError', 'HeadersTimeoutError', 'ConnectTimeoutError',
  'scenario', 'cleanup', 'unclassified', 'Error', 'TimeoutError', 'AssertionError', 'AggregateError', 'TypeError', 'RangeError',
  'fixture', 'runtime', 'session', 'probe_start', 'preview', 'import', 'workflow', 'verify', 'producer', 'evidence',
  'drain', 'probe_stop', 'probe_coverage', 'request_summary', 'event_coverage', 'final_request_summary',
  'driver_finalize', 'network_observation', 'quit', 'cleanup', 'quit_request_cutoff',
  'win32', 'darwin', 'linux', 'x64', 'arm64', 'fixed-histogram-upper-bounds',
  'recorded', 'admitted', 'utf8-bytes-v1', ...GENERATION_DIAGNOSTIC_SOURCE_KINDS, ...MATERIAL_DECISION_CATEGORIES,
])
const SAFE_CODES = new Set(['ERR_ASSERTION', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EIO', 'ENOENT', 'EACCES', 'EPERM',
  'PERFORMANCE_OBSERVATION_TIMEOUT', 'PERFORMANCE_PROBE_COVERAGE_UNAVAILABLE', 'PERFORMANCE_PROBE_ALREADY_RUNNING',
  'PERFORMANCE_RENDERER_PROBE_ALREADY_RUNNING', 'PERFORMANCE_RENDERER_PROBE_START_FAILED', 'PERFORMANCE_IMPORT_DRAIN_TIMEOUT',
  'PERFORMANCE_DRAFT_READ_UNAVAILABLE', 'PERFORMANCE_BLUEPRINT_READ_UNAVAILABLE', 'PERFORMANCE_REQUEST_SUMMARY_UNAVAILABLE',
  'PERFORMANCE_EVENT_COVERAGE_MISSING', 'PERFORMANCE_REQUEST_CUTOFF_CHANGED', 'PERFORMANCE_FIXTURE_REQUEST_CUTOFF_CHANGED',
  'PERFORMANCE_FINAL_REQUEST_SUMMARY_FAILED', 'PERFORMANCE_PRESSURE_TIMEOUT', 'PERFORMANCE_PRESSURE_FINAL_REQUEST_EVIDENCE_FAILED',
  'DRIVE_FINAL_OBSERVATION_TIMEOUT', 'DRIVE_EXTERNAL_REQUEST_LOG_UNAVAILABLE', 'PERFORMANCE_REQUESTS_DURING_QUIT',
  'GENERATION_PROVIDER_FAILED', 'NETWORK_ERROR', 'ROOT_BUDGET_EXHAUSTED', 'GENERATION_STORAGE_FAILED',
  'GENERATION_CONTEXT_LENGTH_EXCEEDED', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR', 'ERR_STREAM_PREMATURE_CLOSE',
  'HTTP_ERROR', 'RESPONSE_BODY_MISSING', 'PROVIDER_STREAM_ERROR', 'STREAM_INVALID', 'STREAM_INCOMPLETE',
  'TIMEOUT', 'UNCLASSIFIED_ERROR'])
const ERROR_CLASSES = new Set(['Error', 'TimeoutError', 'AssertionError', 'AggregateError', 'TypeError', 'RangeError'])
const SCENARIOS = new Set(['perf-import-10', 'perf-import-100', 'perf-import-1000', 'perf-long-stream', 'perf-slow-embedding', 'perf-rate-limit'])
const HASH_FIELDS = new Set(['modelIdHash', 'modelReceiptHash', 'chapterBriefHash', 'authorGuidanceHash', 'dependencyHash',
  'contextSnapshotHash', 'templateHash', 'skillSnapshotHash', 'modelLeaseRevision', 'policyHash', 'outputContractHash',
  'contentHash', 'promptHash', 'manifestFingerprint', 'initialDraftTaskHash', 'frozenInitialTaskSha256', 'corpusSha256', 'messagesSha256'])
const ID_FIELDS = new Set(['projectId', 'epoch', 'rootActionId', 'runId', 'rootRunId', 'attemptId', 'batchId', 'finalizationId', 'id'])

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

/** Do not expose arbitrary error messages, paths, dynamic strings or object keys from diagnostics. */
export function projectPerformanceResult(result, out, options = {}) {
  const visit = (value, key = '') => {
    if (key === 'selection') value = projectPerformanceSelection(value)
    if (Array.isArray(value)) return value.map(item => visit(item, key))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      /^[A-Za-z0-9_.-]+$/.test(name) || ['/v1/chat/completions', '/v1/embeddings', '/v1/messages'].includes(name) ? name : opaque(name),
      visit(item, name),
    ]))
    if (typeof value !== 'string') return value
    if (key === 'screenshot' || key === 'video') return performanceArtifactPath(value, out, options)
    if (key === 'sourceId') return MATERIAL_DECISION_SOURCE_ID.test(value) || /^opaque:[a-f0-9]{64}$/.test(value) ? value : opaque(value)
    if (key === 'reason' && MATERIAL_DECISION_OMISSION_REASONS.includes(value)) return value
    if (key === 'error' || key === 'reason' || key === 'stack' || key === 'message') return projectError(value)
    if (key === 'isolationRoot' || key === 'externalWrites' || key === 'externalWritesIgnored'
      || key === 'hits' || key === 'unreadable' || key === 'file') return opaque(value)
    if (ID_FIELDS.has(key)) return opaque(value)
    if (SAFE_VALUES.has(value) || SAFE_CODES.has(value)) return value
    if ((key === 'scenario' || key === 'session') && SCENARIOS.has(value)) return value
    if (HASH_FIELDS.has(key) && /^[a-f0-9]{64}$/i.test(value)) return value
    if (key === 'sourceSha' && /^[a-f0-9]{40,64}$/i.test(value)) return value
    if (['driverNode', 'electron', 'node', 'chrome'].includes(key) && /^v?\d+(?:\.\d+){1,3}$/.test(value)) return value
    return opaque(value)
  }
  return visit(result)
}
