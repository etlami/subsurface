// AI-generated (Claude)
// Cross-instance determinism probe: instantiate the WASM module several times
// from scratch and run the same 30 m / 18 min air+EAN50 plan, to tell a real
// global-init bug apart from a browser caching artifact.
import createPlannerModule from '../public/planner.js';

const params = { surface_pressure_mbar: 1013, salinity: 10300, gflow: 30, gfhigh: 75,
	vpmb_conservatism: 3, deco_mode: 0, bottomsac_mlpm: 20000, decosac_mlpm: 17000 };
const cylinders = [
	{ o2_permille: 210, he_permille: 0, size_ml: 24000, workingpressure_mbar: 232000 },
	{ o2_permille: 500, he_permille: 0, size_ml: 11100, workingpressure_mbar: 232000 },
];
const segments = [
	{ time_incr_s: 0,    depth_mm: 21000, cylinderid: 1, setpoint_mbar: 0, divemode: 0, entered: true },
	{ time_incr_s: 120,  depth_mm: 30000, cylinderid: 0, setpoint_mbar: 0, divemode: 0, entered: true },
	{ time_incr_s: 1080, depth_mm: 30000, cylinderid: 0, setpoint_mbar: 0, divemode: 0, entered: true },
];

async function once(label) {
	const M = await createPlannerModule();
	const toVec = (V, a) => { const v = new V(); a.forEach(x => v.push_back(x)); return v; };
	const res = M.runPlan(params, toVec(M.CylinderVector, cylinders), toVec(M.SegmentVector, segments));
	let rt = 0; const stops = [];
	for (let i = 0; i < res.samples.size(); i++) { const s = res.samples.get(i); if (s.time_s > rt) rt = s.time_s; }
	for (let i = 0; i < res.stops.size(); i++) { const st = res.stops.get(i); if (st.time_s > 0) stops.push(`${st.depth_mm/1000}m/${Math.round(st.time_s/60)}`); }
	console.log(`${label}: runtime ${Math.round(rt/60)} min, stops ${stops.join(',') || '(none)'}`);
}

for (let i = 1; i <= 4; i++) await once(`instance ${i}`);
