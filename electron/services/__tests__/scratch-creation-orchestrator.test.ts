import { describe, expect, it, vi } from 'vitest'
import { ScratchCreationOrchestrator, type DomainFactGenerator } from '../scratch-creation-orchestrator'
import type { ScratchCreationTaskGrant } from '../../../src/shared/scratch-orchestration-contract'
import type { AutonomousCreationExecutor, ExecutionResult } from '../autonomous-creation-executor'
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
    let counter = 1
    return {
      evaluateAndRecord: vi.fn().mockImplementation(() => {
        return {
          reportId: `ar-mock-${counter++}`,
          status: 'verified',
        }
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

  it('runs complete scratch creation pipeline from zero to preliminary acceptance', async () => {
    const autonomousExecutor = createMockAutonomousExecutor()
    const acceptanceService = createMockAcceptanceService()
    const domainGenerator = createMockDomainGenerator()

    const orchestrator = new ScratchCreationOrchestrator(
      autonomousExecutor,
      acceptanceService,
      domainGenerator,
    )

    const manifest = await orchestrator.startOrchestration(validGrant)

    expect(manifest.status).toBe('completed')
    expect(manifest.currentStage).toBe('completed')
    expect(manifest.isHumanConfirmed).toBe(false)
    expect(manifest.canAutoFinalize).toBe(false)
    expect(manifest.candidateChapterIds).toEqual(['ch-1', 'ch-2'])
    expect(manifest.preliminaryReportIds.length).toBe(2)
    expect(manifest.stageReceipts.length).toBe(6)

    // Staged artifacts preserved
    expect(manifest.stagedArtifacts.foundation).toBe('Cyberpunk Eastern Fantasy Novel World')
    expect(manifest.stagedArtifacts.outline?.length).toBe(2)
    expect(manifest.stagedArtifacts.characters?.length).toBe(2)
    expect(manifest.stagedArtifacts.blueprintsCount).toBe(2)

    // Preliminary acceptance used real prose from domain generator
    expect(domainGenerator.getChapterContent).toHaveBeenCalledWith('proj-cyber-novel', 1)
    expect(domainGenerator.getChapterContent).toHaveBeenCalledWith('proj-cyber-novel', 2)
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

    expect(manifest.status).toBe('completed')
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

    expect(resumedManifest.status).toBe('completed')
    expect(resumedManifest.currentStage).toBe('completed')
    expect(resumedManifest.stagedArtifacts.outline?.length).toBe(2)
    expect(resumedManifest.stagedArtifacts.characters?.length).toBe(2)
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
})
