import { createHash } from 'node:crypto'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Record<string, unknown> : null
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const integer = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && Number(value) >= minimum
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join() === [...keys].sort().join()
function invalid(): never { throw new Error('REVIEW_CYCLE_INPUT_INVALID') }

export interface ReviewCycleSource {
  projectId: string; epoch: string; sourceId: string; revision: number; contentHash: string
}
export interface M03FindingDescriptor {
  findingId: string
  source: ReviewCycleSource & { span: { start: number; end: number; unit: 'utf16-code-unit' } | null }
  excerptHash: string | null
  occurrence: number | null
  category: string
  targetId: string | null
  kind: 'objective' | 'literary'
  problemText: string
  expectedText: string | null
  status: 'unverified' | 'unresolved' | 'unknown' | 'resolved' | 'author-waived'
  evidenceHash: string | null
  confirmationItemIndex: number | null
}

/** Canonical order is finding identity order; a null span is the explicit unverified-anchor marker. */
export function canonicalM03FindingSetHash(findings: readonly M03FindingDescriptor[]): string {
  const immutable = findings.map(finding => ({ findingId: finding.findingId,
    sourceProjectId: finding.source.projectId, sourceEpoch: finding.source.epoch, sourceId: finding.source.sourceId,
    sourceRevision: finding.source.revision, sourceContentHash: finding.source.contentHash,
    spanStart: finding.source.span?.start ?? null, spanEnd: finding.source.span?.end ?? null,
    spanUnit: finding.source.span?.unit ?? null, excerptHash: finding.excerptHash, occurrence: finding.occurrence,
    category: finding.category, targetId: finding.targetId, kind: finding.kind,
    problemText: finding.problemText, expectedText: finding.expectedText }))
  return hash(JSON.stringify(immutable.sort((left, right) => left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0)))
}

interface SavedItem {
  index: number; category: string; severity: 'error' | 'warning' | 'pass' | 'unknown'; description: string
  quote?: string; goalId?: string; stableFactKey?: string
}
interface SavedGoal {
  id: string; text: string; description: string; status: 'completed' | 'unmet' | 'unknown'
  evidence: readonly { quote: string; start: number; end: number }[]
}
export interface SavedReport { items: SavedItem[]; goals: SavedGoal[] }

export function parseSavedReport(body: string): SavedReport {
  let raw: unknown
  try { raw = JSON.parse(body) } catch { invalid() }
  const report = record(raw)
  if (!report || !exactKeys(report, ['summary', 'items', 'goalReview'])
    || !nonempty(report.summary) || !Array.isArray(report.items) || report.items.length === 0) invalid()
  const goalReview = record(report.goalReview)
  if (!goalReview || !exactKeys(goalReview, ['version', 'chapterNumber', 'coverage', 'items'])
    || goalReview.version !== 1 || !integer(goalReview.chapterNumber, 1)
    || !['complete', 'unknown', 'not_configured'].includes(String(goalReview.coverage))
    || !Array.isArray(goalReview.items)) invalid()
  const goalIds = new Set<string>()
  const goals = goalReview.items.map((value): SavedGoal => {
    const item = record(value)
    if (!item || !exactKeys(item, ['id', 'text', 'status', 'description', 'evidence'])
      || !nonempty(item.id) || goalIds.has(item.id) || !nonempty(item.text) || !nonempty(item.description)
      || !['completed', 'unmet', 'unknown'].includes(String(item.status)) || !Array.isArray(item.evidence)) invalid()
    goalIds.add(item.id)
    const evidence = item.evidence.map(entry => {
      const proof = record(entry)
      if (!proof || !exactKeys(proof, ['quote', 'start', 'end']) || !nonempty(proof.quote)
        || !integer(proof.start) || proof.end !== Number(proof.start) + proof.quote.length) invalid()
      return { quote: proof.quote, start: Number(proof.start), end: Number(proof.end) }
    })
    if (item.status !== 'unknown' && evidence.length === 0) invalid()
    return { id: item.id, text: item.text, description: item.description, status: item.status as SavedGoal['status'], evidence }
  })
  const items = report.items.map((value, index): SavedItem => {
    const item = record(value)
    if (!item || Object.keys(item).some(key => ![
      'category', 'severity', 'description', 'quote', 'goalId', 'stableFactKey', 'sourceChapter',
    ].includes(key)) || !nonempty(item.category) || !nonempty(item.description)
      || !['error', 'warning', 'pass', 'unknown'].includes(String(item.severity))
      || (item.quote !== undefined && !nonempty(item.quote))
      || (item.goalId !== undefined && (!nonempty(item.goalId) || !goalIds.has(item.goalId)))
      || (item.stableFactKey !== undefined && !nonempty(item.stableFactKey))
      || (item.goalId !== undefined && item.stableFactKey !== undefined)
      || (item.stableFactKey !== undefined && (item.severity !== 'warning' || !nonempty(item.quote)
        || !integer(item.sourceChapter, 1)))
      || (item.sourceChapter !== undefined && (item.stableFactKey === undefined || !integer(item.sourceChapter, 1)))) invalid()
    return { index, category: item.category, severity: item.severity as SavedItem['severity'], description: item.description,
      ...(item.quote === undefined ? {} : { quote: item.quote }), ...(item.goalId === undefined ? {} : { goalId: item.goalId }),
      ...(item.stableFactKey === undefined ? {} : { stableFactKey: item.stableFactKey }) }
  })
  for (const goal of goals) {
    const projections = items.filter(item => item.goalId === goal.id)
    const expectedSeverity = goal.status === 'completed' ? 'pass' : goal.status === 'unmet' ? 'error' : 'unknown'
    const expectedQuote = goal.evidence.length ? goal.evidence.map(item => item.quote).join('\n') : undefined
    if (projections.length !== 1 || projections[0]!.severity !== expectedSeverity || projections[0]!.quote !== expectedQuote) invalid()
  }
  return { items, goals }
}

function locateUnique(source: string, quote: string): { start: number; end: number } | null {
  const start = source.indexOf(quote)
  return start >= 0 && source.indexOf(quote, start + 1) < 0 ? { start, end: start + quote.length } : null
}
export function finding(input: {
  source: ReviewCycleSource; sourceText: string; category: string; targetId: string | null; kind: 'objective' | 'literary'
  problemText: string; expectedText?: string; quote: string | null; anchoredStatus: 'unresolved' | 'unknown'; logicalIdentity: string
}): M03FindingDescriptor {
  const span = input.quote === null ? null : locateUnique(input.sourceText, input.quote)
  const anchored = input.targetId !== null && span !== null
  const descriptor: M03FindingDescriptor = { findingId: '',
    source: { ...input.source, span: anchored ? { ...span, unit: 'utf16-code-unit' } : null },
    excerptHash: anchored ? hash(input.quote!) : null, occurrence: anchored ? 1 : null,
    category: input.category, targetId: anchored ? input.targetId : null, kind: input.kind,
    problemText: input.problemText, expectedText: input.expectedText ?? null, status: anchored ? input.anchoredStatus : 'unverified',
    evidenceHash: null, confirmationItemIndex: null }
  const identity = { sourceProjectId: descriptor.source.projectId, sourceEpoch: descriptor.source.epoch,
    sourceId: descriptor.source.sourceId, sourceRevision: descriptor.source.revision,
    sourceContentHash: descriptor.source.contentHash, spanStart: descriptor.source.span?.start ?? null,
    spanEnd: descriptor.source.span?.end ?? null, spanUnit: descriptor.source.span?.unit ?? null,
    excerptHash: descriptor.excerptHash, occurrence: descriptor.occurrence, category: descriptor.category,
    targetId: descriptor.targetId, kind: descriptor.kind, logicalIdentity: input.logicalIdentity }
  descriptor.findingId = `finding:${hash(JSON.stringify(identity))}`
  return descriptor
}
export function buildFindings(report: SavedReport, source: ReviewCycleSource, sourceText: string): M03FindingDescriptor[] {
  const result: M03FindingDescriptor[] = [], findingById = new Map<string, M03FindingDescriptor>()
  const add = (item: M03FindingDescriptor) => {
    const existing = findingById.get(item.findingId)
    if (!existing) { result.push(item); findingById.set(item.findingId, item) }
    else if (existing.status !== item.status && item.status === 'unresolved') existing.status = 'unresolved'
  }
  for (const goal of report.goals) {
    if (goal.evidence.some(item => sourceText.slice(item.start, item.end) !== item.quote)) invalid()
    if (goal.status === 'completed') continue
    const projection = report.items.find(item => item.goalId === goal.id)!
    const quote = goal.evidence.length === 1 ? goal.evidence[0]!.quote : null
    add(finding({ source, sourceText, category: projection.category, targetId: goal.id, kind: 'objective', quote,
      problemText: projection.description, expectedText: `${goal.text}\n${goal.description}`,
      anchoredStatus: goal.status === 'unknown' ? 'unknown' : 'unresolved', logicalIdentity: `goal:${goal.id}` }))
  }
  for (const item of report.items) {
    if (item.severity === 'pass' || item.goalId) continue
    const objective = item.stableFactKey !== undefined
    add(finding({ source, sourceText, category: item.category, targetId: item.stableFactKey ?? null,
      kind: objective ? 'objective' : 'literary', quote: item.quote ?? null, problemText: item.description,
      anchoredStatus: 'unresolved', logicalIdentity: objective ? `preflight:${item.stableFactKey}` : `free:${item.index}` }))
  }
  return result
}
