// AI-generated (Claude)
// Headless validation of the WASM planner against the Subsurface reference case
// from tests/testplan.cpp (TestPlan::testMetric): 79 m for 30 min on Tx 15/45,
// deco gases EAN36 and O2. Upstream expects gas switches at 33 m / 6 m and a
// total runtime of ~109 min (with the test's ascent rates). We use default
// prefs here, so we sanity-check that a real deco profile is produced:
// descent + bottom + staged ascent with deco stops and gas consumption.

import createPlannerModule from '../public/planner.js';

const Module = await createPlannerModule();

// droptime to 79 m at the metric descent rate used by the test (23 m/min).
const droptime = Math.round((79000 * 60) / 23000); // ~206 s

const params = {
	surface_pressure_mbar: 1013,
	salinity: 10300,
	gflow: 100, gfhigh: 100,          // match testMetric (gf 100/100)
	vpmb_conservatism: 3,
	deco_mode: 0,                     // BUEHLMANN
	bottomsac_mlpm: 20000,
	decosac_mlpm: 17000,
};

const cylinders = [
	{ o2_permille: 150, he_permille: 450, size_ml: 36000, workingpressure_mbar: 232000 }, // Tx 15/45
	{ o2_permille: 360, he_permille: 0,   size_ml: 24000, workingpressure_mbar: 232000 }, // EAN36
	{ o2_permille: 1000, he_permille: 0,  size_ml: 24000, workingpressure_mbar: 232000 }, // O2
];

// Mirror setupPlan(): two zero-time points registering the deco-gas switch
// depths, then descend to 79 m, then stay until 30 min total.
const segments = [
	{ time_incr_s: 0,                depth_mm: 33000, cylinderid: 1, setpoint_mbar: 0, divemode: 0, entered: true },
	{ time_incr_s: 0,                depth_mm: 6000,  cylinderid: 2, setpoint_mbar: 0, divemode: 0, entered: true },
	{ time_incr_s: droptime,         depth_mm: 79000, cylinderid: 0, setpoint_mbar: 0, divemode: 0, entered: true },
	{ time_incr_s: 30 * 60 - droptime, depth_mm: 79000, cylinderid: 0, setpoint_mbar: 0, divemode: 0, entered: true },
];

const toVec = (Vec, arr) => { const v = new Vec(); arr.forEach(x => v.push_back(x)); return v; };
const cylVec = toVec(Module.CylinderVector, cylinders);
const segVec = toVec(Module.SegmentVector, segments);

const res = Module.runPlan(params, cylVec, segVec);

const n = res.samples.size();
let maxDepth = 0, runtime = 0;
for (let i = 0; i < n; i++) {
	const s = res.samples.get(i);
	if (s.depth_mm > maxDepth) maxDepth = s.depth_mm;
	if (s.time_s > runtime) runtime = s.time_s;
}

const stops = [];
for (let i = 0; i < res.stops.size(); i++) {
	const st = res.stops.get(i);
	stops.push(`${(st.depth_mm / 1000).toFixed(0)}m/${Math.round(st.time_s / 60)}min`);
}

const gas = [];
for (let i = 0; i < res.gas.size(); i++) {
	const g = res.gas.get(i);
	gas.push(`cyl${g.cylinderid}: ${(g.gas_used_ml / 1000).toFixed(1)}L (deco ${(g.deco_gas_used_ml / 1000).toFixed(1)}L)`);
}

console.log('=== WASM planner result ===');
console.log('error code :', res.error);
console.log('samples    :', n);
console.log('max depth  :', (maxDepth / 1000).toFixed(1), 'm');
console.log('runtime    :', (runtime / 60).toFixed(1), 'min');
console.log('deco stops :', stops.length ? stops.join(', ') : '(none)');
console.log('gas used   :');
gas.forEach(g => console.log('   ', g));

// Sanity assertions.
const ok =
	res.error === 0 &&
	Math.abs(maxDepth - 79000) < 1000 &&
	runtime > 60 * 60 &&            // a 79m/30min Tx dive needs > 1h with deco
	stops.length > 0 &&
	res.gas.get(0).gas_used_ml > 0;
console.log('\nSANITY:', ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
