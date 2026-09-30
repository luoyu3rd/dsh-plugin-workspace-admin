# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.1] - 2026-09-30

Licensing, documentation, and language. The tool surface is unchanged: the six
tool names, their arguments, and the JSON result contract are identical to
0.1.0.

### Added

- **`LICENSE` — MIT.** `package.json` had declared `"license": "MIT"` since
  0.1.0 without the file ever shipping.
- **`CHANGELOG.md`** — this file.
- **A Simplified Chinese README**, now the default `README.md`. The English text
  moved to `README.en.md`, and both files carry a language switcher at the top.
- **npm metadata**: `author`, `repository`, `homepage`, and `bugs`.

### Changed

- **The plugin's model-facing text is now Simplified Chinese.** Every tool
  description, parameter description, thrown validation message, and
  `presentCall` label is Chinese. Tool names, JSON field names, and enum-like
  values (`reason: 'already registered'`, `identifiedBy: 'id'`, `kind: 'read'`)
  are deliberately left in English so callers can still match on them. The
  Harness-owned result values (`titleSource`, `origin`, `status`) are still
  whatever the Harness reports.

## [0.1.0] - 2026-09-30

Initial release. Six model-facing tools over the Harness workspace registry
(`ctx.workspaceRegistry`), with no runtime dependencies and no build step.

### Added

- `workspace_list` — every workspace in display order, with id, title, path,
  session count, and directory health. `include_sessions: true` inlines each
  workspace's sessions.
- `workspace_sessions` — one workspace's sessions, newest first, with the folded
  log-backed title, creation time, and lineage metadata (`cwd`, parent session,
  subagent depth, agent preset). Supports `include_archived` and `limit`.
- `workspace_resolve` — maps an absolute directory path to its workspace entry,
  or `null` when the directory is unregistered.
- `workspace_create` — the sidebar "Add workspace" operation, registering a
  directory by its canonical realpath and creating a missing directory
  recursively unless `create_directory: false`.
- `workspace_rename` — retitles one workspace entry without touching the
  directory on disk or its sessions.
- `workspace_delete` — removes the registry record only; the directory and every
  session log are kept, and `workspace_create` adds the entry back.
- Harness bundle packaging: `dsh.bundle.patch` plus `cordis.patch.yml`, so a
  single `dsh plugin add` both records the dependency and activates the layer.
- Offline test harness (`node test/harness.mjs`) covering registration shape,
  the output envelope, argument validation, and every tool's behaviour against an
  in-memory fake of the workspace registry.

### Changed

- Session listing is ordered by session creation time and `limit` is applied
  **after** that sort, so it returns the newest N rather than whichever N
  sessions happen to sit first in the workspace account.
- A session whose header cannot be read sorts **last**: unknown metadata never
  outranks a real timestamp.
- Session failures are contained per session — an unreadable log surfaces as
  `unavailable` / `metadataUnavailable` on that entry instead of failing the
  whole listing.

### Notes

- **No `dependencies` and no `peerDependencies`.** Every tool is a raw
  `ToolDefinition` object, so no bare specifier is ever resolved and the
  package installs on any runtime without a compatibility gate. Adding a
  `defineTool` import or a Schemastery `Config` means declaring the matching
  `@deepseek-ai/dsh*` `peerDependencies` at the same time; the tradeoff is that a
  Harness release changing these service contracts fails at runtime rather than
  at install time.
- **No build step.** The checked-in `.js` files are the published artifact, which
  is what lets a `github:` install succeed on the first `add` without a pnpm
  build allowance.

[Unreleased]: https://github.com/luoyu3rd/dsh-plugin-workspace-admin/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/luoyu3rd/dsh-plugin-workspace-admin/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/luoyu3rd/dsh-plugin-workspace-admin/releases/tag/v0.1.0
