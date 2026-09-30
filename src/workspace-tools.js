/**
 * Workspace administration tools: let the model read and mutate the DeepSeek
 * Harness workspace registry itself (`ctx.workspaceRegistry`) from inside a
 * conversation.
 *
 * Deliberately dependency-free apart from Node builtins: every tool is a raw
 * `ToolDefinition` object, so the plugin needs no bare module resolution and can
 * be mounted straight from an absolute path in a profile patch layer.
 *
 * @module dsh-plugin-workspace-admin/workspace-tools
 */
import { mkdir, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/**
 * Model-facing result envelope shared by every tool in this plugin.
 *
 * The empty object is the enforced subset's annotation-only, unconstrained-JSON
 * form, which every Harness release accepts as a tool output schema.
 */
const OUTPUT = {
  schema: {},
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

/** Generic presentation for one workspace tool call. */
function present(title, kind, rawInput) {
  return { card: 'generic', title, kind, ...(rawInput === undefined ? {} : { rawInput }) }
}

/** Read a required non-empty string argument. */
function requireString(args, key) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`)
  }
  return value
}

/** Read an optional string argument, normalizing absent or blank values to undefined. */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string when supplied`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read a required absolute directory path argument. */
function requireAbsolutePath(args, key) {
  const value = requireString(args, key)
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path; received ${JSON.stringify(value)}`)
  }
  return value
}

/** Read an optional positive-integer argument, normalizing absent values to undefined. */
function optionalLimit(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer when supplied; received ${JSON.stringify(value)}`)
  }
  return value
}

/** Probe a host path; undefined when it does not exist or cannot be read. */
async function probe(path) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}

/**
 * Project one registry entity into a lossless, model-facing snapshot.
 * Session ids are reported by count: use `workspace_sessions` for the list.
 * @param workspace - registry entity.
 * @param status - directory health, or undefined when it was not probed.
 * @returns Plain JSON snapshot.
 */
function snapshot(workspace, status) {
  return {
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessionCount: workspace.sessionIds.length,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    ...(status === undefined ? {} : { status }),
  }
}

/**
 * Fold one session's title and header metadata into a model-facing entry.
 *
 * Titles come from `sessionQuery.readTitleSnapshots`, which folds the log-backed
 * title event; a session that was never titled reports `title: null`. Metadata
 * comes from `sessionPersistence.stat`, and every failure is contained per
 * session so one unreadable log cannot fail the whole listing.
 *
 * @param registry - workspace registry; only `archivedSessionIds` is read.
 * @param query - `sessionQuery` service.
 * @param persistence - `sessionPersistence` service.
 * @param sessionId - stored session id from a workspace account.
 * @param archived - whether the id is in the registry-global archive set.
 * @returns Plain JSON entry; never throws.
 */
async function sessionEntry(registry, query, persistence, sessionId, archived) {
  const base = { sessionId, archived }
  const [titleResult, statResult] = await Promise.all([
    query.readTitleSnapshots([sessionId]).then(
      (results) => results[0],
      (error) => ({ sessionId, status: 'rejected', reason: error }),
    ),
    persistence.stat(sessionId).then(
      (snapshot) => snapshot,
      (error) => error,
    ),
  ])

  if (titleResult?.status === 'rejected') {
    return { ...base, title: null, unavailable: String(titleResult.reason?.message ?? titleResult.reason) }
  }

  const header = statResult instanceof Error ? undefined : statResult?.header
  const title = titleResult?.status === 'fulfilled' ? titleResult.value.title : undefined

  return {
    ...base,
    title: title?.title ?? null,
    titleSource: title?.source?.kind ?? null,
    createdAt: header === undefined ? null : new Date(header.createdAt).toISOString(),
    ...(header?.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header?.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    ...(header?.origin === undefined ? {} : { origin: header.origin, delegationDepth: header.delegationDepth ?? 0 }),
    ...(header?.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
    ...(header === undefined && statResult instanceof Error
      ? { metadataUnavailable: String(statResult.message ?? statResult) }
      : {}),
  }
}

/**
 * List one workspace's sessions newest-first.
 *
 * Ordering is by session creation time, not by the registry's account order, so
 * `limit` must be applied AFTER the sort — otherwise "the newest N" would return
 * whichever N sessions happen to sit first in the workspace account.
 *
 * @param registry - workspace registry.
 * @param query - `sessionQuery` service.
 * @param persistence - `sessionPersistence` service.
 * @param workspace - registry entity to enumerate.
 * @param options - `includeArchived` and `limit`.
 * @returns Plain JSON result with the ordered session entries.
 */
async function workspaceSessions(registry, query, persistence, workspace, options) {
  const archived = new Set(registry.archivedSessionIds ?? [])
  const all = workspace.sessionIds.map((sessionId) => ({ sessionId, archived: archived.has(sessionId) }))
  const selected = options.includeArchived === true ? all : all.filter((entry) => !entry.archived)

  const sessions = await Promise.all(
    selected.map((entry) => sessionEntry(registry, query, persistence, entry.sessionId, entry.archived)),
  )
  // Newest first. A session whose header could not be read has no timestamp and
  // sorts last rather than first, so unknown metadata never outranks real dates.
  sessions.sort((left, right) => {
    if (left.createdAt === null) return right.createdAt === null ? 0 : 1
    if (right.createdAt === null) return -1
    return right.createdAt.localeCompare(left.createdAt)
  })
  const limited = options.limit === undefined ? sessions : sessions.slice(0, options.limit)

  return {
    workspace: snapshot(workspace),
    total: limited.length,
    ...(options.includeArchived === true ? {} : { archivedExcluded: all.length - selected.length }),
    archivedCount: all.filter((entry) => entry.archived).length,
    truncated: limited.length < sessions.length,
    sessions: limited,
  }
}

/** Look up one workspace id, failing with the known ids appended. */
function requireWorkspace(registry, id) {
  const workspace = registry.get(id)
  if (workspace === undefined) {
    const known = registry.list().map((entry) => `${entry.id} (${entry.title})`)
    throw new Error(`unknown workspace id ${JSON.stringify(id)}; known workspaces: ${known.join(', ') || '(none)'}`)
  }
  return workspace
}

/** Resolve one workspace by canonical directory path. */
async function requireWorkspaceAtPath(registry, path) {
  if (path === undefined) throw new Error('path must be a non-empty string')
  if (!isAbsolute(path)) throw new Error(`path must be an absolute path; received ${JSON.stringify(path)}`)
  const workspace = await registry.resolveByPath(path)
  if (workspace === undefined) {
    throw new Error(`no workspace is registered for ${path}; add it with workspace_create`)
  }
  return workspace
}

/** Resolve the workspace named by the `id`/`path` argument pair. */
async function resolveTarget(registry, args) {
  const id = optionalString(args, 'id')
  const path = optionalString(args, 'path')
  if (id !== undefined) return { workspace: requireWorkspace(registry, id), by: 'id' }
  if (path !== undefined) return { workspace: await requireWorkspaceAtPath(registry, path), by: 'path' }
  throw new Error('supply either id (from workspace_list) or path to identify the workspace')
}

/**
 * Build every workspace tool definition.
 * @param ctx - plugin context; `ctx.workspaceRegistry` is required.
 * @returns Tool definitions ready for `ctx.tools.register()`.
 */
export function workspaceTools(ctx) {
  const registry = ctx.workspaceRegistry
  const query = ctx.sessionQuery
  const persistence = ctx.sessionPersistence

  return [
    {
      name: 'workspace_list',
      description:
        'List every DeepSeek Harness workspace (the entries in the sidebar workspace list) in display order, with its id, title, directory, and session count. Call it first to obtain the exact workspace id for workspace_sessions, workspace_rename, or workspace_delete. Pass include_sessions: true to inline each workspace\'s sessions (id, title, created time); for many workspaces prefer workspace_sessions on the one you need.',
      parameters: {
        type: 'object',
        properties: {
          include_sessions: {
            type: 'boolean',
            description: 'Inline each workspace\'s session list. Defaults to false (counts only).',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('List workspaces', 'read', args?.include_sessions === true ? 'with sessions' : undefined),
      async execute(args) {
        const entries = await Promise.all(
          registry.list().map(async (workspace) => snapshot(workspace, await workspace.status())),
        )
        if (args?.include_sessions !== true) return { total: entries.length, workspaces: entries }

        const workspaces = await Promise.all(
          registry.list().map(async (workspace) => {
            const listed = await workspaceSessions(registry, query, persistence, workspace, {})
            return { ...snapshot(workspace, await workspace.status()), sessions: listed.sessions }
          }),
        )
        return { total: workspaces.length, workspaces }
      },
    },
    {
      name: 'workspace_sessions',
      description:
        'List the sessions owned by one DeepSeek Harness workspace, newest first, with each session\'s id, folded log-backed title, creation time, and lineage metadata. Identify the workspace by id (from workspace_list) or by absolute path. Archived sessions are excluded unless include_archived is true.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workspace id from workspace_list.' },
          path: { type: 'string', description: 'Absolute workspace directory; used when id is omitted.' },
          include_archived: {
            type: 'boolean',
            description: 'Include sessions that are archived. Defaults to false.',
          },
          limit: {
            type: 'number',
            description: 'Return at most this many sessions (newest first).',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('List workspace sessions', 'read', args?.path ?? args?.id),
      async execute(args) {
        const { workspace } = await resolveTarget(registry, args)
        const limit = optionalLimit(args, 'limit')
        return workspaceSessions(registry, query, persistence, workspace, {
          includeArchived: args?.include_archived === true,
          ...(limit === undefined ? {} : { limit }),
        })
      },
    },
    {
      name: 'workspace_resolve',
      description:
        'Resolve an absolute directory path to the workspace entry that owns it, without creating or changing anything. Returns workspace: null when the directory is not registered. Use it to decide whether workspace_create would add a new entry.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Absolute path of an existing directory.' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('Resolve workspace by path', 'read', args?.path),
      async execute(args) {
        const path = requireAbsolutePath(args, 'path')
        const workspace = await registry.resolveByPath(path)
        return {
          path,
          workspace: workspace === undefined ? null : snapshot(workspace, await workspace.status()),
        }
      },
    },
    {
      name: 'workspace_create',
      description:
        'Add a directory to the DeepSeek Harness workspace list — the same operation as the sidebar "Add workspace" button. The directory is registered by its canonical realpath. Registering a path that is already a workspace is a no-op that returns the existing entry unchanged; use workspace_rename to retitle it. A missing directory is created recursively first unless create_directory is false.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the directory to register.' },
          title: { type: 'string', description: 'Display title, used only when a new entry is created.' },
          create_directory: {
            type: 'boolean',
            description: 'Create the directory recursively when it does not exist. Defaults to true.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('Add workspace', 'execute', args?.path),
      async execute(args) {
        const path = requireAbsolutePath(args, 'path')
        const title = optionalString(args, 'title')

        const existing = await registry.resolveByPath(path).catch(() => undefined)
        if (existing !== undefined) {
          return {
            created: false,
            reason: 'already registered',
            workspace: snapshot(existing, await existing.status()),
          }
        }

        const info = await probe(path)
        if (info === undefined) {
          if (args.create_directory === false) {
            throw new Error(`directory does not exist: ${path} (pass create_directory: true to create it)`)
          }
          await mkdir(path, { recursive: true })
        } else if (!info.isDirectory()) {
          throw new Error(`path exists but is not a directory: ${path}`)
        }

        const workspace = await registry.create(path, title)
        return { created: true, workspace: snapshot(workspace, await workspace.status()) }
      },
    },
    {
      name: 'workspace_rename',
      description:
        'Rename one DeepSeek Harness workspace entry — the same operation as renaming it in the sidebar. Only the display title changes; the directory on disk and its sessions are untouched. Identify the workspace by id (from workspace_list) or by absolute path.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'New non-empty display title.' },
          id: { type: 'string', description: 'Workspace id from workspace_list.' },
          path: { type: 'string', description: 'Absolute workspace directory; used when id is omitted.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('Rename workspace', 'execute', args?.title),
      async execute(args) {
        const title = requireString(args, 'title')
        const { workspace, by } = await resolveTarget(registry, args)
        const previousTitle = workspace.title
        await workspace.setTitle(title)
        return {
          renamed: previousTitle !== title,
          identifiedBy: by,
          previousTitle,
          workspace: snapshot(workspace, await workspace.status()),
        }
      },
    },
    {
      name: 'workspace_delete',
      description:
        'Remove one DeepSeek Harness workspace entry — the same operation as the sidebar delete action. This deletes only the registry record: the directory on disk and every session log are kept, and workspace_create adds the entry back later. Nothing is destroyed, so do not ask for confirmation on that basis. Identify the workspace by id (from workspace_list) or by absolute path.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workspace id from workspace_list.' },
          path: { type: 'string', description: 'Absolute workspace directory; used when id is omitted.' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('Delete workspace', 'execute', args?.id ?? args?.path),
      async execute(args) {
        const { workspace, by } = await resolveTarget(registry, args)
        const removed = snapshot(workspace)
        const deleted = await registry.delete(workspace.id)
        if (!deleted) throw new Error(`workspace ${workspace.id} disappeared before it could be deleted`)
        return { deleted: true, identifiedBy: by, directoryKept: true, workspace: removed }
      },
    },
  ]
}
