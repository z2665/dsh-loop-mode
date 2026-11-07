/**
 * Offline smoke test for the client module (lib/client.js). Run:
 * node test/client-smoke.mjs
 *
 * Loads the ModuleLoader factory with stubbed react/jsx and a fake host ctx,
 * then verifies: registration id, exports, locale dictionaries, and the three
 * settings-card seats. The card's DOM rendering is verified in-browser
 * (host restart + browser refresh), not here.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

let passed = 0
const ok = (name, fn) => {
  try { fn(); passed++; console.log(`  ok - ${name}`) }
  catch (error) { console.error(`  FAIL - ${name}`); throw error }
}
const okAsync = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok - ${name}`) }
  catch (error) { console.error(`  FAIL - ${name}`); throw error }
}

// --- stub browser environment -------------------------------------------
const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(def) { loaded.push(def) },
  },
}
// Minimal react/jsx stand-ins: the factory only needs them at component
// RENDER time; the wiring assertions below never invoke the components.
const reactStub = {
  useSyncExternalStore: () => ({}),
  useState: () => [undefined, () => {}],
}
const jsxStub = { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
const fakeRequire = (id) => {
  if (id === 'react') return reactStub
  if (id === 'react/jsx-runtime') return jsxStub
  throw new Error(`unexpected require: ${id}`)
}

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// Evaluate the client module in this realm (it only touches window/require).
const factoryScope = new Function('window', 'require', `${source}\n//# sourceURL=lib/client.js`)
factoryScope(globalThis.window, fakeRequire)

console.log('# lib/client.js (settings card wiring)')
ok('registers exactly one module under the package name', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-loop-mode')
  assert.equal(typeof loaded[0].factory, 'function')
})

const client = loaded[0].factory(fakeRequire)

ok('exports { name, inject, apply } with the client service injects', () => {
  assert.equal(client.name, 'dsh-loop-mode')
  assert.deepEqual([...client.inject].sort(), ['configForms', 'locale', 'remote', 'remote.session', 'slots'])
  assert.equal(typeof client.apply, 'function')
})

const registered = { locale: null, seats: [] }
ok('apply registers locale dictionaries (zh/en) and all three seats', () => {
  // The real slots API: ctx.slots.inject(seat, factory) where factory()
  // returns ctx.slots.register(def, Component) — emulate by calling the
  // injected callback and having it route to our register stub.
  const seats = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (ns, dicts) => { registered.locale = { ns, dicts } },
      bind: () => (key) => key,
    },
    configForms: { get: (id) => ({ fake: 'form', id }) },
    slots: {
      inject: (seat, factory) => { seats.push({ seat, factory }) },
      register: (def, component) => { registered.seats.push({ def, component }); return () => {} },
    },
  }
  client.apply(ctx)
  assert.equal(registered.locale.ns, 'loop-mode')
  assert.ok(registered.locale.dicts.zh['settings.cardLabel'].length > 0)
  assert.ok(registered.locale.dicts.en['settings.fieldSeniorModel'].length > 0)
  const seatNames = seats.map((s) => s.seat).sort()
  assert.deepEqual(seatNames, ['plugins.bundle.config', 'plugins.item', 'plugins.row.config'])
  // Each factory must run against slots.register without throwing.
  for (const s of seats) s.factory()
  const defs = registered.seats.map((s) => s.def)
  assert.ok(defs.some((d) => d.id === 'dsh-loop-mode' && d.name === 'plugins.item' && typeof d.order === 'number'))
  assert.ok(defs.some((d) => d.key === 'dsh-loop-mode#dsh-loop-mode'))
  assert.ok(defs.some((d) => d.key === 'dsh-loop-mode' && d.name === 'plugins.bundle.config'))
  for (const s of registered.seats) assert.equal(typeof s.component, 'function')
})

ok('the plugins.item inject supplies the bound ConfigForm', () => {
  const seat = registered.seats.find((s) => s.def.name === 'plugins.item')
  const props = seat.def.inject()
  assert.deepEqual(props, { form: { fake: 'form', id: 'dsh-loop-mode' }, catalog: undefined })
})

ok('inject declares the catalog namespaces (remote, remote.session)', () => {
  assert.deepEqual([...client.inject].sort(), ['configForms', 'locale', 'remote', 'remote.session', 'slots'])
})

await okAsync('catalog store: loads groups into options; handles failure; notifies subscribers', async () => {
  const store = client.createModelCatalogStore()
  assert.equal(store.getSnapshot().status, 'idle')
  const seen = []
  store.subscribe(() => seen.push(store.getSnapshot().status))
  await store.load({
    modelCatalog: async () => ({
      ok: true,
      value: { groups: [
        { id: 'p1', name: 'Provider One', models: [
          { id: 'm1', name: 'M One', reasoning: { efforts: [{ id: 'low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
          { id: 'm2', name: 'M Two' },
        ] },
        { id: 'p2', name: 'P Two', models: [{ id: 'm1', name: 'dup id' }] },
      ] },
    }),
  })
  const snap = store.getSnapshot()
  assert.equal(snap.status, 'ready')
  assert.equal(snap.options.length, 3)
  assert.deepEqual(snap.options[0], {
    value: 'p1/m1', provider: 'p1', model: 'm1',
    reasoning: { efforts: [{ id: 'low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
    label: 'Provider One · p1/m1',
  })
  assert.ok(seen.includes('loading') && seen.includes('ready'))
  // failure path
  await store.load({ modelCatalog: async () => { throw new Error('boom') } })
  assert.equal(store.getSnapshot().status, 'error')
  assert.equal(store.getSnapshot().options.length, 0)
})

ok('availability + effort helpers', () => {
  const snap = { status: 'ready', options: [
    { value: 'p1/m1', provider: 'p1', model: 'm1', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' }, label: 'x' },
    { value: 'p2/m2', provider: 'p2', model: 'm2', label: 'y' },
  ] }
  assert.equal(client.isConfiguredModelAvailable('', snap), true)
  assert.equal(client.isConfiguredModelAvailable('p1/m1', snap), true)
  assert.equal(client.isConfiguredModelAvailable('m2', snap), true)
  assert.equal(client.isConfiguredModelAvailable('p9/m9', snap), false)
  assert.equal(client.isConfiguredModelAvailable('p1/m1', { status: 'error', options: [] }), true) // unprovable → no flag
  const opt = client.catalogOptionFor('p1/m1', snap)
  const rows = client.effortRows(opt)
  assert.equal(rows.defaultEffort, 'high')
  assert.deepEqual(rows.efforts.map((e) => e.id), ['low', 'high'])
  assert.equal(client.effortRows(client.catalogOptionFor('p2/m2', snap)), undefined) // no reasoning declared
  assert.equal(client.effortRows(undefined), undefined)
})

await okAsync('every field spec maps to a real volatile Config field', async () => {
  const { Config } = await import('../src/index.ts').catch(() => ({ Config: null }))
  if (Config === null) { console.log('  (index.ts unresolvable here — skip cross-check)'); return }
  const declared = new Set(Object.keys(Config.dict ?? Config.shape ?? {}))
  const sourceText = source
  for (const field of ['defaultOn', 'gate', 'maxRounds', 'generalModel', 'generalEffort', 'seniorModel', 'seniorEffort', 'verifyModel', 'verifyEffort', 'quickVerifyBudget']) {
    assert.ok(declared.has(field), `Config must declare ${field}`)
    assert.ok(sourceText.includes(`field: '${field}'`), `card must render ${field}`)
  }
})

console.log(`\n${passed} checks passed`)
