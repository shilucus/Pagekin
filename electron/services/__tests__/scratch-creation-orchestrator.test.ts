import { describe, expect, it, vi } from 'vitest'
import { ScratchCreationOrchestrator, type DomainFactGenerator } from '../scratch-creation-orchestrator'
import { createScratchOrchestrationManifest, type ScratchCreationTaskGrant } from '../../../src/shared/scratch-orchestration-contract'
import { AutonomousCreationExecutor, AutonomousExecutionInterruptedError, type ExecutionResult,
  type DraftStorageProvider, type ChapterGenerator } from '../autonomous-creation-executor'
import type { PreliminaryAcceptanceService } from '../preliminary-acceptance-service'

describe('ScratchCreationOrchestrator', () => {
  const createMockAutonomousExecutor = (overrides?: Partial<ExecutionResult>): AutonomousCreationExecutor => {
    return {
      executeBatchChain: vi.fn().mockResolvedValue({
        batchId: 'b-1',
        stoppedDueToConflict: false,
        completedChapters: 2,
        receipts: [
          {
            stepId: 'step-1',
            batchId: 'b-1',
            chapterNumber: 1,
            draftId: 101,
            status: 'candidate_draft_created',
            isFinalized: false,
            sourcePredecessorHash: 'hash-0',
            createdAt: Date.now(),
          },
          {
            stepId: 'step-2',
            batchId: 'b-1',
            chapterNumber: 2,
            draftId: 102,
            status: 'candidate_draft_created',
            isFinalized: false,
            sourcePredecessorHash: 'hash-1',
            createdAt: Date.now(),
          },
        ],
        ...overrides,
      }),
    } as unknown as AutonomousCreationExecutor
  }

  const createMockAcceptanceService = (): PreliminaryAcceptanceService => {
    return {
      evaluateAndRecord: vi.fn().mockImplementation(() => {
        throw new Error('PRELIMINARY_EVALUATOR_MUST_NOT_RUN')
      }),
    } as unknown as PreliminaryAcceptanceService
  }

  const createMockDomainGenerator = (overrides?: Partial<DomainFactGenerator>): DomainFactGenerator => {
    return {
      generateFoundation: vi.fn().mockResolvedValue({
        success: true,
        worldView: 'Cyberpunk Eastern Fantasy Novel World',
      }),
      generateOutline: vi.fn().mockResolvedValue({
        success: true,
        chapters: [
          { chapter: 1, summary: 'The awakening in Neo-ChangAn' },
          { chapter: 2, summary: 'Meeting the cyber-daoist mentor' },
        ],
      }),
      generateCharacters: vi.fn().mockResolvedValue({
        success: true,
        characters: [
          { name: 'Li Xuan', role: 'Protagonist' },
          { name: 'Master Mo', role: 'Mentor' },
        ],
      }),
      generateBlueprints: vi.fn().mockResolvedValue({
        success: true,
        count: 2,
      }),
      getChapterContent: vi.fn().mockResolvedValue('Real generated chapter content prose from storage'),
      ...overrides,
    }
  }

  const validGrant: ScratchCreationTaskGrant = {
    grantId: 'grant-001',
    projectId: 'proj-cyber-novel',
    authorTaskPrompt: 'Write a cyberpunk eastern cultivation novel',
    targetChapterCount: 2,
    maxRepairAttempts: 2,
    allowedStages: [
      'foundation_setup',
      'outline_generation',
      'character_roster',
      'blueprint_planning',
      'candidate_drafting',
      'preliminary_acceptance',
    ],
    timestamp: Date.now(),
  }

  it('preserves generated candidates and suspends when preliminary evidence is unavailable', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator()

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    const manifest = await orchestrator.startOrchestration(validGrant)

    expect(manifest.status).toBe('suspended')
    expect(manifest.currentStage).toBe('suspended_needs_author')
    expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
    expect(manifest.suspensionReason).toBe('SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE')
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.isHumanConfirmed).toBe(false)
    expect(manifest.canAutoFinalize).toBe(false)
    expect(manifest.candidateChapterIds).toEqual(['101', '102'])
    expect(manifest.draftingExecutionResults).toHaveLength(1)
    expect(manifest.preliminaryReportIds).toEqual([])
    expect(manifest.stageReceipts.length).toBe(6)
    expect(manifest.stageReceipts[5]).toMatchObject({
      stage: 'preliminary_acceptance',
      success: false,
      entityCount: 0,
      error: 'SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE',
    })

    // Staged artifacts preserved
    expect(manifest.stagedArtifacts.foundation).toBe('Cyberpunk Eastern Fantasy Novel World')
    expect(manifest.stagedArtifacts.outline?.length).toBe(2)
    expect(manifest.stagedArtifacts.characters?.length).toBe(2)
    expect(manifest.stagedArtifacts.blueprintsCount).toBe(2)

    expect(domainGenerator.getChapterContent).not.toHaveBeenCalled()
    expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
  })

  it.each(['absent', 'null', 'prose', 'throws'] as const)(
    'does not consult a %s chapter content getter to manufacture preliminary evidence',
    async (contentCase) => {
      const getChapterContent = contentCase === 'absent'
        ? undefined
        : vi.fn().mockImplementation(async () => {
            if (contentCase === 'throws') {
              throw new Error('CHAPTER_CONTENT_MUST_NOT_BE_READ')
            }
            return contentCase === 'prose' ? 'Existing fictional chapter prose without versioned evidence' : null
          })
      const acceptanceService = createMockAcceptanceService()
      const orchestrator = new ScratchCreationOrchestrator(
        createMockAutonomousExecutor(),
        acceptanceService,
        createMockDomainGenerator({ getChapterContent }),
      )

      const manifest = await orchestrator.startOrchestration({ ...validGrant, maxRepairAttempts: 1 })

      expect(manifest.status).toBe('suspended')
      expect(manifest.currentStage).toBe('suspended_needs_author')
      expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
      expect(manifest.suspensionReason).toBe('SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE')
      expect(manifest.repairAttempts).toBe(0)
      expect(manifest.preliminaryReportIds).toEqual([])
      expect(manifest.stageReceipts.filter(receipt => receipt.stage === 'preliminary_acceptance')).toEqual([
        expect.objectContaining({ success: false, entityCount: 0, error: 'SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE' }),
      ])
      if (getChapterContent) {
        expect(getChapterContent).not.toHaveBeenCalled()
      }
      expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
    },
  )

  it('keeps staged prose, report IDs and history through two default resumes without regeneration', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator({
      generateFoundation: vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'Temporary foundation failure' })
        .mockResolvedValue({ success: true, worldView: 'Recovered fictional foundation' }),
    })
    const orchestrator = new ScratchCreationOrchestrator(autonomousExecutor, acceptanceService, domainGenerator)
    const manifest = await orchestrator.startOrchestration(validGrant)
    manifest.stagedArtifacts.draftContents = { 1: 'Existing unversioned fictional draft', 2: 'Another fictional draft' }
    manifest.preliminaryReportIds.push('existing-report-id')
    const stagedArtifacts = structuredClone(manifest.stagedArtifacts)
    const candidateChapterIds = [...manifest.candidateChapterIds]
    const stageHistory = structuredClone(manifest.stageReceipts)
    const initialUpdatedAt = manifest.updatedAt
    const clock = vi.spyOn(Date, 'now')

    try {
      for (const attempt of [1, 2]) {
        const updatedAt = initialUpdatedAt + attempt * 100
        clock.mockReturnValue(updatedAt)
        const resumed = await orchestrator.resumeOrchestration(manifest.orchestrationId)

        expect(resumed).toBe(manifest)
        expect(resumed.status).toBe('suspended')
        expect(resumed.currentStage).toBe('suspended_needs_author')
        expect(resumed.suspendedAtStage).toBe('preliminary_acceptance')
        expect(resumed.suspensionReason).toBe('SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE')
        expect(resumed.updatedAt).toBe(updatedAt)
        expect(resumed.repairAttempts).toBe(0)
        expect(resumed.candidateChapterIds).toEqual(candidateChapterIds)
        expect(resumed.preliminaryReportIds).toEqual(['existing-report-id'])
        expect(resumed.stagedArtifacts).toEqual(stagedArtifacts)
        expect(resumed.stageReceipts.slice(0, stageHistory.length)).toEqual(stageHistory)
        expect(resumed.stageReceipts).toHaveLength(stageHistory.length + attempt)
        expect(resumed.stageReceipts.slice(stageHistory.length)).toEqual(
          Array.from({ length: attempt }, () => expect.objectContaining({
            stage: 'preliminary_acceptance',
            success: false,
            entityCount: 0,
            error: 'SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE',
          })),
        )
      }
    } finally {
      clock.mockRestore()
    }

    expect(domainGenerator.generateFoundation).toHaveBeenCalledTimes(2)
    expect(domainGenerator.generateOutline).toHaveBeenCalledTimes(1)
    expect(domainGenerator.generateCharacters).toHaveBeenCalledTimes(1)
    expect(domainGenerator.generateBlueprints).toHaveBeenCalledTimes(1)
    expect(autonomousExecutor.executeBatchChain).toHaveBeenCalledTimes(1)
    expect(domainGenerator.getChapterContent).not.toHaveBeenCalled()
    expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
  })

  it('preserves explicit earlier-stage retry without bypassing preliminary suspension', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator()
    const orchestrator = new ScratchCreationOrchestrator(autonomousExecutor, acceptanceService, domainGenerator)
    const manifest = await orchestrator.startOrchestration(validGrant)
    const stageHistory = structuredClone(manifest.stageReceipts)

    const resumed = await orchestrator.resumeOrchestration(manifest.orchestrationId, 'outline_generation')

    expect(resumed.status).toBe('suspended')
    expect(resumed.suspendedAtStage).toBe('preliminary_acceptance')
    expect(resumed.stageReceipts.slice(0, stageHistory.length)).toEqual(stageHistory)
    expect(domainGenerator.generateFoundation).toHaveBeenCalledTimes(1)
    expect(domainGenerator.generateOutline).toHaveBeenCalledTimes(2)
    expect(domainGenerator.generateCharacters).toHaveBeenCalledTimes(2)
    expect(domainGenerator.generateBlueprints).toHaveBeenCalledTimes(2)
    expect(autonomousExecutor.executeBatchChain).toHaveBeenCalledTimes(2)
    expect(domainGenerator.getChapterContent).not.toHaveBeenCalled()
    expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
  })

  it('converges in-stage retry before hitting max repair attempts limit', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    let foundationAttempt = 0
    const domainGenerator = createMockDomainGenerator({
      generateFoundation: vi.fn().mockImplementation(async () => {
        foundationAttempt++
        if (foundationAttempt === 1) {
          return { success: false, error: 'Temporary transient error' }
        }
        return { success: true, worldView: 'Recovered WorldView' }
      }),
    })

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    const manifest = await orchestrator.startOrchestration(validGrant)

    expect(manifest.status).toBe('suspended')
    expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
    expect(manifest.stagedArtifacts.foundation).toBe('Recovered WorldView')
    // Should have a failed receipt followed by a success receipt for foundation_setup
    const foundationReceipts = manifest.stageReceipts.filter(r => r.stage === 'foundation_setup')
    expect(foundationReceipts.length).toBe(2)
    expect(foundationReceipts[0].success).toBe(false)
    expect(foundationReceipts[1].success).toBe(true)
  })

  it('suspends pipeline and records suspendedAtStage when stage failure reaches max repair attempts limit', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator({
      generateOutline: vi.fn().mockResolvedValue({
        success: false,
        error: 'Failed to balance plot tension curve',
      }),
    })

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    const singleAttemptGrant: ScratchCreationTaskGrant = {
      ...validGrant,
      maxRepairAttempts: 1,
    }

    const manifest = await orchestrator.startOrchestration(singleAttemptGrant)

    expect(manifest.status).toBe('suspended')
    expect(manifest.currentStage).toBe('suspended_needs_author')
    expect(manifest.suspendedAtStage).toBe('outline_generation')
    expect(manifest.repairAttempts).toBe(1)
    expect(manifest.suspensionReason).toContain('Failed to balance plot tension curve')
    expect(manifest.suspensionReason).toContain('挂起等待作者裁决，绝不编造确认')

    // Prior staged foundation artifact is preserved
    expect(manifest.stagedArtifacts.foundation).toBe('Cyberpunk Eastern Fantasy Novel World')

    // Further stages should not have been executed
    expect(domainGenerator.generateCharacters).not.toHaveBeenCalled()
    expect(autonomousExecutor.executeBatchChain).not.toHaveBeenCalled()
  })

  it('self-heals and resumes suspended orchestration preserving all prior staged artifacts', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    let outlineAttempt = 0
    const domainGenerator = createMockDomainGenerator({
      generateOutline: vi.fn().mockImplementation(async () => {
        outlineAttempt++
        if (outlineAttempt === 1) {
          return { success: false, error: 'Temporary context overflow' }
        }
        return {
          success: true,
          chapters: [
            { chapter: 1, summary: 'Fixed outline ch 1' },
            { chapter: 2, summary: 'Fixed outline ch 2' },
          ],
        }
      }),
    })

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    const manifest = await orchestrator.startOrchestration({
      ...validGrant,
      maxRepairAttempts: 1,
    })

    expect(manifest.status).toBe('suspended')
    expect(manifest.suspendedAtStage).toBe('outline_generation')
    // Prior foundation was staged
    expect(manifest.stagedArtifacts.foundation).toBe('Cyberpunk Eastern Fantasy Novel World')

    // Author resumes via public API (NO manual property manipulation!)
    const resumedManifest = await orchestrator.resumeOrchestration(manifest.orchestrationId)

    expect(resumedManifest.status).toBe('suspended')
    expect(resumedManifest.currentStage).toBe('suspended_needs_author')
    expect(resumedManifest.suspendedAtStage).toBe('preliminary_acceptance')
    expect(resumedManifest.stagedArtifacts.outline?.length).toBe(2)
    expect(resumedManifest.stagedArtifacts.characters?.length).toBe(2)
    expect(domainGenerator.generateFoundation).toHaveBeenCalledTimes(1)
    expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
  })

  it('strictly respects allowedStages and halts before unauthorized candidate drafting', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator()

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    // Author only authorizes planning stages (no drafting or acceptance)
    const planningOnlyGrant: ScratchCreationTaskGrant = {
      ...validGrant,
      allowedStages: [
        'foundation_setup',
        'outline_generation',
        'character_roster',
        'blueprint_planning',
      ],
    }

    const manifest = await orchestrator.startOrchestration(planningOnlyGrant)

    expect(manifest.status).toBe('completed')
    expect(manifest.stagedArtifacts.blueprintsCount).toBe(2)
    // Autonomous drafting was not executed because it was not in allowedStages
    expect(autonomousExecutor.executeBatchChain).not.toHaveBeenCalled()
    expect(acceptanceService.evaluateAndRecord).not.toHaveBeenCalled()
    expect(manifest.candidateChapterIds).toEqual([])
  })

  it('rejects invalid grant inputs', async () => {
    const orchestrator = new ScratchCreationOrchestrator(
      createMockAutonomousExecutor(),
      createMockAcceptanceService(),
      createMockDomainGenerator(),
    )

    await expect(
      orchestrator.startOrchestration({
        ...validGrant,
        grantId: '',
      }),
    ).rejects.toThrow('授权 ID 缺失')

    await expect(
      orchestrator.startOrchestration({
        ...validGrant,
        targetChapterCount: 0,
      }),
    ).rejects.toThrow('超出限制')

    await expect(
      orchestrator.startOrchestration({
        ...validGrant,
        allowedStages: [],
      }),
    ).rejects.toThrow('授权阶段集合 (allowedStages) 不能为空')
  })

  it('isolates orchestrations across multiple book projects', async () => {
    const orchestrator = new ScratchCreationOrchestrator(
      createMockAutonomousExecutor(),
      createMockAcceptanceService(),
      createMockDomainGenerator(),
    )

    const m1 = await orchestrator.startOrchestration({
      ...validGrant,
      grantId: 'grant-book-1',
      projectId: 'proj-1',
    })

    const m2 = await orchestrator.startOrchestration({
      ...validGrant,
      grantId: 'grant-book-2',
      projectId: 'proj-2',
    })

    expect(m1.orchestrationId).not.toBe(m2.orchestrationId)
    expect(orchestrator.getOrchestration(m1.orchestrationId)?.projectId).toBe('proj-1')
    expect(orchestrator.getOrchestration(m2.orchestrationId)?.projectId).toBe('proj-2')

    // Clearing proj-1 should not affect proj-2
    orchestrator.clearProjectOrchestrations('proj-1')
    expect(orchestrator.getOrchestration(m1.orchestrationId)).toBeUndefined()
    expect(orchestrator.getOrchestration(m2.orchestrationId)).toBeDefined()
  })

  function realDraftingFixture(options: {
    generate?: ChapterGenerator['generateChapter']
    read?: DraftStorageProvider['getDraft']
    saveFailureAt?: number
    commitBeforeThrow?: boolean
  } = {}) {
    const saved = new Map<number, { draftId: number; version: number; contentHash: string; content: string }>()
    const storage: DraftStorageProvider = {
      getDraft: vi.fn(options.read ?? (async chapterNumber => saved.get(chapterNumber) ?? null)),
      saveCandidateDraft: vi.fn(async (chapterNumber, content) => {
        const row = { draftId: 1000 + chapterNumber, version: 1, contentHash: `fictional-hash-${chapterNumber}`, content }
        if (options.saveFailureAt === chapterNumber) {
          if (options.commitBeforeThrow) saved.set(chapterNumber, row)
          throw new Error('PRIVATE_STORAGE_DETAIL_DO_NOT_RETAIN')
        }
        saved.set(chapterNumber, row)
        return row
      }),
    }
    const generator: ChapterGenerator = {
      generateChapter: vi.fn(options.generate ?? (async chapterNumber => ({ content: `Fictional chapter ${chapterNumber}` }))),
    }
    const executor = new AutonomousCreationExecutor({ storage, generator })
    const execute = vi.spyOn(executor, 'executeBatchChain')
    const domain = createMockDomainGenerator()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    return { saved, storage, generator, executor, execute, domain, orchestrator }
  }

  async function expectBarrierResumesInert(f: ReturnType<typeof realDraftingFixture>, manifest: Awaited<ReturnType<ScratchCreationOrchestrator['startOrchestration']>>) {
    const before = structuredClone(manifest), storedBefore = [...f.saved.entries()]
    const calls = f.execute.mock.calls.length
    for (const stage of [undefined, 'candidate_drafting', 'foundation_setup', 'outline_generation', undefined] as const) {
      expect(await f.orchestrator.resumeOrchestration(manifest.orchestrationId, stage)).toBe(manifest)
      expect(manifest).toEqual(before)
      expect([...f.saved.entries()]).toEqual(storedBefore)
      expect(f.execute).toHaveBeenCalledTimes(calls)
    }
    expect(f.domain.generateFoundation).toHaveBeenCalledTimes(1)
    expect(f.domain.generateOutline).toHaveBeenCalledTimes(1)
    expect(f.domain.generateBlueprints).toHaveBeenCalledTimes(1)
  }

  it.each([1, 2])('retains actual unknown receipts after %i generation calls and blocks every resume path', async chapterNumber => {
    const f = realDraftingFixture({ generate: async chapter => ({ content: 'Fictional prose', status: chapter === chapterNumber ? 'unknown' : 'succeeded' }) })
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(manifest).toMatchObject({ status: 'suspended', suspendedAtStage: 'candidate_drafting', candidateDraftingBarrier: 'unknown', repairAttempts: 0 })
    expect(manifest.draftingExecutionResults).toEqual([expect.objectContaining({ completedChapters: chapterNumber - 1,
      receipts: expect.arrayContaining([expect.objectContaining({ chapterNumber, status: 'unknown', draftId: 0 })]) })])
    expect(manifest.candidateChapterIds).toEqual(chapterNumber === 1 ? [] : ['1001'])
    expect(f.storage.saveCandidateDraft).toHaveBeenCalledTimes(chapterNumber - 1)
    await expectBarrierResumesInert(f, manifest)
  })

  it.each(['missing', 'changed'] as const)('retains the saved prefix and actual %s predecessor conflict without retry', async kind => {
    const f = realDraftingFixture({ read: async () => kind === 'missing' ? null : { version: 2, contentHash: 'changed-fictional-predecessor' } })
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(manifest.candidateDraftingBarrier).toBe('predecessor_conflict')
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.candidateChapterIds).toEqual(['1001'])
    expect(manifest.draftingExecutionResults[0]).toMatchObject({ completedChapters: 1, stoppedDueToConflict: true })
    expect(manifest.draftingExecutionResults[0].receipts.map(receipt => receipt.status)).toEqual(['candidate_draft_created', 'predecessor_conflict_readonly'])
    expect(f.generator.generateChapter).toHaveBeenCalledTimes(1)
    expect(f.storage.saveCandidateDraft).toHaveBeenCalledTimes(1)
    await expectBarrierResumesInert(f, manifest)
  })

  it('retains a failed second step after saving the first candidate and never spends a retry on the partial batch', async () => {
    const f = realDraftingFixture({ generate: async chapter => ({ content: 'Fictional prose', status: chapter === 2 ? 'failed' : 'succeeded' }) })
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(manifest.candidateDraftingBarrier).toBe('partial')
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.candidateChapterIds).toEqual(['1001'])
    expect(manifest.draftingExecutionResults[0].receipts.map(receipt => receipt.status)).toEqual(['candidate_draft_created', 'failed'])
    await expectBarrierResumesInert(f, manifest)
  })

  it.each([
    ['generation', 1, false], ['generation', 2, false], ['predecessor_read', 2, false],
    ['candidate_save', 1, false], ['candidate_save', 2, false],
    ['candidate_save', 1, true], ['candidate_save', 2, true],
  ] as const)('retains the actual prefix on %s chapter %i throw (save already committed: %s)', async (phase, chapterNumber, commitBeforeThrow) => {
    const f = realDraftingFixture({
      ...(phase === 'generation' ? { generate: async (chapter: number) => {
        if (chapter === chapterNumber) throw new Error('PRIVATE_PROVIDER_DETAIL_DO_NOT_RETAIN')
        return { content: 'Fictional prose' }
      } } : {}),
      ...(phase === 'predecessor_read' ? { read: async () => { throw new Error('PRIVATE_READ_DETAIL_DO_NOT_RETAIN') } } : {}),
      ...(phase === 'candidate_save' ? { saveFailureAt: chapterNumber, commitBeforeThrow } : {}),
    })
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(manifest.candidateDraftingBarrier).toBe(phase === 'candidate_save' ? 'unproven' : 'interrupted')
    expect(manifest.suspensionReason).toBe(`AUTONOMOUS_EXECUTION_INTERRUPTED:${phase}:${chapterNumber}`)
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.draftingExecutionResults).toEqual([expect.objectContaining({ completedChapters: chapterNumber - 1 })])
    expect(manifest.draftingExecutionResults[0].receipts).toHaveLength(chapterNumber - 1)
    expect(manifest.candidateChapterIds).toEqual(chapterNumber === 1 ? [] : ['1001'])
    expect(f.saved.size).toBe(chapterNumber - 1 + (commitBeforeThrow ? 1 : 0))
    expect(JSON.stringify(manifest)).not.toContain('PRIVATE_')
    await expectBarrierResumesInert(f, manifest)
  })

  it('does not invent a zero-effect result from an untyped executor exception', async () => {
    const f = realDraftingFixture()
    f.execute.mockRejectedValue(new Error('PRIVATE_UNTYPED_EXCEPTION_DO_NOT_RETAIN'))
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(manifest.candidateDraftingBarrier).toBe('interrupted')
    expect(manifest.draftingExecutionResults).toEqual([])
    expect(manifest.candidateChapterIds).toEqual([])
    expect(manifest.repairAttempts).toBe(0)
    expect(JSON.stringify(manifest)).not.toContain('PRIVATE_')
    await expectBarrierResumesInert(f, manifest)
  })

  it('retains separate cloned returned and typed-interruption results rather than mutable executor objects', async () => {
    const f = realDraftingFixture()
    const empty: ExecutionResult = { batchId: 'fictional-batch', receipts: [], stoppedDueToConflict: false, completedChapters: 0 }
    const interrupted = new AutonomousExecutionInterruptedError('generation', 1, empty)
    f.execute.mockRejectedValue(interrupted)
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    interrupted.actualExecutionResult.completedChapters = 9
    empty.completedChapters = 8
    expect(manifest.draftingExecutionResults[0].completedChapters).toBe(0)

    const returned = realDraftingFixture()
    const result: ExecutionResult = { batchId: 'fictional-batch', receipts: [], stoppedDueToConflict: false, completedChapters: 0 }
    returned.execute.mockResolvedValue(result)
    const other = await returned.orchestrator.startOrchestration(validGrant)
    result.completedChapters = 9
    expect(other.draftingExecutionResults[0].completedChapters).toBe(0)
    expect(other.candidateDraftingBarrier).toBe('unproven')
  })

  it.each(['empty', 'duplicate', 'wrong-chapter', 'counter-only', 'repair-only', 'invalid-id'] as const)('rejects %s drafting success without exact target chapter receipts', async kind => {
    const executor = createMockAutonomousExecutor()
    const result = await executor.executeBatchChain({ batchId: 'fixture', grantId: 'fixture', projectId: 'fixture', startChapter: 1, chapterCount: 2, predecessorChain: [] })
    if (kind === 'empty') { result.receipts = []; result.completedChapters = 0 }
    if (kind === 'duplicate') result.receipts[1].chapterNumber = 1
    if (kind === 'wrong-chapter') result.receipts[1].chapterNumber = 3
    if (kind === 'counter-only') result.receipts = []
    if (kind === 'repair-only') { result.receipts[0].status = 'repair_converged'; result.receipts = [result.receipts[0]]; result.completedChapters = 0 }
    if (kind === 'invalid-id') result.receipts[1].draftId = 0
    vi.mocked(executor.executeBatchChain).mockResolvedValue(result)
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), createMockDomainGenerator())
    const manifest = await orchestrator.startOrchestration(validGrant)
    expect(manifest.status).toBe('suspended')
    expect(manifest.suspendedAtStage).toBe('candidate_drafting')
    expect(manifest.candidateDraftingBarrier).toBe(kind === 'duplicate' || kind === 'wrong-chapter' || kind === 'invalid-id' ? 'partial' : 'unproven')
    expect(manifest.repairAttempts).toBe(0)
    expect(manifest.draftingExecutionResults).toEqual([result])
    expect(executor.executeBatchChain).toHaveBeenCalledTimes(2)
    if (kind === 'invalid-id') expect(manifest.candidateChapterIds).toEqual(['101'])
  })

  it('retains safe failed attempts and then accepts actual complete target receipts from the real executor', async () => {
    let calls = 0
    const f = realDraftingFixture({ generate: async chapter => ({ content: `Fictional chapter ${chapter}`, status: ++calls === 1 ? 'failed' : 'succeeded' }) })
    const manifest = await f.orchestrator.startOrchestration(validGrant)
    expect(f.execute).toHaveBeenCalledTimes(2)
    expect(manifest.draftingExecutionResults.map(result => result.completedChapters)).toEqual([0, 2])
    expect(manifest.draftingExecutionResults[0].receipts[0].status).toBe('failed')
    expect(manifest.draftingExecutionResults[1].receipts.map(receipt => receipt.chapterNumber)).toEqual([1, 2])
    expect(manifest.candidateChapterIds).toEqual(['1001', '1002'])
    expect(manifest.candidateDraftingBarrier).toBeUndefined()
    expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
    expect(manifest.stageReceipts.filter(receipt => receipt.stage === 'candidate_drafting').map(receipt => receipt.success)).toEqual([false, true])
  })

  it('exhausts finite safe zero-save failed attempts while retaining every real result', async () => {
    const f = realDraftingFixture({ generate: async () => ({ content: '', status: 'failed' }) })
    const manifest = await f.orchestrator.startOrchestration({ ...validGrant, maxRepairAttempts: 3 })
    expect(f.execute).toHaveBeenCalledTimes(3)
    expect(f.storage.saveCandidateDraft).not.toHaveBeenCalled()
    expect(manifest.repairAttempts).toBe(3)
    expect(manifest.candidateDraftingBarrier).toBeUndefined()
    expect(manifest.suspendedAtStage).toBe('candidate_drafting')
    expect(manifest.draftingExecutionResults).toHaveLength(3)
    expect(manifest.draftingExecutionResults.every(result => result.completedChapters === 0 && result.receipts.length === 1 && result.receipts[0].status === 'failed')).toBe(true)
    expect(manifest.candidateChapterIds).toEqual([])
  })

  it('shares the start pipeline with all busy resumes before any phase or repair-budget reset', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1794300000000)
    let release!: (value: { success: boolean; worldView: string }) => void, entered!: () => void
    const gated = new Promise<{ success: boolean; worldView: string }>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const domain = createMockDomainGenerator({ generateFoundation: vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'Fictional safe foundation failure' })
      .mockImplementationOnce(() => { entered(); return gated }) })
    const executor = createMockAutonomousExecutor()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    try {
      const started = orchestrator.startOrchestration(validGrant)
      await waiting
      const id = createScratchOrchestrationManifest(validGrant).orchestrationId
      const manifest = orchestrator.getOrchestration(id)!
      const before = structuredClone(manifest)
      expect(manifest.repairAttempts).toBe(1)
      const busy = [undefined, 'foundation_setup', 'outline_generation']
        .map(stage => orchestrator.resumeOrchestration(id, stage as 'foundation_setup' | 'outline_generation' | undefined))
      expect(manifest).toEqual(before)
      expect(domain.generateFoundation).toHaveBeenCalledTimes(2)
      release({ success: true, worldView: 'Gated fictional foundation' })
      const results = await Promise.all([started, ...busy])
      expect(results.every(result => result === manifest)).toBe(true)
      expect(executor.executeBatchChain).toHaveBeenCalledTimes(1)
      expect(domain.generateOutline).toHaveBeenCalledTimes(1)
      expect(manifest.draftingExecutionResults).toHaveLength(1)
    } finally { clock.mockRestore() }
  })

  it('removes a rejected active flight so an explicit retry can run again', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1794300000001)
    const domain = createMockDomainGenerator({ generateFoundation: vi.fn()
      .mockResolvedValueOnce({ success: true, get worldView(): string { throw new Error('SYNTHETIC_PIPELINE_REJECTION') } })
      .mockResolvedValue({ success: true, worldView: 'Recovered fictional foundation' }) })
    const executor = createMockAutonomousExecutor()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    try {
      await expect(orchestrator.startOrchestration(validGrant)).rejects.toThrow('SYNTHETIC_PIPELINE_REJECTION')
      const id = createScratchOrchestrationManifest(validGrant).orchestrationId
      const resumed = await orchestrator.resumeOrchestration(id, 'foundation_setup')
      expect(resumed.suspendedAtStage).toBe('preliminary_acceptance')
      expect(domain.generateFoundation).toHaveBeenCalledTimes(2)
      expect(executor.executeBatchChain).toHaveBeenCalledTimes(1)
    } finally { clock.mockRestore() }
  })

  it('coalesces concurrent resumes of a suspended task and leaves a busy earlier-stage request inert', async () => {
    let release!: (value: { success: boolean; chapters: Array<{ chapter: number; summary: string }> }) => void, entered!: () => void
    const gated = new Promise<{ success: boolean; chapters: Array<{ chapter: number; summary: string }> }>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const domain = createMockDomainGenerator({ generateOutline: vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'Fictional outline failure' })
      .mockImplementationOnce(() => { entered(); return gated }) })
    const executor = createMockAutonomousExecutor()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    const manifest = await orchestrator.startOrchestration({ ...validGrant, maxRepairAttempts: 1 })
    expect(manifest.suspendedAtStage).toBe('outline_generation')
    const resumed = orchestrator.resumeOrchestration(manifest.orchestrationId)
    await waiting
    const before = structuredClone(manifest)
    const duplicates = [orchestrator.resumeOrchestration(manifest.orchestrationId),
      orchestrator.resumeOrchestration(manifest.orchestrationId, 'foundation_setup')]
    expect(manifest).toEqual(before)
    release({ success: true, chapters: [{ chapter: 1, summary: 'Fictional first chapter' }, { chapter: 2, summary: 'Fictional second chapter' }] })
    const results = await Promise.all([resumed, ...duplicates])
    expect(results.every(result => result === manifest)).toBe(true)
    expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
    expect(domain.generateFoundation).toHaveBeenCalledTimes(1)
    expect(domain.generateOutline).toHaveBeenCalledTimes(2)
    expect(domain.generateBlueprints).toHaveBeenCalledTimes(1)
    expect(executor.executeBatchChain).toHaveBeenCalledTimes(1)
    expect(manifest.draftingExecutionResults).toHaveLength(1)
  })

  it('rejects colliding active start IDs before replacing the original manifest, grant or flight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1794300000002)
    let release!: (value: { success: boolean; worldView: string }) => void, entered!: () => void
    const gated = new Promise<{ success: boolean; worldView: string }>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const domain = createMockDomainGenerator({ generateFoundation: vi.fn(() => { entered(); return gated }) })
    const executor = createMockAutonomousExecutor()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    try {
      const started = orchestrator.startOrchestration(validGrant)
      await waiting
      const id = createScratchOrchestrationManifest(validGrant).orchestrationId
      const manifest = orchestrator.getOrchestration(id)!, before = structuredClone(manifest)
      await expect(orchestrator.startOrchestration({ ...validGrant, targetChapterCount: 1, maxRepairAttempts: 1,
        allowedStages: ['foundation_setup'] })).rejects.toThrow('SCRATCH_ORCHESTRATION_ID_CONFLICT')
      expect(orchestrator.getOrchestration(id)).toBe(manifest)
      expect(manifest).toEqual(before)
      const resumed = orchestrator.resumeOrchestration(id, 'foundation_setup')
      release({ success: true, worldView: 'Original fictional foundation' })
      expect(await resumed).toBe(await started)
      expect(manifest.suspendedAtStage).toBe('preliminary_acceptance')
      expect(domain.generateFoundation).toHaveBeenCalledTimes(1)
      expect(executor.executeBatchChain).toHaveBeenCalledTimes(1)
      expect(vi.mocked(executor.executeBatchChain).mock.calls[0][0].chapterCount).toBe(2)
    } finally { clock.mockRestore() }
  })

  it('rejects completed ID collisions without clobbering retained history', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1794300000003)
    const domain = createMockDomainGenerator(), executor = createMockAutonomousExecutor()
    const orchestrator = new ScratchCreationOrchestrator(executor, createMockAcceptanceService(), domain)
    try {
      const manifest = await orchestrator.startOrchestration({ ...validGrant, allowedStages: ['foundation_setup'] })
      const before = structuredClone(manifest)
      expect(manifest.status).toBe('completed')
      await expect(orchestrator.startOrchestration(validGrant)).rejects.toThrow('SCRATCH_ORCHESTRATION_ID_CONFLICT')
      expect(orchestrator.getOrchestration(manifest.orchestrationId)).toBe(manifest)
      expect(manifest).toEqual(before)
      expect(domain.generateFoundation).toHaveBeenCalledTimes(1)
      expect(executor.executeBatchChain).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })
})
