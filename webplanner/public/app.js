//
// Web dive planner UI. Three tabs: Planung (draw + compute), Ausrüstung
// (settings + cylinder inventory, persisted in localStorage) and Assistent.
// The planner core is the real Subsurface code compiled to WASM.

import createPlannerModule from './planner.js';
import { ProfileEditor } from './profile-editor.js';

const Module = await createPlannerModule();
const $ = (id) => document.getElementById(id);

// --- gas helpers ------------------------------------------------------------
const GAS_PALETTE = ['#33424d', '#1e8e5a', '#c98a00', '#7a3fb0', '#0c8599', '#b5485d', '#5f7d1f', '#8a5a2b'];
const gasColor = (i) => GAS_PALETTE[i % GAS_PALETTE.length];
function mixName(o2, he) {
	if (o2 === 1000) return 'O₂';
	if (he > 0) return `Tx ${Math.round(o2 / 10)}/${Math.round(he / 10)}`;
	if (o2 === 210) return 'Luft';
	return `EAN${Math.round(o2 / 10)}`;
}
const gasName = (c) => (c ? mixName(c.o2_permille, c.he_permille) : '?');
const ppo2At = (o2, depth_mm) => (o2 / 1000) * (1 + depth_mm / 10000);
function modMm(o2, lim) { return Math.max(0, Math.floor(((lim / (o2 / 1000) - 1) * 10) / 3) * 3) * 1000; }

// Subsurface standard cylinder presets [name, water ml, working bar].
const TANK_PRESETS = [
	['10 L 200 bar', 10000, 200], ['10 L 232 bar', 10000, 232], ['10 L 300 bar', 10000, 300],
	['11.1 L 232 bar', 11100, 232],
	['12 L 200 bar', 12000, 200], ['12 L 232 bar', 12000, 232], ['12 L 300 bar', 12000, 300],
	['15 L 200 bar', 15000, 200], ['15 L 232 bar', 15000, 232], ['3 L 232 bar', 3000, 232], ['3 L 300 bar', 3000, 300], ['ALU7', 7000, 200],
	['AL40', 5549, 207], ['AL50', 6936, 207], ['AL63', 8739, 207], ['AL72', 9987, 207], ['AL80', 11097, 207], ['AL100', 12610, 228],
	['LP85', 13398, 182], ['LP95', 14975, 182], ['LP108', 17024, 182], ['LP121', 19073, 182],
	['HP65', 7859, 237], ['HP80', 9672, 237], ['HP100', 12090, 237], ['HP117', 14145, 237], ['HP119', 14387, 237], ['HP130', 15717, 237],
	['D7 232 bar', 14000, 232], ['D7 300 bar', 14000, 300], ['D8.5 232 bar', 17000, 232],
	['D12 232 bar', 24000, 232], ['D13 232 bar', 26000, 232], ['D15 232 bar', 30000, 232],
	['D16 232 bar', 32000, 232], ['D18 232 bar', 36000, 232], ['D20 232 bar', 40000, 232],
];
const presetByName = (n) => TANK_PRESETS.find((t) => t[0] === n);
function presetName(size_ml, wp_mbar) {
	let best = '', err = Infinity;
	for (const [n, ml, bar] of TANK_PRESETS) { const e = Math.abs(ml - size_ml) + Math.abs(bar * 1000 - wp_mbar) / 10; if (e < err) { err = e; best = n; } }
	return err < 600 ? best : '';
}
const ROLES = [['bottom', 'Bottom'], ['travel', 'Travel'], ['deco', 'Deko'], ['diluent', 'Diluent'], ['bailout', 'Bailout']];

// --- persistent gear (settings + inventory) ---------------------------------
const GEAR_KEY = 'webplanner_gear';
function defaultSettings() {
	return {
		surface_pressure_mbar: 1013, salinity: 10300, gflow: 30, gfhigh: 75, vpmb_conservatism: 3,
		deco_mode: 0, bottomsac_mlpm: 20000, decosac_mlpm: 17000,
		descrate_mmps: 18000 / 60, ascrate_mmps: 9000 / 60, ascratelast6m_mmps: 9000 / 60,
		last_stop_6m: 0, safetystop: 1, switch_at_req_stop: 1, min_switch_duration_s: 60, doo2breaks: 0,
		sacfactor: 400, problemsolvingtime_min: 4, reserve_gas_mbar: 40000,
		ppo2_limit: 1.6, ppo2_working: 1.4, end_limit_m: 30, drop_stone: 0,
		sp_low_mbar: 700, sp_high_mbar: 1300, sp_switch_depth_mm: 21000, sp_deco_mbar: 1600, sp_deco_depth_mm: 6000,
	};
}
function defaultInventory() {
	return [
		{ label: 'Doppel-12', size_ml: 24000, wp_mbar: 232000, o2_permille: 210, he_permille: 0, roles: ['bottom'], count: 1 },
		{ label: 'Stage 50%', size_ml: 11097, wp_mbar: 207000, o2_permille: 500, he_permille: 0, roles: ['deco', 'bailout'], count: 1 },
		{ label: 'Stage O₂', size_ml: 5549, wp_mbar: 207000, o2_permille: 1000, he_permille: 0, roles: ['deco'], count: 1 },
	];
}
function loadGear() {
	try {
		const g = JSON.parse(localStorage.getItem(GEAR_KEY));
		if (g && g.settings && Array.isArray(g.inventory))
			return { settings: { ...defaultSettings(), ...g.settings }, inventory: g.inventory };
	} catch { /* ignore */ }
	return { settings: defaultSettings(), inventory: defaultInventory() };
}
const gear = loadGear();
const saveGear = () => localStorage.setItem(GEAR_KEY, JSON.stringify(gear));

// --- per-dive state ---------------------------------------------------------
const state = {
	settings: gear.settings,          // reference (persisted)
	inventory: gear.inventory,        // reference (persisted)
	dive_mode: 0,                     // 0 OC, 1 CCR (per dive)
	dobailout: 0,                     // per dive
	selected: new Set([0, 1, 2]),     // inventory indices taken on this dive
	cylinders: [],                    // resolved cylinders for the planner
};
const S = () => state.settings;

// Build the dive's cylinder list from the selected inventory items, back gas /
// diluent first (so it becomes cylinder 0).
function rebuildCylinders() {
	const ccr = state.dive_mode === 1;
	const backRole = ccr ? 'diluent' : 'bottom';
	const sel = [...state.selected].filter((i) => i < state.inventory.length).map((i) => state.inventory[i]);
	sel.sort((a, b) => {
		const ab = a.roles.includes(backRole) ? 0 : 1, bb = b.roles.includes(backRole) ? 0 : 1;
		if (ab !== bb) return ab - bb;
		return a.o2_permille - b.o2_permille; // deeper (leaner) gases first
	});
	state.cylinders = sel.map((c) => ({ o2_permille: c.o2_permille, he_permille: c.he_permille, size_ml: c.size_ml, workingpressure_mbar: c.wp_mbar }));
	if (!state.cylinders.length) state.cylinders = [{ o2_permille: 210, he_permille: 0, size_ml: 24000, workingpressure_mbar: 232000 }];
}

// --- segment building (OC + CCR) -------------------------------------------
const OC_GAS = 0, DILUENT = 1;
function buildSegments(waypoints) {
	const ccr = state.dive_mode === 1;
	const cylinders = state.cylinders.map((c) => ({ ...c, cylinder_use: OC_GAS, description: '' }));
	const segs = [];
	if (!ccr) {
		for (let i = 1; i < cylinders.length; i++)
			segs.push({ time_incr_s: 0, depth_mm: modMm(cylinders[i].o2_permille, S().ppo2_limit), cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true });
		let prev = 0, first = true;
		for (const w of waypoints) {
			let incr = Math.max(0, w.time - prev);
			if (S().drop_stone && first) incr = 1;
			first = false;
			segs.push({ time_incr_s: incr, depth_mm: w.depth, cylinderid: Math.min(w.cyl || 0, cylinders.length - 1), setpoint_mbar: 0, divemode: 0, entered: true });
			prev = w.time;
		}
		return { segments: segs, cylinders };
	}
	const dilId = 0;
	const bailout = state.dobailout === 1;
	cylinders[dilId].cylinder_use = DILUENT;
	if (bailout) {
		for (let i = 1; i < cylinders.length; i++) {
			cylinders[i].cylinder_use = OC_GAS;
			segs.push({ time_incr_s: 0, depth_mm: modMm(cylinders[i].o2_permille, S().ppo2_limit), cylinderid: i, setpoint_mbar: 0, divemode: 0, entered: true });
		}
		const dil = cylinders[dilId];
		cylinders.push({ o2_permille: dil.o2_permille, he_permille: dil.he_permille, size_ml: dil.size_ml, workingpressure_mbar: dil.workingpressure_mbar, cylinder_use: OC_GAS, description: '' });
		segs.push({ time_incr_s: 0, depth_mm: modMm(dil.o2_permille, S().ppo2_limit), cylinderid: cylinders.length - 1, setpoint_mbar: 0, divemode: 0, entered: true });
	} else {
		for (let i = 1; i < cylinders.length; i++) cylinders[i].cylinder_use = DILUENT;
		if (S().sp_deco_mbar > 0) {
			const dil = cylinders[dilId];
			cylinders.push({ o2_permille: dil.o2_permille, he_permille: dil.he_permille, size_ml: dil.size_ml, workingpressure_mbar: dil.workingpressure_mbar, cylinder_use: DILUENT, description: `SP ${(S().sp_deco_mbar / 1000).toFixed(1)}` });
			segs.push({ time_incr_s: 0, depth_mm: S().sp_deco_depth_mm, cylinderid: cylinders.length - 1, setpoint_mbar: 0, divemode: 1, entered: true });
		}
	}
	let prevT = 0, prevD = 0, sp = S().sp_low_mbar, high = false, first = true;
	const sw = S().sp_switch_depth_mm;
	if (S().drop_stone) { sp = S().sp_high_mbar; high = true; }
	for (const w of waypoints) {
		if (!high && prevD < sw && w.depth >= sw && w.time > prevT) {
			const tc = Math.round(prevT + (w.time - prevT) * (sw - prevD) / (w.depth - prevD));
			segs.push({ time_incr_s: Math.max(0, tc - prevT), depth_mm: sw, cylinderid: dilId, setpoint_mbar: sp, divemode: 1, entered: true });
			prevT = tc; prevD = sw; sp = S().sp_high_mbar; high = true;
		}
		if (w.depth >= sw) { sp = S().sp_high_mbar; high = true; }
		let incr = Math.max(0, w.time - prevT);
		if (S().drop_stone && first) incr = 1;
		first = false;
		segs.push({ time_incr_s: incr, depth_mm: w.depth, cylinderid: dilId, setpoint_mbar: sp, divemode: 1, entered: true });
		prevT = w.time; prevD = w.depth;
	}
	return { segments: segs, cylinders };
}

// JsParams for the bridge (from settings + per-dive mode).
function params() {
	const s = S();
	return {
		surface_pressure_mbar: s.surface_pressure_mbar, salinity: s.salinity, gflow: s.gflow, gfhigh: s.gfhigh,
		vpmb_conservatism: s.vpmb_conservatism, deco_mode: s.deco_mode, bottomsac_mlpm: s.bottomsac_mlpm, decosac_mlpm: s.decosac_mlpm,
		descrate_mmps: s.descrate_mmps, ascrate_mmps: s.ascrate_mmps, ascratelast6m_mmps: s.ascratelast6m_mmps,
		last_stop_6m: s.last_stop_6m, dobailout: state.dobailout, safetystop: s.safetystop, switch_at_req_stop: s.switch_at_req_stop,
		min_switch_duration_s: s.min_switch_duration_s, doo2breaks: s.doo2breaks, sacfactor: s.sacfactor,
		problemsolvingtime_min: s.problemsolvingtime_min, reserve_gas_mbar: s.reserve_gas_mbar,
	};
}

function runPlan(waypoints) {
	const built = buildSegments(waypoints);
	const cv = new Module.CylinderVector(); built.cylinders.forEach((c) => cv.push_back(c));
	const sv = new Module.SegmentVector(); built.segments.forEach((s) => sv.push_back(s));
	try { return Module.runPlan(params(), cv, sv); }
	finally { cv.delete(); sv.delete(); }
}

// --- compute + render -------------------------------------------------------
let lastDecoStops = [], lastMaxDepthM = 0, lastDecoMin = 0;

function decoStopMarkers(samples) {
	if (samples.length < 2) return [];
	const maxD = Math.max(...samples.map((s) => s.depth_mm));
	const out = []; let i = 0;
	while (i < samples.length) {
		const d = samples[i].depth_mm; let j = i;
		while (j + 1 < samples.length && samples[j + 1].depth_mm === d) j++;
		const dur = samples[j].time_s - samples[i].time_s;
		if (d > 0 && d < maxD && dur >= 60) out.push({ time_s: samples[i].time_s + dur / 2, depth_mm: d, min: Math.round(dur / 60) });
		i = j + 1;
	}
	return out;
}
function setpointMarkers(samples) {
	const out = []; let last = -1;
	for (const s of samples) { const sp = s.setpoint_mbar || 0; if (sp > 0 && sp !== last) { out.push({ time_s: s.time_s, depth_mm: s.depth_mm, label: `SP ${(sp / 1000).toFixed(1)}` }); last = sp; } }
	return out;
}

function calculate(waypoints) {
	let res;
	try { res = runPlan(waypoints); } catch (e) { $('summary').textContent = 'Fehler: ' + e; console.error(e); return; }
	const samples = [];
	for (let i = 0; i < res.samples.size(); i++) { const s = res.samples.get(i); samples.push({ time_s: s.time_s, depth_mm: s.depth_mm, stopdepth_mm: s.stopdepth_mm, ceiling_mm: s.ceiling_mm, setpoint_mbar: s.setpoint_mbar, in_deco: s.in_deco }); }
	editor.setComputed({ samples, switches: gasSwitches(res), stops: decoStopMarkers(samples), setpointDepthMm: null, spMarkers: state.dive_mode === 1 ? setpointMarkers(samples) : [] });

	let maxDepth = 0, runtime = 0;
	for (const s of samples) { if (s.depth_mm > maxDepth) maxDepth = s.depth_mm; if (s.time_s > runtime) runtime = s.time_s; }
	const stops = [];
	for (let i = 0; i < res.stops.size(); i++) { const st = res.stops.get(i); if (st.time_s > 0) stops.push({ depth: st.depth_mm / 1000, time: Math.round(st.time_s / 60) }); }
	lastDecoStops = stops; lastMaxDepthM = maxDepth / 1000; lastDecoMin = stops.reduce((a, s) => a + s.time, 0);

	const cnsClass = res.cns >= 100 ? 'o2-err' : res.cns >= 80 ? 'o2-warn' : '';
	const sgf = (stops.length > 0 || res.surface_gf >= 100) && res.surface_gf > 0 ? ` · <span class="${res.surface_gf >= 100 ? 'o2-warn' : ''}">Surface GF ${res.surface_gf}%</span>` : '';
	$('summary').innerHTML = `Max. Tiefe ${(maxDepth / 1000).toFixed(1)} m · Laufzeit ${(runtime / 60).toFixed(0)} min · <span class="${cnsClass}">CNS ${res.cns}%</span> · OTU ${res.otu}${sgf}` + (res.error ? ` — Code ${res.error}` : '');
	$('stops').innerHTML = stops.length ? '<table><tr><th>Tiefe</th><th>Stopp</th></tr>' + stops.map((s) => `<tr><td>${s.depth.toFixed(0)} m</td><td>${s.time} min</td></tr>`).join('') + '</table>' : '<em>Keine Dekostopps</em>';

	const names = state.cylinders.map(gasName);
	const gases = [];
	for (let i = 0; i < res.gas.size(); i++) { const g = res.gas.get(i); if (g.cylinderid >= state.cylinders.length) continue; gases.push(`<tr><td>${names[g.cylinderid] || g.cylinderid}</td><td>${(g.gas_used_ml / 1000).toFixed(0)} L</td></tr>`); }
	$('gas').innerHTML = '<table><tr><th>Gas</th><th>Verbrauch</th></tr>' + gases.join('') + '</table>';
	$('mingas').innerHTML = res.min_gas_bar > 0 ? `Min. Gas (Bottom): <b>${res.min_gas_bar} bar</b> <span class="muted">(SAC-Faktor ${(S().sacfactor / 100).toFixed(1)}×, ${S().problemsolvingtime_min} min)</span>` : '';
	renderWarnings(waypoints);
	updateHash();
}

function gasSwitches(res) {
	const out = [];
	for (let i = 0; i < res.switches.size(); i++) { const s = res.switches.get(i); out.push({ time_s: s.time_s, label: mixName(s.o2_permille, s.he_permille), color: s.cylinderid >= 0 ? gasColor(s.cylinderid) : '#444' }); }
	return out;
}

function renderWarnings(waypoints) {
	const out = []; const ccr = state.dive_mode === 1;
	const endM = (he, d_mm) => (d_mm / 1000 + 10) * (1 - he / 1000) - 10;
	if (ccr) {
		[['Bottom', S().sp_high_mbar], ['Deko', S().sp_deco_mbar], ['Start', S().sp_low_mbar]].forEach(([n, mb]) => { if (mb / 1000 > 1.6) out.push({ lvl: 'err', t: `${n}-Setpoint ${(mb / 1000).toFixed(2)} bar > 1,6` }); });
	} else {
		for (const w of waypoints) {
			const c = state.cylinders[w.cyl] || state.cylinders[0]; if (!c) continue;
			const po2 = ppo2At(c.o2_permille, w.depth), dm = (w.depth / 1000).toFixed(0);
			if (po2 > 1.6) out.push({ lvl: 'err', t: `${gasName(c)} @${dm} m: pO₂ ${po2.toFixed(2)} > 1,6` });
			else if (po2 > S().ppo2_working) out.push({ lvl: 'warn', t: `${gasName(c)} @${dm} m: pO₂ ${po2.toFixed(2)} > ${S().ppo2_working}` });
			if (po2 < 0.18) out.push({ lvl: 'err', t: `${gasName(c)} @${dm} m: pO₂ ${po2.toFixed(2)} < 0,18 (hypox)` });
		}
	}
	let we = -1, wd = 0, wn = '';
	for (const w of waypoints) { const c = state.cylinders[w.cyl] || state.cylinders[0]; if (!c) continue; const e = endM(c.he_permille, w.depth); if (e > we) { we = e; wd = w.depth; wn = gasName(c); } }
	if (we > S().end_limit_m) out.push({ lvl: 'warn', t: `END ${we.toFixed(0)} m (${wn} @${(wd / 1000).toFixed(0)} m) > ${S().end_limit_m} m` });
	$('warnings').innerHTML = out.length ? out.map((w) => `<div class="warn-row ${w.lvl}">${w.lvl === 'err' ? '⨯' : '!'} ${w.t}</div>`).join('') : '<div class="ok">Keine Warnungen</div>';
}

// --- inventory editor (Ausrüstung) ------------------------------------------
function renderInventory() {
	const wrap = $('inventory'); if (!wrap) return;
	wrap.innerHTML = '';
	state.inventory.forEach((c, i) => {
		const row = document.createElement('div');
		row.className = 'inv-edit';
		const presetOpts = ['<option value="">– Größe –</option>'].concat(TANK_PRESETS.map(([n]) => `<option value="${n}" ${n === presetName(c.size_ml, c.wp_mbar) ? 'selected' : ''}>${n}</option>`)).join('');
		const roleChecks = ROLES.map(([k, lbl]) => `<label class="rolechk"><input type="checkbox" data-role="${k}" ${c.roles.includes(k) ? 'checked' : ''}>${lbl}</label>`).join('');
		row.innerHTML = `
			<input class="inv-label" type="text" value="${c.label || ''}" placeholder="Name" data-f="label">
			<select data-f="preset">${presetOpts}</select>
			<label>O₂% <input type="number" min="5" max="100" value="${(c.o2_permille / 10).toFixed(0)}" data-f="o2"></label>
			<label>He% <input type="number" min="0" max="95" value="${(c.he_permille / 10).toFixed(0)}" data-f="he"></label>
			<span class="roles">${roleChecks}</span>
			<button class="del" title="entfernen">×</button>`;
		row.querySelector('[data-f=preset]').addEventListener('change', (e) => { const p = presetByName(e.target.value); if (p) { c.size_ml = p[1]; c.wp_mbar = p[2] * 1000; persistAndRefresh(); } });
		row.querySelector('[data-f=label]').addEventListener('change', (e) => { c.label = e.target.value; saveGear(); renderPicker(); });
		row.querySelector('[data-f=o2]').addEventListener('change', (e) => { c.o2_permille = Math.round((parseFloat(e.target.value) || 0) * 10); persistAndRefresh(); });
		row.querySelector('[data-f=he]').addEventListener('change', (e) => { c.he_permille = Math.round((parseFloat(e.target.value) || 0) * 10); persistAndRefresh(); });
		row.querySelectorAll('[data-role]').forEach((cb) => cb.addEventListener('change', () => {
			const k = cb.dataset.role; c.roles = cb.checked ? [...new Set([...c.roles, k])] : c.roles.filter((r) => r !== k); persistAndRefresh();
		}));
		row.querySelector('.del').addEventListener('click', () => { state.inventory.splice(i, 1); state.selected.delete(i); renumberSelection(i); persistAndRefresh(); renderInventory(); });
		wrap.appendChild(row);
	});
}
function renumberSelection(removedIdx) {
	const ns = new Set();
	state.selected.forEach((i) => { if (i < removedIdx) ns.add(i); else if (i > removedIdx) ns.add(i - 1); });
	state.selected = ns;
}
function persistAndRefresh() { saveGear(); renderPicker(); rebuildCylinders(); recompute(); }

// --- cylinder picker (Planung) ----------------------------------------------
function renderPicker() {
	const html = !state.inventory.length
		? '<span class="muted">Inventar unter „Ausrüstung" anlegen.</span>'
		: state.inventory.map((c, i) => {
			const roles = c.roles.map((r) => (ROLES.find((x) => x[0] === r) || [])[1]).filter(Boolean).join(', ');
			return `<label class="pick-row"><input type="checkbox" data-i="${i}" ${state.selected.has(i) ? 'checked' : ''}>
				<span class="gas-dot" style="background:${gasColor(i)}"></span>
				<b>${gasName(c)}</b> <span class="muted">${c.label || ''} · ${(c.size_ml / 1000).toFixed(1)} L${roles ? ' · ' + roles : ''}</span></label>`;
		}).join('');
	for (const id of ['cylPicker', 'wizCyl']) {
		const wrap = $(id); if (!wrap) continue;
		wrap.innerHTML = html;
		wrap.querySelectorAll('input[data-i]').forEach((cb) => cb.addEventListener('change', () => {
			const i = +cb.dataset.i; if (cb.checked) state.selected.add(i); else state.selected.delete(i);
			rebuildCylinders(); renderSelectedGas(); renderPicker(); recompute();
		}));
	}
}

// --- selected-point gas (uses the dive's cylinders) -------------------------
function renderSelected(sel) {
	const box = $('selpoint');
	if (!sel) { box.classList.add('hidden'); return; }
	box.classList.remove('hidden');
	$('selInfo').textContent = `${(sel.depth / 1000).toFixed(0)} m · ${(sel.time / 60).toFixed(0)} min`;
	$('selGas').innerHTML = state.cylinders.map((c, i) => `<option value="${i}" ${i === sel.cyl ? 'selected' : ''}>${i}: ${gasName(c)}</option>`).join('');
}
function renderSelectedGas() { renderSelected(editor.getSelected()); editor.setGasColors(state.cylinders.map((_, i) => gasColor(i))); }

// --- suggestions ------------------------------------------------------------
const mix = (o2, he) => ({ o2_permille: o2, he_permille: he });
function ocBottomGas(D) { return D <= 30 ? mix(320, 0) : D <= 45 ? mix(210, 350) : D <= 60 ? mix(180, 450) : D <= 75 ? mix(150, 550) : mix(120, 650); }
function ocDecoSet(D) { const s = []; if (D > 65) s.push(mix(210, 350)); if (D > 50) s.push(mix(350, 250)); s.push(mix(500, 0)); s.push(mix(1000, 0)); return s; }
function ccrDiluent(D) { return D <= 30 ? mix(210, 0) : D <= 50 ? mix(180, 450) : D <= 65 ? mix(150, 550) : D <= 100 ? mix(100, 700) : mix(70, 750); }
function ccrBailoutLadder(D) {
	if (D <= 30) return [];
	if (D <= 50) return [mix(500, 150), mix(1000, 0)];
	if (D <= 65) return [mix(350, 250), mix(500, 150), mix(1000, 0)];
	if (D <= 100) return [mix(180, 450), mix(210, 350), mix(350, 250), mix(500, 150), mix(1000, 0)];
	return [mix(150, 550), mix(180, 450), mix(210, 350), mix(350, 250), mix(500, 150), mix(1000, 0)];
}
const STD_SIZES_ML = [3000, 5700, 7000, 10000, 11100, 12000, 15000, 18000, 20000, 24000, 30000];
function pickSizeMl(used_ml, wp_mbar, frac, minMl) {
	const need = (used_ml / 1000) / (wp_mbar / 1000 * frac);
	for (const s of STD_SIZES_ML) if (s / 1000 >= need && s >= (minMl || 0)) return s;
	return 30000;
}
const ROLEKEY = { Bottom: 'bottom', Diluent: 'diluent', Deko: 'deco', Bailout: 'bailout' };
// Inventory cylinder carrying ~this gas (composition match), or null.
function ownedCyl(o2, he) { return state.inventory.find((c) => Math.abs(c.o2_permille - o2) < 20 && Math.abs(c.he_permille - he) < 30) || null; }
// Same, formatted as a label for display.
function ownedWithGas(o2, he) { const m = ownedCyl(o2, he); return m ? `${gasName(m)} (${m.label || (m.size_ml / 1000).toFixed(1) + ' L'})` : null; }

// Recommended gases for a profile (from the tables) with the optimal cylinder
// size (from computed gas use) and what the inventory already covers.
function recommendation(waypoints) {
	const D = waypoints.length ? Math.max(...waypoints.map((w) => w.depth)) / 1000 : 0;
	const ccr = state.dive_mode === 1;
	const recs = ccr
		? [{ g: ccrDiluent(D), r: 'Diluent', back: true }, ...ccrBailoutLadder(D).map((g) => ({ g, r: 'Bailout' }))]
		: [{ g: ocBottomGas(D), r: 'Bottom', back: true }, ...ocDecoSet(D).map((g) => ({ g, r: 'Deko' }))];
	const temp = recs.map((x) => ({ o2_permille: x.g.o2_permille, he_permille: x.g.he_permille, size_ml: x.back ? 24000 : 11100, workingpressure_mbar: 232000 }));
	const saved = state.cylinders; state.cylinders = temp;
	const used = {};
	try { const r = runPlan(waypoints); for (let i = 0; i < r.gas.size(); i++) { const g = r.gas.get(i); used[g.cylinderid] = g.gas_used_ml; } }
	catch { /* ignore */ } finally { state.cylinders = saved; }
	return { D, items: recs.map((x, i) => ({ role: x.r, g: x.g, optMl: pickSizeMl(used[i] || 0, 232000, x.back ? 2 / 3 : 0.75, x.back ? 7000 : 5700), owned: ownedCyl(x.g.o2_permille, x.g.he_permille) })) };
}
function renderSuggestion(waypoints, elId) {
	const el = $(elId);
	const D = waypoints.length ? Math.max(...waypoints.map((w) => w.depth)) / 1000 : 0;
	if (!D) { el.textContent = 'Erst ein Profil / eine Tiefe wählen.'; return; }
	const rec = recommendation(waypoints);
	const lines = rec.items.map((it) => {
		const head = `${it.role}: <b>${gasName(it.g)}</b> · mind. <b>${(it.optMl / 1000).toFixed(1)} L</b>`;
		if (it.owned)
			return `${head} · du hast: <b>${it.owned.label || gasName(it.owned)}</b> (${(it.owned.size_ml / 1000).toFixed(1)} L)`;
		return `${head} · <span class="o2-err">nicht im Inventar</span> <button class="add addgas" data-o2="${it.g.o2_permille}" data-he="${it.g.he_permille}" data-role="${ROLEKEY[it.role] || 'deco'}" data-ml="${it.optMl}">+ ins Inventar</button>`;
	});
	el.innerHTML = `Empfohlen für ${rec.D.toFixed(0)} m (${state.dive_mode === 1 ? 'CCR' : 'OC'}):<br>` + lines.join('<br>');
	el.querySelectorAll('.addgas').forEach((b) => b.addEventListener('click', () => {
		state.inventory.push({ label: '', size_ml: +b.dataset.ml, wp_mbar: 232000, o2_permille: +b.dataset.o2, he_permille: +b.dataset.he, roles: [b.dataset.role], count: 1 });
		state.selected.add(state.inventory.length - 1);
		saveGear(); renderInventory(); renderPicker(); rebuildCylinders(); renderSelectedGas(); recompute();
		renderSuggestion(waypoints, elId);
	}));
}
function suggestPlanGases() { renderSuggestion(editor.getWaypoints(), 'bestresult'); }
function suggestBestMix() {
	const d = Math.max(0, parseFloat($('bestdepth').value) || 0);
	let o2 = Math.max(5, Math.min(100, Math.floor((S().ppo2_working / (1 + d / 10)) * 100)));
	let he = Math.max(0, Math.min(100 - o2, Math.ceil((1 - (S().end_limit_m + 10) / (d + 10)) * 100)));
	$('bestresult').innerHTML = `Beste Mischung für ${d} m: <b>${mixName(o2 * 10, he * 10)}</b> <span class="muted">(pO₂ ${S().ppo2_working}, END ≤ ${S().end_limit_m} m)</span>`;
}
function suggestDecoGases() {
	if (state.dive_mode === 1) { $('bestresult').textContent = 'CCR: Deko über den Loop-Setpoint.'; return; }
	if (!lastDecoStops.length) { $('bestresult').textContent = 'Kein Deko-Gas nötig (Nullzeit).'; return; }
	const deepest = Math.max(...lastDecoStops.map((s) => s.depth));
	const want = []; if (deepest > 6) { let o2 = Math.max(22, Math.floor((S().ppo2_limit / (1 + deepest / 10)) * 100 / 2) * 2); want.push(mix(o2 * 10, 0)); } want.push(mix(1000, 0));
	$('bestresult').innerHTML = 'Deko-Gase: ' + want.map((g) => { const o = ownedWithGas(g.o2_permille, g.he_permille); return `<b>${gasName(g)}</b> (${o ? o : '<span class="o2-err">fehlt</span>'})`; }).join(' · ');
}

// --- variations -------------------------------------------------------------
function runtimeFor(waypoints) { const r = runPlan(waypoints); let rt = 0; for (let i = 0; i < r.samples.size(); i++) { const t = r.samples.get(i).time_s; if (t > rt) rt = t; } return rt; }
const fmtDelta = (sec) => (sec >= 0 ? '+' : '−') + Math.floor(Math.abs(sec) / 60) + ':' + String(Math.round(Math.abs(sec) % 60)).padStart(2, '0') + ' min';
function computeVariations() {
	const wp = editor.getWaypoints(); if (!wp.length) return;
	const base = runtimeFor(wp);
	const wpT = wp.map((w) => ({ ...w })); wpT[wpT.length - 1].time += 300;
	const maxD = Math.max(...wp.map((w) => w.depth));
	const wpD = wp.map((w) => ({ ...w, depth: w.depth === maxD ? w.depth + 3000 : w.depth }));
	$('variations').innerHTML = `Laufzeit ${Math.round(base / 60)} min<br>+5 min Grund → ${fmtDelta(runtimeFor(wpT) - base)}<br>+3 m Tiefe → ${fmtDelta(runtimeFor(wpD) - base)}`;
}

// --- max bottom time at a depth with the selected gases ---------------------
// Binary-searches the bottom time; each candidate is planned and checked
// against gas supply (rule of thirds for back gas, 3/4 for stages) and CNS.
const MAXT_MIN = 300;
function evalBottom(depthM, Tmin) {
	const descS = Math.max(1, Math.round(depthM * 1000 / S().descrate_mmps));
	const t1 = descS + Math.max(0, Tmin) * 60;
	const r = runPlan([{ time: descS, depth: depthM * 1000, cyl: 0 }, { time: t1, depth: depthM * 1000, cyl: 0 }]);
	let gasOk = true, limCyl = -1, worst = 1;
	for (let i = 0; i < r.gas.size(); i++) {
		const g = r.gas.get(i);
		if (g.cylinderid >= state.cylinders.length) continue;
		const c = state.cylinders[g.cylinderid];
		const capL = c.size_ml / 1000 * c.workingpressure_mbar / 1000;
		const frac = g.cylinderid === 0 ? 2 / 3 : 0.75;
		const ratio = capL > 0 ? (g.gas_used_ml / 1000) / (capL * frac) : 9;
		if (ratio > 1 && ratio > worst) { gasOk = false; limCyl = g.cylinderid; worst = ratio; }
	}
	return { ok: r.error === 0 && gasOk && r.cns < 100, gasOk, cnsOk: r.cns < 100, cns: r.cns, limCyl, err: r.error };
}
function maxBottomTime(depthM) {
	if (depthM <= 0) return null;
	if (!evalBottom(depthM, 0).ok) return { fail0: true, e: evalBottom(depthM, 0) };
	if (evalBottom(depthM, MAXT_MIN).ok) return { t: MAXT_MIN, capped: true };
	let lo = 0, hi = MAXT_MIN;
	while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (evalBottom(depthM, m).ok) lo = m; else hi = m; }
	const b = evalBottom(depthM, hi);
	let reason = 'Gas/CNS';
	if (!b.cnsOk) reason = `CNS (${b.cns} %)`;
	else if (!b.gasOk) reason = `Gas: ${gasName(state.cylinders[b.limCyl])}`;
	else if (b.err) reason = 'Planer';
	return { t: lo, reason };
}
function showMaxBottomTime() {
	const d = parseFloat($('maxdepth').value) || 0;
	const r = maxBottomTime(d);
	const el = $('maxresult');
	if (!r) { el.textContent = 'Tiefe eingeben.'; return; }
	if (r.fail0) { el.innerHTML = `<span class="o2-err">Schon 0 min nicht möglich</span> (${!r.e.cnsOk ? 'CNS' : 'Gas'} reicht nicht).`; return; }
	el.innerHTML = r.capped
		? `> ${MAXT_MIN} min auf ${d} m <span class="muted">(kein Limit im Bereich)</span>`
		: `max. <b>${r.t} min</b> Grundzeit auf ${d} m — limitiert durch <b>${r.reason}</b>`;
}

// --- saved plans + share ----------------------------------------------------
function encodeState() {
	const obj = {
		w: editor.getWaypoints().map((w) => [w.time, w.depth, w.cyl || 0]),
		c: state.cylinders.map((c) => [c.o2_permille, c.he_permille, c.size_ml, c.workingpressure_mbar]),
		m: state.dive_mode, bo: state.dobailout,
	};
	return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeState(h) { try { return JSON.parse(decodeURIComponent(escape(atob(h.replace(/-/g, '+').replace(/_/g, '/'))))); } catch { return null; } }
function applyDecoded(o) {
	if (!o || !Array.isArray(o.w)) return false;
	if (typeof o.m === 'number') state.dive_mode = o.m;
	if (typeof o.bo === 'number') state.dobailout = o.bo;
	if (Array.isArray(o.c) && o.c.length) { state.cylinders = o.c.map((a) => ({ o2_permille: a[0], he_permille: a[1], size_ml: a[2], workingpressure_mbar: a[3] })); state.selected = new Set(); }
	editor.setWaypoints(o.w.map((a) => ({ time: a[0], depth: a[1], cyl: a[2] || 0 })), false);
	return true;
}
let hashTimer = null;
function updateHash() { clearTimeout(hashTimer); hashTimer = setTimeout(() => history.replaceState(null, '', '#' + encodeState()), 200); }
async function share() { try { await navigator.clipboard.writeText(location.origin + location.pathname + '#' + encodeState()); flash('Link kopiert ✓'); } catch { flash('URL in der Adresszeile'); } }
function flash(m) { const b = $('share'), o = b.textContent; b.textContent = m; setTimeout(() => { b.textContent = o; }, 1500); }

const PLANS_KEY = 'webplanner_plans';
const readPlans = () => { try { return JSON.parse(localStorage.getItem(PLANS_KEY)) || {}; } catch { return {}; } };
function refreshPlanList() { const sel = $('planList'); const p = readPlans(); const n = Object.keys(p).sort(); sel.innerHTML = n.length ? n.map((x) => `<option>${x}</option>`).join('') : '<option value="">(keine)</option>'; }
function savePlan() { const name = ($('planName').value || '').trim(); if (!name) return; const p = readPlans(); p[name] = encodeState(); localStorage.setItem(PLANS_KEY, JSON.stringify(p)); refreshPlanList(); $('planList').value = name; }
function loadSelectedPlan() { const n = $('planList').value, p = readPlans(); if (p[n]) { applyDecoded(decodeState(p[n])); renderPicker(); renderSelectedGas(); recompute(); } }
function deleteSelectedPlan() { const n = $('planList').value, p = readPlans(); delete p[n]; localStorage.setItem(PLANS_KEY, JSON.stringify(p)); refreshPlanList(); }

// --- export PNG / print -----------------------------------------------------
function exportPng() {
	const src = editor.canvas, scale = 2, W = editor.W * scale, profH = editor.H * scale;
	const lines = [$('summary').innerText, 'Stopps: ' + ($('stops').innerText.replace(/\s+/g, ' ').replace('Tiefe Stopp', '').trim() || 'keine'), 'Warnungen: ' + $('warnings').innerText.replace(/\s+/g, ' ').trim()];
	const lineH = 22 * scale, headH = 30 * scale, out = document.createElement('canvas');
	out.width = W; out.height = profH + headH + lines.length * lineH + 16 * scale;
	const ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
	ctx.fillStyle = '#1d2b33'; ctx.font = `bold ${16 * scale}px system-ui`; ctx.fillText('Tauchplan', 12 * scale, 22 * scale);
	ctx.drawImage(src, 0, headH, W, profH);
	ctx.font = `${13 * scale}px system-ui`; ctx.fillStyle = '#33424d';
	lines.forEach((l, i) => ctx.fillText(l, 12 * scale, profH + headH + (i + 1) * lineH));
	const a = document.createElement('a'); a.href = out.toDataURL('image/png'); a.download = 'tauchplan.png'; a.click();
}

// --- settings binding (Ausrüstung) ------------------------------------------
function syncSettingsInputs() {
	const s = S();
	$('algo').value = String(s.deco_mode); document.body.classList.toggle('is-vpmb', s.deco_mode === 2);
	$('gflow').value = s.gflow; $('gfhigh').value = s.gfhigh; $('vpmb').value = s.vpmb_conservatism;
	$('spLow').value = (s.sp_low_mbar / 1000).toFixed(1); $('spHigh').value = (s.sp_high_mbar / 1000).toFixed(1);
	$('spSwitch').value = (s.sp_switch_depth_mm / 1000).toFixed(0); $('spDeco').value = (s.sp_deco_mbar / 1000).toFixed(1); $('spDecoDepth').value = (s.sp_deco_depth_mm / 1000).toFixed(0);
	$('descrate').value = Math.round(s.descrate_mmps * 60 / 1000); $('ascrate').value = Math.round(s.ascrate_mmps * 60 / 1000); $('ascrate6m').value = Math.round(s.ascratelast6m_mmps * 60 / 1000);
	$('laststop').checked = s.last_stop_6m === 1; $('safetystop').checked = s.safetystop === 1; $('dropstone').checked = s.drop_stone === 1;
	$('switchreq').checked = s.switch_at_req_stop === 1; $('minswitch').value = s.min_switch_duration_s; $('o2breaks').checked = s.doo2breaks === 1;
	$('bottomsac').value = (s.bottomsac_mlpm / 1000).toFixed(1); $('decosac').value = (s.decosac_mlpm / 1000).toFixed(1);
	$('surface').value = s.surface_pressure_mbar; $('salinity').value = s.salinity; $('endlimit').value = s.end_limit_m;
	$('probtime').value = s.problemsolvingtime_min; $('reservegas').value = Math.round(s.reserve_gas_mbar / 1000);
	$('mode').value = state.dive_mode === 1 ? 'ccr' : 'oc'; $('bailout').checked = state.dobailout === 1;
	document.body.classList.toggle('is-ccr', state.dive_mode === 1);
}
function bindSettings() {
	const set = (id, fn) => $(id).addEventListener('change', () => { fn($(id)); saveGear(); recompute(); });
	const num = (id, key, scale) => set(id, (e) => { S()[key] = Math.round((parseFloat(e.value) || 0) * (scale || 1)); });
	num('gflow', 'gflow'); num('gfhigh', 'gfhigh'); num('vpmb', 'vpmb_conservatism');
	num('bottomsac', 'bottomsac_mlpm', 1000); num('decosac', 'decosac_mlpm', 1000);
	num('surface', 'surface_pressure_mbar'); num('salinity', 'salinity'); num('endlimit', 'end_limit_m');
	num('probtime', 'problemsolvingtime_min'); num('reservegas', 'reserve_gas_mbar', 1000);
	num('spLow', 'sp_low_mbar', 1000); num('spHigh', 'sp_high_mbar', 1000); num('spDeco', 'sp_deco_mbar', 1000);
	num('spSwitch', 'sp_switch_depth_mm', 1000); num('spDecoDepth', 'sp_deco_depth_mm', 1000);
	num('minswitch', 'min_switch_duration_s');
	const mpm = (id, key) => set(id, (e) => { S()[key] = Math.round((parseFloat(e.value) || 0) * 1000 / 60); });
	mpm('descrate', 'descrate_mmps'); mpm('ascrate', 'ascrate_mmps'); mpm('ascrate6m', 'ascratelast6m_mmps');
	const chk = (id, key) => set(id, (e) => { S()[key] = e.checked ? 1 : 0; });
	chk('laststop', 'last_stop_6m'); chk('safetystop', 'safetystop'); chk('dropstone', 'drop_stone'); chk('switchreq', 'switch_at_req_stop'); chk('o2breaks', 'doo2breaks');
	$('algo').addEventListener('change', () => { S().deco_mode = parseInt($('algo').value, 10) || 0; document.body.classList.toggle('is-vpmb', S().deco_mode === 2); saveGear(); recompute(); });
	$('mode').addEventListener('change', () => setMode($('mode').value === 'ccr' ? 1 : 0));
	$('bailout').addEventListener('change', () => { state.dobailout = $('bailout').checked ? 1 : 0; recompute(); });
}

// --- tabs -------------------------------------------------------------------
function showTab(t) {
	document.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x.dataset.tab === t));
	document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + t));
	if (t === 'plan') editor.resize();
}
function bindTabs() { document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab))); }

// Set OC/CCR mode everywhere (Planung + Assistent in sync).
function setMode(m) {
	state.dive_mode = m;
	document.body.classList.toggle('is-ccr', m === 1);
	if ($('mode')) $('mode').value = m === 1 ? 'ccr' : 'oc';
	if ($('wizMode')) $('wizMode').value = m === 1 ? 'ccr' : 'oc';
	rebuildCylinders(); renderSelectedGas(); recompute();
}

// --- wizard -----------------------------------------------------------------
let wizApplyProfile = null; // {depthMm, timeS}
function wizShowStep(s) {
	document.querySelectorAll('#view-wizard .wiz-step').forEach((el) => el.classList.toggle('active', el.dataset.step === s));
	document.querySelectorAll('.wiz-nav li').forEach((li) => li.classList.toggle('active', li.dataset.s === s));
}
function wizWaypoints(depthM, timeMin) {
	const descS = Math.max(1, Math.round(depthM * 1000 / S().descrate_mmps));
	return [{ time: descS, depth: depthM * 1000, cyl: 0 }, { time: descS + Math.max(0, timeMin) * 60, depth: depthM * 1000, cyl: 0 }];
}
function bindWizard() {
	document.querySelectorAll('.wiz-go').forEach((b) => b.addEventListener('click', () => wizShowStep(b.dataset.to)));
	$('wizMode').addEventListener('change', () => setMode($('wizMode').value === 'ccr' ? 1 : 0));
	$('wizMaxTime').addEventListener('click', () => {
		const d = parseFloat($('wizDepth').value) || 0;
		const r = maxBottomTime(d);
		if (!r) { $('wizResult').textContent = 'Tiefe eingeben.'; return; }
		if (r.fail0) { $('wizResult').innerHTML = `<span class="o2-err">Schon 0 min nicht möglich</span>.`; wizApplyProfile = null; return; }
		const t = r.capped ? MAXT_MIN : r.t;
		wizApplyProfile = { depthM: d, timeMin: t };
		$('wizResult').innerHTML = r.capped
			? `> ${MAXT_MIN} min auf ${d} m <span class="muted">(kein Limit im Bereich)</span>`
			: `Du kannst <b>${r.t} min</b> auf ${d} m bleiben — limitiert durch <b>${r.reason}</b>.`;
	});
	$('wizNeed').addEventListener('click', () => {
		const d = parseFloat($('wizDepth').value) || 0;
		const t = parseFloat($('wizTime').value) || 0;
		if (!d) { $('wizResult').textContent = 'Tiefe eingeben.'; return; }
		wizApplyProfile = { depthM: d, timeMin: t };
		renderSuggestion(wizWaypoints(d, t), 'wizResult');
	});
	$('wizApply').addEventListener('click', () => {
		if (!wizApplyProfile) { $('wizResult').textContent = 'Erst berechnen.'; return; }
		editor.setWaypoints(wizWaypoints(wizApplyProfile.depthM, wizApplyProfile.timeMin), false);
		showTab('plan'); renderSelectedGas(); recompute();
	});
}

// --- debounced recompute ----------------------------------------------------
let timer = null;
function recompute() { clearTimeout(timer); timer = setTimeout(() => calculate(editor.getWaypoints()), 120); }

// --- boot -------------------------------------------------------------------
const editor = new ProfileEditor($('profile'), () => recompute());
editor.onSelect = (sel) => renderSelected(sel);

bindTabs();
bindSettings();
bindWizard();
$('snap').addEventListener('change', () => editor.setSnap($('snap').checked));
$('selGas').addEventListener('change', () => editor.setSelectedGas(parseInt($('selGas').value, 10)));
$('delPoint').addEventListener('click', () => editor.deleteSelected());
$('share').addEventListener('click', share);
$('export').addEventListener('click', exportPng);
$('print').addEventListener('click', () => window.print());
$('savePlan').addEventListener('click', savePlan);
$('loadPlan').addEventListener('click', loadSelectedPlan);
$('delPlan').addEventListener('click', deleteSelectedPlan);
$('invAdd').addEventListener('click', () => { state.inventory.push({ label: '', size_ml: 11100, wp_mbar: 232000, o2_permille: 320, he_permille: 0, roles: ['deco'], count: 1 }); saveGear(); renderInventory(); renderPicker(); });
$('suggestplan').addEventListener('click', suggestPlanGases);
$('bestdeco').addEventListener('click', suggestDecoGases);
$('bestmix').addEventListener('click', suggestBestMix);
$('calcvar').addEventListener('click', computeVariations);
$('calcmax').addEventListener('click', showMaxBottomTime);

const fromHash = location.hash.length > 1 ? applyDecoded(decodeState(location.hash.slice(1))) : false;
if (!fromHash) rebuildCylinders();
syncSettingsInputs();
renderInventory();
renderPicker();
renderSelectedGas();
refreshPlanList();
calculate(editor.getWaypoints());
