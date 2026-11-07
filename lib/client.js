// dsh-loop-mode client module: the settings card seated on the official
// Plugins page (plugins.item / plugins.row.config / plugins.bundle.config),
// bound to the row's ConfigForm in either of the two shapes the seats
// deliver — volatile writes stay live without a restart. The card is the
// ONLY GUI surface for the plugin's volatile fields: the host Plugins page
// draws no fields of its own and dsh-client-ui-settings ships the
// configForms service, not a renderer.
//
// Format follows the host's ModuleLoader wrapper (same shape the official
// client bundles and MarchLiu's dsh-cybernetics use). Registration id = the
// package name in package.json (`dsh-loop-mode`) — the client-modules boot
// graph keys rows by the package manifest name.
/* global window */
window.__ModuleLoader__.load({
	id: 'dsh-loop-mode',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const react = require('react');
		const jsx = require('react/jsx-runtime');

		//#region locale dictionaries (zh is the key-set source of truth)
		const NS = 'loop-mode';
		const zh = {
			'settings.cardLabel': 'dsh-loop-mode 控制回路',
			'settings.title': 'loop 控制回路模式',
			'settings.description': '按会话开启的 cybernetics 控制回路：/loop on 激活协议引导 + 硬门。以下为全局默认（volatile，保存即时生效）。',
			'settings.unavailable': '配置表单尚未就绪（宿主未服务本条目的命名空间）。',
			'settings.saving': '保存中…',
			'settings.saveFailed': '保存未生效——控件将回到宿主确认的值。可改在 profile cordis.patch.yml 手工维护。',
			'settings.fieldDefaultOn': '全局面默认（defaultOn）',
			'settings.hintDefaultOn': '未执行过 /loop 的会话继承此值。false = 按会话显式开启；true = 默认全开、/loop off 按会话退出。',
			'settings.fieldGate': '硬门（gate）',
			'settings.hintGate': '模式开启期间从顶层会话结构性摘除一切变更类工具（含 update_goal），只留读/对话/goal/委派动词。关闭后模式只剩协议引导。',
			'settings.fieldMaxRounds': '每目标矫正轮上限（maxRounds）',
			'settings.hintMaxRounds': '1-10，默认 3。写入 create_goal 的 maxGoalRounds（平台轮次预算）。',
			'settings.invalidNumber': '请输入 1-10 的整数（留空恢复默认）。',
			'settings.headerExecutors': '执行者分层（loop_task）',
			'settings.fieldGeneralModel': '通用执行者模型（generalModel）',
			'settings.hintGeneralModel': 'tier=general：常规/机械/有界任务。"provider/model" 或裸模型名；留空 = 继承子代理默认路由。',
			'settings.fieldGeneralEffort': '通用执行者思考强度（generalEffort）',
			'settings.hintGeneralEffort': '可留空 = 模型默认档位。',
			'settings.fieldSeniorModel': '高级执行者模型（seniorModel）',
			'settings.hintSeniorModel': 'tier=senior：复杂/高风险/多步变更或新颖任务。',
			'settings.fieldSeniorEffort': '高级执行者思考强度（seniorEffort）',
			'settings.hintSeniorEffort': '可留空 = 模型默认档位。',
			'settings.headerVerify': '验收者（loop_verify）',
			'settings.fieldVerifyModel': '验收者模型（verifyModel）',
			'settings.hintVerifyModel': '独立验收的模型路由，可与执行者不同——测量与行动分离的模型面。',
			'settings.fieldVerifyEffort': '验收者思考强度（verifyEffort）',
			'settings.hintVerifyEffort': '可留空 = 模型默认档位。',
			'settings.fieldQuickBudget': '快速验收预算（quickVerifyBudget）',
			'settings.hintQuickBudget': '1-10，默认 3。每 goal 连续 quick 验收用尽后，loop_verify 拒绝 quick 并要求 mode=full（架构/安全/质量三方向评审）。',
			'settings.placeholderModel': 'provider/model（留空继承）',
			'settings.placeholderEffort': '如 high（留空默认）',
			'settings.modelUnavailable': '该模型不在实时目录中——委派时会显式报错；请重新选择或清空以继承。',
			'settings.effortDefault': '默认',
			'settings.effortUnsupported': '当前模型未声明思考强度档位，可手工输入或留空。',
			'settings.clearOption': '（清空 · 恢复继承）',
			'settings.summary': '通用 {general} · 高级 {senior} · 验收 {verify}',
			'settings.on': '开',
			'settings.off': '关',
		};
		const en = {
			'settings.cardLabel': 'dsh-loop-mode control loop',
			'settings.title': 'loop control-loop mode',
			'settings.description': 'Per-session cybernetics loop: /loop on activates the protocol + hard gate. Global defaults below (volatile, live on save).',
			'settings.unavailable': 'Config form not served yet for this entry.',
			'settings.saving': 'Saving…',
			'settings.saveFailed': 'Save refused — controls return to the host-confirmed value. Edit profile cordis.patch.yml manually instead.',
			'settings.fieldDefaultOn': 'Global default (defaultOn)',
			'settings.hintDefaultOn': 'Sessions without an explicit /loop inherit this. false = opt-in per session; true = on by default, /loop off opts out.',
			'settings.fieldGate': 'Hard gate (gate)',
			'settings.hintGate': 'While the mode is on, structurally strip every world-changing tool (incl. update_goal) from the top-level session.',
			'settings.fieldMaxRounds': 'Corrective rounds per goal (maxRounds)',
			'settings.hintMaxRounds': '1-10, default 3. Written to create_goal maxGoalRounds (platform round budget).',
			'settings.invalidNumber': 'Enter an integer 1-10 (empty restores the default).',
			'settings.headerExecutors': 'Executor tiers (loop_task)',
			'settings.fieldGeneralModel': 'General executor model (generalModel)',
			'settings.hintGeneralModel': 'tier=general: routine/mechanical/bounded work. "provider/model" or bare model; empty = inherit.',
			'settings.fieldGeneralEffort': 'General executor effort (generalEffort)',
			'settings.hintGeneralEffort': 'Optional — model default when empty.',
			'settings.fieldSeniorModel': 'Senior executor model (seniorModel)',
			'settings.hintSeniorModel': 'tier=senior: complex/risky/multi-step or novel work.',
			'settings.fieldSeniorEffort': 'Senior executor effort (seniorEffort)',
			'settings.hintSeniorEffort': 'Optional — model default when empty.',
			'settings.headerVerify': 'Verifier (loop_verify)',
			'settings.fieldVerifyModel': 'Verifier model (verifyModel)',
			'settings.hintVerifyModel': 'Independent measurement route — may differ from the executors.',
			'settings.fieldVerifyEffort': 'Verifier effort (verifyEffort)',
			'settings.hintVerifyEffort': 'Optional — model default when empty.',
			'settings.fieldQuickBudget': 'Quick-verify budget (quickVerifyBudget)',
			'settings.hintQuickBudget': '1-10, default 3. After it is spent per goal, loop_verify refuses quick and demands mode=full (architecture/security/quality review).',
			'settings.placeholderModel': 'provider/model (empty = inherit)',
			'settings.placeholderEffort': 'e.g. high (empty = default)',
			'settings.modelUnavailable': 'Not in the live catalog — delegation will fail loudly; re-pick or clear to inherit.',
			'settings.effortDefault': 'default',
			'settings.effortUnsupported': 'The selected model declares no reasoning efforts; type one or leave empty.',
			'settings.clearOption': '(clear · restore inherit)',
			'settings.summary': 'general {general} · senior {senior} · verify {verify}',
			'settings.on': 'on',
			'settings.off': 'off',
		};
		//#endregion

		//#region styles (subset of the host plugins-page card idiom)
		const styles = {
			card: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', borderTop: '1px solid #21262d' },
			row: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
			main: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
			title: { fontSize: 13, fontWeight: 600 },
			desc: { fontSize: 12, color: '#8b949e' },
			header: { fontSize: 12, fontWeight: 600, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.4, marginTop: 4 },
			field: { display: 'flex', flexDirection: 'column', gap: 4 },
			input: {
				fontSize: 13,
				padding: '5px 8px',
				borderRadius: 6,
				border: '1px solid #30363d',
				// Explicit dark pair: the card sets its own dark input background,
				// so the text color must NOT inherit (a dark inherited color made
				// entered values invisible). Options inherit the select color.
				background: '#0d1117',
				color: '#e6edf3',
				minWidth: 0,
				width: '100%',
				boxSizing: 'border-box',
			},
			invalid: { fontSize: 12, color: '#d29922' },
			unavailable: { fontSize: 12, color: '#8b949e' },
			switch: { display: 'inline-flex', alignItems: 'center', border: '1px solid #30363d', borderRadius: 999, background: '#0d1117', padding: 2, cursor: 'pointer', flexShrink: 0 },
			knob: { display: 'inline-block', width: 14, height: 14, borderRadius: '50%', transition: 'transform .15s ease' },
			knobOn: { background: '#3fb950', transform: 'translateX(16px)' },
			knobOff: { background: '#8b949e', transform: 'translateX(0)' },
		};
		//#endregion

		const SETTINGS_ENTRY_ID = 'dsh-loop-mode';
		const noopSubscribe = () => () => {};
		const NO_FORM_SNAP = { status: 'pending' };
		/** Datalist option that CLEARS the field: browsers drop empty-value
		 * options, so "none/inherit" needs a non-empty sentinel — picking it
		 * unsets the config immediately. */
		const CLEAR_SENTINEL = '(inherit)';

		//#region model catalog store (dropdown data + unavailable-model detection)
		// Host model directory, read the same way the official 子智能体 settings
		// page does: the `remote.session` namespace answers modelCatalog() with
		// { ok, value: { groups: [{id, name, models: [{id, name, reasoning?}]}] } }
		// — every currently routable model, grouped by provider. Provider
		// invalidations arrive as `llm/adapters-updated` on ctx.remote.
		// OPTIONAL everywhere: a host without the namespace leaves the store
		// absent, the dropdown empty and the text entry intact.
		function createModelCatalogStore() {
			let snap = { status: 'idle', options: [] };
			const subs = new Set();
			return {
				subscribe(cb) { subs.add(cb); return () => subs.delete(cb); },
				getSnapshot() { return snap; },
				set(next) { snap = next; for (const cb of subs) cb(); },
				load: async (session) => {
					snap = { status: 'loading', options: snap.options };
					for (const cb of subs) cb();
					try {
						const response = await session.modelCatalog();
						if (response && response.ok === true && response.value && Array.isArray(response.value.groups)) {
							const options = [];
							for (const group of response.value.groups) {
								for (const model of (group.models ?? [])) {
									options.push({
										value: group.id + '/' + model.id,
										provider: group.id,
										model: model.id,
										reasoning: model.reasoning === undefined || model.reasoning === null ? undefined : model.reasoning,
										label: (group.name ?? group.id) + ' · ' + group.id + '/' + model.id,
									});
								}
							}
							snap = { status: 'ready', options };
						} else {
							snap = { status: 'error', options: [] };
						}
					} catch {
						snap = { status: 'error', options: [] };
					}
					for (const cb of subs) cb();
				},
			};
		}

		/** Whether a configured model value still resolves against the live
		 * catalog. Empty value or absent/failed catalog never flags — the
		 * warning must be provable, not a guess. */
		function isConfiguredModelAvailable(value, catalogSnap) {
			const text = (value ?? '').trim();
			if (text === '') return true;
			if (!catalogSnap || catalogSnap.status !== 'ready' || !Array.isArray(catalogSnap.options) || catalogSnap.options.length === 0) return true;
			if (text.indexOf('/') >= 0) return catalogSnap.options.some((opt) => opt.value === text);
			return catalogSnap.options.some((opt) => opt.model === text);
		}

		/** Resolve the catalog option for a configured model value, or undefined. */
		function catalogOptionFor(value, catalogSnap) {
			const text = (value ?? '').trim();
			if (text === '') return undefined;
			if (!catalogSnap || catalogSnap.status !== 'ready' || !Array.isArray(catalogSnap.options)) return undefined;
			if (text.indexOf('/') >= 0) return catalogSnap.options.find((opt) => opt.value === text);
			return catalogSnap.options.find((opt) => opt.model === text);
		}

		/** Effort rows for one catalog option: [{id, name}] + defaultEffort. */
		function effortRows(option) {
			const reasoning = option && option.reasoning;
			if (reasoning === undefined || reasoning === null || typeof reasoning !== 'object') return undefined;
			const efforts = Array.isArray(reasoning.efforts)
				? reasoning.efforts.filter((e) => e !== null && typeof e === 'object' && typeof e.id === 'string')
				: [];
			if (efforts.length === 0) return undefined;
			return { efforts, defaultEffort: typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined };
		}
		//#endregion

		/** Field specs: the card is data-driven; every field is volatile.
		 * `pair` links an effort field to its model field (dropdown source). */
		const FIELD_SPECS = [
			{ kind: 'toggle', field: 'defaultOn', labelKey: 'settings.fieldDefaultOn', hintKey: 'settings.hintDefaultOn' },
			{ kind: 'toggle', field: 'gate', labelKey: 'settings.fieldGate', hintKey: 'settings.hintGate' },
			{ kind: 'number', field: 'maxRounds', labelKey: 'settings.fieldMaxRounds', hintKey: 'settings.hintMaxRounds' },
			{ kind: 'header', labelKey: 'settings.headerExecutors' },
			{ kind: 'model', field: 'generalModel', labelKey: 'settings.fieldGeneralModel', hintKey: 'settings.hintGeneralModel' },
			{ kind: 'effort', field: 'generalEffort', labelKey: 'settings.fieldGeneralEffort', hintKey: 'settings.hintGeneralEffort', pair: 'generalModel' },
			{ kind: 'model', field: 'seniorModel', labelKey: 'settings.fieldSeniorModel', hintKey: 'settings.hintSeniorModel' },
			{ kind: 'effort', field: 'seniorEffort', labelKey: 'settings.fieldSeniorEffort', hintKey: 'settings.hintSeniorEffort', pair: 'seniorModel' },
			{ kind: 'header', labelKey: 'settings.headerVerify' },
			{ kind: 'model', field: 'verifyModel', labelKey: 'settings.fieldVerifyModel', hintKey: 'settings.hintVerifyModel' },
			{ kind: 'effort', field: 'verifyEffort', labelKey: 'settings.fieldVerifyEffort', hintKey: 'settings.hintVerifyEffort', pair: 'verifyModel' },
			{ kind: 'number', field: 'quickVerifyBudget', labelKey: 'settings.fieldQuickBudget', hintKey: 'settings.hintQuickBudget' },
		];

		/**
		 * The settings card. `props.form` arrives in one of two shapes:
		 *  - the LIVE ConfigForm (configForms.get(id)): subscribe/getSnapshot/
		 *    set/unset/mutate — the plugins.bundle.config page and summary rows;
		 *  - the HOST's ConfigPageForm { state, mutate } — the plugins.item and
		 *    plugins.row.config detail pages (no subscribe; state recomputed by
		 *    the owning page per mirror update).
		 * Writes go through set/unset (one-field sugar over mutate); a refusal
		 * shows the failure line and every control returns to the snapshot
		 * value — the only state the host confirmed.
		 */
		function SettingsCard(props) {
			const t = props.t;
			const form = props.form;
			const view = props.view === 'summary' ? 'summary' : 'page';
			const live = form !== null && typeof form === 'object'
				&& typeof form.subscribe === 'function' && typeof form.getSnapshot === 'function' && typeof form.set === 'function'
				? form : undefined;
			const host = live === undefined && form !== null && typeof form === 'object'
				&& typeof form.mutate === 'function' && form.state !== null && typeof form.state === 'object'
				? form : undefined;
			const liveSnap = react.useSyncExternalStore(
				live ? (cb) => live.subscribe(cb) : noopSubscribe,
				live ? () => live.getSnapshot() : () => NO_FORM_SNAP,
			);
			const snap = host !== undefined ? host.state : liveSnap;
			const [saving, setSaving] = react.useState(false);
			const [failed, setFailed] = react.useState(false);
			const [drafts, setDrafts] = react.useState({});
			const [invalid, setInvalid] = react.useState('');
			const catalog = props.catalog;
			const catalogSnap = react.useSyncExternalStore(
				catalog ? (cb) => catalog.subscribe(cb) : noopSubscribe,
				catalog ? () => catalog.getSnapshot() : () => NO_FORM_SNAP,
			);
			const catalogOptions = catalogSnap && Array.isArray(catalogSnap.options) ? catalogSnap.options : [];
			const cfgRaw = snap.status === 'ready' && snap.value !== null && typeof snap.value === 'object' ? snap.value : {};
			// Volatile fields may arrive as live references ({get()}) — the
			// server's readConfigField dereferences them; do the same here so
			// toggles and inputs never silently read undefined (quality review).
			const cfg = {};
			for (const key of Object.keys(cfgRaw)) {
				const v = cfgRaw[key];
				cfg[key] = v !== null && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v;
			}
			const disabled = (live === undefined && host === undefined) || snap.status !== 'ready' || snap.writable === false || saving;

			// Latest dereferenced config for POST-WRITE VERIFICATION: a write
			// that the transport accepts but the mirror never echoes back is a
			// SILENT LOSS (observed live: an effort selection never landed).
			// Keep a ref to the newest cfg so a scheduled check can compare.
			const cfgRef = react.useRef(cfg);
			cfgRef.current = cfg;
			const readCfgField = (field) => {
				const v = cfgRef.current[field];
				return v === null || typeof v !== 'object' ? v : undefined;
			};
			/** After a write settles, require the mirror to echo the value
			 * within a short window; otherwise surface a loud failure. */
			const verifyWrite = (field, expected) => {
				window.setTimeout(() => {
					const current = readCfgField(field);
					const matches = expected === undefined
						? current === undefined || current === ''
						: current === expected;
					if (!matches) {
						setFailed('保存未被宿主确认：字段 ' + field + ' 期望 ' + JSON.stringify(expected) + '，表单仍为 ' + JSON.stringify(current) + '。请重试一次；若持续出现请反馈。');
					}
				}, 1200);
			};
			const runWrite = (thunk, verifyField, verifyExpected) => {
				setFailed(false);
				setSaving(true);
				const done = (ok, error) => {
					setSaving(false);
					if (!ok) setFailed(error === undefined ? true : String(error));
					else if (verifyField !== undefined) verifyWrite(verifyField, verifyExpected);
				};
				try {
					const result = thunk();
					if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
						result.then(() => done(true), (error) => done(false, error));
					} else done(true);
				} catch (error) {
					done(false, error);
				}
			};
			const setField = (field, value) => {
				if (live !== undefined) runWrite(() => live.set(field, value), field, value);
				else if (host !== undefined) runWrite(() => host.mutate([{ op: 'set', path: [field], value }]), field, value);
			};
			const unsetField = (field) => {
				if (live !== undefined) runWrite(() => live.unset(field), field, undefined);
				else if (host !== undefined) runWrite(() => host.mutate([{ op: 'unset', path: [field] }]), field, undefined);
			};
			const setDraft = (field, text) => setDrafts((d) => ({ ...d, [field]: text }));
			const clearDraft = (field) => setDrafts((d) => {
				if (!(field in d)) return d;
				const next = { ...d };
				delete next[field];
				return next;
			});
			/** Commit one text/number field: empty → unset; else validate + set. */
			const commitField = (spec, raw) => {
				const text = raw.trim();
				if (text === CLEAR_SENTINEL) { setInvalid(''); unsetField(spec.field); return; }
				if (spec.kind === 'number') {
					if (text.length === 0) { setInvalid(''); unsetField(spec.field); return; }
					// Strict integer parse ('3.5' / '3abc' must not silently pass).
					if (!/^\d+$/.test(text)) { setInvalid(spec.field); return; }
					const n = Number.parseInt(text, 10);
					if (n < 1 || n > 10) { setInvalid(spec.field); return; }
					setInvalid('');
					setField(spec.field, n);
					return;
				}
				if (text.length === 0) unsetField(spec.field);
				else setField(spec.field, text);
			};

			if (view === 'summary') {
				const route = (v) => typeof v === 'string' && v.length > 0 ? v : 'inherit';
				return jsx.jsx('span', { children: snap.status === 'ready'
					? t('settings.summary', {
						general: route(cfg.generalModel),
						senior: route(cfg.seniorModel),
						verify: route(cfg.verifyModel),
					})
					: t('settings.unavailable') });
			}

			const children = [
				jsx.jsxs('div', { style: styles.row, children: [
					jsx.jsxs('div', { style: styles.main, children: [
						jsx.jsx('div', { style: styles.title, children: t('settings.title') }),
						jsx.jsx('div', { style: styles.desc, children: t('settings.description') }),
					] }),
				] }),
			];
			if (snap.status !== 'ready') children.push(jsx.jsx('div', { style: styles.unavailable, children: t('settings.unavailable') }));
			if (saving) children.push(jsx.jsx('div', { style: styles.unavailable, children: t('settings.saving') }));
			if (!saving && failed) children.push(jsx.jsx('div', { style: { ...styles.unavailable, color: '#d29922' }, children: failed === true ? t('settings.saveFailed') : String(failed) }));
			for (const spec of FIELD_SPECS) {
				if (spec.kind === 'header') {
					children.push(jsx.jsx('div', { style: styles.header, children: t(spec.labelKey) }, spec.labelKey));
					continue;
				}
				if (spec.kind === 'toggle') {
					const on = cfg[spec.field] === true;
					children.push(jsx.jsxs('div', { style: styles.field, key: spec.field, children: [
						jsx.jsxs('div', { style: styles.row, children: [
							jsx.jsxs('div', { style: styles.main, children: [
								jsx.jsx('div', { style: styles.title, children: t(spec.labelKey) + '：' + t(on ? 'settings.on' : 'settings.off') }),
								jsx.jsx('div', { style: styles.desc, children: t(spec.hintKey) }),
							] }),
							jsx.jsx('button', {
								style: { ...styles.switch, width: 36, opacity: disabled ? 0.5 : 1 },
								disabled,
								onClick: () => setField(spec.field, !on),
								children: jsx.jsx('span', { style: { ...styles.knob, ...(on ? styles.knobOn : styles.knobOff) } }),
							}),
						] }),
					] }));
					continue;
				}
				const value = spec.field in drafts ? drafts[spec.field]
					: cfg[spec.field] === undefined || cfg[spec.field] === null ? '' : String(cfg[spec.field]);
				// Model fields: datalist dropdown over the live catalog (free
				// text stays available); provably-unavailable configured models
				// get a warning line. Effort fields: a select of the PAIRED
				// model's declared reasoning efforts when the catalog knows
				// them, otherwise a plain text input.
				if (spec.kind === 'model') {
					const listId = 'loop-mode-catalog-' + spec.field;
					const unavailable = !isConfiguredModelAvailable(value, catalogSnap);
					children.push(jsx.jsxs('div', { style: styles.field, key: spec.field, children: [
						jsx.jsx('div', { style: styles.title, children: t(spec.labelKey) }),
						jsx.jsx('div', { style: styles.desc, children: t(spec.hintKey) }),
						jsx.jsx('input', {
							style: styles.input,
							disabled,
							list: catalogOptions.length > 0 ? listId : undefined,
							placeholder: t(spec.placeholderKey),
							value,
							onChange: (e) => {
								if (e.target.value === CLEAR_SENTINEL) {
									// picked the clear option: unset at once, keep the box empty
									setInvalid('')
									unsetField(spec.field)
									clearDraft(spec.field)
									return
								}
								setDraft(spec.field, e.target.value)
							},
							onKeyDown: (e) => { if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) { commitField(spec, e.target.value); clearDraft(spec.field); } },
							onBlur: (e) => { if (spec.field in drafts) { commitField(spec, e.target.value); clearDraft(spec.field); } },
						}),
						catalogOptions.length > 0
							? jsx.jsx('datalist', {
								id: listId,
								children: [
									jsx.jsx('option', { value: CLEAR_SENTINEL, label: t('settings.clearOption') }, CLEAR_SENTINEL),
									...catalogOptions.map((opt) => jsx.jsx('option', { value: opt.value, label: opt.label ?? opt.value }, opt.value)),
								],
							})
							: null,
						unavailable ? jsx.jsx('div', { style: styles.invalid, children: t('settings.modelUnavailable') }) : null,
					] }));
					continue;
				}
				if (spec.kind === 'effort') {
					const pairedValue = cfg[spec.pair] === undefined || cfg[spec.pair] === null ? '' : String(cfg[spec.pair]);
					const rows = effortRows(catalogOptionFor(pairedValue, catalogSnap));
					const commonHead = [
						jsx.jsx('div', { style: styles.title, children: t(spec.labelKey) }),
						jsx.jsx('div', { style: styles.desc, children: t(spec.hintKey) }),
					];
					if (rows !== undefined) {
						children.push(jsx.jsxs('div', { style: styles.field, key: spec.field, children: [
							...commonHead,
							jsx.jsxs('select', {
								style: styles.input,
								disabled,
								value,
								onChange: (e) => { if (e.target.value === '') unsetField(spec.field); else setField(spec.field, e.target.value); },
								children: [
									jsx.jsx('option', { value: '', children: rows.defaultEffort !== undefined ? t('settings.effortDefault') + ' (' + rows.defaultEffort + ')' : t('settings.effortDefault') }, 'default'),
									...rows.efforts.map((effort) => jsx.jsx('option', { value: effort.id, children: effort.name !== undefined && effort.name !== effort.id ? effort.id + ' · ' + effort.name : effort.id }, effort.id)),
								],
							}),
						] }));
						continue;
					}
					children.push(jsx.jsxs('div', { style: styles.field, key: spec.field, children: [
						...commonHead,
						jsx.jsx('input', {
							style: styles.input,
							disabled,
							placeholder: t('settings.placeholderEffort'),
							value,
							onChange: (e) => setDraft(spec.field, e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) { commitField(spec, e.target.value); clearDraft(spec.field); } },
							onBlur: (e) => { if (spec.field in drafts) { commitField(spec, e.target.value); clearDraft(spec.field); } },
						}),
						pairedValue !== '' && catalogSnap.status === 'ready' ? jsx.jsx('div', { style: styles.desc, children: t('settings.effortUnsupported') }) : null,
					] }));
					continue;
				}
				children.push(jsx.jsxs('div', { style: styles.field, key: spec.field, children: [
					jsx.jsx('div', { style: styles.title, children: t(spec.labelKey) }),
					jsx.jsx('div', { style: styles.desc, children: t(spec.hintKey) }),
					jsx.jsx('input', {
						style: styles.input,
						disabled,
						placeholder: t(spec.placeholderKey),
						value,
						onChange: (e) => setDraft(spec.field, e.target.value),
						// IME composing guard: an Enter that confirms candidate
						// text must not commit the draft early.
						onKeyDown: (e) => { if (e.key === 'Enter' && !(e.nativeEvent && e.nativeEvent.isComposing)) { commitField(spec, e.target.value); clearDraft(spec.field); } },
						onBlur: (e) => { if (spec.field in drafts) { commitField(spec, e.target.value); clearDraft(spec.field); } },
					}),
					invalid === spec.field ? jsx.jsx('div', { style: styles.invalid, children: t('settings.invalidNumber') }) : null,
				] }));
			}
			return jsx.jsxs('div', { style: styles.card, children });
		}

		const name = 'dsh-loop-mode';
		const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session'];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-loop-mode: dictionaries');
			const t = ctx.locale.bind(NS);
			// Bind the row's ConfigForm once per apply body; namespace = the
			// loader row id. A host not yet serving it renders the card's
			// unavailable state instead of throwing.
			let settingsForm;
			try {
				settingsForm = ctx.configForms.get(SETTINGS_ENTRY_ID);
			} catch {
				settingsForm = undefined;
			}
			// Live model catalog for the dropdowns + unavailable-model warnings.
			// OPTIONAL: a host without remote.session leaves it undefined — the
			// card renders plain text inputs, no crash, no warnings.
			let catalogStore;
			try {
				if (ctx.remote && ctx.remote.session && typeof ctx.remote.session.modelCatalog === 'function') {
					catalogStore = createModelCatalogStore();
					ctx.effect(() => {
						catalogStore.load(ctx.remote.session);
						if (ctx.remote.$on && typeof ctx.remote.$on === 'function') {
							ctx.remote.$on('llm/adapters-updated', () => { catalogStore.load(ctx.remote.session); });
						}
					}, 'dsh-loop-mode: model catalog');
				}
			} catch {
				catalogStore = undefined;
			}
			const settingsInject = () => ({ form: settingsForm, catalog: catalogStore });
			// The plugins page renders 内置插件配置 group cards ONLY from the
			// plugins.item slot — register it unconditionally so the card is
			// always visible (its unavailable line is diagnosable; absent is not).
			ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
				name: 'plugins.item',
				id: SETTINGS_ENTRY_ID,
				order: 80,
				label: () => t('settings.cardLabel'),
				locale: NS,
				inject: settingsInject,
			}, SettingsCard)), 'dsh-loop-mode: plugins-page settings card');
			// Keyed seats on the bundle/row config pages (package name keys).
			ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
				name: 'plugins.row.config',
				key: SETTINGS_ENTRY_ID + '#' + SETTINGS_ENTRY_ID,
				locale: NS,
				inject: settingsInject,
			}, SettingsCard));
			ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
				name: 'plugins.bundle.config',
				key: SETTINGS_ENTRY_ID,
				locale: NS,
				inject: settingsInject,
			}, SettingsCard));
		}

		module.exports = { name, inject, apply, createModelCatalogStore, isConfiguredModelAvailable, catalogOptionFor, effortRows, CLEAR_SENTINEL };
		return module.exports;
	},
});
