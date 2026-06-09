//
// Web dive planner UI glue: loads the Subsurface planner WASM module, manages
// gases and parameters, turns the drawn profile into planner segments, runs the
// real decompression calculation and renders the result. Also: per-segment gas
// selection, pO2/MOD warnings, and shareable plans via the URL hash.

import createPlannerModule from './planner.js';
import { ProfileEditor } from './profile-editor.js';

const Module = await createPlannerModule();

// --- application state ------------------------------------------------------
const defaultState = () => ({
	params: {
		surface_pressure_mbar: 1013,
		salinity: 10300,
		gflow: 30,
		gfhigh: 75,
		vpmb_conservatism: 3,
		deco_mode: 0,          // 0 = Bühlmann, 1 = VPM-B
		bottomsac_mlpm: 20000,
		decosac_mlpm: 17000,
	},
	ppo2_limit: 1.6,           // deco-gas MOD limit
	ppo2_working: 1.4,         // working-gas MOD limit (for warnings)
	cylinders: [
		{ o2_permille: 210, he_permille: 0, size_ml: 24000, workingpressure_mbar: 232000 }, // back gas (air)
		{ o2_permille: 500, he_permille: 0, size_ml: 11100, workingpressure_mbar: 232000 }, // EAN50 deco
	],
});
const state = defaultState();

// --- helpers ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const GAS_PALETTE = ['#33424d', '#1e8e5a', '#c98a00', '#7a3fb0', '#0c8599', '#b5485d', '#5f7d1f', '#8a5a2b'];
const gasColor = (i) => GAS_PALETTE[i % GAS_PALETTE.length];

function gasName(c) {
	if (!c) return '?';
	if (c.o2_permille === 1000) return 'O₂';
	if (c.he_permille > 0) return `Tx ${Math.round(c.o2_permille / 10)}/${Math.round(c.he_permille / 10)}`;
	if (c.o2_permille === 210) return 'Luft';
	return `EAN${Math.round(c.o2_permille / 10)}`;
}

// ppO2 (bar) of a gas at a depth in mm (seawater approx P_abs = 1 + d/10).
const ppo2At = (o2_permille, depth_mm) => (o2_permille / 1000) * (1 + depth_mm / 10000);

// MOD in mm where ppO2 reaches a limit, rounded down to 3 m.
function modMm(o2_permille, ppo2_limit) {
	const fo2 = o2_permille / 1000;
	const depth_m = (ppo2_limit / fo2 - 1) * 10;
	return Math.max(0, Math.floor(depth_m / 3) * 3) * 1000;
}

// Build planner segments. Each drawn waypoint breathes its assigned cylinder.
// Every non-back cylinder is also registered with a zero-duration point at its
// MOD so the planner can auto-switch to it on ascent (mirrors testplan.cpp).
function buildSegments(waypoints) {
	const segs = [];
	for (let i = 1; i < state.cylinders.length; i++) {
		segs.push({
			time_incr_s: 0,
			depth_mm: modMm(state.cylinders[i].o2_permille, state.ppo2_limit),
			cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true,
		});
	}
	let prev = 0;
	for (const w of waypoints) {
		segs.push({
			time_incr_s: Math.max(0, w.time - prev), depth_mm: w.depth,
			cylinderid: Math.min(w.cyl || 0, state.cylinders.length - 1),
			setpoint_mbar: 0, divemode: 0, entered: true,
		});
		prev = w.time;
	}
	return segs;
}

let v_track = [];
function toVec(Vec, arr) { const v = new Vec(); arr.forEach((x) => v.push_back(x)); v_track.push(v); return v; }
function freeVecs() { v_track.forEach((v) => v.delete()); v_track = []; }

// --- the calculation --------------------------------------------------------
function calculate(waypoints) {
	const segs = buildSegments(waypoints);
	const cylVec = toVec(Module.CylinderVector, state.cylinders);
	const segVec = toVec(Module.SegmentVector, segs);
	try {
		renderResult(Module.runPlan(state.params, cylVec, segVec), waypoints);
	} catch (err) {
		$('summary').textContent = 'Berechnungsfehler: ' + err;
		console.error(err);
	} finally {
		freeVecs();
	}
	renderWarnings(waypoints);
	updateHash();
}

function renderResult(res, waypoints) {
	const samples = [];
	for (let i = 0; i < res.samples.size(); i++) {
		const s = res.samples.get(i);
		samples.push({ time_s: s.time_s, depth_mm: s.depth_mm, stopdepth_mm: s.stopdepth_mm, in_deco: s.in_deco });
	}
	editor.setComputed({ samples });

	let maxDepth = 0, runtime = 0;
	for (const s of samples) { if (s.depth_mm > maxDepth) maxDepth = s.depth_mm; if (s.time_s > runtime) runtime = s.time_s; }

	const stops = [];
	for (let i = 0; i < res.stops.size(); i++) {
		const st = res.stops.get(i);
		if (st.time_s > 0) stops.push({ depth: st.depth_mm / 1000, time: Math.round(st.time_s / 60) });
	}

	const gasNames = state.cylinders.map(gasName);
	const gases = [];
	for (let i = 0; i < res.gas.size(); i++) {
		const g = res.gas.get(i);
		gases.push({ name: gasNames[g.cylinderid] || `Zyl ${g.cylinderid}`, used: g.gas_used_ml / 1000, deco: g.deco_gas_used_ml / 1000 });
	}

	const errTxt = res.error === 0 ? '' : ` — Hinweis: Planner-Code ${res.error}`;
	$('summary').textContent =
		`Max. Tiefe ${(maxDepth / 1000).toFixed(1)} m · Laufzeit ${(runtime / 60).toFixed(0)} min` + errTxt;

	$('stops').innerHTML = stops.length
		? '<table><tr><th>Tiefe</th><th>Stopp</th></tr>' +
		  stops.map((s) => `<tr><td>${s.depth.toFixed(0)} m</td><td>${s.time} min</td></tr>`).join('') + '</table>'
		: '<em>Keine Dekostopps (Nullzeittauchgang)</em>';

	$('gas').innerHTML =
		'<table><tr><th>Gas</th><th>Verbrauch</th><th>davon Deko</th></tr>' +
		gases.map((g) => `<tr><td>${g.name}</td><td>${g.used.toFixed(0)} L</td><td>${g.deco.toFixed(0)} L</td></tr>`).join('') +
		'</table>';
}

// --- pO2 / MOD warnings (input-based, per drawn segment) --------------------
function renderWarnings(waypoints) {
	const out = [];
	for (const w of waypoints) {
		const c = state.cylinders[w.cyl] || state.cylinders[0];
		const name = gasName(c), dm = (w.depth / 1000).toFixed(0);
		const po2 = ppo2At(c.o2_permille, w.depth);
		if (po2 > 1.6) out.push({ lvl: 'err', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar > 1,6 (Sauerstofftoxizität)` });
		else if (po2 > state.ppo2_working) out.push({ lvl: 'warn', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar > ${state.ppo2_working} (über Arbeits-MOD)` });
		if (po2 < 0.18) out.push({ lvl: 'err', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar < 0,18 (hypoxisch)` });
	}
	const el = $('warnings');
	if (!out.length) {
		el.innerHTML = '<div class="ok">Keine pO₂-Warnungen</div>';
		return;
	}
	el.innerHTML = out.map((w) => `<div class="warn-row ${w.lvl}">${w.lvl === 'err' ? '⨯' : '!'} ${w.t}</div>`).join('');
}

// --- selected-point panel ---------------------------------------------------
function renderSelected(sel) {
	const box = $('selpoint');
	if (!sel) { box.classList.add('hidden'); return; }
	box.classList.remove('hidden');
	$('selInfo').textContent = `${(sel.depth / 1000).toFixed(0)} m · ${(sel.time / 60).toFixed(0)} min`;
	const sg = $('selGas');
	sg.innerHTML = state.cylinders.map((c, i) =>
		`<option value="${i}" ${i === sel.cyl ? 'selected' : ''}>${i}: ${gasName(c)}</option>`).join('');
}

// --- parameter + cylinder UI ------------------------------------------------
function renderCylinders() {
	const wrap = $('cylinders');
	wrap.innerHTML = '';
	state.cylinders.forEach((c, i) => {
		const row = document.createElement('div');
		row.className = 'cyl-row';
		row.innerHTML = `
			<span class="cyl-idx"><span class="gas-dot" style="background:${gasColor(i)}"></span>${i}${i === 0 ? ' (Back)' : ''}</span>
			<label>O₂% <input type="number" min="5" max="100" value="${(c.o2_permille / 10).toFixed(0)}" data-f="o2"></label>
			<label>He% <input type="number" min="0" max="95" value="${(c.he_permille / 10).toFixed(0)}" data-f="he"></label>
			<label>Größe <input type="number" min="1" max="40" step="0.1" value="${(c.size_ml / 1000).toFixed(1)}" data-f="size"></label>
			<label>bar <input type="number" min="50" max="300" value="${(c.workingpressure_mbar / 1000).toFixed(0)}" data-f="wp"></label>
			<button class="del" title="Flasche entfernen" ${state.cylinders.length <= 1 ? 'disabled' : ''}>×</button>`;
		row.querySelectorAll('input').forEach((inp) => {
			inp.addEventListener('change', () => {
				const v = parseFloat(inp.value) || 0;
				const f = inp.dataset.f;
				if (f === 'o2') c.o2_permille = Math.round(v * 10);
				else if (f === 'he') c.he_permille = Math.round(v * 10);
				else if (f === 'size') c.size_ml = Math.round(v * 1000);
				else if (f === 'wp') c.workingpressure_mbar = Math.round(v * 1000);
				refreshGasColors();
				recompute();
			});
		});
		row.querySelector('.del').addEventListener('click', () => {
			state.cylinders.splice(i, 1);
			renderCylinders();
			refreshGasColors();
			editor.clampGasIndices(state.cylinders.length);
			renderSelected(editor.getSelected());
		});
		wrap.appendChild(row);
	});
}

function refreshGasColors() {
	editor.setGasColors(state.cylinders.map((_, i) => gasColor(i)));
	renderSelected(editor.getSelected());
}

function bindParams() {
	const map = [
		['gflow', 'gflow', 1], ['gfhigh', 'gfhigh', 1],
		['bottomsac', 'bottomsac_mlpm', 1000], ['decosac', 'decosac_mlpm', 1000],
		['surface', 'surface_pressure_mbar', 1], ['salinity', 'salinity', 1],
		['vpmb', 'vpmb_conservatism', 1],
	];
	for (const [id, key, scale] of map) {
		const el = $(id);
		if (!el) continue;
		el.addEventListener('change', () => { state.params[key] = Math.round((parseFloat(el.value) || 0) * scale); recompute(); });
	}
	$('algo').addEventListener('change', () => {
		state.params.deco_mode = $('algo').value === 'vpmb' ? 1 : 0;
		document.body.classList.toggle('is-vpmb', state.params.deco_mode === 1);
		recompute();
	});
	$('addcyl').addEventListener('click', () => {
		state.cylinders.push({ o2_permille: 320, he_permille: 0, size_ml: 11100, workingpressure_mbar: 232000 });
		renderCylinders();
		refreshGasColors();
		recompute();
	});
	$('snap').addEventListener('change', () => editor.setSnap($('snap').checked));
	$('selGas').addEventListener('change', () => editor.setSelectedGas(parseInt($('selGas').value, 10)));
	$('share').addEventListener('click', share);
}

// Reflect restored state values back into the input fields.
function syncInputsFromState() {
	$('gflow').value = state.params.gflow;
	$('gfhigh').value = state.params.gfhigh;
	$('bottomsac').value = (state.params.bottomsac_mlpm / 1000).toFixed(1);
	$('decosac').value = (state.params.decosac_mlpm / 1000).toFixed(1);
	$('surface').value = state.params.surface_pressure_mbar;
	$('salinity').value = state.params.salinity;
	$('vpmb').value = state.params.vpmb_conservatism;
	$('algo').value = state.params.deco_mode === 1 ? 'vpmb' : 'buehlmann';
	document.body.classList.toggle('is-vpmb', state.params.deco_mode === 1);
}

// --- share / restore via URL hash -------------------------------------------
// Compact serialisation: waypoints as [timeS, depthMm, cyl], cylinders as
// [o2permille, hepermille, sizeMl, wpMbar], plus params.
function encodeState() {
	const obj = {
		w: editor.getWaypoints().map((w) => [w.time, w.depth, w.cyl || 0]),
		c: state.cylinders.map((c) => [c.o2_permille, c.he_permille, c.size_ml, c.workingpressure_mbar]),
		p: state.params,
	};
	return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(hash) {
	try {
		const b64 = hash.replace(/-/g, '+').replace(/_/g, '/');
		const obj = JSON.parse(decodeURIComponent(escape(atob(b64))));
		if (!obj || !Array.isArray(obj.w) || !Array.isArray(obj.c)) return null;
		return obj;
	} catch { return null; }
}

let hashTimer = null;
function updateHash() {
	clearTimeout(hashTimer);
	hashTimer = setTimeout(() => {
		const enc = encodeState();
		history.replaceState(null, '', '#' + enc);
	}, 200);
}

async function share() {
	const url = location.origin + location.pathname + '#' + encodeState();
	try {
		await navigator.clipboard.writeText(url);
		flashShare('Link kopiert ✓');
	} catch {
		flashShare('Konnte nicht kopieren — URL ist in der Adresszeile');
	}
}
function flashShare(msg) {
	const b = $('share');
	const old = b.textContent;
	b.textContent = msg;
	setTimeout(() => { b.textContent = old; }, 1600);
}

function restoreFromHash() {
	const h = location.hash.replace(/^#/, '');
	if (!h) return false;
	const obj = decodeState(h);
	if (!obj) return false;
	if (obj.p) Object.assign(state.params, obj.p);
	state.cylinders = obj.c.map((a) => ({ o2_permille: a[0], he_permille: a[1], size_ml: a[2], workingpressure_mbar: a[3] }));
	editor.setWaypoints(obj.w.map((a) => ({ time: a[0], depth: a[1], cyl: a[2] || 0 })), false);
	return true;
}

// --- debounced recompute ----------------------------------------------------
let timer = null;
function recompute() {
	clearTimeout(timer);
	timer = setTimeout(() => calculate(editor.getWaypoints()), 120);
}

// --- boot -------------------------------------------------------------------
const editor = new ProfileEditor($('profile'), () => recompute());
editor.onSelect = (sel) => renderSelected(sel);

restoreFromHash();          // may overwrite state.cylinders / waypoints
bindParams();
syncInputsFromState();
renderCylinders();
refreshGasColors();
calculate(editor.getWaypoints());
