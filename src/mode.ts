/**
 * Per-session loop mode: the durable `/loop on|off` override, its session
 * projection, and the tri-state resolution every consumer (guidance section,
 * hard gate, command status) shares.
 *
 * Pattern copied from @deepseek-ai/dsh-plan-mode (and, transitively, from
 * MarchLiu's dsh-cybernetics src/sessionMode.ts): one append-only session log
 * event (`plugin:loop-mode/mode { enabled }`, written as an ignorable plugin
 * record) folded by a registered session projection, so the override survives
 * resume and fork (both replay the log prefix). `enabled: null` (or a missing
 * override) falls the session back to the profile-global `defaultOn` volatile.
 *
 * Zero runtime dependencies: the projection definition is duck-typed — the
 * host only ever calls `.parse` on the schemas.
 *
 * @module dsh-loop-mode/mode
 */

/** Session log event type carrying the per-session override (ignorable plugin record). */
export const MODE_EVENT_TYPE = 'plugin:loop-mode/mode'

/** Projection registry key for the folded override state. */
export const MODE_PROJECTION_KEY = 'loopMode'

/** Wire/state shape of the projection: tri-state override, null = inherit global. */
export interface LoopModeState {
  override: boolean | null
}

/** Duck-typed Zod stand-in (the host only calls `.parse`; pass-through suffices). */
interface SchemaLike<T> {
  parse(value: unknown): T
}

const passThrough = <T>(): SchemaLike<T> => ({ parse: (value) => value as T })

export interface ModeProjectionDefinitionLike {
  key: typeof MODE_PROJECTION_KEY
  stateSchema: SchemaLike<LoopModeState>
  init(header: unknown, inheritedEventCount: number): LoopModeState
  apply(state: LoopModeState, event: { type: string; data?: unknown }): LoopModeState
  wire: {
    viewSchema: SchemaLike<LoopModeState>
    view(state: LoopModeState): LoopModeState
  }
  stateVersion: number
}

/**
 * The projection definition for `ctx.sessionProjections.register()`. Every
 * `plugin:loop-mode/mode` event is a whole-value write ({ enabled: true |
 * false | null }); last write wins — append-only history, no delta merge.
 * Any non-boolean `enabled` heals to `null` (inherit global).
 */
export function loopModeProjection(): ModeProjectionDefinitionLike {
  return {
    key: MODE_PROJECTION_KEY,
    stateSchema: passThrough<LoopModeState>(),
    init: () => ({ override: null }),
    apply(state, event) {
      if (event?.type !== MODE_EVENT_TYPE) return state
      const data = event.data as { enabled?: unknown } | undefined
      if (data === null || typeof data !== 'object') return state
      const enabled = data.enabled
      const override = typeof enabled === 'boolean' ? enabled : null
      // A fresh object per owned event: the host republishes only when the
      // view reference changes.
      return { override }
    },
    wire: {
      viewSchema: passThrough<LoopModeState>(),
      view: (state) => state,
    },
    stateVersion: 1,
  }
}

/** Minimal projection-registry face the helpers need. */
interface ProjectionsLike {
  stateOf?(session: unknown, key: string): unknown
}

/**
 * Read the per-session override. Any failure (no registry, key not yet
 * replayed, malformed state) resolves to "no override" — the global default
 * decides, exactly like a fresh session.
 */
export function modeOverrideOf(ctx: unknown, session: unknown): boolean | null {
  if (session === undefined || session === null) return null
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return null
  try {
    const state = projections.stateOf(session, MODE_PROJECTION_KEY) as LoopModeState | undefined
    if (state === undefined || state === null || typeof state !== 'object') return null
    return typeof state.override === 'boolean' ? state.override : null
  } catch {
    return null
  }
}

/** Canonical resolution join: override > session preset identity > global default. */
export interface ResolvedMode {
  enabled: boolean
  source: 'override' | 'preset' | 'global'
}

/**
 * Full resolution with the agent-preset layer (v0.7.0): per-session override
 * > session preset identity (a session on `loopPresetId` defaults ON) >
 * global default. The preset layer lets the GUI's agent-preset selector act
 * as the mode switch without remounting the plugin inside the preset realm.
 */
export function resolveMode(override: boolean | null, globalDefault: boolean, sessionPreset?: string | null, loopPresetId?: string): ResolvedMode {
  if (override !== null) return { enabled: override, source: 'override' }
  if (typeof sessionPreset === 'string' && sessionPreset.length > 0
    && typeof loopPresetId === 'string' && loopPresetId.length > 0
    && sessionPreset === loopPresetId) {
    return { enabled: true, source: 'preset' }
  }
  return { enabled: globalDefault === true, source: 'global' }
}

/**
 * The session's current agent preset id, read from the host registry's own
 * `agentPreset` projection (dsh-agent-preset-registry index.js:48-58: state
 * is the preset id string or null, initialized from the session header and
 * advanced by agent-preset/selected events). Failures resolve to null.
 */
export function sessionPresetOf(ctx: unknown, session: unknown): string | null {
  if (session === undefined || session === null) return null
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return null
  try {
    const state = projections.stateOf(session, 'agentPreset') as unknown
    return typeof state === 'string' && state.length > 0 ? state : null
  } catch {
    return null
  }
}

/**
 * Effective loop-mode enablement for one session: per-session override wins;
 * then the session's agent preset identity (loop preset = default on); then
 * the profile-global `defaultOn` volatile.
 */
export function effectiveEnabled(ctx: unknown, session: unknown, globalDefault: boolean, loopPresetId?: string): boolean {
  return resolveMode(modeOverrideOf(ctx, session), globalDefault, sessionPresetOf(ctx, session), loopPresetId).enabled
}

/**
 * TRUE when plan mode is active or about to become active for this session —
 * plan discipline is carried by the plan plugin's own guidance, so loop mode
 * yields (no guidance section, gate passes through) while it holds. Reads the
 * dsh-plan-mode projection through the SAME sessionProjections registry — no
 * cooperation needed from plan-mode. Any failure resolves to false (plain
 * loop session), the same fail-safe shape as modeOverrideOf.
 */
export function planWanted(ctx: unknown, session: unknown): boolean {
  if (session === undefined || session === null) return false
  const projections = (ctx as { sessionProjections?: ProjectionsLike })?.sessionProjections
  if (projections === undefined || typeof projections.stateOf !== 'function') return false
  try {
    const state = projections.stateOf(session, 'plan') as
      | { active?: unknown; wanted?: unknown; running?: { wanted?: unknown } | null }
      | undefined
    if (state === undefined || state === null || typeof state !== 'object') return false
    if (state.active === true) return true
    if (state.running?.wanted === true) return true
    if (state.wanted === true) return true
    return false
  } catch {
    return false
  }
}
