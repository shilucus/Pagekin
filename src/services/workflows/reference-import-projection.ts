import type { AllEventChannels, EventChannel, NovelConfig, ProjectSessionContext } from '../../shared/ipc-channels'
import { isReferenceRunProgress, REFERENCE_RUN_STAGES, type ReferenceRunProgress, type ReferenceRunRequest, type ReferenceRunResponse, type ReferenceRunStage } from '../../shared/reference-run-contract'
import type { ImportRunSnapshot } from '../../shared/import-run'
import { ipc } from '../ipc-client'
import { isReferenceStyleProgress } from '../../shared/reference-style-contract'
import { isReferenceGlobalProgress } from '../../shared/reference-global-contract'
import { isReferenceBlueprintProgress } from '../../shared/reference-blueprint-contract'
import { isReferenceKnowledgeProgress } from '../../shared/reference-knowledge-contract'
import { isReferenceRefreshProgress } from '../../shared/reference-refresh-contract'
import { projectSessionContextFromProject, sameProjectSessionContext } from '../../shared/project-session-context'
import { useProjectStore } from '../../stores/project-store'

type ChildChannel = 'reference-knowledge:v1:progress' | 'reference-knowledge:v1:refresh-progress'
  | 'import-generation:v1:global-progress' | 'import-generation:v1:style-progress' | 'import-generation:v1:blueprints-progress'
type StageEntry = { kind: 'started'; run: ImportRunSnapshot } | { kind: 'skipped'; run: ImportRunSnapshot; token: string }
type Completion = Extract<ReferenceRunProgress, { kind: 'stage-completed' }>
export class ReferenceRunFailure extends Error {
  readonly code: string
  constructor(readonly response: Extract<ReferenceRunResponse, { success: false }>) {
    super(response.error)
    this.code = response.errorCode
  }
}
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // A terminal failure can arrive before a later step starts waiting.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

/** Buffers child projection events until the matching existing workflow step is active. */
export class ReferenceImportProjection {
  private readonly entries = new Map(REFERENCE_RUN_STAGES.map(stage => [stage, deferred<StageEntry>()]))
  private readonly completions = new Map(REFERENCE_RUN_STAGES.map(stage => [stage, deferred<Completion>()]))
  private readonly childEvents = new Map<ChildChannel, unknown[]>()
  private readonly styleSnapshots = new Map<number, { config?: NovelConfig; error?: unknown }>()
  private readonly listeners = new Map<ChildChannel, (value: never) => void>()
  private readonly unsubscriptions: Array<() => void> = []
  private sequence = 0
  private nextStage = 0
  private activeStage: ReferenceRunStage | undefined
  private terminal: Promise<ReferenceRunResponse> | undefined

  constructor(private readonly session: ProjectSessionContext, private readonly request: ReferenceRunRequest, private readonly rootRunId: string) {
    const child = <C extends ChildChannel>(channel: C) => {
      this.unsubscriptions.push(ipc.on(channel, event => {
        if (!event || typeof event !== 'object' || Array.isArray(event)) return
        if ((channel === 'reference-knowledge:v1:progress' && !isReferenceKnowledgeProgress(event))
          || (channel === 'reference-knowledge:v1:refresh-progress' && !isReferenceRefreshProgress(event))
          || (channel === 'import-generation:v1:global-progress' && !isReferenceGlobalProgress(event))
          || (channel === 'import-generation:v1:style-progress' && !isReferenceStyleProgress(event))
          || (channel === 'import-generation:v1:blueprints-progress' && !isReferenceBlueprintProgress(event))) return
        const value = event as unknown as Record<string, unknown>
        const ref = value.reference as Record<string, unknown> | undefined
        const execution = value.execution as Record<string, unknown> | undefined
        if (execution?.owner !== request.execution.owner || execution.epoch !== request.execution.epoch) return
        if (ref) {
          if (ref.projectId !== request.reference.projectId || ref.runId !== request.reference.runId
            || ref.grantId !== request.reference.grantId || ref.revision !== request.reference.revision) return
        } else if (value.projectId !== request.reference.projectId || value.runId !== request.reference.runId) return
        if ('leaseId' in value && value.leaseId !== session.leaseId) return
        if (channel === 'import-generation:v1:style-progress' && isReferenceStyleProgress(event) && event.kind === 'opened'
          && !this.styleSnapshots.has(event.sequence)) {
          try {
            const project = useProjectStore.getState().currentProject
            if (!project || !sameProjectSessionContext(session, projectSessionContextFromProject(project))) throw new Error('GENERATION_AUTHOR_DRAFT_CHANGED')
            this.styleSnapshots.set(event.sequence, { config: structuredClone(project.novelConfig) })
          } catch (error) { this.styleSnapshots.set(event.sequence, { error }) }
        }
        const listener = this.listeners.get(channel)
        if (listener) listener(event as never)
        else this.childEvents.set(channel, [...(this.childEvents.get(channel) ?? []), event])
      }))
    }
    child('reference-knowledge:v1:progress')
    child('import-generation:v1:global-progress')
    child('import-generation:v1:style-progress')
    child('import-generation:v1:blueprints-progress')
    child('reference-knowledge:v1:refresh-progress')
    this.unsubscriptions.push(ipc.on('reference-run:v1:progress', event => this.receive(event)))
  }

  readonly on: typeof ipc.on = <C extends EventChannel>(channel: C, callback: (data: AllEventChannels[C]) => void) => {
    const key = channel as ChildChannel
    this.listeners.set(key, callback as (value: never) => void)
    for (const event of this.childEvents.get(key) ?? []) callback(event as AllEventChannels[C])
    this.childEvents.delete(key)
    return () => { this.listeners.delete(key) }
  }

  private fail(error: unknown): void {
    for (const item of this.entries.values()) item.reject(error)
    for (const item of this.completions.values()) item.reject(error)
  }

  private receive(event: unknown): void {
    if (!isReferenceRunProgress(event) || event.leaseId !== this.session.leaseId
      || event.reference.projectId !== this.request.reference.projectId || event.reference.runId !== this.request.reference.runId
      || event.reference.grantId !== this.request.reference.grantId || event.reference.revision !== this.request.reference.revision
      || event.execution.owner !== this.request.execution.owner || event.execution.epoch !== this.request.execution.epoch
      || event.sequence <= this.sequence) return
    this.sequence = event.sequence
    const stage = event.kind === 'stage-completed' ? event.completion.stage : event.stage
    const run = event.kind === 'stage-completed' ? event.completion.result.run : event.run
    if (run.rootRunId !== this.rootRunId) { this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')); return }
    if (stage !== REFERENCE_RUN_STAGES[this.nextStage]) { this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')); return }
    if (event.kind === 'stage-started') {
      if (this.activeStage) { this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')); return }
      this.activeStage = stage
      this.entries.get(stage)!.resolve({ kind: 'started', run: event.run })
    } else if (event.kind === 'stage-skipped') {
      if (this.activeStage) { this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')); return }
      this.entries.get(stage)!.resolve({ kind: 'skipped', run: event.run, token: event.token })
      this.nextStage++
    } else {
      if (this.activeStage !== stage) { this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')); return }
      this.completions.get(stage)!.resolve(event)
      this.activeStage = undefined
      this.nextStage++
    }
  }

  start(): void {
    this.terminal = ipc.invokeWithProjectSession(this.session, 'reference-run:v1:execute', this.request)
    void this.terminal.then(result => {
      if (!result.success) this.fail(new ReferenceRunFailure(result))
      else if (this.nextStage !== REFERENCE_RUN_STAGES.length) this.fail(new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID'))
    }, error => this.fail(error))
  }

  entry(stage: ReferenceRunStage): Promise<StageEntry> { return this.entries.get(stage)!.promise }
  completion(stage: ReferenceRunStage): Promise<Completion> { return this.completions.get(stage)!.promise }
  openedStyle(sequence: number): { config?: NovelConfig; error?: unknown } | undefined { return this.styleSnapshots.get(sequence) }

  async acknowledge(stage: ReferenceRunStage, token: string, decision: 'settled' | 'cancelled' | 'projection-failed'): Promise<void> {
    const result = await ipc.invokeWithProjectSession(this.session, 'reference-run:v1:projection-ack', {
      reference: this.request.reference, execution: this.request.execution, stage, token, decision,
    })
    if (!result || result.version !== 1) throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
  }

  async finish(): Promise<void> {
    try {
      const result = await this.terminal!
      if (!result.success) throw new ReferenceRunFailure(result)
      if (this.nextStage !== REFERENCE_RUN_STAGES.length || result.version !== 1 || result.execution !== null
        || result.run.id !== this.request.reference.runId || result.run.rootRunId !== this.rootRunId || result.run.purpose !== 'reference'
        || result.run.stage !== 'completed' || result.run.status !== 'completed') throw new Error('KNOWLEDGE_BASE_REFERENCE_EXECUTION_INVALID')
    } finally { this.close() }
  }

  close(): void { for (const unsubscribe of this.unsubscriptions.splice(0)) unsubscribe() }
}
