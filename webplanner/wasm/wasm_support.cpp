// AI-generated (Claude)
//
// Link-time support shims for the WASM build of the Subsurface planner core.
//
// The real core sources we compile reference a handful of functions that live
// in subsystems we deliberately do NOT pull into the WASM module, because they
// drag in heavy host-only dependencies (libxslt + Qt via qthelper.h, the git
// storage layer, the translation catalogue, media/pictures). None of these are
// exercised on the dive-planning code path.
//
// Where a referenced symbol is genuinely needed on the planning path we provide
// a faithful minimal implementation (and say why it is equivalent). Where it is
// not, we provide a no-op. If a no-op here is ever actually CALLED at runtime it
// means the planner path changed and should show up as obviously wrong output
// during validation.

#include <cstdarg>
#include <cstdio>
#include <string>
#include <vector>

#include "core/deco.h"
#include "core/dive.h"
#include "core/divelist.h"
#include "core/divelog.h"
#include "core/planner.h"
#include "core/pref.h"
// Full definitions of the divelog member element types are needed so that the
// defaulted divelog ctor/dtor can instantiate the owning unique_ptr containers.
#include "core/trip.h"
#include "core/divesite.h"
#include "core/filterpreset.h"
#include "core/filterconstraint.h"
#include "core/eventtype.h"
#include "core/device.h"
#include "core/event.h"

// ---------------------------------------------------------------------------
// gettext: gettext.h declares (C++ linkage) const char *trGettext(const char*).
// translate() forwards to it. We keep the original (already-English) string.
// ---------------------------------------------------------------------------
const char *trGettext(const char *s)
{
	return s;
}

// ---------------------------------------------------------------------------
// format.h std::string helpers. Upstream lives in core/format.cpp which also
// defines QString variants and therefore needs a full QString; we only need the
// std::string printf wrappers, reimplemented here with vsnprintf.
// ---------------------------------------------------------------------------
std::string vformat_string_std(const char *fmt, va_list ap)
{
	va_list copy;
	va_copy(copy, ap);
	int needed = vsnprintf(nullptr, 0, fmt, copy);
	va_end(copy);
	if (needed < 0)
		return {};
	std::string out(static_cast<size_t>(needed), '\0');
	vsnprintf(out.data(), static_cast<size_t>(needed) + 1, fmt, ap);
	return out;
}

std::string format_string_std(const char *fmt, ...)
{
	va_list ap;
	va_start(ap, fmt);
	std::string out = vformat_string_std(fmt, ap);
	va_end(ap);
	return out;
}

std::string casprintf_loc(const char *fmt, ...)
{
	// No localisation in the WASM build: behave like format_string_std.
	va_list ap;
	va_start(ap, fmt);
	std::string out = vformat_string_std(fmt, ap);
	va_end(ap);
	return out;
}

// ---------------------------------------------------------------------------
// diveplan::add_plan_to_notes (upstream core/plannernotes.cpp) builds an HTML
// notes string for the dive. It is not needed to compute the profile; the
// bridge reads samples / decostops / gas usage directly. No-op for v1.
// ---------------------------------------------------------------------------
void diveplan::add_plan_to_notes(struct dive &, bool, planner_error_t)
{
}

// ---------------------------------------------------------------------------
// dive_table::init_decompression (upstream core/divelist.cpp, which pulls
// qthelper.h -> libxslt + Qt). The web planner's dive table only ever holds the
// single planned dive, so there are never PREVIOUS dives to off-gas from. That
// is exactly the upstream "!deco_init" branch: clear the deco state at the
// dive's surface pressure and run one tolerance calc (kept for its side
// effects, per the upstream comment). surface_time stays at the 48h default.
// ---------------------------------------------------------------------------
int dive_table::init_decompression(struct deco_state *ds, const struct dive *dive, bool in_planner) const
{
	const int surface_time = 48 * 60 * 60;
	if (!dive)
		return false;
	double surface_pressure = dive->get_surface_pressure().mbar / 1000.0;
	clear_deco(ds, surface_pressure, in_planner);
	// Upstream keeps this call "for side effects" even though the result is
	// unused; we replicate it to stay bit-faithful.
	tissue_tolerance_calc(ds, dive, surface_pressure, in_planner);
	return surface_time;
}

// ---------------------------------------------------------------------------
// The global dive log (upstream core/divelog.cpp). planner.cpp references it
// only as `divelog.dives.init_decompression(...)`. We provide an empty instance
// with trivial ctor/dtor so it links without the storage layer.
// ---------------------------------------------------------------------------
divelog::divelog() = default;
divelog::~divelog() = default;
struct divelog divelog;

// ---------------------------------------------------------------------------
// remember_event_type (upstream core/eventtype.cpp, QString-based) maintains a
// UI registry of seen event types. Irrelevant to planning. No-op.
// ---------------------------------------------------------------------------
void remember_event_type(const struct event *)
{
}

// ---------------------------------------------------------------------------
// filter_constraint dtor (upstream core/filterconstraint.cpp, pulls qthelper +
// Qt). Only referenced because the empty filter_presets table in our divelog
// instantiates the owning container's element destructor; no filter_constraint
// is ever constructed on the planning path, so the defaulted dtor is safe.
// ---------------------------------------------------------------------------
filter_constraint::~filter_constraint() = default;
