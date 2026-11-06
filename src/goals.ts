/**
 * Append-only goal-chain bookkeeping for dsh-loop-mode: the durable
 * `plugin:loop-mode/revise` audit event, its session projection, and a read
 * helper. This is the structural counterpart of the protocol rule "the only
 * goal-change verb is revise": every revision appends ONE audit record to the
 * session log (ignorable plugin record — harness builds that do not know the
 * type may skip it), and the folded chain is what `/loop status` reports.
 *
 * The goal SLOT itself rides the host goal service: `loop_revise` clears the
 * current goal (durable tombstone + history retained by the service) and
 * creates the replacement — the chain of {from, to, reason} events is the
 * revision genealogy.
 *
 * @module dsh-loop-mode/goals
 */

/** Session log event type carrying one append-only goal revision (ignorable plugin record). */
export const REVISE_EVENT_TYPE = 'plugin:loop-mode/revise'

/** Projection registry key for the folded revision chain. */
export const REVISIONS_PROJECTION_KEY = 'loopRevisions'

/** One revision audit record. */
export interface RevisionRecord {
  from: { id: string; revision: number } | null
  to: { id: string; revision: number }
  reason: string
  at: string
}

/** Folded chain state: count + the latest record (cheap status surface). */
export interface RevisionsState {
  count: number
  last: RevisionRecord | null
}

/** Duck-typed schema stand-in (the host only calls `.parse`). */
interface SchemaLike<T> {
  parse(value: unknown): T
}

const passThrough = <T>(): SchemaLike<T> => ({ parse: (value) => value as T })

export interface RevisionsProjectionDefinitionLike {
  key: typeof REVISIONS_PROJECTION_KEY
  stateSchema: SchemaLike<RevisionsState>
  init(header: unknown, inheritedEventCount: number): RevisionsState
  apply(state: RevisionsState, event: { type: string; data?: unknown }): RevisionsState
  wire: {
    viewSchema: SchemaLike<RevisionsState>
    view(state: RevisionsState): RevisionsState
  }
  stateVersion: number
}

/**
 * Fold every `plugin:loop-mode/revise` event into {count, last}. Malformed
 * records are skipped (the audit trail stays append-only and honest — garbage
 * never rewrites history).
 */
export function revisionsProjection(): RevisionsProjectionDefinitionLike {
  return {
    key: REVISIONS_PROJECTION_KEY,
    stateSchema: passThrough<RevisionsState>(),
    init: () => ({ count: 0, last: null }),
    apply(state, event) {
      if (event?.type !== REVISE_EVENT_TYPE) return state
      const data = event.data as Partial<RevisionRecord> | undefined
      if (data === null || typeof data !== 'object') return state
      const to = data.to as RevisionRecord['to'] | undefined
      const reason = typeof data.reason === 'string' ? data.reason : ''
      if (to === null || typeof to !== 'object' || typeof to.id !== 'string') return state
      const from =
        data.from !== null && typeof data.from === 'object' && typeof (data.from as { id?: unknown }).id === 'string'
          ? { id: (data.from as { id: string }).id, revision: Number((data.from as { revision?: unknown }).revision) || 1 }
          : null
      const record: RevisionRecord = {
        from,
        to: { id: to.id, revision: Number(to.revision) || 1 },
        reason,
        at: typeof data.at === 'string' ? data.at : '',
      }
      // Fresh object per owned event so the host republishes the view.
      return { count: state.count + 1, last: record }
    },
    wire: {
      viewSchema: passThrough<RevisionsState>(),
      view: (state) => state,
    },
    stateVersion: 1,
  }
}

/** Minimal projection-registry face. */
interface ProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * Read the folded revision chain. Any failure resolves to the empty chain —
 * status reporting never throws.
 */
export function revisionsOf(ctx: unknown, session: unknown): RevisionsState {
  if (session === undefined || session === null) return { count: 0, last: null }
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return { count: 0, last: null }
  try {
    const state = projections.stateOf(session, REVISIONS_PROJECTION_KEY) as RevisionsState | undefined
    if (state === undefined || state === null || typeof state !== 'object') return { count: 0, last: null }
    return {
      count: Number(state.count) || 0,
      last: state.last ?? null,
    }
  } catch {
    return { count: 0, last: null }
  }
}

/**
 * -----------------------------------------------------------------------------
 * Verify ledger (v0.6.1, security review finding): the quick/full pacing rule
 * used to count launches from the JSONL audit file — which task executors
 * (unGated, full tools) can read AND truncate, resetting their own budget.
 * The ledger now rides the SAME durable, host-managed session log as the mode
 * and revision events: one ignorable `plugin:loop-mode/verify` record per
 * launch, folded by a registered projection. Executors have no write path
 * into the controller's session log, so the count is tamper-resistant; the
 * audit file keeps its display/reporting role only.
 */

/** Session log event type carrying one verification launch (ignorable plugin record). */
export const VERIFY_EVENT_TYPE = 'plugin:loop-mode/verify'

/** Projection registry key for the folded verify ledger. */
export const VERIFY_LEDGER_PROJECTION_KEY = 'loopVerifyLedger'

/** Folded ledger: per-goal quick/full launch counts. */
export interface VerifyLedgerState {
  perGoal: Record<string, { quick: number; full: number }>
}

export interface VerifyLedgerProjectionLike {
  key: typeof VERIFY_LEDGER_PROJECTION_KEY
  stateSchema: SchemaLike<VerifyLedgerState>
  init(header: unknown, inheritedEventCount: number): VerifyLedgerState
  apply(state: VerifyLedgerState, event: { type: string; data?: unknown }): VerifyLedgerState
  wire: {
    viewSchema: SchemaLike<VerifyLedgerState>
    view(state: VerifyLedgerState): VerifyLedgerState
  }
  stateVersion: number
}

/**
 * Fold every `plugin:loop-mode/verify` event into per-goal quick/full counts.
 * Malformed records are skipped; a missing goalId counts under '_'.
 */
export function verifyLedgerProjection(): VerifyLedgerProjectionLike {
  return {
    key: VERIFY_LEDGER_PROJECTION_KEY,
    stateSchema: passThrough<VerifyLedgerState>(),
    init: () => ({ perGoal: {} }),
    apply(state, event) {
      if (event?.type !== VERIFY_EVENT_TYPE) return state
      const data = event.data as { goalId?: unknown; mode?: unknown } | undefined
      if (data === null || typeof data !== 'object') return state
      const goalId = typeof data.goalId === 'string' && data.goalId.length > 0 ? data.goalId : '_'
      const isFull = data.mode === 'full'
      const entry = state.perGoal[goalId] ?? { quick: 0, full: 0 }
      // Fresh objects per owned event so the host republishes the view.
      const perGoal = { ...state.perGoal }
      perGoal[goalId] = {
        quick: entry.quick + (isFull ? 0 : 1),
        full: entry.full + (isFull ? 1 : 0),
      }
      return { perGoal }
    },
    wire: {
      viewSchema: passThrough<VerifyLedgerState>(),
      view: (state) => state,
    },
    stateVersion: 1,
  }
}

/** Quick launches counted for one goal; any failure resolves to 0 (the audit-file fallback may still apply). */
export function quickSpentOf(ctx: unknown, session: unknown, goalId: string | undefined): number {
  if (session === undefined || session === null) return 0
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return 0
  try {
    const state = projections.stateOf(session, VERIFY_LEDGER_PROJECTION_KEY) as VerifyLedgerState | undefined
    if (state === undefined || state === null || typeof state !== 'object') return 0
    const entry = state.perGoal?.[goalId !== undefined && goalId.length > 0 ? goalId : '_']
    return Number(entry?.quick) || 0
  } catch {
    return 0
  }
}
