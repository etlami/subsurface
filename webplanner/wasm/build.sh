#!/usr/bin/env bash
#
# Build the Subsurface dive-planner core to WebAssembly.

set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"

# Repo root = two levels up from this script (webplanner/wasm -> repo).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$REPO/webplanner/public"
OBJ="$REPO/webplanner/build"

echo "Repo:   $REPO"
echo "Output: $OUT"
mkdir -p "$OUT" "$OBJ"

if [ ! -f "$REPO/libdivecomputer/include/libdivecomputer/parser.h" ]; then
	echo "error: libdivecomputer headers missing. Run: git submodule update --init libdivecomputer" >&2
	exit 1
fi

# include paths (stub dirs FIRST so they shadow Qt / libgit2 / libdc)
INC=(
	-I "$REPO/webplanner/wasm/qt-stubs"
	-I "$REPO/webplanner/wasm/git-stubs"
	-I "$REPO/webplanner/wasm/libdc-stubs"
	-I "$REPO/core"
	-I "$REPO"
	-I "$REPO/libdivecomputer/include"
)

# Core sources needed by plan() (discovered via iterative linking). The data/
# storage-heavy units (divelist, divelog, plannernotes, format) are NOT built;
# the few symbols plan() needs from them are reimplemented in wasm_support.cpp,
# because those units pull libxslt + Qt (via qthelper.h) which we don't want in
# the WASM module.
CORE_SRCS=(
	core/deco.cpp core/planner.cpp core/gas-model.cpp core/gas.cpp
	core/dive.cpp core/divecomputer.cpp core/equipment.cpp core/event.cpp
	core/units.cpp core/sample.cpp core/divesite.cpp core/trip.cpp
	core/pref.cpp core/errorhelper.cpp
)
WASM_SRCS=(webplanner/wasm/bridge.cpp webplanner/wasm/wasm_support.cpp)

# -include numeric: dive.cpp uses std::accumulate but relies on a transitive
# include that is absent under emscripten's libc++.
# STRING_KEY_*: device-metadata import keys referenced by divecomputer.cpp but
# not defined in this source snapshot; only used on the import path, never on
# the planning path, so any stable value works.
CXXFLAGS=(
	-std=c++17 -O2 -include numeric
	-DSTRING_KEY_SERIAL_NUMBER='"Serial"'
	-DSTRING_KEY_FIRMWARE_VERSION='"FirmwareVersion"'
)
LDFLAGS=(
	--bind -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPlannerModule
	-sALLOW_MEMORY_GROWTH=1 -sENVIRONMENT=web,worker,node
)

cd "$REPO"
OBJS=(); fail=0
echo "== compiling =="
for src in "${CORE_SRCS[@]}" "${WASM_SRCS[@]}"; do
	name="$(basename "$src" .cpp)"
	if emcc "${CXXFLAGS[@]}" "${INC[@]}" -c "$REPO/$src" -o "$OBJ/$name.o" 2>"$OBJ/$name.err"; then
		echo "  OK   $src"; OBJS+=("$OBJ/$name.o")
	else
		echo "  FAIL $src"; grep -m5 'error:\|not found' "$OBJ/$name.err" | sed 's/^/       /'; fail=1
	fi
done
[ "$fail" -eq 0 ] || { echo "Compilation failed."; exit 1; }

echo "== linking =="
emcc "${CXXFLAGS[@]}" "${LDFLAGS[@]}" "${OBJS[@]}" -o "$OUT/planner.js"
echo "Wrote $OUT/planner.js + planner.wasm"
