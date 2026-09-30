/**
 * Workspace administration tools: let the model read and mutate the DeepSeek
 * Harness workspace registry itself (`ctx.workspaceRegistry`) from inside a
 * conversation.
 *
 * Deliberately dependency-free apart from Node builtins: every tool is a raw
 * `ToolDefinition` object, so the plugin needs no bare module resolution and can
 * be mounted straight from an absolute path in a profile patch layer.
 *
 * Model-facing prose (tool and parameter descriptions, thrown messages, and the
 * `presentCall` labels) is Simplified Chinese. Identifiers and the JSON output
 * contract are NOT translated: tool names, result field names, and enum-like
 * values such as `reason: 'already registered'` or `identifiedBy: 'id'` stay
 * stable so callers can match on them.
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
    throw new Error(`${key} 必须是非空字符串`)
  }
  return value
}

/** Read an optional string argument, normalizing absent or blank values to undefined. */
function optionalString(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} 必须是字符串（若提供）`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Read a required absolute directory path argument. */
function requireAbsolutePath(args, key) {
  const value = requireString(args, key)
  if (!isAbsolute(value)) {
    throw new Error(`${key} 必须是绝对路径；实际收到 ${JSON.stringify(value)}`)
  }
  return value
}

/** Read an optional positive-integer argument, normalizing absent values to undefined. */
function optionalLimit(args, key) {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} 必须是正整数（若提供）；实际收到 ${JSON.stringify(value)}`)
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
    throw new Error(`未知的工作区 id ${JSON.stringify(id)}；已知工作区：${known.join('、') || '（无）'}`)
  }
  return workspace
}

/** Resolve one workspace by canonical directory path. */
async function requireWorkspaceAtPath(registry, path) {
  if (path === undefined) throw new Error('path 必须是非空字符串')
  if (!isAbsolute(path)) throw new Error(`path 必须是绝对路径；实际收到 ${JSON.stringify(path)}`)
  const workspace = await registry.resolveByPath(path)
  if (workspace === undefined) {
    throw new Error(`没有为 ${path} 注册工作区；可以用 workspace_create 添加`)
  }
  return workspace
}

/** Resolve the workspace named by the `id`/`path` argument pair. */
async function resolveTarget(registry, args) {
  const id = optionalString(args, 'id')
  const path = optionalString(args, 'path')
  if (id !== undefined) return { workspace: requireWorkspace(registry, id), by: 'id' }
  if (path !== undefined) return { workspace: await requireWorkspaceAtPath(registry, path), by: 'path' }
  throw new Error('请提供 id（来自 workspace_list）或 path 来标识工作区')
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
        '列出 DeepSeek Harness 的全部工作区（即侧边栏工作区列表中的条目），按显示顺序返回其 id、标题、目录与会话数量。先调用它来取得 workspace_sessions、workspace_rename 或 workspace_delete 所需的准确工作区 id。传入 include_sessions: true 会内联每个工作区的会话（id、标题、创建时间）；工作区很多时，请优先只对需要的那一个调用 workspace_sessions。',
      parameters: {
        type: 'object',
        properties: {
          include_sessions: {
            type: 'boolean',
            description: '内联每个工作区的会话列表。默认 false（只返回会话数量）。',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('列出工作区', 'read', args?.include_sessions === true ? '含会话' : undefined),
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
        '列出某个 DeepSeek Harness 工作区所拥有的会话，按时间倒序，含每个会话的 id、由日志折叠出的标题、创建时间与谱系元数据。用 id（来自 workspace_list）或绝对路径标识工作区。默认排除已归档的会话，除非 include_archived 为 true。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '工作区 id，来自 workspace_list。' },
          path: { type: 'string', description: '工作区的绝对目录路径；省略 id 时使用。' },
          include_archived: {
            type: 'boolean',
            description: '包含已归档的会话。默认 false。',
          },
          limit: {
            type: 'number',
            description: '最多返回多少个会话（按时间倒序，取最新的若干个）。',
          },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('列出工作区会话', 'read', args?.path ?? args?.id),
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
        '把绝对目录路径解析为拥有它的工作区条目，不创建也不修改任何内容。目录未注册时返回 workspace: null。可用它判断 workspace_create 是否会新增条目。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '已存在目录的绝对路径。' } },
        required: ['path'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('按路径解析工作区', 'read', args?.path),
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
        '把一个目录加入 DeepSeek Harness 工作区列表——等同于侧边栏的「Add workspace」按钮。目录按其规范 realpath 注册。注册一个已经是工作区的路径属于无操作，会原样返回既有条目；如需改标题请用 workspace_rename。目录不存在时默认先递归创建，除非 create_directory 为 false。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要注册的目录的绝对路径。' },
          title: { type: 'string', description: '显示标题，仅在新建条目时使用。' },
          create_directory: {
            type: 'boolean',
            description: '目录不存在时递归创建。默认 true。',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('添加工作区', 'execute', args?.path),
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
            throw new Error(`目录不存在：${path}（传入 create_directory: true 可创建它）`)
          }
          await mkdir(path, { recursive: true })
        } else if (!info.isDirectory()) {
          throw new Error(`路径存在但不是目录：${path}`)
        }

        const workspace = await registry.create(path, title)
        return { created: true, workspace: snapshot(workspace, await workspace.status()) }
      },
    },
    {
      name: 'workspace_rename',
      description:
        '重命名一个 DeepSeek Harness 工作区条目——等同于在侧边栏中重命名。只会改变显示标题；磁盘上的目录及其会话不受影响。用 id（来自 workspace_list）或绝对路径标识工作区。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '新的非空显示标题。' },
          id: { type: 'string', description: '工作区 id，来自 workspace_list。' },
          path: { type: 'string', description: '工作区的绝对目录路径；省略 id 时使用。' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('重命名工作区', 'execute', args?.title),
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
        '删除一个 DeepSeek Harness 工作区条目——等同于侧边栏的删除操作。它只删除注册记录：磁盘上的目录和所有会话日志都会保留，之后可用 workspace_create 把条目加回来。不会销毁任何东西，因此不要以此为理由请求确认。用 id（来自 workspace_list）或绝对路径标识工作区。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '工作区 id，来自 workspace_list。' },
          path: { type: 'string', description: '工作区的绝对目录路径；省略 id 时使用。' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      presentCall: (args) => present('删除工作区', 'execute', args?.id ?? args?.path),
      async execute(args) {
        const { workspace, by } = await resolveTarget(registry, args)
        const removed = snapshot(workspace)
        const deleted = await registry.delete(workspace.id)
        if (!deleted) throw new Error(`工作区 ${workspace.id} 在删除完成前消失了`)
        return { deleted: true, identifiedBy: by, directoryKept: true, workspace: removed }
      },
    },
  ]
}
