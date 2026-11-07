import type Database from 'better-sqlite3'
import type { GenerationPreservedTail } from '../../src/services/generation/generation-runtime'
import type { PortableRuntimeFreezeTable } from '../services/portable-runtime-freeze'
import { GenerationRunRepository, textHash } from './generation-run-repository'

export interface PreserveGenerationTailInput {
  attemptId: string
  artifactId: string
  durableRevision: number
  text: string
  prefixHash: string
}

interface TailRow {
  attempt_id: string; artifact_id: string; durable_revision: number; prefix_hash: string
  tail_text: string; tail_hash: string; preserved_at: string
}

/** Non-executable history for a real tail held by this captured generation service. */
export class GenerationRecoveryTailRepository {
  constructor(private readonly db: Database.Database, private readonly runs: GenerationRunRepository,
    private readonly isFrozen: (table: PortableRuntimeFreezeTable, id: string) => boolean = () => false) {}

  preserve(input: PreserveGenerationTailInput): void {
    if (this.db.inTransaction) throw new Error('GENERATION_RECOVERY_TAIL_TRANSACTION_ACTIVE')
    this.db.transaction(() => {
      if (!Number.isSafeInteger(input.durableRevision) || input.durableRevision < 0 || !input.text
        || !/^[a-f0-9]{64}$/.test(input.prefixHash)) throw new Error('GENERATION_RECOVERY_TAIL_INVALID')
      if (this.isFrozen('generation_attempts', input.attemptId)) throw new Error('GENERATION_RECOVERY_TAIL_READ_ONLY')
      const receipt = this.runs.receipt(input.attemptId), artifact = receipt.artifact
      if (!artifact || artifact.artifactId !== input.artifactId || artifact.attemptId !== input.attemptId
        || receipt.attempt.attemptId !== input.attemptId || receipt.attempt.rootActionId !== receipt.run.rootActionId
        || !['settled', 'unknown', 'cancelled-before-dispatch'].includes(receipt.attempt.status)
        || artifact.textHash !== textHash(artifact.text)) throw new Error('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
      const link = this.db.prepare('SELECT attempt_id,run_id FROM generation_artifacts WHERE artifact_id=?').get(input.artifactId) as { attempt_id: string; run_id: string } | undefined
      if (link?.attempt_id !== input.attemptId || link.run_id !== receipt.run.runId) throw new Error('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
      const old = this.db.prepare('SELECT * FROM generation_recovery_tails WHERE attempt_id=?').get(input.attemptId) as TailRow | undefined
      if (old && (old.artifact_id !== input.artifactId || old.durable_revision !== input.durableRevision
        || old.prefix_hash !== input.prefixHash || old.tail_text !== input.text || old.tail_hash !== textHash(input.text)
        || !Number.isFinite(Date.parse(old.preserved_at)) || new Date(old.preserved_at).toISOString() !== old.preserved_at)) {
        throw new Error('GENERATION_RECOVERY_TAIL_CONFLICT')
      }
      if (artifact.revision === input.durableRevision + 1 && artifact.text.endsWith(input.text)
        && textHash(artifact.text.slice(0, artifact.text.length - input.text.length)) === input.prefixHash && !old) return
      if (artifact.revision !== input.durableRevision || artifact.textHash !== input.prefixHash) throw new Error('GENERATION_RECOVERY_TAIL_SOURCE_CONFLICT')
      if (old) return
      this.db.prepare(`INSERT INTO generation_recovery_tails
        (attempt_id,artifact_id,durable_revision,prefix_hash,tail_text,tail_hash,preserved_at) VALUES(?,?,?,?,?,?,?)`)
        .run(input.attemptId, input.artifactId, input.durableRevision, input.prefixHash, input.text, textHash(input.text), new Date().toISOString())
    }).immediate()
  }

  list(runId: string): GenerationPreservedTail[] {
    const rows = this.db.prepare(`SELECT t.*,p.attempt_json,p.run_id AS attempt_run_id,p.root_action_id AS attempt_root_id,
      a.attempt_id AS artifact_attempt_id,a.run_id AS artifact_run_id,a.artifact_json,a.revision AS artifact_revision,
      r.root_action_id AS run_root_id FROM generation_recovery_tails t
      JOIN generation_attempts p ON p.attempt_id=t.attempt_id
      LEFT JOIN generation_artifacts a ON a.artifact_id=t.artifact_id
      LEFT JOIN generation_runs r ON r.run_id=p.run_id WHERE p.run_id=? ORDER BY t.rowid`).all(runId) as Array<TailRow & {
        attempt_json: string; attempt_run_id: string; attempt_root_id: string; artifact_attempt_id: string
        artifact_run_id: string; artifact_json: string; artifact_revision: number; run_root_id: string
      }>
    return rows.map(row => {
      // Portable history intentionally has no executable usage receipt or machine binding.
      try {
        const attempt = JSON.parse(row.attempt_json) as { attemptId: string; rootActionId: string; status: string }
        const artifact = JSON.parse(row.artifact_json) as { artifactId: string; attemptId: string; rootActionId: string;
          revision: number; text: string; textHash: string }
        if (row.attempt_run_id !== runId || row.artifact_run_id !== runId || row.artifact_attempt_id !== row.attempt_id
          || row.attempt_root_id !== row.run_root_id || attempt.attemptId !== row.attempt_id
          || attempt.rootActionId !== row.run_root_id || artifact.rootActionId !== row.run_root_id
          || artifact.artifactId !== row.artifact_id || artifact.attemptId !== row.attempt_id
          || !['settled', 'unknown', 'cancelled-before-dispatch'].includes(attempt.status)
          || !Number.isSafeInteger(row.durable_revision) || row.durable_revision < 0
          || artifact.revision !== row.durable_revision || row.artifact_revision !== row.durable_revision
          || typeof artifact.text !== 'string' || artifact.textHash !== row.prefix_hash || textHash(artifact.text) !== row.prefix_hash
          || typeof row.tail_text !== 'string' || !row.tail_text || textHash(row.tail_text) !== row.tail_hash
          || !Number.isFinite(Date.parse(row.preserved_at)) || new Date(row.preserved_at).toISOString() !== row.preserved_at) {
          throw new Error('GENERATION_RECOVERY_TAIL_INTEGRITY_FAILED')
        }
        return { kind: 'preserved-partial' as const, attemptId: row.attempt_id, artifactId: row.artifact_id,
          durableRevision: row.durable_revision, durableText: artifact.text, prefixHash: row.prefix_hash,
          tailText: row.tail_text, tailHash: row.tail_hash, preservedAt: row.preserved_at }
      } catch {
        throw new Error('GENERATION_RECOVERY_TAIL_INTEGRITY_FAILED')
      }
    })
  }
}
