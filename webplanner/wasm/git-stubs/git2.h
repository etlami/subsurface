// AI-generated (Claude)
// Minimal <git2.h> stub for the WASM build. core/pref.cpp pulls in
// core/git-access.h (for git_prefs) which includes <git2.h>, but the planner
// path never calls libgit2. We only need the referenced types to exist as
// opaque forward declarations so the headers parse; any libgit2 function that
// ends up referenced is resolved by a link-time no-op in wasm_support.cpp.
#ifndef SUBSURFACE_WASM_GIT2_STUB
#define SUBSURFACE_WASM_GIT2_STUB

struct git_repository;
struct git_oid;
struct git_signature;
struct git_reference;
struct git_object;
struct git_tree;
struct git_commit;
struct git_index;
struct git_config;
struct git_remote;
struct git_blob;

#endif
