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
	end_limit_m: 30,           // narcosis (END) warning threshold
	dive_mode: 0,              // 0 = OC, 1 = CCR
	sp_low_mbar: 700,          // CCR low setpoint (shallow)
	sp_high_mbar: 1200,        // CCR high setpoint (deep)
	sp_switch_depth_mm: 21000, // depth at/below which the high setpoint applies
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

function mixName(o2, he) {
	if (o2 === 1000) return 'O₂';
	if (he > 0) return `Tx ${Math.round(o2 / 10)}/${Math.round(he / 10)}`;
	if (o2 === 210) return 'Luft';
	return `EAN${Math.round(o2 / 10)}`;
}
function gasName(c) { return c ? mixName(c.o2_permille, c.he_permille) : '?'; }

// Constant-depth deco stops detected from the sample plateaus (excluding the
// bottom). Returns markers {time_s, depth_mm, min} for the graph.
function decoStopMarkers(samples) {
	if (samples.length < 2) return [];
	const maxD = Math.max(...samples.map((s) => s.depth_mm));
	const out = [];
	let i = 0;
	while (i < samples.length) {
		const d = samples[i].depth_mm; let j = i;
		while (j + 1 < samples.length && samples[j + 1].depth_mm === d) j++;
		const dur = samples[j].time_s - samples[i].time_s;
		if (d > 0 && d < maxD && dur >= 60) out.push({ time_s: samples[i].time_s + dur / 2, depth_mm: d, min: Math.round(dur / 60) });
		i = j + 1;
	}
	return out;
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
	const ccr = state.dive_mode === 1;
	const dm = ccr ? 1 : 0;
	const spFor = (depth_mm) => (depth_mm >= state.sp_switch_depth_mm ? state.sp_high_mbar : state.sp_low_mbar);
	const segs = [];
	// Open-circuit only: register deco/travel gases at their MOD so the planner
	// can auto-switch on ascent. On CCR the loop maintains the setpoint with the
	// diluent, so we don't register OC deco gases.
	if (!ccr) {
		for (let i = 1; i < state.cylinders.length; i++) {
			segs.push({
				time_incr_s: 0,
				depth_mm: modMm(state.cylinders[i].o2_permille, state.ppo2_limit),
				cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true,
			});
		}
	}
	let prev = 0;
	for (const w of waypoints) {
		segs.push({
			time_incr_s: Math.max(0, w.time - prev), depth_mm: w.depth,
			cylinderid: Math.min(w.cyl || 0, state.cylinders.length - 1),
			setpoint_mbar: ccr ? spFor(w.depth) : 0, divemode: dm, entered: true,
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
	const switches = [];
	for (let i = 0; i < res.switches.size(); i++) {
		const s = res.switches.get(i);
		switches.push({ time_s: s.time_s, label: mixName(s.o2_permille, s.he_permille), color: s.cylinderid >= 0 ? gasColor(s.cylinderid) : '#444' });
	}
	editor.setComputed({
		samples,
		switches,
		stops: decoStopMarkers(samples),
		setpointDepthMm: state.dive_mode === 1 ? state.sp_switch_depth_mm : null,
	});

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
	const cnsClass = res.cns >= 100 ? 'o2-err' : res.cns >= 80 ? 'o2-warn' : '';
	$('summary').innerHTML =
		`Max. Tiefe ${(maxDepth / 1000).toFixed(1)} m · Laufzeit ${(runtime / 60).toFixed(0)} min` +
		` · <span class="${cnsClass}">CNS ${res.cns}%</span> · OTU ${res.otu}` + errTxt;

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
	const ccr = state.dive_mode === 1;
	const ambBar = (depth_mm) => 1 + depth_mm / 10000;
	// Equivalent narcotic depth (o2narcotic convention: narcotic fraction = 1-fHe).
	const endM = (he_permille, depth_mm) => (depth_mm / 1000 + 10) * (1 - he_permille / 1000) - 10;

	if (ccr) {
		// pO2 follows the setpoint (low above the switch depth, high below),
		// capped by ambient when shallow.
		const seen = new Set();
		if (state.sp_high_mbar / 1000 > 1.6) out.push({ lvl: 'err', t: `High-Setpoint ${(state.sp_high_mbar / 1000).toFixed(2)} bar > 1,6 (Sauerstofftoxizität)` });
		for (const w of waypoints) {
			const sp = (w.depth >= state.sp_switch_depth_mm ? state.sp_high_mbar : state.sp_low_mbar) / 1000;
			const po2 = Math.min(sp, ambBar(w.depth));
			if (po2 < 0.18 && !seen.has('hyp')) {
				out.push({ lvl: 'err', t: `Loop-pO₂ ${po2.toFixed(2)} bar auf ${(w.depth / 1000).toFixed(0)} m < 0,18 (hypoxisch)` });
				seen.add('hyp');
			}
		}
	} else {
		for (const w of waypoints) {
			const c = state.cylinders[w.cyl] || state.cylinders[0];
			const name = gasName(c), dm = (w.depth / 1000).toFixed(0);
			const po2 = ppo2At(c.o2_permille, w.depth);
			if (po2 > 1.6) out.push({ lvl: 'err', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar > 1,6 (Sauerstofftoxizität)` });
			else if (po2 > state.ppo2_working) out.push({ lvl: 'warn', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar > ${state.ppo2_working} (über Arbeits-MOD)` });
			if (po2 < 0.18) out.push({ lvl: 'err', t: `${name} auf ${dm} m: pO₂ ${po2.toFixed(2)} bar < 0,18 (hypoxisch)` });
		}
	}

	// Narcosis (END) — applies to the breathed/diluent gas in both modes.
	let worstEnd = -1, worstDepth = 0, worstName = '';
	for (const w of waypoints) {
		const c = state.cylinders[w.cyl] || state.cylinders[0];
		const e = endM(c.he_permille, w.depth);
		if (e > worstEnd) { worstEnd = e; worstDepth = w.depth; worstName = gasName(c); }
	}
	if (worstEnd > state.end_limit_m) {
		out.push({ lvl: 'warn', t: `END ${worstEnd.toFixed(0)} m (${worstName} auf ${(worstDepth / 1000).toFixed(0)} m) > ${state.end_limit_m} m (Narkose)` });
	}

	const el = $('warnings');
	el.innerHTML = out.length
		? out.map((w) => `<div class="warn-row ${w.lvl}">${w.lvl === 'err' ? '⨯' : '!'} ${w.t}</div>`).join('')
		: '<div class="ok">Keine Warnungen</div>';
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

	$('mode').addEventListener('change', () => {
		state.dive_mode = $('mode').value === 'ccr' ? 1 : 0;
		document.body.classList.toggle('is-ccr', state.dive_mode === 1);
		recompute();
	});
	$('spLow').addEventListener('change', () => { state.sp_low_mbar = Math.round((parseFloat($('spLow').value) || 0.7) * 1000); recompute(); });
	$('spHigh').addEventListener('change', () => { state.sp_high_mbar = Math.round((parseFloat($('spHigh').value) || 1.2) * 1000); recompute(); });
	$('spSwitch').addEventListener('change', () => { state.sp_switch_depth_mm = Math.round((parseFloat($('spSwitch').value) || 21) * 1000); recompute(); });
	$('endlimit').addEventListener('change', () => { state.end_limit_m = Math.round(parseFloat($('endlimit').value) || 30); recompute(); });
	$('bestmix').addEventListener('click', suggestBestMix);
	$('export').addEventListener('click', exportPng);
}

// Best mix for a target depth: max O2 within the working pO2 limit, plus enough
// He to keep END at/below the narcosis limit (o2narcotic convention).
function suggestBestMix() {
	const d = Math.max(0, parseFloat($('bestdepth').value) || 0);
	const amb = 1 + d / 10;
	let o2 = Math.floor((state.ppo2_working / amb) * 100);
	o2 = Math.max(5, Math.min(100, o2));
	let he = Math.ceil((1 - (state.end_limit_m + 10) / (d + 10)) * 100);
	he = Math.max(0, Math.min(100 - o2, he));
	const cyl = { o2_permille: o2 * 10, he_permille: he * 10, size_ml: 11100, workingpressure_mbar: 232000 };
	state.cylinders.push(cyl);
	renderCylinders();
	refreshGasColors();
	recompute();
	$('bestresult').textContent = `→ ${mixName(cyl.o2_permille, cyl.he_permille)} als Flasche ${state.cylinders.length - 1} hinzugefügt`;
}

// Export the profile plus a result summary as a PNG.
function exportPng() {
	const src = editor.canvas;
	const scale = 2;
	const W = editor.W * scale, profH = editor.H * scale;
	const lines = [
		$('summary').innerText,
		'Dekostopps: ' + ($('stops').innerText.replace(/\s+/g, ' ').replace('Tiefe Stopp', '').trim() || 'keine'),
		'Warnungen: ' + $('warnings').innerText.replace(/\s+/g, ' ').trim(),
	];
	const lineH = 22 * scale, headH = 30 * scale, textH = headH + lines.length * lineH + 16 * scale;
	const out = document.createElement('canvas');
	out.width = W; out.height = profH + textH;
	const ctx = out.getContext('2d');
	ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
	ctx.fillStyle = '#1d2b33'; ctx.font = `bold ${16 * scale}px system-ui, sans-serif`;
	ctx.fillText('Tauchplan (Subsurface-Kern)', 12 * scale, 22 * scale);
	ctx.drawImage(src, 0, headH, W, profH);
	ctx.font = `${13 * scale}px system-ui, sans-serif`;
	ctx.fillStyle = '#33424d';
	lines.forEach((l, i) => ctx.fillText(l, 12 * scale, profH + headH + (i + 1) * lineH));
	const a = document.createElement('a');
	a.href = out.toDataURL('image/png');
	a.download = 'tauchplan.png';
	a.click();
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
	$('mode').value = state.dive_mode === 1 ? 'ccr' : 'oc';
	$('spLow').value = (state.sp_low_mbar / 1000).toFixed(1);
	$('spHigh').value = (state.sp_high_mbar / 1000).toFixed(1);
	$('spSwitch').value = (state.sp_switch_depth_mm / 1000).toFixed(0);
	$('endlimit').value = state.end_limit_m;
	document.body.classList.toggle('is-ccr', state.dive_mode === 1);
}

// --- share / restore via URL hash -------------------------------------------
// Compact serialisation: waypoints as [timeS, depthMm, cyl], cylinders as
// [o2permille, hepermille, sizeMl, wpMbar], plus params.
function encodeState() {
	const obj = {
		w: editor.getWaypoints().map((w) => [w.time, w.depth, w.cyl || 0]),
		c: state.cylinders.map((c) => [c.o2_permille, c.he_permille, c.size_ml, c.workingpressure_mbar]),
		p: state.params,
		m: state.dive_mode, spl: state.sp_low_mbar, sph: state.sp_high_mbar, spd: state.sp_switch_depth_mm, el: state.end_limit_m,
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
	if (typeof obj.m === 'number') state.dive_mode = obj.m;
	if (typeof obj.spl === 'number') state.sp_low_mbar = obj.spl;
	if (typeof obj.sph === 'number') state.sp_high_mbar = obj.sph;
	if (typeof obj.spd === 'number') state.sp_switch_depth_mm = obj.spd;
	if (typeof obj.el === 'number') state.end_limit_m = obj.el;
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
