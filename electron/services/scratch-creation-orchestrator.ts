import {
  assembleStageExecutionReceipt,
  createScratchOrchestrationManifest,
  validateScratchCreationGrant,
  type ScratchCreationStage,
  type ScratchCreationTaskGrant,
  type ScratchOrchestrationManifest,
} from '../../src/shared/scratch-orchestration-contract'
import type { AutonomousBatchChainConfig, AutonomousStepReceipt } from '../../src/shared/autonomous-executor-contract'
import type { AutonomousCreationExecutor } from './autonomous-creation-executor'
import type { PreliminaryAcceptanceService } from './preliminary-acceptance-service'

export interface DomainFactGenerator {
  generateFoundation(prompt: string): Promise<{ success: boolean; worldView?: string; error?: string }>
  generateOutline(
    prompt: string,
    foundation: unknown,
  ): Promise<{ success: boolean; chapters?: Array<{ chapter: number; summary: string }>; error?: string }>
  generateCharacters(
    prompt: string,
    outline: unknown,
  ): Promise<{ success: boolean; characters?: Array<{ name: string; role: string }>; error?: string }>
  generateBlueprints(
    prompt: string,
    chapters: Array<{ chapter: number; summary: string }>,
    characters: unknown,
  ): Promise<{ success: boolean; count?: number; error?: string }>
  getChapterContent?(projectId: string, chapterNumber: number): Promise<string | null>
}

export class ScratchCreationOrchestrator {
  private readonly manifests = new Map<string, ScratchOrchestrationManifest>()
  private readonly grants = new Map<string, ScratchCreationTaskGrant>()

  constructor(
    private readonly autonomousExecutor: AutonomousCreationExecutor,
    _acceptanceService: PreliminaryAcceptanceService,
    private readonly domainGenerator: DomainFactGenerator,
  ) {}

  /**
   * 启动从零创作编排任务
   */
  public async startOrchestration(grant: ScratchCreationTaskGrant): Promise<ScratchOrchestrationManifest> {
    const grantCheck = validateScratchCreationGrant(grant)
    if (!grantCheck.valid) {
      throw new Error(`从零创作授权校验失败: ${grantCheck.reason}`) // i18n-exempt: 内部断言错误
    }

    const manifest = createScratchOrchestrationManifest(grant)
    this.manifests.set(manifest.orchestrationId, manifest)
    this.grants.set(manifest.orchestrationId, grant)

    return this.runPipeline(manifest, grant)
  }

  /**
   * 恢复挂起的编排任务（作者介入后自愈重试断点阶段）
   */
  public async resumeOrchestration(
    orchestrationId: string,
    retryStage?: ScratchCreationStage,
  ): Promise<ScratchOrchestrationManifest> {
    const manifest = this.manifests.get(orchestrationId)
    const grant = this.grants.get(orchestrationId)
    if (!manifest || !grant) {
      throw new Error(`未找到从零编排任务 [${orchestrationId}]`) // i18n-exempt: 内部断言错误
    }

    if (manifest.status === 'completed') {
      return manifest
    }

    // 自愈恢复断点：重置为挂起时的阶段，若未指定则使用 suspendedAtStage
    const targetStage = retryStage ?? manifest.suspendedAtStage ?? 'foundation_setup'
    manifest.currentStage = targetStage
    manifest.suspendedAtStage = undefined
    manifest.status = 'in_progress'
    manifest.suspensionReason = undefined
    // 重置当前阶段尝试计数，为作者介入后的重试提供配额
    manifest.repairAttempts = 0
    manifest.updatedAt = Date.now()

    return this.runPipeline(manifest, grant)
  }

  /**
   * 核心阶段驱动状态机（支持断点持久上下文、阶段内收敛重试与授权边界保护）
   */
  private async runPipeline(
    manifest: ScratchOrchestrationManifest,
    grant: ScratchCreationTaskGrant,
  ): Promise<ScratchOrchestrationManifest> {
    while (manifest.status === 'in_progress' && manifest.currentStage !== 'completed') {
      // 1. 严格授权边界校验：若当前阶段未被作者授权，则立即终止后续越权执行并安全收工
      if (!grant.allowedStages.includes(manifest.currentStage)) {
        manifest.status = 'completed'
        manifest.updatedAt = Date.now()
        return manifest
      }

      // 阶段 1: 设定事实生成 (foundation_setup)
      if (manifest.currentStage === 'foundation_setup') {
        let fRes: { success: boolean; worldView?: string; error?: string }
        try {
          fRes = await this.domainGenerator.generateFoundation(grant.authorTaskPrompt)
        } catch (err: unknown) {
          fRes = { success: false, error: err instanceof Error ? err.message : String(err) }
        }

        if (!fRes.success) {
          const suspended = this.handleStageFailure(manifest, grant, 'foundation_setup', fRes.error ?? '设定事实生成失败')
          if (suspended) {
            return manifest
          }
          continue // 未达上限，阶段内继续重试收敛
        }

        // 保存前序事实至持久化上下文，确保断点恢复不丢失
        manifest.stagedArtifacts.foundation = fRes.worldView
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'foundation_setup',
            success: true,
            entityCount: 1,
          }),
        )
        manifest.currentStage = 'outline_generation'
        manifest.repairAttempts = 0 // 阶段成功后重置错误尝试计数
        manifest.updatedAt = Date.now()
        continue
      }

      // 阶段 2: 故事大纲生成 (outline_generation)
      if (manifest.currentStage === 'outline_generation') {
        let oRes: { success: boolean; chapters?: Array<{ chapter: number; summary: string }>; error?: string }
        try {
          oRes = await this.domainGenerator.generateOutline(
            grant.authorTaskPrompt,
            manifest.stagedArtifacts.foundation,
          )
        } catch (err: unknown) {
          oRes = { success: false, error: err instanceof Error ? err.message : String(err) }
        }

        if (!oRes.success || !oRes.chapters || oRes.chapters.length === 0) {
          const suspended = this.handleStageFailure(manifest, grant, 'outline_generation', oRes.error ?? '大纲生成失败或未返回章节')
          if (suspended) {
            return manifest
          }
          continue
        }

        const outlineData = oRes.chapters.slice(0, grant.targetChapterCount)
        manifest.stagedArtifacts.outline = outlineData
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'outline_generation',
            success: true,
            entityCount: outlineData.length,
          }),
        )
        manifest.currentStage = 'character_roster'
        manifest.repairAttempts = 0
        manifest.updatedAt = Date.now()
        continue
      }

      // 阶段 3: 角色名单建立 (character_roster)
      if (manifest.currentStage === 'character_roster') {
        let cRes: { success: boolean; characters?: Array<{ name: string; role: string }>; error?: string }
        try {
          cRes = await this.domainGenerator.generateCharacters(
            grant.authorTaskPrompt,
            manifest.stagedArtifacts.outline ?? [],
          )
        } catch (err: unknown) {
          cRes = { success: false, error: err instanceof Error ? err.message : String(err) }
        }

        if (!cRes.success || !cRes.characters || cRes.characters.length === 0) {
          const suspended = this.handleStageFailure(manifest, grant, 'character_roster', cRes.error ?? '角色名单生成失败')
          if (suspended) {
            return manifest
          }
          continue
        }

        manifest.stagedArtifacts.characters = cRes.characters
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'character_roster',
            success: true,
            entityCount: cRes.characters.length,
          }),
        )
        manifest.currentStage = 'blueprint_planning'
        manifest.repairAttempts = 0
        manifest.updatedAt = Date.now()
        continue
      }

      // 阶段 4: 章节蓝图规划 (blueprint_planning)
      if (manifest.currentStage === 'blueprint_planning') {
        let bRes: { success: boolean; count?: number; error?: string }
        try {
          bRes = await this.domainGenerator.generateBlueprints(
            grant.authorTaskPrompt,
            manifest.stagedArtifacts.outline ?? [],
            manifest.stagedArtifacts.characters ?? [],
          )
        } catch (err: unknown) {
          bRes = { success: false, error: err instanceof Error ? err.message : String(err) }
        }

        if (!bRes.success) {
          const suspended = this.handleStageFailure(manifest, grant, 'blueprint_planning', bRes.error ?? '章节蓝图规划失败')
          if (suspended) {
            return manifest
          }
          continue
        }

        manifest.stagedArtifacts.blueprintsCount = bRes.count ?? grant.targetChapterCount
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'blueprint_planning',
            success: true,
            entityCount: manifest.stagedArtifacts.blueprintsCount,
          }),
        )
        manifest.currentStage = 'candidate_drafting'
        manifest.repairAttempts = 0
        manifest.updatedAt = Date.now()
        continue
      }

      // 阶段 5: 正文候选草稿自主生成 (candidate_drafting)
      if (manifest.currentStage === 'candidate_drafting') {
        const chainConfig: AutonomousBatchChainConfig = {
          batchId: `batch-${manifest.orchestrationId}`,
          grantId: grant.grantId,
          projectId: grant.projectId,
          startChapter: 1,
          chapterCount: grant.targetChapterCount,
          predecessorChain: [],
          allowAutoFinalize: false,
        }

        let draftResult: {
          batchId: string
          receipts: AutonomousStepReceipt[]
          stoppedDueToConflict: boolean
          completedChapters: number
        }

        try {
          draftResult = await this.autonomousExecutor.executeBatchChain(chainConfig)
        } catch (err: unknown) {
          const suspended = this.handleStageFailure(
            manifest,
            grant,
            'candidate_drafting',
            err instanceof Error ? err.message : String(err),
          )
          if (suspended) {
            return manifest
          }
          continue
        }

        if (
          draftResult.stoppedDueToConflict ||
          draftResult.receipts.some(r => r.status === 'failed' || r.status === 'unknown') ||
          draftResult.completedChapters < grant.targetChapterCount
        ) {
          const suspended = this.handleStageFailure(manifest, grant, 'candidate_drafting', '正文候选生成中断或发生前序冲突')
          if (suspended) {
            return manifest
          }
          continue
        }

        manifest.candidateChapterIds = draftResult.receipts.map((r: AutonomousStepReceipt) => `ch-${r.chapterNumber}`)
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'candidate_drafting',
            success: true,
            entityCount: draftResult.receipts.length,
          }),
        )
        manifest.currentStage = 'preliminary_acceptance'
        manifest.repairAttempts = 0
        manifest.updatedAt = Date.now()
        continue
      }

      // 阶段 6: 结构化初验评估 (preliminary_acceptance)
      if (manifest.currentStage === 'preliminary_acceptance') {
        // This stage check is not a physical receipt: the API lacks versioned acceptance evidence.
        const reason = 'SCRATCH_PRELIMINARY_EVIDENCE_UNAVAILABLE'
        manifest.stageReceipts.push(
          assembleStageExecutionReceipt({
            orchestrationId: manifest.orchestrationId,
            stage: 'preliminary_acceptance',
            success: false,
            entityCount: 0,
            error: reason,
          }),
        )
        manifest.suspendedAtStage = 'preliminary_acceptance'
        manifest.currentStage = 'suspended_needs_author'
        manifest.status = 'suspended'
        manifest.suspensionReason = reason
        manifest.updatedAt = Date.now()
        return manifest
      }
    }

    return manifest
  }

  /**
   * 阶段失败与有限修复次数处理（超限则挂起待决，记录断点阶段，绝不编造确认）
   * @returns 是否已触发挂起 (true = suspended, false = retry allowed)
   */
  private handleStageFailure(
    manifest: ScratchOrchestrationManifest,
    grant: ScratchCreationTaskGrant,
    stage: ScratchCreationStage,
    error: string,
  ): boolean {
    manifest.repairAttempts += 1
    manifest.stageReceipts.push(
      assembleStageExecutionReceipt({
        orchestrationId: manifest.orchestrationId,
        stage,
        success: false,
        entityCount: 0,
        error,
      }),
    )

    if (manifest.repairAttempts >= grant.maxRepairAttempts) {
      manifest.suspendedAtStage = stage
      manifest.currentStage = 'suspended_needs_author'
      manifest.status = 'suspended'
      // i18n-exempt: 内部编排执行器诊断原因，不直接在界面错误框显示
      manifest.suspensionReason = `阶段 [${stage}] 失败且修复尝试达到上限 (${manifest.repairAttempts}/${grant.maxRepairAttempts}): ${error}。挂起等待作者裁决，绝不编造确认。`
      manifest.updatedAt = Date.now()
      return true
    }

    manifest.updatedAt = Date.now()
    return false
  }

  public getOrchestration(orchestrationId: string): ScratchOrchestrationManifest | undefined {
    return this.manifests.get(orchestrationId)
  }

  public clearProjectOrchestrations(projectId: string): void {
    for (const [id, m] of Array.from(this.manifests.entries())) {
      if (m.projectId === projectId) {
        this.manifests.delete(id)
        this.grants.delete(id)
      }
    }
  }
}
