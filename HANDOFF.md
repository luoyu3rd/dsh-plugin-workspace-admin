# HANDOFF — dsh-plugin-workspace-admin

Context document for continuing this project in a fresh session. It records the
design decisions, the exact tool contracts, and the failures that cost real time
so they are not rediscovered.

**Origin session**: `session-57c55f1d-13d6-4e5d-80d0-5fef9cce8506`
(workspace `dshws`, `/Users/long/Temp/dshws`). The plugin was designed, built,
mounted, verified, published, and moved here in that one session. That session
cannot be moved into this workspace: session membership is decided by the
immutable `cwd` in the session header (see "Hard constraints" below).

## Status

| | |
| --- | --- |
| Location | `/Users/long/Projects/dsh-plugin-workspace-admin` |
| Version | `0.1.0` (tag `v0.1.0`) |
| Published | https://github.com/luoyu3rd/dsh-plugin-workspace-admin (public) |
| Head | `main`; last code change `387ce65` (tag `v0.1.0`) — run `git log --oneline -1` for the current tip |
| Tool count | 6 |
| Dependencies | none (no `dependencies`, no `peerDependencies`) |
| Build step | none |
| Registry | not published to npm |
| Mounted in | the `desktop` profile, installed from GitHub |
| Tests | `node test/harness.mjs` — all assertions pass |
| License | MIT — `LICENSE`, © 2026 luoyu3rd |
| Changelog | `CHANGELOG.md` (Keep a Changelog + SemVer) |

## What it is

Model-facing tools that let an agent read and mutate the DeepSeek Harness
workspace registry from inside a conversation. Originally scoped to three
operations (add / delete / rename); `workspace_list` and `workspace_resolve`
were added for usability and `workspace_sessions` to expose the sessions a
workspace owns.

The plugin **owns no state**. Every tool is a validated projection of
`ctx.workspaceRegistry` — the same durable service the sidebar, the Remote
`ctx.remote.workspace` namespace, and the REST controller use — so all surfaces
converge on one registry at `$DSH_HOME/storages/workspace.json`.

## Tool contracts

All six share this output envelope: `output.schema = {}` (the enforced JSON
Schema subset's annotation-only, unconstrained-JSON form) and a `render` that
pretty-prints `JSON.stringify(value, null, 2)`.

### `workspace_list`

| Arg | Type | Required | Default |
| --- | --- | --- | --- |
| `include_sessions` | boolean | no | `false` |

Returns `{ total, workspaces[] }`. Each workspace:
`{ id, title, path, sessionCount, createdAt, updatedAt, status }`, plus
`sessions[]` when `include_sessions: true`.

### `workspace_sessions`

| Arg | Type | Required | Default |
| --- | --- | --- | --- |
| `id` | string | one of id/path | — |
| `path` | string | one of id/path | — |
| `include_archived` | boolean | no | `false` |
| `limit` | number | no | unbounded |

Returns `{ workspace, total, archivedExcluded?, archivedCount, truncated,
sessions[] }`. Each session: `{ sessionId, archived, title, titleSource,
createdAt, cwd?, parentSession?, origin?, delegationDepth?, agentPreset? }`,
plus `unavailable` when the session's log cannot be read or
`metadataUnavailable` when only its header cannot be read.

### `workspace_resolve`

`{ path }` (required) → `{ path, workspace | null }`.

### `workspace_create`

| Arg | Type | Required | Default |
| --- | --- | --- | --- |
| `path` | string | yes | — |
| `title` | string | no | directory basename |
| `create_directory` | boolean | no | `true` |

→ `{ created: true, workspace }`, or `{ created: false, reason: 'already
registered', workspace }` for an existing entry.

### `workspace_rename`

`{ title }` (required), plus `id` or `path` → `{ renamed, identifiedBy,
previousTitle, workspace }`.

### `workspace_delete`

`id` or `path` → `{ deleted: true, identifiedBy, directoryKept: true, workspace }`.
Removes **only the registry record**; the directory and every session log stay.

Every tool validates its own arguments inside `execute` (there is no `defineTool`
layer doing it): non-empty strings, absolute paths via `node:path.isAbsolute`,
positive integers for `limit`, and an explicit "supply either id or path" error.

## Where the data comes from

A workspace record stores only session **ids**. Everything else is read from
other services:

| Field | Source |
| --- | --- |
| `title`, `titleSource` | `sessionQuery.readTitleSnapshots(ids)` — folds the log-backed title event for a batch in one observation |
| `createdAt`, `cwd`, `parentSession`, `origin`, `delegationDepth`, `agentPreset` | `sessionPersistence.stat(id)` header |
| `archived` | `workspaceRegistry.archivedSessionIds` (plain getter, not a method) |
| `sessionCount` | `workspace.sessionIds.length` |

Failures are **contained per session**: one unreadable log yields an
`unavailable` field on that entry instead of failing the listing.

## Design decisions

### Zero bare imports (the load-bearing choice)

Every tool is a raw `ToolDefinition` object rather than a `defineTool(...)` call.
The only imports are `node:fs/promises`, `node:path`, and one relative module.

This was originally chosen to mount from an absolute path without a profile
`node_modules`, but it turned out to be the single most valuable decision, and it
should be preserved:

- **No `dependencies`/`peerDependencies`** → the launcher's
  `evaluatePluginCompatibility` returns early (it only inspects
  `@deepseek-ai/dsh*` peer entries), so there is no version gate. The package
  installs on any runtime.
- **No build step** → with no `scripts.prepare`, pnpm has nothing to allowlist,
  so a `github:` install **succeeds on the first `add`** instead of failing with
  a build-permission error. This is the documented git-install pitfall the
  package sidesteps.
- **Sources are the artifact** → a pushed commit is immediately installable; the
  repository cannot drift from what users run.

The tradeoff: a future Harness release changing these service contracts fails at
**runtime**, not install time. **If you ever add a `defineTool` import or a
Schemastery `Config`, that is the moment to declare matching
`peerDependencies`.**

### No `Config` schema

A native Schemastery `Config` requires a bare import. The tools have no
deployment-varying settings, so the plugin exports none. Add one when a real
tunable appears.

### `limit` is applied after sorting

Ordering is by session creation time, not by the workspace's account order.
An earlier version sliced before sorting, so "the newest N" returned whichever N
sessions happened to sit first in the account. A test caught it; do not
reintroduce it.

### Missing metadata sorts last

`createdAt` is `null` for a session whose header cannot be read. String
comparison treats `''` as the maximum, so an earlier version floated unknown
sessions to the top. The comparator now places `null` last explicitly.

### The patch row names the package, not a path

`cordis.patch.yml` inserts `name: "dsh-plugin-workspace-admin"`. The Loader
resolves module names from the profile directory and its `node_modules`, which
is where pnpm hoists the package. An absolute path only works for a source
checkout and **must not** be committed as the bundle's row.

## Hard constraints discovered

These are Harness behavior, not plugin bugs. Re-deriving them is expensive.

### 1. A failed plugin entry cannot recover in a running process

A plugin whose import or `apply` throws becomes a terminal `failed` fiber. The
live profile-patch reconcile updates the row (its `moduleName` visibly changes)
but **does not re-initialize** the entry. Verified by control experiment:

| Experiment | Result |
| --- | --- |
| Add a probe row that throws in `apply` | appears as `failed` → the reconcile *does* add entries and import modules |
| Edit that probe's source to stop throwing, touch the patch | still `failed` |
| Point the row at a **brand-new URL** with correct code | still `failed` |

So "swap the module URL to bust the cache" does **not** work — the blocker is
loader semantics for terminal fibers, not Node's ESM cache. The only remedy is
restarting the process.

**Consequence**: if you mount a broken version by absolute path and then move or
delete that source directory, the plugin stays broken until the app restarts.

### 2. Session ↔ workspace membership is decided by an immutable header field

Membership is `realpath(header.cwd) === workspace.path`. The `cwd` is written
into the session header at creation (it is the first line of the session file)
and is immutable. Therefore:

- A session **cannot be moved** between workspaces by any API.
- Moving a workspace directory silently orphans every session it owns; they are
  filtered out with a `canonical cwd '…' differs from workspace path '…'`
  warning.

### 3. Profile patch layer wins over a bundle patch on a duplicate row id

Both this profile's `cordis.patch.yml` and the bundle's own patch inserted
`id: tool-workspace-admin`. The profile patch applies last, so its
absolute-path row **overrode** the bundle's package-name row — meaning an
apparently installed-from-GitHub plugin was silently still running local source.
If two mounts of one plugin ever coexist, check `moduleName` on the entry.

## Environment constraints

| Fact | Detail |
| --- | --- |
| Two DSH installations | Homebrew CLI `0.1.7-rc.2` (`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`) and the desktop app's bundled runtime `0.2.0-rc.2` (inside `app.asar`) |
| The desktop app's runtime source | `.dsh/node_modules/...` inside `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` — extract with `python3 <asar-reader> cat <path>` |
| `dsh-tools` parity | The `register()` and `assertSupportedJsonSchema()` implementations are **byte-identical** between 0.1.7-rc.2 and 0.2.0-rc.2, so a CLI boot is a valid smoke test for the app |
| The `desktop` profile is Electron-exclusive | `dsh plugin --profile desktop …` fails with "managed exclusively by the Electron application". Install/update through the app's plugin manager UI |
| Verifying a CLI boot | `dsh web --no-open --port 0`; an entry that fails to activate prints `warning: N entry did not activate`. Absence of that warning is the proof the row resolved and applied |
| `--dump-config` proves composition, not import | It shows the layer and the row but does not import the module |

## Verification recipes

```sh
# offline: tool logic against an in-memory registry
node test/harness.mjs

# packaging: confirm exactly which files ship
pnpm pack && tar -tzf dsh-plugin-workspace-admin-0.1.0.tgz

# real boot smoke test from a CLI profile (temporary, then revert)
dsh web --no-open --port 0     # expect no "did not activate" warning
```

The harness covers: registration shape, output envelope, argument validation,
idempotent create, recursive directory creation, rename by id and by path,
delete, re-add after delete, session listing, archived filtering, `limit`
truncation, and per-session degradation.

## Known limitations

- **Unreadable session logs.** A session whose log cannot be read still appears
  with `title: null`, `createdAt: null`, and an `unavailable` reason. A real
  example exists in this Harness home: a pre-v1 store holding only
  `{"type":"session","version":0,…}`, which the `v0-to-v1` migrator refuses
  because a permission/preset payload carries an unexpected `origin` member.
  The entry is reported rather than hidden because the workspace still accounts
  for it.
- **Session titles are not always meaningful.** `titleSource: "fallback"` means
  the first-prompt heuristic produced the title, which can be a truncated
  fragment of the opening message (e.g. `已完成定位。**没有改动任何`).
- **`include_sessions: true` can be large.** It inlines every session of every
  workspace; for a home with many workspaces prefer `workspace_sessions` on the
  one you need.

## Open items

- **The app's dependency is unpinned.** The desktop profile records
  `github:luoyu3rd/dsh-plugin-workspace-admin`, which tracks the default branch.
  Pin a commit or tag for reproducibility.
- **Not published to npm.** `npm publish` would make `dsh plugin add
  dsh-plugin-workspace-admin` work without a git host.

Resolved since the origin session: `LICENSE` (MIT) and `CHANGELOG.md` now exist,
and `package.json` carries `author`, `repository`, `homepage`, and `bugs`.

### A note on the Status table's `Head` row

It used to hold a bare short hash, which went stale the moment the next commit
landed — including the commit that added this very file. A commit cannot record
its own hash, so the row now names the last **code** change and defers the tip to
`git log`. Keep it that way; do not start chasing the current hash again.

## Working agreement for the next session

1. Read this file first; it is the canonical context.
2. `node test/harness.mjs` before and after any change to
   `src/workspace-tools.js`.
3. After changing plugin source, remember the running app will **not** pick it
   up (see constraint 1). The installed copy under
   `~/.dsh/profiles/desktop/node_modules/` is what runs — not this source tree.
4. Keep the zero-bare-import property unless there is a concrete reason to give
   it up, and read the tradeoff above before doing so.
5. Do not commit an absolute path into `cordis.patch.yml`.
6. On any release: bump `version` in `package.json`, add a `CHANGELOG.md` entry,
   then tag. The tag is what installs pin to.
