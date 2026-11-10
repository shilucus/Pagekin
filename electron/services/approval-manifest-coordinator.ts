import {
  canUnfreezeManifest,
  computeBufferHash,
  createApprovalManifest,
  mergeEditorBufferSnapshot,
  validateApprovalManifest,
  type ApprovalManifest,
  type CreateApprovalManifestParams,
  type FrozenEditorBuffer,
} from '../../src/shared/approval-manifest-contract'

export interface EditorRevisionProbeResult {
  connected: boolean
  isDirty: boolean
  dirtyContent?: string
  revision: number
  hasConcurrencyConflict?: boolean
}

export interface HandshakeFreezeResult {
  success: boolean
  manifest: ApprovalManifest
  error?: string
}

export class ApprovalManifestCoordinator {
  private readonly manifests = new Map<string, ApprovalManifest>()
  private readonly handshakes = new Map<string, symbol>()

  /**
   * 准备批次批准清单，执行权限与范围强校验
   */
  public prepareApprovalManifest(
    params: CreateApprovalManifestParams,
    clientScope: string,
  ): { success: boolean; manifest?: ApprovalManifest; error?: string } {
    const manifest = createApprovalManifest(params)
    const validation = validateApprovalManifest(manifest, clientScope)

    if (!validation.valid) {
      return {
        success: false,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: validation.reason ?? '批次批准清单校验失败',
      }
    }

    this.handshakes.delete(manifest.manifestId)
    this.manifests.set(manifest.manifestId, manifest)
    return {
      success: true,
      manifest,
    }
  }

  /**
   * 获取指定批准清单
   */
  public getManifest(manifestId: string): ApprovalManifest | undefined {
    return this.manifests.get(manifestId)
  }

  /**
   * 事务前执行活跃编辑器 Revision 握手与脏缓冲安全封存
   * 铁律：必须在任何数据库/SQL事务开启前执行，绝不阻塞数据库连接与事务锁！
   */
  public async performEditorHandshakeAndFreeze(
    manifestId: string,
    editorProbe: (chapterNumber: number) => Promise<EditorRevisionProbeResult>,
  ): Promise<HandshakeFreezeResult> {
    const manifest = this.manifests.get(manifestId)
    if (!manifest) {
      return {
        success: false,
        manifest: null as unknown as ApprovalManifest,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: '未找到对应批次清单 (Manifest not found)',
      }
    }

    if (manifest.status !== 'draft' && manifest.status !== 'pending_handshake') {
      return {
        success: false,
        manifest,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: `清单当前状态 [${manifest.status}] 不允许执行握手封存`,
      }
    }

    if (this.handshakes.has(manifestId)) {
      return { success: false, manifest, error: 'EDITOR_HANDSHAKE_IN_PROGRESS' }
    }

    const token = Symbol()
    this.handshakes.set(manifestId, token)
    manifest.status = 'pending_handshake'
    manifest.updatedAt = Date.now()

    const isCurrent = () => this.manifests.get(manifestId) === manifest
      && this.handshakes.get(manifestId) === token && manifest.status === 'pending_handshake'
    const invalidated = (buffer?: FrozenEditorBuffer): HandshakeFreezeResult => {
      // Late author input remains recoverable without reviving or changing the revoked approval.
      let snapshot = structuredClone(manifest)
      if (buffer) snapshot = mergeEditorBufferSnapshot(snapshot, buffer)
      snapshot.status = 'pending_author_action'
      snapshot.pendingReason = 'EDITOR_HANDSHAKE_INVALIDATED'
      snapshot.updatedAt = Date.now()
      return { success: false, manifest: snapshot, error: snapshot.pendingReason }
    }

    try {
      // 逐章握手探测各章节活跃编辑器
      for (const item of manifest.items) {
        let probeResult: EditorRevisionProbeResult
        try {
          probeResult = await editorProbe(item.chapterNumber)
        } catch {
          if (!isCurrent()) return invalidated()
          manifest.status = 'pending_author_action'
          manifest.pendingReason = 'EDITOR_HANDSHAKE_PROBE_FAILED'
          manifest.updatedAt = Date.now()
          return { success: false, manifest, error: manifest.pendingReason }
        }

        const frozenBuffer: FrozenEditorBuffer | undefined = probeResult.isDirty && probeResult.dirtyContent !== undefined
          ? {
            chapterNumber: item.chapterNumber,
            bufferHash: computeBufferHash(probeResult.dirtyContent),
            content: probeResult.dirtyContent,
            revision: probeResult.revision,
            timestamp: Date.now(),
          } : undefined
        if (!isCurrent()) return invalidated(frozenBuffer)

        if (probeResult.isDirty && probeResult.dirtyContent === undefined) {
          manifest.status = 'pending_author_action'
          manifest.pendingReason = 'EDITOR_HANDSHAKE_BUFFER_UNAVAILABLE'
          manifest.updatedAt = Date.now()
          return { success: false, manifest, error: manifest.pendingReason }
        }

        // Preserve returned author input even when disconnection or conflict blocks approval.
        if (frozenBuffer) {
          const updatedManifest = mergeEditorBufferSnapshot(manifest, frozenBuffer)
          manifest.frozenBuffers = updatedManifest.frozenBuffers
        }

        // 1. 若编辑器断连
        if (!probeResult.connected) {
          manifest.status = 'pending_author_action'
          // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
          manifest.pendingReason = `第 ${item.chapterNumber} 章活跃编辑器已断开连接，挂起等待作者恢复`
          manifest.updatedAt = Date.now()
          return {
            success: false,
            manifest,
            error: manifest.pendingReason,
          }
        }

        // 2. 若握手期间发生输入并发冲突（作者正在键入）
        if (probeResult.hasConcurrencyConflict) {
          manifest.status = 'pending_author_action'
          // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
          manifest.pendingReason = `握手期间检测到第 ${item.chapterNumber} 章产生并发新输入，挂起等待作者裁决`
          manifest.updatedAt = Date.now()
          return {
            success: false,
            manifest,
            error: manifest.pendingReason,
          }
        }
      }

      if (!isCurrent()) return invalidated()
      // 所有章节握手成功并完成必要封存，进入 frozen 就绪状态
      manifest.status = 'frozen'
      manifest.pendingReason = undefined
      manifest.updatedAt = Date.now()

      return { success: true, manifest }
    } finally {
      if (this.handshakes.get(manifestId) === token) this.handshakes.delete(manifestId)
    }
  }

  /**
   * 解封先赢 (Unfreeze-Wins)：撤销未提交的批准清单
   */
  public unfreezeManifest(manifestId: string): { success: boolean; error?: string } {
    const manifest = this.manifests.get(manifestId)
    if (!manifest) {
      return {
        success: false,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: '未找到对应批次清单',
      }
    }

    const check = canUnfreezeManifest(manifest)
    if (!check.allowed) {
      return {
        success: false,
        error: check.reason,
      }
    }

    this.handshakes.delete(manifestId)
    manifest.status = 'unfrozen'
    manifest.updatedAt = Date.now()
    return { success: true }
  }

  /**
   * 提交先赢 (Commit-Wins)：事务成功提交后标记为已定稿提交
   */
  public markManifestCommitted(manifestId: string): { success: boolean; error?: string } {
    const manifest = this.manifests.get(manifestId)
    if (!manifest) {
      return {
        success: false,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: '未找到对应批次清单',
      }
    }

    if (manifest.status !== 'frozen') {
      return {
        success: false,
        // i18n-exempt: 内部协调器诊断原因，不直接在界面错误框显示
        error: `清单状态为 [${manifest.status}]，只有处于 [frozen] 状态的清单才允许提交`,
      }
    }

    manifest.status = 'committed'
    manifest.updatedAt = Date.now()
    return { success: true }
  }

  /**
   * 清除指定项目的清单
   */
  public clearProjectManifests(projectId: string): void {
    for (const [id, m] of Array.from(this.manifests.entries())) {
      if (m.projectId === projectId) {
        this.handshakes.delete(id)
        this.manifests.delete(id)
      }
    }
  }
}
