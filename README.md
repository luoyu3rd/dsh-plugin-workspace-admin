# dsh-plugin-workspace-admin

Model-facing **workspace administration** for DeepSeek Harness: lets an agent
read and change the Harness workspace list itself, from inside a conversation.

MVP scope is the sidebar's own workspace operations — **add**, **rename**,
**delete** — plus read-only helpers for browsing workspaces and the sessions
each one owns.

## Tools

| Tool | What it does |
| --- | --- |
| `workspace_list` | Lists every workspace with id, title, directory, session count, and directory health. `include_sessions: true` inlines each workspace's sessions. |
| `workspace_sessions` | Lists one workspace's sessions, newest first: id, folded log-backed title, creation time, and lineage (`cwd`, parent session, subagent depth, agent preset). Excludes archived sessions unless `include_archived: true`; `limit` caps the result. |
| `workspace_resolve` | Maps an absolute directory path to its workspace entry (`null` when unregistered). |
| `workspace_create` | Adds a directory to the workspace list (the “Add workspace” operation). Creates a missing directory first unless `create_directory: false`. |
| `workspace_rename` | Retitles one workspace entry. Only the display title changes. |
| `workspace_delete` | Removes one workspace entry (the sidebar delete operation). **The directory and every session log are kept** and the entry can be added back. |

Identify a workspace by `id` (from `workspace_list`) or, when unambiguous, by
absolute `path`.

## Where session data comes from

A workspace record stores only session **ids**. Titles and metadata come from
other Harness services, which the plugin reads instead of re-parsing logs:

- `sessionQuery.readTitleSnapshots(ids)` folds the log-backed title event for a
  batch of sessions in one observation; a never-titled session reports
  `title: null`.
- `sessionPersistence.stat(id)` supplies the header: creation time, `cwd`,
  `parentSession`, `origin`/`delegationDepth`, and `agentPreset`.
- `workspaceRegistry.archivedSessionIds` is the registry-global archive set.

Failures are contained **per session**: an unreadable log surfaces as
`unavailable` / `metadataUnavailable` on that one entry rather than failing the
whole listing. Ordering is by session creation time, and `limit` is applied
*after* that sort so it really returns the newest N.

## How it works

The plugin owns no state. `workspaceRegistry` is the same durable service the
sidebar, the `ctx.remote.workspace` Remote namespace, and the REST controller
use, so all surfaces converge on one registry at
`$DSH_HOME/storages/workspace.json`.

```
index.js                  plugin entry: name / inject / apply
src/workspace-tools.js    the six raw ToolDefinition objects
test/harness.mjs          offline assertions over a fake registry
cordis.patch.yml          the bundle layer that mounts the row
```

Two deliberate design choices:

- **Zero bare imports.** Every tool is a raw `ToolDefinition` rather than a
  `defineTool` call, so the plugin imports nothing but `node:` builtins and one
  relative module. That keeps it installable without DSH peer dependencies, and
  it also loads from any absolute path without a profile `node_modules` — which
  is what makes the local-development mount possible.
- **No `Config` schema.** A native Schemastery schema would require a bare
  import; the tools take no deployment-varying settings, so the plugin exports
  none. Add one when a real tunable appears.

## Known limitations

- **Unreadable session logs.** A session whose log cannot be read still appears,
  with `title: null` and `createdAt: null`, plus an `unavailable` field carrying
  the reason. A real example already present in this Harness home is a
  pre-v1 store: a file holding only `{"type":"session","version":0,...}`, which
  the `v0-to-v1` migrator refuses, so no title or header can be folded for it.
  The entry is reported rather than hidden, because a workspace still accounts
  for it and the user may want to act on it.
- **Session titles are not always meaningful.** `titleSource: "fallback"` means
  the first-prompt heuristic produced the title, which can be a truncated
  fragment of the opening message rather than a summary.

## Install

### As a bundle (the distributable form)

This package is a **dsh bundle**: `package.json` declares
`dsh.bundle.patch`, and [`cordis.patch.yml`](cordis.patch.yml) inserts the row
that mounts the plugin. Installing it therefore both adds the dependency and
activates the layer:

```sh
# from a registry
dsh plugin --profile web add dsh-plugin-workspace-admin

# from a checkout, tarball, or git host
dsh plugin --profile web add ./dsh-plugin-workspace-admin
dsh plugin --profile web add ./dsh-plugin-workspace-admin-0.1.0.tgz
dsh plugin --profile web add github:you/dsh-plugin-workspace-admin
```

`dsh plugin` forwards to pnpm inside the profile, then appends the package to
`dsh.profile.bundles`. Verify without booting, then boot:

```sh
dsh --profile web --dump-config | grep -A2 dsh-plugin-workspace-admin
dsh --profile web
```

Remove it with `dsh plugin --profile web remove dsh-plugin-workspace-admin`.

The patch row names the package (`name: "dsh-plugin-workspace-admin"`) rather
than a file path. That is required for an installed bundle: the Loader resolves
module names from the profile directory and its `node_modules`, which is where
pnpm hoists the package.

### Local development (absolute path)

To iterate on the source in place, mount it by absolute path instead — the
Loader imports the file directly and no install is needed:

```yaml
- insert:
    - id: tool-workspace-admin
      name: "/absolute/path/to/dsh-plugin-workspace-admin/index.js"
```

The path must be **absolute**: a patch file contributes configuration but does
not change the profile directory the Loader resolves module names from.

## Publishing

```sh
pnpm pack          # → dsh-plugin-workspace-admin-0.1.0.tgz (5 files, ~8 KB)
npm publish        # or: npm publish --access public, for a scoped name
```

Two facts make this package unusually easy to publish:

- **No build step.** The sources are plain ESM JavaScript, not TypeScript, so
  `main: "index.js"` ships as-is. There is no `lib/` to build and no `prepare`
  script, which is exactly what makes git installs
  (`dsh plugin add github:you/...`) work without a pnpm build allowance.
- **No DSH imports.** The plugin imports only `node:` builtins and one relative
  module; every tool is a raw `ToolDefinition` instead of a `defineTool` call.
  So it declares no `dependencies` and no `peerDependencies` on
  `@deepseek-ai/dsh*`.

That last point is also why there is no compatibility gate. The launcher's
`evaluatePluginCompatibility` check only inspects `peerDependencies` entries for
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`; with none declared, the check returns
early and the bundle is accepted by any runtime. The tradeoff is that a future
Harness release changing these service contracts would fail at runtime rather
than at install time — so if you later add a `defineTool` import or a
Schemastery `Config`, declare the matching `peerDependencies` then.

## Editing the plugin

The Loader imports a plugin module once per process, keyed by URL, so **editing
these files does not take effect in a running profile** — not even by changing
the patch file, which only reconciles rows. Restart the profile (for the desktop
app: quit and reopen) after changing plugin source.

Patch-file edits, by contrast, are reconciled live.

## Test

```sh
node test/harness.mjs
```

Runs the real tool definitions against an in-memory fake of the workspace
registry: registration shape, output envelope, argument validation, idempotent
create, directory creation, rename, delete, and re-add after delete.
