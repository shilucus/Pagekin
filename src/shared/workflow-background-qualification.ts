import type { ProjectSessionContext } from './ipc-channels'

export interface WorkflowBackgroundCandidate {
  type: string
  projectSession?: ProjectSessionContext | null
  backgroundQualified?: boolean
}

/**
 * 判断工作流运行实例是否具备在切书后继续于后台运行的资格（UI-001 / ADR-0049）。
 * 只有具备独立 ProjectSessionContext，且属于已迁多书架构的工作流类型才具备后台资格；
 * 未迁移的旧工作流必须保留原有切书取消与等待保护。
 */
export function isWorkflowBackgroundQualified(run: WorkflowBackgroundCandidate): boolean {
  if (!run.projectSession || !run.projectSession.projectId || !run.projectSession.leaseId || !run.projectSession.projectPath) {
    return false
  }
  if (run.backgroundQualified === true) return true
  // novel_import 已在 Stage 6E/13/14 完整迁移多书隔离与独立上下文
  if (run.type === 'novel_import') return true
  // batch_generate 已在 Stage 5B1 完成主进程调度与独立 ProjectSession 隔离
  if (run.type === 'batch_generate') return true
  return false
}
