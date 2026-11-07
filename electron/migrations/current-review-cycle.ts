import type Database from 'better-sqlite3'
import { verifyM03ReviewCycle } from './m03-review-cycle'
import { readVerifiedOrdinaryHistory } from './ordinary-review-history'

/** Current-only bridge. Historical registries continue to call the original strict M03 verifier. */
export function verifyCurrentReviewCycles(db: Database.Database): boolean {
  try { return verifyM03ReviewCycle(db, readVerifiedOrdinaryHistory(db)) }
  catch { return false }
}
