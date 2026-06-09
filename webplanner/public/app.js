// AI-generated (Claude)
//
// Web dive planner UI glue: loads the Subsurface planner WASM module, manages
// gases and parameters, turns the drawn profile into planner segments, runs the
// real decompression calculation and renders the result.

import createPlannerModule from './planner.js';
import { ProfileEditor } from './profile-editor.js';

const Module = await createPlannerModule();

// --- application state ------------------------------------------------------
const state = {
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
	ppo2_limit: 1.6,           // for deco-gas MOD registration
	cylinders: [
		{ o2_permille: 210, he_permille: 0,   size_ml: 24000, workingpressure_mbar: 232000 }, // back gas (air)
		{ o2_permille: 500, he_permille: 0,   size_ml: 11100, workingpressure_mbar: 232000 }, // EAN50 deco
	],
};

// --- helpers ----------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// MOD in mm where ppO2 reaches the limit, rounded down to 3 m (seawater approx
// P_abs[bar] = 1 + depth_m / 10).
function modMm(o2_permille, ppo2_limit) {
	const fo2 = o2_permille / 1000;
	const depth_m = (ppo2_limit / fo2 - 1) * 10;
	return Math.max(0, Math.floor(depth_m / 3) * 3) * 1000;
}

// Build planner segments from the drawn waypoints. Deco/travel gases (cylinder
// index > 0) are registered with zero-duration points at their MOD so the
// planner may switch to them on ascent (this mirrors tests/testplan.cpp).
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
		const incr = Math.max(0, w.time - prev);
		segs.push({
			time_incr_s: incr, depth_mm: w.depth,
			cylinderid: 0, setpoint_mbar: 0, divemode: 0, entered: true,
		});
		prev = w.time;
	}
	return segs;
}

function toVec(Vec, arr) { const v = new Vec(); arr.forEach((x) => v.push_back(x)); v_track.push(v); return v; }
let v_track = [];
function freeVecs() { v_track.forEach((v) => v.delete()); v_track = []; }

// --- the calculation --------------------------------------------------------
function calculate(waypoints) {
	const segs = buildSegments(waypoints);
	const cylVec = toVec(Module.CylinderVector, state.cylinders);
	const segVec = toVec(Module.SegmentVector, segs);
	let res;
	try {
		res = Module.runPlan(state.params, cylVec, segVec);
		renderResult(res, waypoints);
	} catch (err) {
		$('summary').textContent = 'Berechnungsfehler: ' + err;
		console.error(err);
	} finally {
		freeVecs();
	}
}

// --- rendering of results ---------------------------------------------------
function renderResult(res, waypoints) {
	// Convert embind vectors to plain JS so the editor can render an overlay.
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

function gasName(c) {
	if (c.o2_permille === 1000) return 'O₂';
	if (c.he_permille > 0) return `Tx ${Math.round(c.o2_permille / 10)}/${Math.round(c.he_permille / 10)}`;
	if (c.o2_permille === 210) return 'Luft';
	return `EAN${Math.round(c.o2_permille / 10)}`;
}

// --- parameter + cylinder UI ------------------------------------------------
function renderCylinders() {
	const wrap = $('cylinders');
	wrap.innerHTML = '';
	state.cylinders.forEach((c, i) => {
		const row = document.createElement('div');
		row.className = 'cyl-row';
		row.innerHTML = `
			<span class="cyl-idx">${i}${i === 0 ? ' (Back)' : ''}</span>
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
				recompute();
			});
		});
		row.querySelector('.del').addEventListener('click', () => {
			state.cylinders.splice(i, 1);
			renderCylinders();
			recompute();
		});
		wrap.appendChild(row);
	});
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
		recompute();
	});
	$('snap').addEventListener('change', () => editor.setSnap($('snap').checked));
}

// --- debounced recompute ----------------------------------------------------
let timer = null;
function recompute() {
	clearTimeout(timer);
	timer = setTimeout(() => calculate(editor.getWaypoints()), 120);
}

// --- boot -------------------------------------------------------------------
const editor = new ProfileEditor($('profile'), () => recompute());
bindParams();
renderCylinders();
calculate(editor.getWaypoints());
