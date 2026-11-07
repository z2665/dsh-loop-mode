/**
 * dsh-loop-mode — a minimal cybernetics loop MODE for DSH.
 *
 * Design idea distilled from MarchLiu's dsh-cybernetics
 * (https://github.com/MarchLiu/dsh-cybernetics and the blog post
 * "Cybernetics Agent——人工智能应用的新范式"): turn agent orchestration into
 * an explicit feedback control loop — goal (setpoint) → fresh task subagent
 * (act) → independent verify subagent (measure) → controller decision with
 * the user as the outer loop (calibrate).
 *
 * The blog's four key designs, each carried STRUCTURALLY (never by advice):
 * 1. Append-only goal lineage — update_goal is removed by the hard gate; the
 *    only goal-change verb is the loop_revise tool: reason required, old goal
 *    tombstoned, replacement created, one audit event appended to the session
 *    log and folded by the loopRevisions projection.
 * 2. Rationed context — executors and verifiers are fresh subagents
 *    (subagent_fork removed by the gate); the verifier's prompt and output
 *    schema are authored by the PLUGIN (loop_verify), so measurement never
 *    inherits the executor's narrative or the session's history.
 * 3. Hard gate — assembly filter + dispatch deny remove every world-changing
 *    tool from the top-level controller while the mode is on.
 * 4. Bounded graded rounds — create_goal carries maxGoalRounds (platform
 *    round budget); the protocol routes bounded lookups to quick single
 *    rounds and everything else through the full measure loop.
 *
 * And the one principle this simple version adds over the original:
 * **completely inert until the mode is switched on**. No guidance, no gate,
 * no touched tools in the default state — mode-off sessions do not even see
 * this plugin's tools. `/loop on` (a durable, ignorable session event folded
 * by a registered projection) activates everything, for THAT session only.
 * Plan mode outranks the loop: while a plan is active the section yields and
 * the gate passes through.
 *
 * @module dsh-loop-mode
 */
import z from '@deepseek-ai/schemastery'
import {
  MODE_EVENT_TYPE, loopModeProjection, modeOverrideOf, effectiveEnabled, planWanted, sessionPresetOf, resolveMode,
} from './mode.ts'
import {
  REVISE_EVENT_TYPE, revisionsProjection, revisionsOf,
  VERIFY_EVENT_TYPE, verifyLedgerProjection, quickSpentOf,
} from './goals.ts'
import {
  resolveGateAllowlist, buildGuidance, buildVerifierPrompt, buildFullReviewPrompts, REVIEW_DIRECTIONS,
  VERDICT_SCHEMA, filterAssemblyTools, stripPluginTools, isDeniedByGate, isPluginTool, isTopLevel,
  fenceField, fenceNonce, TASK_PREAMBLE,
} from './protocol.ts'
import {
  parseModelSpec, agentOptionsFor, formatRoute, validateModelRoute,
} from './routes.ts'
import {
  appendAudit, auditFile, preview, parseStructuredResult, summarizeAudit, renderReport, readAudit,
} from './audit.ts'

export const name = 'dsh-loop-mode'

export const inject = [
  'tools',
  'systemPrompt',
  'goals',
  'subagents',
  'agents',
  'workingDirectory',
  'sessionProjections',
] as const
// All root-level services (the same seams dsh-plan-mode and dsh-cybernetics
// inject at the top level). The commands service is resolved in a child scope
// via ctx.inject(['commands'], …) — the dsh-plan-mode registration shape.

export const Config = z.object({
  defaultOn: z.boolean().default(false).volatile()
    .description('全局面默认值（默认 false）：未执行过 /loop 的会话继承此值。保持 false 即“按会话显式开启”；true 则“默认全开、/loop off 按会话退出”。保存即时生效。'),
  gate: z.boolean().default(true).volatile()
    .description('模式开启期间是否装配硬门（默认 true）：装配期从顶层会话摘除一切变更类工具（含 update_goal）、调用分发层兜底拒绝，只保留读/对话/goal/委派动词。关闭后模式只剩协议引导（劝告式）。保存即时生效。'),
  maxRounds: z.number().min(1).max(10).default(3).volatile()
    .description('每个 goal 的连续矫正轮上限（默认 3）：create_goal/loop_revise 以此写入 maxGoalRounds（平台轮次预算），达到上限后控制器停止自动迭代、如实回报。保存即时生效。'),
  generalModel: z.string().volatile()
    .description('通用执行者（loop_task tier=general）的模型路由（volatile）："provider/model" 或裸模型名；留空 = 继承子代理默认路由。适合常规/机械/有界任务。由插件在委派时结构性附带。'),
  generalEffort: z.string().volatile()
    .description('通用执行者的思考强度档位（volatile，可留空）：随 generalModel 一并附带。'),
  seniorModel: z.string().volatile()
    .description('高级执行者（loop_task tier=senior）的模型路由（volatile）："provider/model" 或裸模型名；留空 = 继承子代理默认路由。适合复杂/高风险/多步变更与新颖任务。'),
  seniorEffort: z.string().volatile()
    .description('高级执行者的思考强度档位（volatile，可留空）。'),
  verifyModel: z.string().volatile()
    .description('验收者（loop_verify）的模型路由（volatile）："provider/model" 或裸模型名；留空 = 继承子代理默认路由。验收者与执行者可用不同模型——测量与行动分离的模型面。'),
  verifyEffort: z.string().volatile()
    .description('验收者的思考强度档位（volatile，可留空）。'),
  quickVerifyBudget: z.number().min(1).max(10).default(3).volatile()
    .description('每 goal 连续快速验收预算（默认 3）：用尽后 loop_verify 拒绝 quick、要求 mode=full（三方向全量评审）。保存即时生效。'),
  loopPresetId: z.string().default('loop').volatile()
    .description('视为"默认开启 loop 模式"的 Agent 预设 id（默认 loop，即本插件 presets/loop.patch.yml 声明的预设）。会话选择了该预设即默认开模式；/loop off 仍可按会话退出。保存即时生效。'),
  delegateProvider: z.string()
    .description('loop_task / loop_verify 使用的 subagent provider 名（非 volatile，缺省/留空自动选择且经能力校验：跳过继承父上下文或缺少所需能力的 provider）。修改需插件重载。'),
  gateAllowlistExtra: z.array(z.string())
    .description('硬门 allowlist 追加项（非 volatile）：在本部署需要保留给控制器的额外工具名。修改需插件重载。'),
  commandName: z.string().default('loop')
    .description('斜杠命令名（默认 loop，非 volatile）。修改需插件重载。'),
})

/** One resolved config field: a live reference (volatile), or a plain value. */
type ConfigField<T> = { get(): T } | T

/** Read one resolved config field, following the live reference the schema produces for volatile fields. */
function readConfigField<T>(field: ConfigField<T> | undefined, fallback: T): T {
  if (field === undefined) return fallback
  if (typeof field === 'object' && field !== null && typeof (field as { get?: unknown }).get === 'function') {
    const value = (field as { get(): T }).get()
    return value === undefined ? fallback : value
  }
  return field as T
}

/** Writes an ignorable plugin record onto a session (host API). */
type ModeAppender = (session: unknown, type: string, data: unknown) => unknown

/**
 * The plugin-record appender. Resolved lazily from '@deepseek-ai/dsh-session'
 * (dynamic import kicked off at apply() time) so that this module — and the
 * offline test suite — never needs the host package at import time. The
 * dynamic import also sidesteps the dual-module-instance pitfall MarchLiu
 * documented (a statically linked copy may fail the host Session brand
 * check); if the resolved copy rejects a session, the error surfaces in the
 * tool/command result instead of failing silently.
 */
let modeAppender: ModeAppender | undefined
let appenderSettled = false

/** Test seam: inject a synchronous appender (pass undefined to restore). */
export function setModeAppenderForTest(appender?: ModeAppender): void {
  modeAppender = appender
  appenderSettled = appender !== undefined
}

function kickAppenderLoad(): void {
  if (appenderSettled || modeAppender !== undefined) return
  appenderSettled = true
  void import('@deepseek-ai/dsh-session')
    .then((mod) => {
      const candidate = (mod as { appendPluginRecord?: unknown }).appendPluginRecord
      if (typeof candidate === 'function' && modeAppender === undefined) {
        modeAppender = candidate as ModeAppender
      }
    })
    .catch(() => {
      // Tools/commands surface the not-ready error; nothing to do at boot.
      appenderSettled = false
    })
}

export function apply(ctx: any, config: Partial<Config> = {}) {
  const commandName = (() => {
    const raw = typeof config.commandName === 'string' ? config.commandName.trim() : ''
    // Charset-guarded (security review): a command name that collides with or
    // mimics other registrations must not be expressible through config.
    return /^[a-z0-9-]+$/.test(raw) ? raw : 'loop'
  })()
  // Volatile fields arrive as live references — always read at use time.
  const defaultOn = (): boolean => readConfigField(config.defaultOn, false) === true
  const gateOn = (): boolean => readConfigField(config.gate, true) === true
  const maxRounds = (): number => {
    const value = readConfigField(config.maxRounds, 3)
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3
  }
  const allow = (): Set<string> => resolveGateAllowlist(config.gateAllowlistExtra)
  // --- full-chain observability (best-effort audit trail) -------------------
  // childId -> which loop role launched it (settlement correlation).
  const childRoles = new Map<string, { role: 'task' | 'verify'; tier?: 'general' | 'senior'; sessionId: string }>()
  const sessionIdOf = (session: unknown): string | undefined => {
    const id = (session as { id?: unknown } | undefined)?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }
  /** Fire-and-forget audit append; observability never breaks the loop. */
  const audit = (
    session: unknown,
    kind: 'mode' | 'round' | 'goal' | 'task' | 'task-settled' | 'verify' | 'verdict' | 'revise' | 'lifecycle' | 'deny',
    fields: Record<string, unknown>,
  ): void => {
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    let root: string | undefined
    try {
      root = ctx.workingDirectory?.get?.(session)
    } catch { root = undefined }
    if (typeof root !== 'string' || root.length === 0) return
    void appendAudit(root, sessionId, { ts: new Date().toISOString(), kind, ...fields })
  }

  const loopPresetId = (): string => {
    const raw = readConfigField(config.loopPresetId, 'loop')
    return typeof raw === 'string' && /^[a-z0-9-]+$/.test(raw) ? raw : 'loop'
  }
  const enabledFor = (session: unknown): boolean => effectiveEnabled(ctx, session, defaultOn(), loopPresetId())

  // --- per-role model routes (volatile, read live) --------------------------
  // Executor is two-tier: senior (complex/risky/novel work) and general
  // (routine/mechanical/bounded work) — each with its own model + effort.
  type ExecutorTier = 'general' | 'senior'
  const tierRoute = (tier: ExecutorTier) =>
    tier === 'senior'
      ? parseModelSpec(readConfigField(config.seniorModel, ''))
      : parseModelSpec(readConfigField(config.generalModel, ''))
  const tierEffortText = (tier: ExecutorTier) =>
    tier === 'senior'
      ? readConfigField(config.seniorEffort, '')
      : readConfigField(config.generalEffort, '')
  const tierRouteText = (tier: ExecutorTier) => formatRoute(tierRoute(tier), tierEffortText(tier))
  const verifyRoute = () => parseModelSpec(readConfigField(config.verifyModel, ''))
  const verifyRouteText = () => formatRoute(verifyRoute(), readConfigField(config.verifyEffort, ''))
  const quickVerifyBudget = (): number => {
    const value = readConfigField(config.quickVerifyBudget, 3)
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 3
  }

  /**
   * Resolve the delegation provider for a loop tool: the configured name
   * (capability-checked — a provider that inherits parent context or lacks
   * the needed capability is skipped, security review), else the first
   * registered fresh-context provider satisfying the needs. Auto-pick prefers
   * providers with agentOptions/outputSchema capabilities so an unset config
   * does not silently drift to a zero-capability external backend.
   */
  const resolveDelegateProvider = (needs: { outputSchema?: boolean; agentOptions?: boolean }): string | undefined => {
    const subagents = ctx.subagents as any
    const passes = (provider: any): boolean => {
      if (provider === undefined) return false
      if (provider.inheritsParentContext === true) return false
      if (needs.outputSchema === true && provider.capabilities?.outputSchema !== true) return false
      if (needs.agentOptions === true && provider.capabilities?.agentOptions !== true) return false
      return true
    }
    let names: string[] = []
    try { names = subagents.list?.() ?? [] } catch { names = [] }
    const configured = readConfigField(config.delegateProvider, undefined as string | undefined)
    if (typeof configured === 'string' && configured.length > 0) {
      if (passes(subagents.getProvider?.(configured))) return configured
      // configured but unsuitable → fall through to auto-pick
    }
    const capable = names.filter((name) => passes(subagents.getProvider?.(name)))
    if (capable.length > 0) return capable[0]
    // No provider meets the full needs: for needs without hard capabilities
    // (loop_task with no route), any fresh provider still works.
    if (needs.outputSchema !== true && needs.agentOptions !== true) {
      const fresh = names.filter((name) => {
        const provider = subagents.getProvider?.(name)
        return provider !== undefined && provider.inheritsParentContext !== true
      })
      if (fresh.length > 0) return fresh[0]
    }
    return undefined
  }

  // Catalog validation cache: one probe per spec per minute — volatile config
  // flips are picked up on the next TTL window, and the host's delegation
  // preflight remains the enforcement of last resort either way.
  const routeProbeCache = new Map<string, { at: number; result: Promise<{ ok: boolean; detail?: string }> }>()
  const probeRoute = (spec: unknown): Promise<{ ok: boolean; detail?: string }> => {
    const key = typeof spec === 'string' ? spec.trim() : ''
    if (key.length === 0) return Promise.resolve({ ok: true })
    const now = Date.now()
    const cached = routeProbeCache.get(key)
    if (cached !== undefined && now - cached.at < 60_000) return cached.result
    const llm = (() => { try { return ctx.get?.('llm') } catch { return undefined } })()
    const result = validateModelRoute(llm, key).then((r) =>
      r.ok ? { ok: true } : { ok: false, detail: `${r.status}: ${r.detail ?? ''}` })
    routeProbeCache.set(key, { at: now, result })
    return result
  }

  const disposers: Array<() => void> = []
  const safePush = (d: unknown) => { if (typeof d === 'function') disposers.push(d) }

  kickAppenderLoad()

  // --- projections: durable /loop override + the revision chain ------------
  const projections = ctx.sessionProjections as
    | { register?: (definition: unknown) => (() => void) | undefined }
    | undefined
  if (projections !== undefined && typeof projections.register === 'function') {
    // The host's own usage awaits register (dsh-goal index.js:599) — accept a
    // thenable handle as well as a sync disposer (architecture review).
    const registerProjection = (def: unknown): void => {
      const returned = projections.register!(def)
      if (returned !== null && typeof returned === 'object' && typeof (returned as { then?: unknown }).then === 'function') {
        disposers.push(() => { void (returned as Promise<{ dispose?: () => void } | void>).then((h) => { try { h?.dispose?.() } catch { /* idempotent */ } }) })
      } else {
        safePush(returned)
      }
    }
    registerProjection(loopModeProjection())
    registerProjection(revisionsProjection())
    registerProjection(verifyLedgerProjection())
  }

  // --- guidance section: the loop protocol, per-session mode-gated ----------
  let disposeSection: (() => void) | undefined
  if (typeof ctx.systemPrompt?.section === 'function') {
    disposeSection = ctx.systemPrompt.section({
      name: 'loop-mode',
      order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
      text: (context: any) => {
        // Dual-read (architecture review High finding): the host's own
        // sections receive ({ scope, toolSet }) — dsh-tools.js:607 — while
        // dsh-plan-mode-era plugins read context.agent.session. Accept both;
        // dogfooding verifies which shape this host delivers.
        const session = context?.agent?.session ?? context?.scope?.session
        // Mode-gated EVERYTHING: sessions without the mode get no text at all.
        if (!enabledFor(session)) return ''
        // Plan precedence: plan discipline rides plan-mode's own section.
        if (planWanted(ctx, session)) return ''
        return buildGuidance({
          maxRounds: maxRounds(),
          gate: gateOn(),
          generalRoute: tierRouteText('general'),
          seniorRoute: tierRouteText('senior'),
          verifyRoute: verifyRouteText(),
          quickVerifyBudget: quickVerifyBudget(),
        })
      },
    })
    safePush(() => { try { disposeSection?.() } catch { /* idempotent teardown */ } })
  }

  // --- gate listeners: assembly filter + dispatch deny ----------------------
  // Semantics per event (all inputs re-read live):
  //   delegated child        → plugin's own tools hidden/denied everywhere
  //                            (children never drive the loop), rest untouched
  //   top-level, mode off /
  //   plan active            → plugin's own tools hidden/denied, rest untouched
  //   top-level, mode on,
  //   gate on                → allowlist filter / dispatch deny
  //   top-level, mode on,
  //   gate off               → everything passes (protocol-only stance)
  if (typeof ctx.on === 'function') {
    const assembleDisposer = ctx.on('system-prompt/assemble', (assembly: any, context: any, next: () => unknown) => {
      const scope = context?.scope
      if (Array.isArray(assembly.tools) && !isTopLevel(ctx, scope)) {
        // Children never see the loop's conversation-seam tools, whatever the
        // host's mode resolution for them would be.
        assembly.tools = stripPluginTools(assembly.tools)
        return next()
      }
      const session = scope?.session
      const active = enabledFor(session) && !planWanted(ctx, session)
      if (Array.isArray(assembly.tools)) {
        if (!active) assembly.tools = stripPluginTools(assembly.tools)
        else if (gateOn()) assembly.tools = filterAssemblyTools(assembly.tools, allow())
      }
      return next()
    })
    safePush(assembleDisposer)

    const dispatchDisposer = ctx.on('tools/pre-execute', (exec: any, next: () => Promise<unknown>) => {
      const toolName = exec?.name
      if (typeof toolName !== 'string') return next()
      if (!isTopLevel(ctx, exec?.agent)) {
        // Children cannot drive the loop — structural, mode-independent.
        if (!isPluginTool(toolName)) return next()
        return Promise.resolve({
          kind: 'deny' as const,
          reason: `loop-mode: "${toolName}" is reserved for the top-level controller session.`,
        })
      }
      const session = exec?.agent?.session
      const active = enabledFor(session) && !planWanted(ctx, session)
      if (!active) {
        // Default state: this plugin's tools are not callable — mode hygiene.
        if (!isPluginTool(toolName)) return next()
        audit(session, 'deny', { tool: toolName, phase: 'mode-off' })
        return Promise.resolve({
          kind: 'deny' as const,
          reason: `loop-mode: "${toolName}" requires the loop mode. /loop on activates it for this session.`,
        })
      }
      if (!gateOn()) return next()
      // Plan approval survives even a planWanted detection failure.
      if (toolName === 'exit_plan_mode') return next()
      if (!isDeniedByGate(toolName, allow())) return next()
      audit(session, 'deny', { tool: toolName, phase: 'gate' })
      return Promise.resolve({
        kind: 'deny' as const,
        reason:
          `loop-mode hard gate: tool "${toolName}" is not available to the controller. ` +
          'Delegate the work: launch a task subagent with a complete brief (subagent tool), ' +
          'then measure with loop_verify. Goal changes go through loop_revise. /loop off restores native tools.',
      })
    })
    safePush(dispatchDisposer)

    // --- settlement classification helpers (observability) --------------------
    /** ChildIds already recorded from a settlement — idempotence guard: an
     * inbox message can legitimately fire agent/inbox/inserted again on
     * relocation (nextTurn → nextStep), and each copy would re-record. */
    const settledChildIds = new Set<string>()
    /** Record one child settlement: verdict when parseable, else explicit. */
    const recordSettlement = (
      session: unknown,
      childId: string,
      message: unknown,
      known: { role: 'task' | 'verify'; tier?: 'general' | 'senior'; direction?: string },
    ): void => {
      if (settledChildIds.has(childId)) return
      settledChildIds.add(childId)
      const firstText = Array.isArray((message as any)?.content)
        ? ((message as any).content.find((b: any) => b?.type === 'text') as { text?: unknown } | undefined)?.text
        : undefined
      if (known.role !== 'verify') {
        audit(session, 'task-settled', { childId, role: known.role, summary: preview(firstText, 120) })
        return
      }
      const verdict = parseStructuredResult((message as any)?.content)
      if (verdict === null) {
        // No structured result — the verifier ended abnormally (error /
        // refusal / max-tokens). Count separately, never as met=false.
        audit(session, 'verify-settled', { childId, direction: known.direction, parsed: false, summary: preview(firstText, 120) })
        return
      }
      const criteria = Array.isArray(verdict?.criteria) ? (verdict?.criteria as unknown[]) : []
      const gaps = Array.isArray(verdict?.gaps) ? (verdict?.gaps as unknown[]).filter((g) => typeof g === 'string') : []
      audit(session, 'verdict', {
        childId,
        direction: known.direction,
        met: verdict?.met === true,
        pass: criteria.filter((c) => (c as { pass?: unknown })?.pass === true).length,
        fail: criteria.filter((c) => (c as { pass?: unknown })?.pass !== true).length,
        goalQuestionable: verdict?.goalQuestionable === true,
        gaps: gaps.slice(0, 5).map((g) => preview(g, 200)),
      })
    }
    /** ChildIds already proven absent from the audit trail (negative cache). */
    const rebuildMisses = new Set<string>()
    /** Rebuild a lost childRoles correlation from the durable audit trail. */
    const rebuildChildRole = async (
      childId: string,
      session: unknown,
    ): Promise<{ role: 'task' | 'verify'; direction?: string } | undefined> => {
      let root: string | undefined
      try { root = ctx.workingDirectory?.get?.(session) } catch { root = undefined }
      const sessionId = sessionIdOf(session)
      if (typeof root !== 'string' || sessionId === undefined) return undefined
      const events = await readAudit(root, sessionId)
      const record = events.find((e) => (e.kind === 'verify' || e.kind === 'task') && e.childId === childId)
      if (record === undefined) return undefined
      if (record.kind === 'task') return { role: 'task' }
      return { role: 'verify', direction: typeof record.direction === 'string' ? record.direction : undefined }
    }

    // --- observability listeners: platform rounds + child settlements --------
    // Mode-gated (architecture review): a session that never /loop'd must
    // leave NO trace — default inertness applies to observation too.
    const goalDisposer = ctx.on('goal/changed', (payload: any) => {
      try {
        const session = payload?.agent?.session
        if (!enabledFor(session)) return
        const change = payload?.change
        const goal = change?.goal ?? {}
        // The host's clear notification carries no goal object — the tombstone
        // ref is the id source (dsh-goal index.js:749-757).
        const id = goal.id ?? change?.cleared?.id ?? change?.ref?.id
        audit(session, 'goal', {
          operation: change?.operation,
          id,
          revision: goal.revision ?? change?.cleared?.revision ?? change?.ref?.revision,
          phase: goal.phase,
          maxGoalRounds: goal.maxGoalRounds,
          objectivePreview: preview(goal.objective, 100),
        })
      } catch { /* observability never throws */ }
    })
    safePush(goalDisposer)

    const inboxDisposer = ctx.on('agent/inbox/inserted', (payload: any) => {
      try {
        const agent = payload?.agent
        const message = payload?.message
        const source = message?.source
        if (source?.kind === 'goal' && typeof source.round === 'number' && source.round > 0) {
          // The platform goal-round driver injected a continuation round.
          if (!enabledFor(agent?.session)) return
          audit(agent?.session, 'round', { goalId: source.goalId, revision: source.revision, round: source.round })
          return
        }
        if (source?.kind === 'subagent-settled' && typeof source.senderSessionId === 'string') {
          const childId = source.senderSessionId
          if (!enabledFor(agent?.session)) return
          const known = childRoles.get(childId)
          if (known !== undefined) {
            recordSettlement(agent?.session, childId, message, known)
            childRoles.delete(childId)
          } else if (!rebuildMisses.has(childId)) {
            // Restart/resume drift: rebuild the correlation from the durable
            // audit trail (verify/task records carry childId), then record.
            void (async () => {
              const rebuilt = await rebuildChildRole(childId, agent?.session)
              if (rebuilt !== undefined) recordSettlement(agent?.session, childId, message, rebuilt)
              else rebuildMisses.add(childId)
            })()
          }
        }
      } catch { /* observability never throws */ }
    })
    safePush(inboxDisposer)
  }

  // --- loop_task: routed task executor launch (ACT) -------------------------
  if (typeof ctx.tools?.register === 'function') {
    const taskDisposer = ctx.tools.register({
      name: 'loop_task',
      description:
        'Launch a TASK EXECUTOR for one round of loop work: a fresh subagent (no conversation ' +
        'history) that receives your brief verbatim and returns its result. Choose the tier by task ' +
        'shape: senior for complex/risky/multi-step changes or novel problems; general for routine, ' +
        'mechanical or bounded work. The model route per tier is pinned by the plugin from deployment ' +
        'config (generalModel/seniorModel + efforts) — do not try to select a model yourself. The ' +
        'brief is a COMPLETE work order: background, paths, constraints, acceptance criteria; ' +
        'anything it omits does not exist for the executor.',
      parameters: {
        type: 'object',
        properties: {
          tier: { type: 'string', enum: ['general', 'senior'], description: 'general=常规/机械/有界任务（默认）；senior=复杂/高风险/多步变更或新颖任务。' },
          description: { type: 'string', description: 'A short (3-5 word) description of the task, for display.' },
          brief: { type: 'string', description: 'The complete, self-contained work order for the executor.' },
        },
        required: ['description', 'brief'],
        additionalProperties: false,
      },
      // Host contract (dsh-tools.js:436): output {schema, render} is REQUIRED —
      // a top-level render alone throws TypeError at register time.
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { tier?: string; description?: string; brief?: string }, exec: any) {
        const subagents = ctx.subagents
        if (subagents === undefined) throw new Error('loop_task: subagents service unavailable')
        const parent = exec?.agent
        if (parent?.session === undefined) throw new Error('loop_task requires a calling agent session')
        if ((parent.session as any)?.header?.parentSession !== undefined) {
          throw new Error('loop_task: reserved for the top-level controller session (this agent is a delegated child).')
        }
        const tier: ExecutorTier = args.tier === 'senior' ? 'senior' : 'general'
        const description = typeof args.description === 'string' ? args.description.trim() : ''
        const brief = typeof args.brief === 'string' ? args.brief.trim() : ''
        if (brief.length === 0) throw new Error('loop_task: brief is required (the complete work order)')
        const route = tierRoute(tier)
        const effort = tierEffortText(tier)
        const agentOptions = agentOptionsFor(route, effort)
        if (agentOptions !== undefined) {
          const probe = await probeRoute(tier === 'senior'
            ? readConfigField(config.seniorModel, '')
            : readConfigField(config.generalModel, ''))
          if (!probe.ok) throw new Error(`loop_task: 配置的 ${tier}Model 不可用——${probe.detail}。请在插件配置中修正（或清空以继承默认路由）。`)
        }
        const providerName = resolveDelegateProvider({ agentOptions: agentOptions !== undefined })
        if (providerName === undefined) {
          throw new Error(agentOptions !== undefined
            ? 'loop_task: no fresh-context subagent provider with agentOptions capability is registered (set config delegateProvider explicitly)'
            : 'loop_task: no fresh-context subagent provider is registered (set config delegateProvider explicitly)')
        }
        const prompt =
          'TASK BRIEF — you are a task executor in a cybernetics control loop. You have NO conversation ' +
          'history: this brief is everything you know. Deliver the work it orders and report the outcome ' +
          'with concrete evidence.\n\n' +
          `${TASK_PREAMBLE}\n\n${fenceField('WORK ORDER', brief, fenceNonce())}`
        const activation = await subagents.startActivation({
          provider: providerName,
          label: description.length > 0 ? description : 'loop task',
          request: {
            prompt: [{ type: 'text', text: prompt }],
            parent,
            ...agentOptions === undefined ? {} : { agentOptions },
          },
          signal: exec?.signal,
          delivery: 'parent',
        })
        childRoles.set(activation.childId, { role: 'task', tier, sessionId: sessionIdOf(parent.session) ?? '' })
        audit(parent.session, 'task', {
          childId: activation.childId,
          tier,
          provider: providerName,
          route: formatRoute(route, effort),
          description: preview(description, 60),
          briefChars: brief.length,
          briefPreview: preview(brief, 120),
        })
        return {
          text:
            `${tier} 执行者已启动（provider ${providerName}${agentOptions !== undefined ? `，路由 ${formatRoute(route, effort)}` : '，默认路由'}，subagent ${activation.childId}）。` +
            '结果将作为其返回送达；期间可继续与用户对话（外环不受阻塞）。',
        }
      },
    })
    safePush(taskDisposer)

    const reviseDisposer = ctx.tools.register({
      name: 'loop_revise',
      description:
        'Revise the session goal — the ONLY goal-change verb (update_goal is structurally unavailable). ' +
        'Append-only: tombstones the current goal, creates a replacement objective, and appends one ' +
        'durable audit record {from, to, reason} to the session log. Requires the user\'s confirmation ' +
        'in conversation first. Use for goal-level corrections; for execution-level correction just ' +
        'launch a better-briefed round under the SAME goal.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the goal changes (required, enters the durable audit chain).' },
          objective: { type: 'string', description: 'The replacement objective, carrying explicit acceptance criteria (required).' },
          maxGoalRounds: { type: 'number', description: `Round cap for the new goal, clamped to the deployment maxRounds (currently ${maxRounds()}).` },
        },
        required: ['reason', 'objective'],
        additionalProperties: false,
      },
      // Host contract (dsh-tools.js:436): output {schema, render} is REQUIRED —
      // a top-level render alone throws TypeError at register time.
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { reason?: string; objective?: string; maxGoalRounds?: number }, exec: any) {
        const goals = ctx.goals
        if (goals === undefined) throw new Error('loop_revise: goals service unavailable — is dsh-goal loaded?')
        const parent = exec?.agent
        if (parent?.session === undefined) throw new Error('loop_revise requires a calling agent session')
        if ((parent.session as any)?.header?.parentSession !== undefined) {
          throw new Error('loop_revise: reserved for the top-level controller session (this agent is a delegated child).')
        }
        const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
        const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
        if (reason.length === 0) throw new Error('loop_revise: reason is required (append-only audit)')
        if (objective.length === 0) throw new Error('loop_revise: objective is required')
        if (typeof modeAppender !== 'function') kickAppenderLoad()
        if (typeof modeAppender !== 'function') {
          throw new Error('loop_revise: audit appender not ready (host @deepseek-ai/dsh-session unresolved); retry shortly')
        }
        // Snapshot the outgoing goal (may be absent: first goal of the session).
        let from: { id: string; revision: number } | null = null
        let fromObjective: string | undefined
        let fromCap: number | undefined
        const current = goals.get(parent)
        if (current !== undefined && current !== null && current.phase !== 'complete') {
          from = { id: current.id, revision: current.revision }
          fromObjective = typeof current.objective === 'string' ? current.objective : undefined
          fromCap = typeof current.maxGoalRounds === 'number' ? current.maxGoalRounds : undefined
          goals.clear(parent, from)
        }
        // Round budget is clamped to the deployment cap (security review): the
        // constrained party cannot grant itself a larger budget than maxRounds.
        const deploymentCap = maxRounds()
        const requested = Number.isFinite(args.maxGoalRounds) && (args.maxGoalRounds as number) >= 1
          ? Math.floor(args.maxGoalRounds as number)
          : deploymentCap
        const cap = Math.min(requested, deploymentCap)
        let created: { id: string; revision: number }
        try {
          created = goals.create(parent, { objective, maxGoalRounds: cap })
        } catch (error) {
          // clear succeeded but create failed — the slot is empty. Best-effort
          // compensation: restore the old objective so the setpoint survives.
          let restored = false
          if (fromObjective !== undefined) {
            try {
              goals.create(parent, { objective: fromObjective, maxGoalRounds: fromCap ?? deploymentCap })
              restored = true
            } catch { /* compensation failed too — the message below tells the model what to do */ }
          }
          throw new Error(
            `loop_revise: 创建新 goal 失败（${String((error as Error)?.message ?? error)}）。` +
            (restored
              ? `旧 goal 的 objective 已原样重建——修订未发生，向用户报告后重试。`
              : fromObjective !== undefined
                ? `旧 goal 已被清除且重建失败——请立即用 create_goal 重建原 objective，并向用户报告。`
                : `本会话原先无 goal——向用户报告后重试。`),
          )
        }
        const record = {
          from,
          to: { id: created.id, revision: created.revision },
          reason,
          at: new Date().toISOString(),
        }
        try {
          modeAppender(parent.session, REVISE_EVENT_TYPE, record)
        } catch (error) {
          // The goal slot already moved; the audit line is the only casualty —
          // surface it loudly rather than losing the revision silently.
          throw new Error(`loop_revise: goal replaced (${from?.id ?? '∅'} → ${created.id}) but the audit event failed: ${String(error)}`)
        }
        // outgoingPhase classifies the revision in the measurement layer: a
        // paused outgoing goal is the met→pause progression (phase advance);
        // an active/blocked one is a mid-course correction.
        audit(parent.session, 'revise', {
          from: from?.id ?? null,
          to: created.id,
          outgoingPhase: from !== null && current !== undefined && current !== null && typeof current.phase === 'string' ? current.phase : null,
          reason: preview(reason, 100),
        })
        return {
          text:
            `goal 修订完成：${from !== null ? `${from.id} → 墓穴` : '（无前序 goal）'} 新 goal ${created.id}（objective 已更新，轮上限 ${cap}）。` +
            `reason 已入持久审计链（本会话修订数 +1）。`,
        }
      },
    })
    safePush(reviseDisposer)

    // --- loop_verify: plugin-authored independent measurement (tiered) -------
    const verifyDisposer = ctx.tools.register({
      name: 'loop_verify',
      description:
        'Commission INDEPENDENT verification for a finished task round. QUICK-FIRST policy: ' +
        'mode="quick" (default) — ONE fresh verifier, short-term quality focus — is the right cost ' +
        'for every routine verification and iteration round. mode="full" — THREE independent ' +
        'reviewers (architecture & conformance, security, code quality; met requires ALL THREE) — is ' +
        'reserved for MILESTONE deliverables: substantial staged artifacts handed to the user and the ' +
        'final acceptance of a major delivery. After the per-goal quick budget is spent the tool ' +
        'REFUSES quick and demands full. Supply the acceptance criteria, where the deliverable lives, ' +
        'and the executor\'s report (claims, never evidence).',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['quick', 'full'], description: 'quick=单验收者·短期质量（默认）；full=三方向独立评审（架构/安全/质量），全过才算 met。' },
          criteria: { type: 'string', description: 'The acceptance criteria to check, one per line (from the goal objective).' },
          deliverable: { type: 'string', description: 'Where the deliverable lives and what to inspect: paths, commands, artifacts.' },
          report: { type: 'string', description: 'The executor\'s structured report — claims the verifier must re-check, not accept.' },
          objective: { type: 'string', description: 'The goal objective (defaults to the session\'s current goal).' },
        },
        required: ['criteria', 'deliverable'],
        additionalProperties: false,
      },
      // Host contract (dsh-tools.js:436): output {schema, render} is REQUIRED —
      // a top-level render alone throws TypeError at register time.
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(args: { mode?: string; criteria?: string; deliverable?: string; report?: string; objective?: string }, exec: any) {
        const subagents = ctx.subagents
        if (subagents === undefined) throw new Error('loop_verify: subagents service unavailable')
        const parent = exec?.agent
        if (parent?.session === undefined) throw new Error('loop_verify requires a calling agent session')
        const mode = args.mode === 'full' ? 'full' : 'quick'
        if ((parent.session as any)?.header?.parentSession !== undefined) {
          throw new Error('loop_verify: reserved for the top-level controller session (this agent is a delegated child).')
        }
        const criteria = typeof args.criteria === 'string' ? args.criteria.trim() : ''
        const deliverable = typeof args.deliverable === 'string' ? args.deliverable.trim() : ''
        if (criteria.length === 0) throw new Error('loop_verify: criteria is required')
        if (deliverable.length === 0) throw new Error('loop_verify: deliverable is required')
        let objective = typeof args.objective === 'string' && args.objective.trim().length > 0
          ? args.objective.trim()
          : undefined
        const currentGoalView = (() => { try { return ctx.goals?.get?.(parent) } catch { return undefined } })()
        if (objective === undefined) {
          objective = typeof currentGoalView?.objective === 'string' && currentGoalView.objective.trim().length > 0
            ? currentGoalView.objective
            : '(no objective supplied and no current goal)'
        }
        const goalId = typeof currentGoalView?.id === 'string' ? currentGoalView.id : undefined
        const budget = quickVerifyBudget()
        // Pacing rule, structural half: refuse quick once the per-goal quick
        // budget is spent. Counted from the SESSION-LOG projection (v0.6.1,
        // security review): executors cannot write the controller's session
        // log, unlike the JSONL audit file they could truncate. A session
        // without a current goal counts under '_' — quick is never unlimited.
        let spent = 0
        if (mode === 'quick') {
          spent = quickSpentOf(ctx, parent.session, goalId)
          if (spent >= budget) {
            throw new Error(
              `loop_verify: 本 goal 的快速验收预算已用尽（${spent}/${budget}）——多轮 quick 之后必须做全量验收。` +
              `请以 mode="full" 重试（架构遵从/安全/代码质量三方向独立评审，全过才算 met）。`,
            )
          }
        }
        // Resolve the verifier's route: plugin-pinned from verifyModel/
        // verifyEffort (config), never chosen per call by the controller.
        const route = verifyRoute()
        const agentOptions = agentOptionsFor(route, readConfigField(config.verifyEffort, ''))
        if (agentOptions !== undefined) {
          const probe = await probeRoute(readConfigField(config.verifyModel, ''))
          if (!probe.ok) throw new Error(`loop_verify: 配置的 verifyModel 不可用——${probe.detail}。请在插件配置中修正（或清空以继承默认路由）。`)
        }
        const providerName = resolveDelegateProvider({
          outputSchema: true,
          agentOptions: agentOptions !== undefined,
        })
        if (providerName === undefined) {
          throw new Error('loop_verify: no fresh-context subagent provider with outputSchema capability is registered (set config delegateProvider explicitly)')
        }
        const routeText = formatRoute(route, readConfigField(config.verifyEffort, ''))
        const launch = async (label: string, prompt: string) => {
          const activation = await subagents.startActivation({
            provider: providerName,
            label,
            request: {
              prompt: [{ type: 'text', text: prompt }],
              parent,
              outputSchema: VERDICT_SCHEMA,
              ...agentOptions === undefined ? {} : { agentOptions },
            },
            signal: exec?.signal,
            delivery: 'parent',
          })
          return activation.childId as string
        }
        if (mode === 'full') {
          const prompts = buildFullReviewPrompts({ objective, criteria, deliverable, report: args.report })
          const childIds: string[] = []
          for (const direction of REVIEW_DIRECTIONS) {
            const childId = await launch(`loop verify: ${direction}`, prompts[direction])
            childRoles.set(childId, { role: 'verify', direction, sessionId: sessionIdOf(parent.session) ?? '' })
            if (typeof modeAppender !== 'function') kickAppenderLoad()
            try {
              // Durable pacing ledger: one ignorable session-log record per
              // launch — executors cannot write this channel (security fix).
              modeAppender?.(parent.session, VERIFY_EVENT_TYPE, { goalId: goalId ?? null, mode: 'full', direction })
            } catch { /* the audit file below still records the launch */ }
            audit(parent.session, 'verify', {
              childId, mode, direction, goalId,
              provider: providerName, route: routeText,
              criteriaPreview: preview(criteria, 100), deliverablePreview: preview(deliverable, 100),
            })
            childIds.push(childId)
          }
          return {
            text:
              `全量验收已启动：三个独立评审者（architecture / security / quality）${childIds.map((id, i) => `${REVIEW_DIRECTIONS[i]}=${id}`).join('、')}，` +
              `provider ${providerName}${agentOptions !== undefined ? `，路由 ${routeText}` : '，默认路由'}。` +
              '三份 verdict 将分别送达；全部 met 才算本轮通过——聚合所有方向的 gaps 构造矫正 brief。',
          }
        }
        const childId = await launch('loop verify', buildVerifierPrompt({ objective, criteria, deliverable, report: args.report }))
        childRoles.set(childId, { role: 'verify', sessionId: sessionIdOf(parent.session) ?? '' })
        if (typeof modeAppender !== 'function') kickAppenderLoad()
        try {
          modeAppender?.(parent.session, VERIFY_EVENT_TYPE, { goalId: goalId ?? null, mode: 'quick' })
        } catch { /* the audit file below still records the launch */ }
        audit(parent.session, 'verify', {
          childId, mode, goalId,
          provider: providerName, route: routeText,
          criteriaPreview: preview(criteria, 100), deliverablePreview: preview(deliverable, 100),
        })
        return {
          text:
            `快速验收已启动（provider ${providerName}${agentOptions !== undefined ? `，路由 ${routeText}` : '，默认路由'}，subagent ${childId}）：verifier 不继承本会话上下文，` +
            `按插件固定的提示词与输出契约做短期质量核查；verdict 将作为其结果返回。本 goal 快速预算剩 ${Math.max(0, budget - spent - 1)} 次后须全量。`,
        }
      },
    })
    safePush(verifyDisposer)

    // --- loop_pause / loop_resume: lifecycle verbs for the auto-round driver --
    // The platform goal-round-driver auto-injects rounds while the goal is
    // active+armed (and blocks it at maxGoalRounds). pause disarms that
    // heartbeat — the controller's "met, awaiting the user" state; resume
    // re-arms it after the user asks to continue. update_goal stays removed:
    // the objective itself is only ever changed by loop_revise.
    const currentRef = (parent: any) => {
      const view = ctx.goals.get(parent)
      if (view === undefined || view === null) throw new Error('loop_pause/loop_resume: 本会话没有当前 goal')
      return { ref: { id: view.id, revision: view.revision }, view }
    }
    const pauseDisposer = ctx.tools.register({
      name: 'loop_pause',
      description:
        'Pause the current goal: disarms the platform auto-round driver so the loop WAITS instead of ' +
        'burning round budget. Call it when the verdict is met (report first, then pause and await the ' +
        'user) or when the user asks to hold. Not a goal-content change — the objective is untouched.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // Host contract (dsh-tools.js:436): output {schema, render} is REQUIRED —
      // a top-level render alone throws TypeError at register time.
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(_args: Record<string, never>, exec: any) {
        if (ctx.goals === undefined) throw new Error('loop_pause: goals service unavailable')
        const parent = exec?.agent
        if (parent?.session === undefined) throw new Error('loop_pause requires a calling agent session')
        if ((parent.session as any)?.header?.parentSession !== undefined) {
          throw new Error('loop_pause: reserved for the top-level controller session.')
        }
        const { view } = currentRef(parent)
        try {
          ctx.goals.pause(parent, { id: view.id, revision: view.revision })
        } catch (error) {
          throw new Error(`loop_pause: ${String((error as Error)?.message ?? error)}`)
        }
        audit(parent.session, 'lifecycle', { verb: 'pause', id: view.id, roundsStarted: view.roundsStarted, maxGoalRounds: view.maxGoalRounds })
        return { text: `goal ${view.id} 已暂停（自动续跑解除，轮次预算保留 ${view.roundsStarted ?? 0}/${view.maxGoalRounds}）。等待用户：确认完成走用户的 /goal 命令或 UI；继续推进用 loop_resume。` }
      },
    })
    safePush(pauseDisposer)

    const resumeDisposer = ctx.tools.register({
      name: 'loop_resume',
      description:
        'Resume (re-arm) the current paused/blocked goal so the platform auto-round driver continues. ' +
        'Use after the user asks to keep going. Fails with the platform transition error when the round ' +
        'budget is exhausted — in that case report honestly; a fresh budget requires a user-confirmed ' +
        'loop_revise (new goal).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      // Host contract (dsh-tools.js:436): output {schema, render} is REQUIRED —
      // a top-level render alone throws TypeError at register time.
      output: {
        schema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        render: (_args: unknown, value: any) => [{ type: 'text', text: value.text }],
      },
      async execute(_args: Record<string, never>, exec: any) {
        if (ctx.goals === undefined) throw new Error('loop_resume: goals service unavailable')
        const parent = exec?.agent
        if (parent?.session === undefined) throw new Error('loop_resume requires a calling agent session')
        if ((parent.session as any)?.header?.parentSession !== undefined) {
          throw new Error('loop_resume: reserved for the top-level controller session.')
        }
        const { view } = currentRef(parent)
        try {
          ctx.goals.resume(parent, { id: view.id, revision: view.revision })
        } catch (error) {
          throw new Error(`loop_resume: ${String((error as Error)?.message ?? error)}`)
        }
        audit(parent.session, 'lifecycle', { verb: 'resume', id: view.id, roundsStarted: view.roundsStarted, maxGoalRounds: view.maxGoalRounds })
        return { text: `goal ${view.id} 已恢复（armed）——空闲时平台续跑驱动将注入下一轮；已用 ${view.roundsStarted ?? 0}/${view.maxGoalRounds} 轮。` }
      },
    })
    safePush(resumeDisposer)
  }

  // --- /loop command: the on/off switch -------------------------------------
  ctx.inject?.(['commands'], (commandCtx: any) => {
    const handler = async (invocation: any) => {
      const agent = invocation?.agent
      const session = agent?.session
      if (session === undefined || session === null || typeof session !== 'object') {
        return { kind: 'error' as const, text: 'loop: 会话不可用，无法读取/写入模式状态。' }
      }
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase()
      if (arg === 'on' || arg === 'off') {
        if (typeof modeAppender !== 'function') kickAppenderLoad()
        if (typeof modeAppender !== 'function') {
          return {
            kind: 'error' as const,
            text: 'loop: 模式事件写入器尚未就绪（宿主 @deepseek-ai/dsh-session 未解析）。请稍后重试；若持续失败请查看宿主日志。',
          }
        }
        try {
          // Ignorable plugin record: harness builds that do not know the type
          // may safely skip it (plain session.append would fail-close loads).
          modeAppender(session, MODE_EVENT_TYPE, { enabled: arg === 'on' })
        } catch (error) {
          return { kind: 'error' as const, text: `loop: 写入模式事件失败：${String(error)}` }
        }
        audit(session, 'mode', { on: arg === 'on' })
        return {
          kind: 'success' as const,
          text: arg === 'on'
            ? 'loop 控制回路已对本会话开启：协议引导 + 硬门（变更与 update_goal 仅可经委派/loop_revise）。写入为持久会话事件，resume/fork 后仍生效。/loop off 可关闭。'
            : 'loop 控制回路已对本会话关闭：不再注入协议引导，硬门放行，恢复 DSH 原生行为。/loop on 可重新开启。',
        }
      }
      if (arg === 'report') {
        // Full-chain measurement report from the append-only audit trail.
        let root: string | undefined
        try { root = ctx.workingDirectory?.get?.(session) } catch { root = undefined }
        const sessionId = sessionIdOf(session)
        if (typeof root !== 'string' || sessionId === undefined) {
          return { kind: 'error' as const, text: 'loop report: 工作区根目录或会话 id 不可用。' }
        }
        const events = await readAudit(root, sessionId)
        return { kind: 'success' as const, text: renderReport(summarizeAudit(events), auditFile(root, sessionId)) }
      }
      // No argument (or unknown text) = status report.
      const override = modeOverrideOf(ctx, session)
      const preset = sessionPresetOf(ctx, session)
      const resolution = resolveMode(override, defaultOn(), preset, loopPresetId())
      const effective = resolution.enabled
      const overrideText = override === null ? '未设置（继承预设/全局）' : override ? 'on' : 'off'
      const presetText = preset === null ? '未读取到' : `${preset}${resolution.source === 'preset' ? '（→ 默认开启）' : ''}`
      const chain = revisionsOf(ctx, session)
      const chainText = chain.count === 0
        ? '- goal 修订链：无修订记录'
        : `- goal 修订链：${chain.count} 次修订，最近一次 ${chain.last?.from?.id ?? '∅'} → ${chain.last?.to.id}（${chain.last?.reason.slice(0, 60) ?? ''}）`
      return {
        kind: 'success' as const,
        text:
          `loop 模式本会话状态：${effective ? '生效' : '关闭'}（来源：${resolution.source}）\n` +
          `- 会话 override：${overrideText}\n` +
          `- 会话 Agent 预设：${presetText}（loop 预设 id = ${loopPresetId()}）\n` +
          `- 全局 defaultOn：${defaultOn() ? 'on' : 'off'}\n` +
          `- 硬门 gate：${gateOn() ? 'on（模式开启的会话装配）' : 'off（模式只剩协议引导）'}\n` +
          `- 每目标矫正轮上限 maxRounds：${maxRounds()}\n` +
          `- 角色路由：通用执行者 → ${tierRouteText('general')}；高级执行者 → ${tierRouteText('senior')}；验收者 → ${verifyRouteText()}\n` +
          `- 验收分层：quick 单验收者（每 goal 预算 ${quickVerifyBudget()} 次），full=架构/安全/质量三方向独立评审\n` +
          `${chainText}\n` +
          `用法：/loop on | /loop off | /loop status | /loop report（测量报告）`,
      }
    }
    const commandDisposer = commandCtx.commands.register({
      name: commandName,
      description: 'Toggle the cybernetics control loop mode (controller protocol + hard gate) for THIS session; no argument shows status',
      input: { hint: '[on|off|status]' },
      handler,
    })
    safePush(commandDisposer)
  })

  return () => { disposers.forEach((d) => { try { d() } catch { /* idempotent teardown */ } }) }
}
