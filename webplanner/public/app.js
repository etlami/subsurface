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
		descrate_mmps: 18000 / 60,        // 18 m/min
		ascrate_mmps: 9000 / 60,          // 9 m/min
		ascratelast6m_mmps: 9000 / 60,    // 9 m/min
		last_stop_6m: 0,                  // 0 = last stop 3 m, 1 = 6 m
		dobailout: 0,                     // CCR: deco on OC bailout
		safetystop: 1,                    // auto 3 min @ 5 m on no-deco dives
		switch_at_req_stop: 0,            // only switch gas at required stops
		min_switch_duration_s: 60,        // gas/SP switch duration
		doo2breaks: 0,                    // O2 deco breaks
		sacfactor: 400,                   // x100 (4.0) for minimum-gas calc
		problemsolvingtime_min: 4,        // minutes, for minimum-gas calc
		reserve_gas_mbar: 40000,          // deco-gas reserve (40 bar)
	},
	drop_stone: 0,                       // instant descent to the first waypoint
	ppo2_limit: 1.6,           // deco-gas MOD limit
	ppo2_working: 1.4,         // working-gas MOD limit (for warnings)
	end_limit_m: 30,           // narcosis (END) warning threshold
	dive_mode: 0,              // 0 = OC, 1 = CCR
	sp_low_mbar: 700,          // start/descent setpoint
	sp_high_mbar: 1300,        // bottom setpoint (reached on descent, kept on ascent)
	sp_switch_depth_mm: 21000, // descent depth where low -> high
	sp_deco_mbar: 1600,        // deco setpoint
	sp_deco_depth_mm: 6000,    // ascent depth where the deco setpoint applies
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

// CCR setpoint-change markers from the actual per-sample setpoint computed by
// the planner (so they reflect the real switch points, including the deco SP).
function setpointMarkers(samples) {
	const out = [];
	let last = -1;
	for (let i = 0; i < samples.length; i++) {
		const sp = samples[i].setpoint_mbar || 0;
		if (sp > 0 && sp !== last) {
			out.push({ time_s: samples[i].time_s, depth_mm: samples[i].depth_mm, label: `SP ${(sp / 1000).toFixed(1)}` });
			last = sp;
		}
	}
	return out;
}

// Rock-bottom / minimum gas reserve for the back gas (cylinder 0): gas for two
// divers to solve a problem at the deepest depth and ascend at 9 m/min on a
// stressed SAC (1.5x). Approximate, for situational awareness.
function renderMinGas(maxDepth_mm, realBar) {
	const el = $('mingas');
	if (!el) return;
	const back = state.cylinders[0];
	if (realBar > 0) {
		// Real Subsurface minimum-gas (rock-bottom) for the bottom gas (OC).
		el.innerHTML = `Min. Gas (Bottom-Gas) = <b>${realBar} bar</b><br>` +
			`<span class="muted">Subsurface-Formel: SAC-Faktor ${(state.params.sacfactor / 100).toFixed(1)}× · ` +
			`Problemzeit ${state.params.problemsolvingtime_min} min · Reserve-Gas ${Math.round(state.params.reserve_gas_mbar / 1000)} bar</span>`;
		return;
	}
	// Fallback estimate (CCR / no OC bottom): simple rock-bottom approximation.
	const d = maxDepth_mm / 1000;
	const sacReserve = (state.params.bottomsac_mlpm / 1000) * 1.5;
	const tAscent = d / 9;
	const reserveL = sacReserve * 2 * ((1 + d / 10) * 2 + (1 + (d / 2) / 10) * tAscent);
	const volL = back.size_ml / 1000;
	const bar = volL > 0 ? reserveL / volL : 0;
	el.innerHTML = `Reserve (Näherung, 2 Taucher) ≈ <b>${Math.round(bar)} bar</b><br><span class="muted">${gasName(back)}, ${volL.toFixed(0)} L · ${sacReserve.toFixed(0)} L/min · 9 m/min</span>`;
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
// Returns { segments, cylinders } — cylinders may gain a synthetic "SP x.x"
// setpoint-change cylinder for CCR deco, which is how Subsurface models a
// setpoint switch on ascent (see core/planner.cpp::setpoint_change).
const OC_GAS = 0, DILUENT = 1;
function buildSegments(waypoints) {
	const ccr = state.dive_mode === 1;
	// Normalise: every cylinder object must carry all embind fields.
	const cylinders = state.cylinders.map((c) => ({
		o2_permille: c.o2_permille, he_permille: c.he_permille, size_ml: c.size_ml,
		workingpressure_mbar: c.workingpressure_mbar,
		cylinder_use: OC_GAS, description: '',
	}));
	const segs = [];

	if (!ccr) {
		// OC: register deco/travel gases at their MOD for auto gas switching.
		for (let i = 1; i < cylinders.length; i++) {
			segs.push({ time_incr_s: 0, depth_mm: modMm(cylinders[i].o2_permille, state.ppo2_limit), cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true });
		}
		let prev = 0, first = true;
		for (const w of waypoints) {
			let incr = Math.max(0, w.time - prev);
			if (state.drop_stone && first) incr = 1; // instant descent
			first = false;
			segs.push({ time_incr_s: incr, depth_mm: w.depth, cylinderid: Math.min(w.cyl || 0, cylinders.length - 1), setpoint_mbar: 0, divemode: 0, entered: true });
			prev = w.time;
		}
		return { segments: segs, cylinders };
	}

	// CCR: cylinder 0 is the diluent (breathed on the loop).
	const dilId = 0;
	const bailout = state.params.dobailout === 1;
	cylinders[dilId].cylinder_use = DILUENT;
	if (bailout) {
		// Deco on open-circuit bailout: the other cylinders are OC bailout gases,
		// registered at their MOD so the planner switches to them on the ascent.
		for (let i = 1; i < cylinders.length; i++) {
			cylinders[i].cylinder_use = OC_GAS;
			segs.push({ time_incr_s: 0, depth_mm: modMm(cylinders[i].o2_permille, state.ppo2_limit), cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true });
		}
		// The planner needs an OC bottom bailout gas breathable at depth. Provide
		// one with the diluent's mix (you bail out to OC on your diluent).
		const dil = cylinders[dilId];
		cylinders.push({ o2_permille: dil.o2_permille, he_permille: dil.he_permille, size_ml: dil.size_ml, workingpressure_mbar: dil.workingpressure_mbar, cylinder_use: OC_GAS, description: '' });
		segs.push({ time_incr_s: 0, depth_mm: modMm(dil.o2_permille, state.ppo2_limit), cylinderid: cylinders.length - 1, setpoint_mbar: 0, divemode: 0, entered: true });
	} else {
		// Deco on the loop: register a deco setpoint change as an "SP x.x" diluent
		// cylinder at its depth (the planner switches the loop setpoint there).
		for (let i = 1; i < cylinders.length; i++) cylinders[i].cylinder_use = DILUENT;
		if (state.sp_deco_mbar > 0) {
			const dil = cylinders[dilId];
			cylinders.push({ o2_permille: dil.o2_permille, he_permille: dil.he_permille, size_ml: dil.size_ml, workingpressure_mbar: dil.workingpressure_mbar, cylinder_use: DILUENT, description: `SP ${(state.sp_deco_mbar / 1000).toFixed(1)}` });
			segs.push({ time_incr_s: 0, depth_mm: state.sp_deco_depth_mm, cylinderid: cylinders.length - 1, setpoint_mbar: 0, divemode: 1, entered: true });
		}
	}

	// Entered legs: start on the low setpoint, switch to high once the descent
	// crosses the switch depth, then keep high (the planner persists it on the
	// way up; the deco SP above kicks in at its depth during the ascent).
	let prevT = 0, prevD = 0, sp = state.sp_low_mbar, high = false, first = true;
	const sw = state.sp_switch_depth_mm;
	if (state.drop_stone) { sp = state.sp_high_mbar; high = true; } // instant to bottom
	for (const w of waypoints) {
		if (!high && prevD < sw && w.depth >= sw && w.time > prevT) {
			const tc = Math.round(prevT + (w.time - prevT) * (sw - prevD) / (w.depth - prevD));
			segs.push({ time_incr_s: Math.max(0, tc - prevT), depth_mm: sw, cylinderid: dilId, setpoint_mbar: sp, divemode: 1, entered: true });
			prevT = tc; prevD = sw; sp = state.sp_high_mbar; high = true;
		}
		if (w.depth >= sw) { sp = state.sp_high_mbar; high = true; }
		let incr = Math.max(0, w.time - prevT);
		if (state.drop_stone && first) incr = 1;
		first = false;
		segs.push({ time_incr_s: incr, depth_mm: w.depth, cylinderid: dilId, setpoint_mbar: sp, divemode: 1, entered: true });
		prevT = w.time; prevD = w.depth;
	}
	return { segments: segs, cylinders };
}

let v_track = [];
let lastDecoStops = []; // [{depth(m), time(min)}] of the last computed plan
function toVec(Vec, arr) { const v = new Vec(); arr.forEach((x) => v.push_back(x)); v_track.push(v); return v; }
function freeVecs() { v_track.forEach((v) => v.delete()); v_track = []; }

// --- the calculation --------------------------------------------------------
function calculate(waypoints) {
	const built = buildSegments(waypoints);
	const cylVec = toVec(Module.CylinderVector, built.cylinders);
	const segVec = toVec(Module.SegmentVector, built.segments);
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
		samples.push({ time_s: s.time_s, depth_mm: s.depth_mm, stopdepth_mm: s.stopdepth_mm, ceiling_mm: s.ceiling_mm, setpoint_mbar: s.setpoint_mbar, in_deco: s.in_deco });
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
		setpointDepthMm: null,
		spMarkers: state.dive_mode === 1 ? setpointMarkers(samples) : [],
	});

	let maxDepth = 0, runtime = 0;
	for (const s of samples) { if (s.depth_mm > maxDepth) maxDepth = s.depth_mm; if (s.time_s > runtime) runtime = s.time_s; }

	const stops = [];
	for (let i = 0; i < res.stops.size(); i++) {
		const st = res.stops.get(i);
		if (st.time_s > 0) stops.push({ depth: st.depth_mm / 1000, time: Math.round(st.time_s / 60) });
	}
	lastDecoStops = stops;

	const gasNames = state.cylinders.map(gasName);
	const gases = [];
	for (let i = 0; i < res.gas.size(); i++) {
		const g = res.gas.get(i);
		if (g.cylinderid >= state.cylinders.length) continue; // skip synthetic SP cylinder
		gases.push({ name: gasNames[g.cylinderid] || `Zyl ${g.cylinderid}`, used: g.gas_used_ml / 1000, deco: g.deco_gas_used_ml / 1000 });
	}

	const errTxt = res.error === 0 ? '' : ` — Hinweis: Planner-Code ${res.error}`;
	const cnsClass = res.cns >= 100 ? 'o2-err' : res.cns >= 80 ? 'o2-warn' : '';
	// Surface GF: shown once the dive incurs deco (Subsurface behaviour). Amber
	// when over 100 % (you would exceed your surfacing M-value -> deco needed).
	const sgf = (stops.length > 0 || res.surface_gf >= 100) && res.surface_gf > 0
		? ` · <span class="${res.surface_gf >= 100 ? 'o2-warn' : ''}">Surface GF ${res.surface_gf}%</span>` : '';
	$('summary').innerHTML =
		`Max. Tiefe ${(maxDepth / 1000).toFixed(1)} m · Laufzeit ${(runtime / 60).toFixed(0)} min` +
		` · <span class="${cnsClass}">CNS ${res.cns}%</span> · OTU ${res.otu}` + sgf + errTxt;

	renderMinGas(maxDepth, res.min_gas_bar || 0);

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
		// Each setpoint is capped by ambient pressure (you cannot hold a higher
		// pO2 than the surrounding pressure provides).
		[['Bottom', state.sp_high_mbar], ['Deko', state.sp_deco_mbar], ['Start', state.sp_low_mbar]].forEach(([n, mb]) => {
			if (mb / 1000 > 1.6) out.push({ lvl: 'err', t: `${n}-Setpoint ${(mb / 1000).toFixed(2)} bar > 1,6 (Sauerstofftoxizität)` });
		});
		// Low setpoint hypoxic at the surface? (diluent flush concern)
		if (state.sp_low_mbar / 1000 < 0.18) out.push({ lvl: 'err', t: `Start-Setpoint ${(state.sp_low_mbar / 1000).toFixed(2)} bar < 0,18 (hypoxisch)` });
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
		state.params.deco_mode = parseInt($('algo').value, 10) || 0; // 0 Bühlmann, 1 Recreational, 2 VPM-B
		document.body.classList.toggle('is-vpmb', state.params.deco_mode === 2);
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
	$('spHigh').addEventListener('change', () => { state.sp_high_mbar = Math.round((parseFloat($('spHigh').value) || 1.3) * 1000); recompute(); });
	$('spSwitch').addEventListener('change', () => { state.sp_switch_depth_mm = Math.round((parseFloat($('spSwitch').value) || 21) * 1000); recompute(); });
	$('spDeco').addEventListener('change', () => { state.sp_deco_mbar = Math.round((parseFloat($('spDeco').value) || 1.6) * 1000); recompute(); });
	$('spDecoDepth').addEventListener('change', () => { state.sp_deco_depth_mm = Math.round((parseFloat($('spDecoDepth').value) || 6) * 1000); recompute(); });
	$('endlimit').addEventListener('change', () => { state.end_limit_m = Math.round(parseFloat($('endlimit').value) || 30); recompute(); });
	const mpm2mmps = (v) => Math.round((parseFloat(v) || 0) * 1000 / 60);
	$('descrate').addEventListener('change', () => { state.params.descrate_mmps = mpm2mmps($('descrate').value) || state.params.descrate_mmps; recompute(); });
	$('ascrate').addEventListener('change', () => { state.params.ascrate_mmps = mpm2mmps($('ascrate').value) || state.params.ascrate_mmps; recompute(); });
	$('ascrate6m').addEventListener('change', () => { state.params.ascratelast6m_mmps = mpm2mmps($('ascrate6m').value) || state.params.ascratelast6m_mmps; recompute(); });
	$('laststop').addEventListener('change', () => { state.params.last_stop_6m = $('laststop').checked ? 1 : 0; recompute(); });
	$('bailout').addEventListener('change', () => { state.params.dobailout = $('bailout').checked ? 1 : 0; recompute(); });
	$('safetystop').addEventListener('change', () => { state.params.safetystop = $('safetystop').checked ? 1 : 0; recompute(); });
	$('switchreq').addEventListener('change', () => { state.params.switch_at_req_stop = $('switchreq').checked ? 1 : 0; recompute(); });
	$('minswitch').addEventListener('change', () => { state.params.min_switch_duration_s = Math.max(0, Math.round(parseFloat($('minswitch').value) || 60)); recompute(); });
	$('o2breaks').addEventListener('change', () => { state.params.doo2breaks = $('o2breaks').checked ? 1 : 0; recompute(); });
	$('dropstone').addEventListener('change', () => { state.drop_stone = $('dropstone').checked ? 1 : 0; recompute(); });
	$('probtime').addEventListener('change', () => { state.params.problemsolvingtime_min = Math.max(0, Math.round(parseFloat($('probtime').value) || 4)); recompute(); });
	$('reservegas').addEventListener('change', () => { state.params.reserve_gas_mbar = Math.max(0, Math.round((parseFloat($('reservegas').value) || 40) * 1000)); recompute(); });
	$('calcvar').addEventListener('click', computeVariations);
	$('bestmix').addEventListener('click', suggestBestMix);
	$('bestdeco').addEventListener('click', suggestDecoGases);
	$('export').addEventListener('click', exportPng);
	$('print').addEventListener('click', () => window.print());
	$('savePlan').addEventListener('click', savePlan);
	$('loadPlan').addEventListener('click', loadSelectedPlan);
	$('delPlan').addEventListener('click', deleteSelectedPlan);
	$('delPoint').addEventListener('click', () => editor.deleteSelected());
}

// --- variations ("what if +5 min / +3 m") -----------------------------------
function runtimeFor(waypoints) {
	const built = buildSegments(waypoints);
	const cv = new Module.CylinderVector(); built.cylinders.forEach((c) => cv.push_back(c));
	const sv = new Module.SegmentVector(); built.segments.forEach((s) => sv.push_back(s));
	let rt = 0;
	try {
		const r = Module.runPlan(state.params, cv, sv);
		for (let i = 0; i < r.samples.size(); i++) { const t = r.samples.get(i).time_s; if (t > rt) rt = t; }
	} finally { cv.delete(); sv.delete(); }
	return rt;
}
const fmtDelta = (sec) => (sec >= 0 ? '+' : '−') + Math.floor(Math.abs(sec) / 60) + ':' + String(Math.round(Math.abs(sec) % 60)).padStart(2, '0') + ' min';

function computeVariations() {
	const wp = editor.getWaypoints();
	if (!wp.length) return;
	const base = runtimeFor(wp);
	const wpT = wp.map((w) => ({ ...w }));
	wpT[wpT.length - 1].time += 300; // +5 min bottom
	const rtT = runtimeFor(wpT);
	const maxD = Math.max(...wp.map((w) => w.depth));
	const wpD = wp.map((w) => ({ ...w, depth: w.depth === maxD ? w.depth + 3000 : w.depth }));
	const rtD = runtimeFor(wpD);
	$('variations').innerHTML =
		`Laufzeit ${Math.round(base / 60)} min<br>` +
		`+5 min Grundzeit → Laufzeit ${fmtDelta(rtT - base)}<br>` +
		`+3 m Tiefe → Laufzeit ${fmtDelta(rtD - base)}`;
}

// --- best deco gas suggestion (OC) ------------------------------------------
// Adds the richest nitrox breathable at the deepest deco stop (pO2 limit), plus
// O2 for the shallow stops, so the planner can auto-switch to them on ascent.
function suggestDecoGases() {
	const el = $('bestresult');
	if (state.dive_mode === 1) { el.textContent = 'CCR: Deko läuft über den Loop-Setpoint.'; return; }
	if (!lastDecoStops.length) { el.textContent = 'Kein Deko-Gas nötig (Nullzeittauchgang).'; return; }
	const deepest = Math.max(...lastDecoStops.map((s) => s.depth)); // metres
	const added = [];
	const haveMix = (o2) => state.cylinders.some((c) => Math.abs(c.o2_permille - o2 * 10) < 5);
	// deco nitrox at the deepest stop (rounded to a tidy 2 %)
	if (deepest > 6) {
		let o2 = Math.floor((state.ppo2_limit / (1 + deepest / 10)) * 100 / 2) * 2;
		o2 = Math.max(22, Math.min(100, o2));
		if (!haveMix(o2)) { state.cylinders.push({ o2_permille: o2 * 10, he_permille: 0, size_ml: 11100, workingpressure_mbar: 232000 }); added.push(mixName(o2 * 10, 0)); }
	}
	// O2 for the 6 m / 3 m stops
	if (!haveMix(100)) { state.cylinders.push({ o2_permille: 1000, he_permille: 0, size_ml: 11100, workingpressure_mbar: 232000 }); added.push('O₂'); }
	renderCylinders();
	refreshGasColors();
	recompute();
	el.textContent = added.length ? `→ Deko-Gase ergänzt: ${added.join(', ')}` : 'Passende Deko-Gase sind bereits vorhanden.';
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
	$('algo').value = String(state.params.deco_mode);
	document.body.classList.toggle('is-vpmb', state.params.deco_mode === 2);
	$('mode').value = state.dive_mode === 1 ? 'ccr' : 'oc';
	$('spLow').value = (state.sp_low_mbar / 1000).toFixed(1);
	$('spHigh').value = (state.sp_high_mbar / 1000).toFixed(1);
	$('spSwitch').value = (state.sp_switch_depth_mm / 1000).toFixed(0);
	$('spDeco').value = (state.sp_deco_mbar / 1000).toFixed(1);
	$('spDecoDepth').value = (state.sp_deco_depth_mm / 1000).toFixed(0);
	$('endlimit').value = state.end_limit_m;
	const mmps2mpm = (v) => Math.round(v * 60 / 1000);
	$('descrate').value = mmps2mpm(state.params.descrate_mmps);
	$('ascrate').value = mmps2mpm(state.params.ascrate_mmps);
	$('ascrate6m').value = mmps2mpm(state.params.ascratelast6m_mmps);
	$('laststop').checked = state.params.last_stop_6m === 1;
	$('bailout').checked = state.params.dobailout === 1;
	$('safetystop').checked = state.params.safetystop === 1;
	$('switchreq').checked = state.params.switch_at_req_stop === 1;
	$('minswitch').value = state.params.min_switch_duration_s;
	$('o2breaks').checked = state.params.doo2breaks === 1;
	$('dropstone').checked = state.drop_stone === 1;
	$('probtime').value = state.params.problemsolvingtime_min;
	$('reservegas').value = Math.round(state.params.reserve_gas_mbar / 1000);
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
		m: state.dive_mode, spl: state.sp_low_mbar, sph: state.sp_high_mbar, spd: state.sp_switch_depth_mm,
		spdeco: state.sp_deco_mbar, spdd: state.sp_deco_depth_mm, el: state.end_limit_m,
		ds: state.drop_stone,
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

function applyDecoded(obj) {
	if (!obj || !Array.isArray(obj.w) || !Array.isArray(obj.c)) return false;
	if (obj.p) Object.assign(state.params, obj.p);
	if (typeof obj.m === 'number') state.dive_mode = obj.m;
	if (typeof obj.spl === 'number') state.sp_low_mbar = obj.spl;
	if (typeof obj.sph === 'number') state.sp_high_mbar = obj.sph;
	if (typeof obj.spd === 'number') state.sp_switch_depth_mm = obj.spd;
	if (typeof obj.spdeco === 'number') state.sp_deco_mbar = obj.spdeco;
	if (typeof obj.spdd === 'number') state.sp_deco_depth_mm = obj.spdd;
	if (typeof obj.el === 'number') state.end_limit_m = obj.el;
	if (typeof obj.ds === 'number') state.drop_stone = obj.ds;
	state.cylinders = obj.c.map((a) => ({ o2_permille: a[0], he_permille: a[1], size_ml: a[2], workingpressure_mbar: a[3] }));
	editor.setWaypoints(obj.w.map((a) => ({ time: a[0], depth: a[1], cyl: a[2] || 0 })), false);
	return true;
}

function restoreFromHash() {
	const h = location.hash.replace(/^#/, '');
	return h ? applyDecoded(decodeState(h)) : false;
}

// Apply a decoded plan at runtime (not at boot): also refresh all UI.
function loadPlanObject(obj) {
	if (!applyDecoded(obj)) return;
	syncInputsFromState();
	renderCylinders();
	refreshGasColors();
	recompute();
}

// --- saved plans (localStorage) ---------------------------------------------
const PLANS_KEY = 'webplanner_plans';
const readPlans = () => { try { return JSON.parse(localStorage.getItem(PLANS_KEY)) || {}; } catch { return {}; } };
const writePlans = (p) => localStorage.setItem(PLANS_KEY, JSON.stringify(p));

function refreshPlanList() {
	const sel = $('planList');
	if (!sel) return;
	const plans = readPlans();
	const names = Object.keys(plans).sort();
	sel.innerHTML = names.length ? names.map((n) => `<option>${n}</option>`).join('') : '<option value="">(keine)</option>';
}

function savePlan() {
	const name = ($('planName').value || '').trim();
	if (!name) { $('planName').focus(); return; }
	const plans = readPlans();
	plans[name] = encodeState();
	writePlans(plans);
	refreshPlanList();
	$('planList').value = name;
}

function loadSelectedPlan() {
	const name = $('planList').value;
	if (!name) return;
	const plans = readPlans();
	if (plans[name]) { loadPlanObject(decodeState(plans[name])); $('planName').value = name; }
}

function deleteSelectedPlan() {
	const name = $('planList').value;
	if (!name) return;
	const plans = readPlans();
	delete plans[name];
	writePlans(plans);
	refreshPlanList();
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
refreshPlanList();
calculate(editor.getWaypoints());
