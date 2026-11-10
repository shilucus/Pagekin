import { createHash } from 'node:crypto'
import type { AutonomousExecutionResult } from './autonomous-executor-contract'

export type ScratchCreationStage =
  | 'foundation_setup'
  | 'outline_generation'
  | 'character_roster'
  | 'blueprint_planning'
  | 'candidate_drafting'
  | 'preliminary_acceptance'
  | 'completed'
  | 'suspended_needs_author'

export interface ScratchCreationTaskGrant {
  grantId: string
  projectId: string
  authorTaskPrompt: string
  targetChapterCount: number
  maxRepairAttempts: number
  allowedStages: ScratchCreationStage[]
  timestamp: number
}

export interface StageExecutionReceipt {
  stage: ScratchCreationStage
  success: boolean
  receiptId: string
  entityCount: number
  timestamp: number
  error?: string
}

export interface ScratchStagedArtifacts {
  foundation?: string
  outline?: Array<{ chapter: number; summary: string }>
  characters?: Array<{ name: string; role: string }>
  blueprintsCount?: number
  draftContents?: Record<number, string>
}

export type CandidateDraftingBarrierReason =
  | 'unknown'
  | 'predecessor_conflict'
  | 'partial'
  | 'interrupted'
  | 'unproven'

export interface ScratchOrchestrationManifest {
  orchestrationId: string
  grantId: string
  projectId: string
  currentStage: ScratchCreationStage
  suspendedAtStage?: ScratchCreationStage
  repairAttempts: number
  stageReceipts: StageExecutionReceipt[]
  draftingExecutionResults: AutonomousExecutionResult[]
  candidateDraftingBarrier?: CandidateDraftingBarrierReason
  candidateChapterIds: string[]
  preliminaryReportIds: string[]
  stagedArtifacts: ScratchStagedArtifacts
  status: 'in_progress' | 'completed' | 'suspended'
  suspensionReason?: string
  isHumanConfirmed: false
  canAutoFinalize: false
  createdAt: number
  updatedAt: number
}

export const STAGE_SEQUENCE: readonly ScratchCreationStage[] = [
  'foundation_setup',
  'outline_generation',
  'character_roster',
  'blueprint_planning',
  'candidate_drafting',
  'preliminary_acceptance',
  'completed',
] as const

export function validateScratchCreationGrant(grant: ScratchCreationTaskGrant): { valid: boolean; reason?: string } {
  if (!grant.grantId) {
    return { valid: false, reason: '授权 ID 缺失 (Missing grantId)' }
  }

  if (!grant.projectId) {
    return { valid: false, reason: '项目 ID 缺失 (Missing projectId)' }
  }

  if (!grant.authorTaskPrompt || !grant.authorTaskPrompt.trim()) {
    return { valid: false, reason: '作者任务提示词不能为空 (Author task prompt is required)' }
  }

  if (grant.targetChapterCount < 1 || grant.targetChapterCount > 10) {
    return {
      valid: false,
      reason: `目标章节数 [${grant.targetChapterCount}] 超出限制，单次从零编排上限为 1-10 章`,
    }
  }

  if (grant.maxRepairAttempts < 1 || grant.maxRepairAttempts > 5) {
    return {
      valid: false,
      reason: `最大修复次数 [${grant.maxRepairAttempts}] 必须处于 1 至 5 次之间`,
    }
  }

  if (!grant.allowedStages || !Array.isArray(grant.allowedStages) || grant.allowedStages.length === 0) {
    return {
      valid: false,
      reason: '授权阶段集合 (allowedStages) 不能为空',
    }
  }

  return { valid: true }
}

export function createScratchOrchestrationManifest(grant: ScratchCreationTaskGrant): ScratchOrchestrationManifest {
  const orchestrationId = `som-${createHash('sha256')
    .update(`${grant.projectId}:${grant.grantId}:${grant.authorTaskPrompt}:${Date.now()}`)
    .digest('hex')
    .slice(0, 16)}`

  return {
    orchestrationId,
    grantId: grant.grantId,
    projectId: grant.projectId,
    currentStage: 'foundation_setup',
    repairAttempts: 0,
    stageReceipts: [],
    draftingExecutionResults: [],
    candidateChapterIds: [],
    preliminaryReportIds: [],
    stagedArtifacts: {},
    status: 'in_progress',
    isHumanConfirmed: false,
    canAutoFinalize: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function assembleStageExecutionReceipt(params: {
  orchestrationId: string
  stage: ScratchCreationStage
  success: boolean
  entityCount: number
  error?: string
}): StageExecutionReceipt {
  const receiptId = `ser-${createHash('sha256')
    .update(`${params.orchestrationId}:${params.stage}:${params.success}:${params.entityCount}:${Date.now()}`)
    .digest('hex')
    .slice(0, 16)}`

  return {
    stage: params.stage,
    success: params.success,
    receiptId,
    entityCount: params.entityCount,
    timestamp: Date.now(),
    error: params.error,
  }
}
