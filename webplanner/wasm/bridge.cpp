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
#include <string>
#include <vector>

#include "core/deco.h"
#include "core/dive.h"
#include "core/divelist.h" // for init_decompression()
#include "core/event.h"
#include "core/planner.h"
#include "core/pref.h"
#include "core/gas.h"
#include "core/sample.h"
#include "core/units.h"

using namespace emscripten;

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

struct JsResult {
	int error = 0;             // planner_error_t
	std::vector<JsSample> samples;
	std::vector<JsDecoStop> stops;
	std::vector<JsGasUse> gas;
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

	value_object<JsResult>("PlanResult")
		.field("error", &JsResult::error)
		.field("samples", &JsResult::samples)
		.field("stops", &JsResult::stops)
		.field("gas", &JsResult::gas)
		.field("notes", &JsResult::notes);

	register_vector<JsCylinder>("CylinderVector");
	register_vector<JsSegment>("SegmentVector");
	register_vector<JsSample>("SampleVector");
	register_vector<JsDecoStop>("DecoStopVector");
	register_vector<JsGasUse>("GasUseVector");

	function("runPlan", &run_plan);
}
