/**
 * Full-chain observability for dsh-loop-mode: an append-only JSONL audit
 * trail per session (`<workspace>/.loop-mode/audit-<sessionId>.jsonl`) and a
 * pure aggregator that turns it into the dogfooding measurement report.
 *
 * The design stance mirrors the blog's rule — "a failure you cannot see does
 * not exist": every loop-visible happening (mode flips, platform round
 * injections, goal transitions, task delegations and their settlements,
 * verifications and their verdicts, goal revisions, lifecycle verbs, hard-
 * gate denials) lands as one structured record. Writing is best-effort and
 * NEVER throws into the loop — observability must not be able to kill the
 * system it observes. Aggregation is pure so the report itself is testable.
 *
 * @module dsh-loop-mode/audit
 */
import { mkdir, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One audit record. `kind` discriminates; everything else is open. */
export interface AuditEvent {
  ts: string
  kind: 'mode' | 'round' | 'goal' | 'task' | 'task-settled' | 'verify' | 'verify-settled' | 'verdict' | 'revise' | 'lifecycle' | 'deny'
  [field: string]: unknown
}

/** Directory holding the audit files for one workspace. */
export function auditDir(root: string): string {
  return join(root, '.loop-mode')
}

/** Per-session audit file path: audit-<sanitized-id>.jsonl (the prefix keeps
 * our files distinguishable from raw session-id-named artifacts). */
export function auditFile(root: string, sessionId: string): string {
  return join(auditDir(root), `audit-${auditFileStem(sessionId)}.jsonl`)
}

/** File-stem sanitizer: session ids are usually safe, but never trust it.
 * Length-capped (security review): an over-long id must not silently break
 * every future append via ENAMETOOLONG. */
export function auditFileStem(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
  return cleaned.length > 0 ? cleaned : 'session'
}

/** Truncate for previews kept inside audit records. */
export function preview(text: unknown, max = 80): string {
  const s = typeof text === 'string' ? text : ''
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/**
 * Append one record. Best-effort by contract: any failure resolves false and
 * the caller proceeds — the audit trail must never break the loop.
 */
export async function appendAudit(root: string, sessionId: string, event: AuditEvent): Promise<boolean> {
  try {
    const dir = auditDir(root)
    await mkdir(dir, { recursive: true })
    await appendFile(auditFile(root, sessionId), `${JSON.stringify(event)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Read all records; unreadable file → []; corrupt lines are skipped. */
export async function readAudit(root: string, sessionId: string): Promise<AuditEvent[]> {
  let raw: string
  try {
    raw = await readFile(auditFile(root, sessionId), 'utf8')
  } catch {
    return []
  }
  const events: AuditEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as AuditEvent
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.kind === 'string') events.push(parsed)
    } catch { /* a corrupt line never hides the rest */ }
  }
  return events
}

/**
 * Parse the verdict from a settlement message's content blocks: the runtime
 * renders `Structured result: {json}` as one text block when the child used
 * an outputSchema. Returns null when no structured block is present.
 */
export function parseStructuredResult(content: unknown): Record<string, unknown> | null {
  if (!Array.isArray(content)) return null
  for (const block of content) {
    const text = (block as { type?: unknown; text?: unknown })?.text
    if (typeof text !== 'string') continue
    const marker = 'Structured result: '
    const at = text.indexOf(marker)
    if (at < 0) continue
    const payload = text.slice(at + marker.length).trim()
    try {
      const parsed = JSON.parse(payload)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* not our schema — ignore */ }
  }
  return null

}

/** Aggregated measurement for one session. */
export interface AuditSummary {
  window: { first: string | null; last: string | null; modeFlips: number }
  goals: { created: number; revisions: number; reviseReasons: string[]; finalPhases: Record<string, number> }
  rounds: { driven: number; byGoal: Record<string, number> }
  tasks: { launched: number; routes: Record<string, number>; settled: number }
  verifies: { launched: number; quick: number; full: number; verdicts: number; met: number; failed: number; unparsed: number; goalQuestionable: number; gaps: string[] }
  denies: { total: number; byTool: Record<string, number> }
}

/** Pure aggregation of the audit trail — the report's data layer. */
export function summarizeAudit(events: AuditEvent[]): AuditSummary {
  const summary: AuditSummary = {
    window: { first: null, last: null, modeFlips: 0 },
    goals: { created: 0, revisions: 0, reviseReasons: [], finalPhases: {} },
    rounds: { driven: 0, byGoal: {} },
    tasks: { launched: 0, routes: {}, settled: 0 },
    verifies: { launched: 0, quick: 0, full: 0, verdicts: 0, met: 0, failed: 0, unparsed: 0, goalQuestionable: 0, gaps: [] },
    denies: { total: 0, byTool: {} },
  }
  const goalPhase = new Map<string, string>()
  for (const event of events) {
    if (typeof event.ts === 'string') {
      if (summary.window.first === null) summary.window.first = event.ts
      summary.window.last = event.ts
    }
    switch (event.kind) {
      case 'mode':
        summary.window.modeFlips++
        break
      case 'round': {
        summary.rounds.driven++
        const goalId = typeof event.goalId === 'string' ? event.goalId : '?'
        summary.rounds.byGoal[goalId] = (summary.rounds.byGoal[goalId] ?? 0) + 1
        break
      }
      case 'goal': {
        const operation = String(event.operation ?? '?')
        if (operation === 'create') summary.goals.created++
        const id = typeof event.id === 'string' ? event.id : '?'
        // The host's clear notification carries a tombstone ref, no phase —
        // delete from the final-phase map on clear regardless of phase.
        if (operation === 'clear') goalPhase.delete(id)
        else if (typeof event.phase === 'string') goalPhase.set(id, event.phase)
        break
      }
      case 'task': {
        summary.tasks.launched++
        const route = String(event.route ?? 'inherit')
        summary.tasks.routes[route] = (summary.tasks.routes[route] ?? 0) + 1
        break
      }
      case 'task-settled':
        summary.tasks.settled++
        break
      case 'verify':
        summary.verifies.launched++
        if (event.mode === 'full') summary.verifies.full++
        else summary.verifies.quick++
        break
      case 'verify-settled':
        summary.verifies.unparsed++
        break
      case 'verdict': {
        summary.verifies.verdicts++
        if (event.met === true) summary.verifies.met++
        else summary.verifies.failed++
        if (event.goalQuestionable === true) summary.verifies.goalQuestionable++
        if (Array.isArray(event.gaps)) {
          for (const gap of event.gaps) {
            if (typeof gap === 'string' && gap.trim().length > 0) summary.verifies.gaps.push(gap.trim())
          }
        }
        break
      }
      case 'revise':
        summary.goals.revisions++
        if (typeof event.reason === 'string' && event.reason.length > 0) summary.goals.reviseReasons.push(event.reason)
        break
      case 'deny': {
        summary.denies.total++
        const tool = String(event.tool ?? '?')
        summary.denies.byTool[tool] = (summary.denies.byTool[tool] ?? 0) + 1
        break
      }
      case 'lifecycle':
        break
    }
  }
  for (const phase of goalPhase.values()) {
    summary.goals.finalPhases[phase] = (summary.goals.finalPhases[phase] ?? 0) + 1
  }
  return summary
}

/** Deterministic improvement hints derived from the measurement. */
export function improvementHints(summary: AuditSummary): string[] {
  const hints: string[] = []
  if (summary.verifies.verdicts >= 2 && summary.verifies.met / summary.verifies.verdicts < 0.5) {
    hints.push(`验收通过率 ${summary.verifies.met}/${summary.verifies.verdicts} 偏低——检查验收标准是否可检验、brief 是否遗漏约束，或换更强的 verify 路由。`)
  }
  const gapCounts = new Map<string, number>()
  for (const gap of summary.verifies.gaps) gapCounts.set(gap, (gapCounts.get(gap) ?? 0) + 1)
  const repeated = [...gapCounts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3)
  for (const [gap, n] of repeated) {
    hints.push(`同一 gap 重复出现 ${n} 次：「${preview(gap, 60)}」——矫正 brief 可能没有真正回应它。`)
  }
  if (summary.denies.total >= 3) {
    const worst = Object.entries(summary.denies.byTool).sort((a, b) => b[1] - a[1])[0]
    if (worst !== undefined) hints.push(`硬门拒绝 ${summary.denies.total} 次（最多：${worst[0]} ×${worst[1]}）——控制器仍想亲自行动，检查 brief 是否把变更工作留给了执行者。`)
  }
  if (summary.rounds.driven > 0 && summary.verifies.verdicts === 0) {
    hints.push('平台已驱动多轮但没有任何独立验收——协议没有走到 MEASURE 环节。')
  }
  if (summary.goals.revisions >= 3) {
    hints.push(`目标修订 ${summary.goals.revisions} 次——初始目标可能定义不足（验收标准先行可以减少修订）。`)
  }
  return hints
}

/** Render the full text report (data + hints). */
export function renderReport(summary: AuditSummary, filePath: string): string {
  const pct = summary.verifies.verdicts > 0
    ? `${Math.round((summary.verifies.met / summary.verifies.verdicts) * 100)}%`
    : '—'
  // Direction-launches → review rounds (dogfooding: "3 次启动" for ONE full
  // review of 3 directions read like three rounds). Three directions per
  // full review; keep in sync with REVIEW_DIRECTIONS.
  const fullRounds = Math.max(summary.verifies.full > 0 ? 1 : 0, Math.round(summary.verifies.full / 3))
  const lines: string[] = [
    'loop 模式测量报告（本会话审计聚合）',
    `- 时间窗：${summary.window.first ?? '—'} → ${summary.window.last ?? '—'}；模式开关 ${summary.window.modeFlips} 次`,
    `- goal：创建 ${summary.goals.created}、修订 ${summary.goals.revisions}${summary.goals.reviseReasons.length > 0 ? `（${summary.goals.reviseReasons.map((r) => preview(r, 30)).join('；')}）` : ''}、终态分布 ${JSON.stringify(summary.goals.finalPhases)}`,
    `- 平台驱动轮次：${summary.rounds.driven}${Object.keys(summary.rounds.byGoal).length > 0 ? `（按 goal：${Object.entries(summary.rounds.byGoal).map(([g, n]) => `${preview(g, 12)}×${n}`).join('、')}）` : ''}`,
    `- task 委派：${summary.tasks.launched} 次（路由：${Object.entries(summary.tasks.routes).map(([r, n]) => `${r}×${n}`).join('、') || '—'}），结算 ${summary.tasks.settled} 次`,
    `- 独立验收：quick ${summary.verifies.quick} 次 + full ${fullRounds} 轮全量评审（${summary.verifies.full} 方向启动）、${summary.verifies.verdicts} 份 verdict——met ${summary.verifies.met} / fail ${summary.verifies.failed}（通过率 ${pct}）${summary.verifies.unparsed > 0 ? `、异常结束 ${summary.verifies.unparsed}（未产出 verdict，不计入通过率）` : ''}，goalQuestionable ${summary.verifies.goalQuestionable}`,
    `- 硬门拒绝：${summary.denies.total} 次${summary.denies.total > 0 ? `（${Object.entries(summary.denies.byTool).map(([t, n]) => `${t}×${n}`).join('、')}）` : ''}`,
  ]
  const hints = improvementHints(summary)
  if (hints.length > 0) {
    lines.push('', '改进信号：')
    for (const hint of hints) lines.push(`- ${hint}`)
  } else if (summary.rounds.driven > 0 || summary.tasks.launched > 0) {
    lines.push('', '改进信号：暂无——回路行为健康。')
  } else {
    lines.push('', '尚无回路活动可测量。')
  }
  lines.push('', `审计流水（append-only）：${filePath}`)
  return lines.join('\n')
}
