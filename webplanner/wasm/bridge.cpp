// AI-generated (Claude)
//
// WebAssembly bridge for the Subsurface dive planner core.
//
// This exposes the pure-C++ decompression planner (core/planner.cpp,
// core/deco.cpp, core/gas-model.cpp) to JavaScript via Emscripten/embind.
// The construction of the dive + diveplan and the call into plan() mirror
// the headless setup used by tests/testplan.cpp, which is the canonical
// example of driving the planner without any Qt/UI dependency.

#include <emscripten/bind.h>
#include <cmath>
#include <string>
#include <tuple>
#include <vector>

#include "core/deco.h"
#include "core/dive.h"
#include "core/divecomputer.h"
#include "core/divelist.h" // for init_decompression()
#include "core/event.h"
#include "core/planner.h"
#include "core/pref.h"
#include "core/gas.h"
#include "core/sample.h"
#include "core/range.h"
#include "core/interpolate.h"
#include "core/units.h"

using namespace emscripten;

// ---- O2 exposure (CNS% / OTU) ----------------------------------------------
// Ported verbatim from core/divelist.cpp (calculate_otu / calculate_cns_dive),
// which is file-static and lives in a translation unit we don't compile (it
// pulls libxslt via qthelper.h). The helpers it calls (get_dive_status_at,
// get_gasmix_at_time, pscr_o2, depth_to_*) are all linked from the core units
// we DO build, so the formulas run unchanged here.

static int ss_active_o2(const struct dive &dive, const struct divecomputer *dc, duration_t time)
{
	struct gasmix gas = dive.get_gasmix_at_time(*dc, time);
	return get_o2(gas);
}

static int ss_calculate_otu(const struct dive &dive)
{
	double otu = 0.0;
	const struct divecomputer &dc = dive.dcs[0];
	gasmix_loop loop_gas(dive, dc);
	divemode_loop loop_mode(dc);
	for (auto [psample, sample] : pairwise_range(dc.samples)) {
		int po2i, po2f;
		double pm;
		int t = (sample.time - psample.time).seconds;
		depth_t depth = sample.depth;
		depth_t pdepth = psample.depth;
		if ((dc.divemode == CCR || dc.divemode == PSCR) && psample.o2sensor[0].mbar) {
			po2i = psample.o2sensor[0].mbar;
			po2f = sample.o2sensor[0].mbar ? sample.o2sensor[0].mbar : po2i;
		} else {
			[[maybe_unused]] auto [divemode, _ci, _gas] = get_dive_status_at(dive, dc, psample.time.seconds, &loop_mode, &loop_gas);
			if (divemode == CCR) {
				po2i = std::min((int) psample.setpoint.mbar, dive.depth_to_mbar(pdepth));
				po2f = std::min((int) psample.setpoint.mbar, dive.depth_to_mbar(depth));
			} else {
				double amb = dive.depth_to_bar(depth);
				double pamb = dive.depth_to_bar(pdepth);
				if (dc.divemode == PSCR) {
					po2i = pscr_o2(pamb, dive.get_gasmix_at_time(dc, psample.time));
					po2f = pscr_o2(amb, dive.get_gasmix_at_time(dc, sample.time));
				} else {
					int o2 = ss_active_o2(dive, &dc, psample.time);
					po2i = lrint(o2 * pamb);
					po2f = lrint(o2 * amb);
				}
			}
		}
		if ((po2i > 500) || (po2f > 500)) {
			if (po2i <= 500) {
				t = t * (po2f - 500) / (po2f - po2i);
				po2i = 501;
			} else if (po2f <= 500) {
				t = t * (po2i - 500) / (po2i - po2f);
				po2f = 501;
			}
			pm = (po2f + po2i) / 1000.0 - 1.0;
			otu += t / 60.0 * pow(pm, 5.0 / 6.0) * (1.0 - 5.0 * (po2f - po2i) * (po2f - po2i) / 216000000.0 / (pm * pm));
		}
	}
	return lrint(otu);
}

static double ss_calculate_cns_dive(const struct dive &dive)
{
	const struct divecomputer dc = dive.dcs[0];
	double cns = 0.0;
	gasmix_loop loop_gas(dive, dc);
	divemode_loop loop_mode(dc);
	for (auto [psample, sample] : pairwise_range(dc.samples)) {
		int t = (sample.time - psample.time).seconds;
		int po2i, po2f, po2;
		depth_t depth = sample.depth;
		depth_t pdepth = psample.depth;
		[[maybe_unused]] auto [divemode, _ci, _gas] = get_dive_status_at(dive, dc, psample.time.seconds, &loop_mode, &loop_gas);
		if ((dc.divemode == CCR || dc.divemode == PSCR) && psample.o2sensor[0].mbar) {
			po2i = psample.o2sensor[0].mbar;
			po2f = sample.o2sensor[0].mbar ? sample.o2sensor[0].mbar : po2i;
			po2 = (po2f + po2i) / 2;
		} else if (divemode == CCR) {
			po2 = std::min((int) psample.setpoint.mbar, dive.depth_to_mbar(pdepth));
		} else {
			double amb = dive.depth_to_bar(depth);
			double pamb = dive.depth_to_bar(pdepth);
			if (dc.divemode == PSCR) {
				po2i = pscr_o2(pamb, dive.get_gasmix_at_time(dc, psample.time));
				po2f = pscr_o2(amb, dive.get_gasmix_at_time(dc, sample.time));
			} else {
				int o2 = ss_active_o2(dive, &dc, psample.time);
				po2i = lrint(o2 * pamb);
				po2f = lrint(o2 * amb);
			}
			po2 = (po2i + po2f) / 2;
		}
		if (po2 <= 500)
			continue;
		double rate = po2 <= 1500 ? exp(-11.7853 + 0.00193873 * po2) : exp(-23.6349 + 0.00980829 * po2);
		cns += (double) t * rate * 100.0;
	}
	return cns;
}

// Peak "surface GF": for each sample, the gradient factor your tissues would be
// at if you surfaced from there. Subsurface shows this once a dive incurs deco.
// Re-walks the planned samples through a fresh Buehlmann deco state (the plan()
// state is consumed) and applies the surface-GF formula from
// core/profile.cpp::calculate_deco_information (the per-tissue max).
static double ss_max_surface_gf(const struct dive &dive, short gflow, short gfhigh,
				double surface_pressure_bar, bool in_planner)
{
	const struct divecomputer &dc = dive.dcs[0];
	if (dc.samples.size() < 2)
		return 0.0;
	struct deco_state ds = {};
	set_gf(gflow, gfhigh);
	clear_deco(&ds, surface_pressure_bar, in_planner);
	gasmix_loop loop_gas(dive, dc);
	divemode_loop loop_mode(dc);
	double maxgf = 0.0;
	for (auto [psample, sample] : pairwise_range(dc.samples)) {
		int t0 = psample.time.seconds, t1 = sample.time.seconds;
		if (t1 <= t0)
			continue;
		[[maybe_unused]] auto [dm, _ci, gas] = get_dive_status_at(dive, dc, t1, &loop_mode, &loop_gas);
		if (!gas)
			continue;
		int step = (t1 - t0 < 20) ? (t1 - t0) : 20;
		for (int j = t0 + step; j <= t1; j += step) {
			depth_t nd = interpolate(psample.depth, sample.depth, j - t0, t1 - t0);
			add_segment(&ds, dive.depth_to_bar(nd), *gas, step, sample.setpoint.mbar, dm, 0, in_planner);
			if ((t1 - j < step) && (j < t1))
				step = t1 - j;
		}
		double amb = dive.depth_to_bar(sample.depth);
		tissue_tolerance_calc(&ds, &dive, amb, in_planner);
		for (int k = 0; k < 16; k++) {
			double sm = ds.buehlmann_inertgas_a[k] + surface_pressure_bar / ds.buehlmann_inertgas_b[k];
			double sgf = 100.0 * (ds.tissue_inertgas_saturation[k] - surface_pressure_bar) / (sm - surface_pressure_bar);
			if (sgf > maxgf)
				maxgf = sgf;
		}
	}
	return maxgf;
}

// ---- Input value objects (plain data, populated from JS) -------------------

struct JsCylinder {
	int o2_permille = 210;     // O2 fraction in permille (210 = air)
	int he_permille = 0;       // He fraction in permille
	int size_ml = 12000;       // cylinder water volume in ml
	int workingpressure_mbar = 232000;
};

struct JsSegment {
	int time_incr_s = 0;       // duration increment to reach this waypoint (s)
	int depth_mm = 0;          // target depth (mm)
	int cylinderid = 0;        // index into cylinders
	int setpoint_mbar = 0;     // CCR setpoint (0 = open circuit)
	int divemode = 0;          // 0 = OC (enum divemode_t)
	bool entered = true;       // user-entered waypoint
};

struct JsParams {
	int surface_pressure_mbar = 1013;
	int salinity = 10300;
	int gflow = 30;
	int gfhigh = 75;
	int vpmb_conservatism = 3;
	int deco_mode = 0;         // 0 = BUEHLMANN, 1 = VPMB (enum deco_mode)
	int bottomsac_mlpm = 20000;
	int decosac_mlpm = 17000;
};

// ---- Output value objects (read back, returned to JS) ----------------------

struct JsSample {
	int time_s = 0;
	int depth_mm = 0;
	int ndl_s = 0;
	int tts_s = 0;
	int stopdepth_mm = 0;
	int stoptime_s = 0;
	int pressure_mbar = 0;     // primary cylinder pressure
	bool in_deco = false;
};

struct JsDecoStop {
	int depth_mm = 0;
	int time_s = 0;
};

struct JsGasUse {
	int cylinderid = 0;
	int gas_used_ml = 0;
	int deco_gas_used_ml = 0;
};

struct JsGasSwitch {
	int time_s = 0;
	int cylinderid = -1;
	int o2_permille = 0;
	int he_permille = 0;
};

struct JsResult {
	int error = 0;             // planner_error_t
	int cns = 0;               // CNS % at end of dive
	int otu = 0;               // OTU (pulmonary O2 toxicity units)
	int surface_gf = 0;        // peak surfacing gradient factor (%), Buehlmann only
	std::vector<JsSample> samples;
	std::vector<JsDecoStop> stops;
	std::vector<JsGasUse> gas;
	std::vector<JsGasSwitch> switches;
	std::string notes;
};

// ---- The actual planning call ---------------------------------------------

static JsResult run_plan(const JsParams &params,
			 const std::vector<JsCylinder> &cylinders,
			 const std::vector<JsSegment> &segments)
{
	JsResult result;

	// Start from compiled-in defaults, then apply the requested algorithm.
	prefs = default_prefs;
	prefs.planner_deco_mode = static_cast<enum deco_mode>(params.deco_mode);
	prefs.bottomsac = params.bottomsac_mlpm;
	prefs.decosac = params.decosac_mlpm;
	prefs.vpmb_conservatism = params.vpmb_conservatism;

	struct dive dive;
	struct deco_state ds = {};

	// Cylinders. Highest index first so reallocation does not invalidate
	// earlier pointers (see note in tests/testplan.cpp).
	for (int i = static_cast<int>(cylinders.size()) - 1; i >= 0; --i) {
		cylinder_t *cyl = dive.get_or_create_cylinder(i);
		const JsCylinder &c = cylinders[i];
		cyl->gasmix.o2.permille = c.o2_permille;
		cyl->gasmix.he.permille = c.he_permille;
		cyl->type.size.mliter = c.size_ml;
		cyl->type.workingpressure.mbar = c.workingpressure_mbar;
	}
	reset_cylinders(&dive, true);

	// Build the dive plan.
	struct diveplan diveplan;
	diveplan.salinity = params.salinity;
	diveplan.surface_pressure.mbar = params.surface_pressure_mbar;
	diveplan.gflow = params.gflow;
	diveplan.gfhigh = params.gfhigh;
	diveplan.vpmb_conservatism = params.vpmb_conservatism;
	diveplan.bottomsac = params.bottomsac_mlpm;
	diveplan.decosac = params.decosac_mlpm;

	for (const JsSegment &s : segments) {
		depth_t depth;
		depth.mm = s.depth_mm;
		plan_add_segment(diveplan, s.time_incr_s, depth, s.cylinderid,
				 s.setpoint_mbar,
				 s.entered,
				 static_cast<enum divemode_t>(s.divemode));
	}

	std::vector<decostop> stoptable;
	deco_state_cache cache;
	planner_error_t err = plan(&ds, diveplan, &dive, 0, 60, cache,
				   /*is_planner=*/true, /*show_disclaimer=*/false,
				   &stoptable);
	result.error = static_cast<int>(err);

	// Read back the computed profile from the first divecomputer.
	if (!dive.dcs.empty()) {
		const struct divecomputer &dc = dive.dcs[0];
		for (const struct sample &smp : dc.samples) {
			JsSample js;
			js.time_s = smp.time.seconds;
			js.depth_mm = smp.depth.mm;
			js.ndl_s = smp.ndl.seconds;
			js.tts_s = smp.tts.seconds;
			js.stopdepth_mm = smp.stopdepth.mm;
			js.stoptime_s = smp.stoptime.seconds;
			js.pressure_mbar = smp.pressure[0].mbar;
			js.in_deco = smp.in_deco;
			result.samples.push_back(js);
		}
		// Gas-change markers from the computed profile.
		for (const struct event &ev : dc.events) {
			if (!ev.is_gaschange())
				continue;
			JsGasSwitch g;
			g.time_s = ev.time.seconds;
			g.cylinderid = ev.gas.index;
			g.o2_permille = get_o2(ev.gas.mix);
			g.he_permille = get_he(ev.gas.mix);
			result.switches.push_back(g);
		}
	}

	for (const decostop &st : stoptable) {
		JsDecoStop js;
		js.depth_mm = st.depth;
		js.time_s = st.time;
		result.stops.push_back(js);
	}

	for (size_t i = 0; i < cylinders.size(); ++i) {
		const cylinder_t *cyl = dive.get_cylinder(static_cast<int>(i));
		if (!cyl)
			continue;
		JsGasUse g;
		g.cylinderid = static_cast<int>(i);
		g.gas_used_ml = cyl->gas_used.mliter;
		g.deco_gas_used_ml = cyl->deco_gas_used.mliter;
		result.gas.push_back(g);
	}

	// O2 exposure over the planned profile.
	if (!dive.dcs.empty() && dive.dcs[0].samples.size() > 1) {
		result.cns = static_cast<int>(lrint(ss_calculate_cns_dive(dive)));
		result.otu = ss_calculate_otu(dive);
		// Surface GF is a Buehlmann concept; only meaningful in that mode.
		if (prefs.planner_deco_mode == BUEHLMANN)
			result.surface_gf = static_cast<int>(lrint(ss_max_surface_gf(
				dive, diveplan.gflow, diveplan.gfhigh,
				params.surface_pressure_mbar / 1000.0, true)));
	}

	return result;
}

// ---- embind registration ---------------------------------------------------

EMSCRIPTEN_BINDINGS(subsurface_planner) {
	value_object<JsCylinder>("Cylinder")
		.field("o2_permille", &JsCylinder::o2_permille)
		.field("he_permille", &JsCylinder::he_permille)
		.field("size_ml", &JsCylinder::size_ml)
		.field("workingpressure_mbar", &JsCylinder::workingpressure_mbar);

	value_object<JsSegment>("Segment")
		.field("time_incr_s", &JsSegment::time_incr_s)
		.field("depth_mm", &JsSegment::depth_mm)
		.field("cylinderid", &JsSegment::cylinderid)
		.field("setpoint_mbar", &JsSegment::setpoint_mbar)
		.field("divemode", &JsSegment::divemode)
		.field("entered", &JsSegment::entered);

	value_object<JsParams>("Params")
		.field("surface_pressure_mbar", &JsParams::surface_pressure_mbar)
		.field("salinity", &JsParams::salinity)
		.field("gflow", &JsParams::gflow)
		.field("gfhigh", &JsParams::gfhigh)
		.field("vpmb_conservatism", &JsParams::vpmb_conservatism)
		.field("deco_mode", &JsParams::deco_mode)
		.field("bottomsac_mlpm", &JsParams::bottomsac_mlpm)
		.field("decosac_mlpm", &JsParams::decosac_mlpm);

	value_object<JsSample>("Sample")
		.field("time_s", &JsSample::time_s)
		.field("depth_mm", &JsSample::depth_mm)
		.field("ndl_s", &JsSample::ndl_s)
		.field("tts_s", &JsSample::tts_s)
		.field("stopdepth_mm", &JsSample::stopdepth_mm)
		.field("stoptime_s", &JsSample::stoptime_s)
		.field("pressure_mbar", &JsSample::pressure_mbar)
		.field("in_deco", &JsSample::in_deco);

	value_object<JsDecoStop>("DecoStop")
		.field("depth_mm", &JsDecoStop::depth_mm)
		.field("time_s", &JsDecoStop::time_s);

	value_object<JsGasUse>("GasUse")
		.field("cylinderid", &JsGasUse::cylinderid)
		.field("gas_used_ml", &JsGasUse::gas_used_ml)
		.field("deco_gas_used_ml", &JsGasUse::deco_gas_used_ml);

	value_object<JsGasSwitch>("GasSwitch")
		.field("time_s", &JsGasSwitch::time_s)
		.field("cylinderid", &JsGasSwitch::cylinderid)
		.field("o2_permille", &JsGasSwitch::o2_permille)
		.field("he_permille", &JsGasSwitch::he_permille);

	value_object<JsResult>("PlanResult")
		.field("error", &JsResult::error)
		.field("cns", &JsResult::cns)
		.field("otu", &JsResult::otu)
		.field("surface_gf", &JsResult::surface_gf)
		.field("switches", &JsResult::switches)
		.field("samples", &JsResult::samples)
		.field("stops", &JsResult::stops)
		.field("gas", &JsResult::gas)
		.field("notes", &JsResult::notes);

	register_vector<JsCylinder>("CylinderVector");
	register_vector<JsSegment>("SegmentVector");
	register_vector<JsSample>("SampleVector");
	register_vector<JsDecoStop>("DecoStopVector");
	register_vector<JsGasUse>("GasUseVector");
	register_vector<JsGasSwitch>("GasSwitchVector");

	function("runPlan", &run_plan);
}
