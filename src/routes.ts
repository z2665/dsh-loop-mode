/**
 * Per-role model routing for dsh-loop-mode: parse "provider/model" specs,
 * build subagent agentOptions, format routes for guidance/status, and
 * validate configured routes against the live llm catalog. Pure except for
 * the catalog probe helpers, which take the llm service as an argument.
 *
 * Design stance (mirrors the original's explicit-config-wins rule): a
 * configured route is pinned by the PLUGIN (loop_task / loop_verify pass it
 * as agentOptions) — the controller cannot soften or bypass it per call. An
 * unset route inherits the child default; nothing is ever silently rewritten.
 *
 * @module dsh-loop-mode/routes
 */

/** A parsed model route. provider undefined = bare model id (child default provider). */
export interface ModelRoute {
  provider?: string
  model: string
}

/** Subagent agentOptions shape (dsh-subagent resolveChildAgentOptions). */
export interface AgentOptions {
  provider?: string
  model: string
  reasoningEffort?: string
}

/**
 * Parse a configured route spec: "provider/model" or a bare "model".
 * Returns null for empty/whitespace input (inherit). Security-hardened:
 * each segment must match [A-Za-z0-9._-]+ — anything else (newlines, spaces,
 * prompt payload) is rejected as null so it can never reach the system
 * prompt via formatRoute.
 */
export function parseModelSpec(spec: unknown): ModelRoute | null {
  if (typeof spec !== 'string') return null
  const trimmed = spec.trim()
  if (trimmed.length === 0) return null
  const SAFE_ID = /^[A-Za-z0-9._-]+$/
  const slash = trimmed.indexOf('/')
  if (slash < 0) return SAFE_ID.test(trimmed) ? { model: trimmed } : null
  const provider = trimmed.slice(0, slash).trim()
  const model = trimmed.slice(slash + 1).trim()
  if (provider.length === 0 || model.length === 0) return null
  if (trimmed.indexOf('/', slash + 1) >= 0) return null
  if (!SAFE_ID.test(provider) || !SAFE_ID.test(model)) return null
  return { provider, model }
}

/** Build subagent agentOptions from a route + optional effort; null = inherit.
 * Effort-only rows are honored: the host merges partial agentOptions
 * (resolveChildAgentOptions, dsh-subagent index.js:316-331). */
export function agentOptionsFor(route: ModelRoute | null, effort?: unknown): AgentOptions | undefined {
  const effortText = typeof effort === 'string' && effort.trim().length > 0 ? effort.trim() : undefined
  if (route === null) {
    return effortText === undefined ? undefined : { reasoningEffort: effortText }
  }
  return {
    ...route.provider === undefined ? {} : { provider: route.provider },
    model: route.model,
    ...effortText === undefined ? {} : { reasoningEffort: effortText },
  }
}

/** Human-readable route for guidance/status: "p/m (effort e)" or "inherit". */
export function formatRoute(route: ModelRoute | null, effort?: unknown): string {
  const effortText = typeof effort === 'string' && effort.trim().length > 0 ? `，effort ${effort.trim()}` : ''
  if (route === null) {
    return effortText !== '' ? `inherit（子代理默认路由${effortText}）` : 'inherit（子代理默认路由）'
  }
  return `${route.provider !== undefined ? `${route.provider}/` : ''}${route.model}${effortText}`
}

/** Result of a catalog validation probe. */
export interface RouteValidation {
  ok: boolean
  /** 'catalog-unavailable' = probe skipped (host llm missing/failed) — proceed. */
  status: 'ok' | 'unknown-provider' | 'unknown-model' | 'bad-spec' | 'catalog-unavailable'
  detail?: string
}

/** Provider ids from a listProviders() result (strings or {id}/{name} objects). */
function providerIdsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') ids.push(entry)
    else if (entry !== null && typeof entry === 'object') {
      const id = (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/** Model ids from a listModels() result ({id} objects or strings). */
function modelIdsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const entry of list) {
    if (typeof entry === 'string') ids.push(entry)
    else if (entry !== null && typeof entry === 'object') {
      const id = (entry as { id?: unknown; model?: unknown }).id ?? (entry as { model?: unknown }).model
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/** Minimal llm face used by validation (duck-typed; ctx.get('llm')). */
export interface LlmCatalogLike {
  listProviders?: () => unknown
  listModels?: (provider: string) => Promise<unknown>
}

/**
 * Validate one configured route against the live catalog. Advisory-catalog
 * semantics: an unreachable catalog (missing service, failing probe) is NOT
 * an error — the host's own delegation preflight remains the enforcement of
 * last resort. A reachable catalog with a missing provider/model fails loud
 * so a config typo surfaces at the first delegation instead of degrading
 * silently.
 */
export async function validateModelRoute(
  llm: LlmCatalogLike | undefined,
  spec: unknown,
): Promise<RouteValidation> {
  const route = parseModelSpec(spec)
  if (typeof spec === 'string' && spec.trim().length > 0 && route === null) {
    return { ok: false, status: 'bad-spec', detail: `"${spec}" is not a valid provider/model or model spec` }
  }
  if (route === null) return { ok: true, status: 'ok' }
  if (llm === undefined || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
    return { ok: true, status: 'catalog-unavailable' }
  }
  let providers: string[]
  try {
    providers = providerIdsOf(llm.listProviders())
  } catch {
    return { ok: true, status: 'catalog-unavailable' }
  }
  if (route.provider !== undefined && !providers.includes(route.provider)) {
    return { ok: false, status: 'unknown-provider', detail: `provider "${route.provider}" 不在实时目录（${providers.join(', ') || '空'}）` }
  }
  const provider = route.provider ?? providers[0]
  if (provider === undefined) return { ok: true, status: 'catalog-unavailable' }
  try {
    const models = modelIdsOf(await llm.listModels(provider))
    if (models.length > 0 && !models.includes(route.model)) {
      return { ok: false, status: 'unknown-model', detail: `model "${route.model}" 不在 ${provider} 的模型目录（${models.length} 个模型）` }
    }
  } catch {
    // Adapter-level probe failure: catalog advisory, delegation preflight decides.
    return { ok: true, status: 'catalog-unavailable' }
  }
  return { ok: true, status: 'ok' }
}
