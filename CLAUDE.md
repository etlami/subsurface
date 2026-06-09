# Claude Guidelines for this Subsurface fork

This is a personal fork (etlami/subsurface). The rules here are deliberately
light-weight; this is not the upstream contribution workflow.

For project structure and build instructions, see `.github/copilot-instructions.md`.
For coding style and naming conventions, see `CODINGSTYLE.md`.

## Working rules

- Direct work is fine: commit, branch, merge and push directly. No pull-request
  requirement, and working on `master` is allowed when it makes sense.
- AI-generated code does NOT need to be marked. (Existing `// AI-generated
  (Claude)` comments may stay or be removed; no need to add new ones.)
- Keep changes focused and explain non-obvious decisions in commit messages.

## Web dive planner (webplanner/)

A browser dive planner that runs the real Subsurface decompression core
(`core/planner.cpp`, `deco.cpp`, ...) compiled to WebAssembly. See
`webplanner/README.md`. Build with `bash webplanner/wasm/build.sh`, serve
`webplanner/public/` with any static server.
