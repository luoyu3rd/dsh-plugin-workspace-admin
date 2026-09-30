/**
 * Offline test harness for the workspace-admin tool definitions.
 *
 * Runs the real tool definitions against an in-memory fake of the Harness
 * workspace registry, so tool behaviour and argument validation can be checked
 * without booting a Harness profile.
 *
 * Usage: node test/harness.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceTools } from '../src/workspace-tools.js'

/** Minimal in-memory stand-in for `Workspace`. */
class FakeWorkspace {
  constructor(record) {
    this.record = record
  }
  get id() { return this.record.id }
  get title() { return this.record.title }
  get path() { return this.record.path }
  get sessionIds() { return this.record.sessionIds }
  get createdAt() { return this.record.createdAt }
  get updatedAt() { return this.record.updatedAt }
  async setTitle(title) { this.record.title = title }
  async status() { return this.record.status }
}

/** Minimal in-memory stand-in for `WorkspaceRegistry`. */
class FakeRegistry {
  constructor() {
    this.records = new Map()
    this.counter = 0
    this.archived = []
  }
  list() { return [...this.records.values()].map((record) => new FakeWorkspace(record)) }
  get(id) { const record = this.records.get(id); return record === undefined ? undefined : new FakeWorkspace(record) }
  async resolveByPath(path) {
    for (const record of this.records.values()) if (record.path === path) return new FakeWorkspace(record)
    return undefined
  }
  async create(path, title) {
    const existing = await this.resolveByPath(path)
    if (existing !== undefined) return existing
    this.counter += 1
    const record = {
      id: `ws-${this.counter}`,
      path,
      title: title ?? (path.split('/').pop() || path),
      sessionIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      status: 'ok',
    }
    this.records.set(record.id, record)
    return new FakeWorkspace(record)
  }
  async delete(id) { return this.records.delete(id) }
  get archivedSessionIds() { return this.archived }
}

/** Minimal in-memory stand-in for `sessionQuery` (title folding only). */
class FakeSessionQuery {
  constructor(titles) {
    this.titles = titles
  }
  async readTitleSnapshots(sessionIds) {
    return sessionIds.map((sessionId) => {
      const title = this.titles.get(sessionId)
      if (title instanceof Error) return { sessionId, status: 'rejected', reason: title }
      return {
        sessionId,
        status: 'fulfilled',
        value: { title: title === undefined ? undefined : { title, source: { kind: 'user' } } },
      }
    })
  }
}

/** Minimal in-memory stand-in for `sessionPersistence` (header metadata only). */
class FakeSessionPersistence {
  constructor(headers) {
    this.headers = headers
  }
  async stat(id) {
    const header = this.headers.get(id)
    if (header === undefined) return undefined
    if (header instanceof Error) throw header
    return { header, revision: 'r1' }
  }
}

/** Locate one definition by tool name, failing loudly when it is absent. */
function tool(definitions, name) {
  const found = definitions.find((definition) => definition.name === name)
  assert.ok(found, `tool ${name} must be registered`)
  return found
}

/** Register `sessionIds` on a workspace created through the registry. */
function account(registry, id, sessionIds) {
  registry.records.get(id).sessionIds = sessionIds
}

const scratch = await mkdtemp(join(tmpdir(), 'workspace-admin-test-'))
const registry = new FakeRegistry()
const titles = new Map()
const headers = new Map()
const sessionQuery = new FakeSessionQuery(titles)
const sessionPersistence = new FakeSessionPersistence(headers)
const definitions = workspaceTools({ workspaceRegistry: registry, sessionQuery, sessionPersistence })

assert.equal(definitions.length, 6, 'six tools are registered')
assert.deepEqual(
  definitions.map((definition) => definition.name),
  ['workspace_list', 'workspace_sessions', 'workspace_resolve', 'workspace_create', 'workspace_rename', 'workspace_delete'],
)

// Every definition must satisfy the registry's output contract.
for (const definition of definitions) {
  assert.equal(typeof definition.description, 'string')
  assert.equal(definition.parameters.type, 'object')
  assert.equal(typeof definition.output.render, 'function')
  // Annotation-only schema: the enforced subset's unconstrained-JSON form.
  assert.deepEqual(definition.output.schema, {})
  const rendered = definition.output.render({}, { ok: true })
  assert.equal(rendered[0].type, 'text')
  assert.deepEqual(JSON.parse(rendered[0].text), { ok: true })
}

// list on an empty registry
assert.deepEqual(await tool(definitions, 'workspace_list').execute({}), { total: 0, workspaces: [] })

// resolve rejects relative paths before touching the registry
await assert.rejects(
  () => tool(definitions, 'workspace_resolve').execute({ path: 'relative/path' }),
  /must be an absolute path/,
)

// resolve on an unregistered but existing directory yields null
const resolved = await tool(definitions, 'workspace_resolve').execute({ path: scratch })
assert.equal(resolved.workspace, null)

// create with an existing directory and no title
const created = await tool(definitions, 'workspace_create').execute({ path: scratch })
assert.equal(created.created, true)
assert.equal(created.workspace.path, scratch)
assert.equal(created.workspace.title, scratch.split('/').pop())
assert.equal(created.workspace.status, 'ok')

// create is idempotent and never retitles
const again = await tool(definitions, 'workspace_create').execute({ path: scratch, title: 'ignored' })
assert.equal(again.created, false)
assert.equal(again.reason, 'already registered')
assert.equal(again.workspace.title, created.workspace.title)

// create makes missing directories by default
const nested = join(scratch, 'a', 'b', 'c')
const made = await tool(definitions, 'workspace_create').execute({ path: nested, title: 'Nested' })
assert.equal(made.created, true)
assert.equal(made.workspace.title, 'Nested')

// ...and refuses when asked not to
await assert.rejects(
  () => tool(definitions, 'workspace_create').execute({ path: join(scratch, 'missing'), create_directory: false }),
  /directory does not exist/,
)

// create rejects a path that is a regular file
const filePath = join(scratch, 'not-a-directory.txt')
await writeFile(filePath, 'x')
await assert.rejects(
  () => tool(definitions, 'workspace_create').execute({ path: filePath }),
  /not a directory/,
)

// list reports both entries with status
const listed = await tool(definitions, 'workspace_list').execute({})
assert.equal(listed.total, 2)
assert.deepEqual(listed.workspaces.map((entry) => entry.title), [created.workspace.title, 'Nested'])

// rename by id
const renamed = await tool(definitions, 'workspace_rename').execute({ id: made.workspace.id, title: 'Renamed' })
assert.equal(renamed.renamed, true)
assert.equal(renamed.previousTitle, 'Nested')
assert.equal(renamed.workspace.title, 'Renamed')
assert.equal(renamed.identifiedBy, 'id')

// rename is a no-op when the title is unchanged
const unchanged = await tool(definitions, 'workspace_rename').execute({ id: made.workspace.id, title: 'Renamed' })
assert.equal(unchanged.renamed, false)

// rename by path
const byPath = await tool(definitions, 'workspace_rename').execute({ path: nested, title: 'By path' })
assert.equal(byPath.workspace.title, 'By path')
assert.equal(byPath.identifiedBy, 'path')

// rename validates its arguments
await assert.rejects(() => tool(definitions, 'workspace_rename').execute({ title: '   ' }), /title must be a non-empty string/)
await assert.rejects(() => tool(definitions, 'workspace_rename').execute({ title: 'x' }), /supply either id/)
await assert.rejects(() => tool(definitions, 'workspace_rename').execute({ id: 'nope', title: 'x' }), /unknown workspace id/)
await assert.rejects(
  () => tool(definitions, 'workspace_rename').execute({ path: join(scratch, 'nowhere'), title: 'x' }),
  /no workspace is registered/,
)

// --- sessions -------------------------------------------------------------

// account three sessions on the first workspace: two live, one archived,
// with one unreadable log and one session that was never titled
account(registry, created.workspace.id, ['session-a', 'session-b', 'session-archived'])
account(registry, made.workspace.id, ['session-c'])
registry.archived = ['session-archived']
titles.set('session-a', 'First session')
titles.set('session-b', undefined)
titles.set('session-archived', 'Archived session')
titles.set('session-c', 'Third session')
titles.set('session-broken', new Error('log unreadable'))
const at = (iso) => ({ version: 'v4', id: 'x', createdAt: Date.parse(iso), isSeeded: false })
headers.set('session-a', { ...at('2026-03-01T00:00:00Z'), cwd: scratch, agentPreset: 'standard' })
headers.set('session-b', at('2026-03-02T00:00:00Z'))
headers.set('session-archived', at('2026-03-03T00:00:00Z'))
headers.set('session-c', { ...at('2026-03-04T00:00:00Z'), parentSession: 'session-a', origin: 'subagent', delegationDepth: 1 })
const sessions = await tool(definitions, 'workspace_sessions').execute({ id: created.workspace.id })
assert.equal(sessions.workspace.id, created.workspace.id)
assert.equal(sessions.total, 2, 'archived session excluded by default')
assert.equal(sessions.archivedCount, 1)
assert.equal(sessions.archivedExcluded, 1)
assert.equal(sessions.truncated, false)
// newest first
assert.deepEqual(sessions.sessions.map((entry) => entry.sessionId), ['session-b', 'session-a'])
assert.equal(sessions.sessions[1].title, 'First session')
assert.equal(sessions.sessions[1].titleSource, 'user')
assert.equal(sessions.sessions[1].cwd, scratch)
assert.equal(sessions.sessions[1].agentPreset, 'standard')
assert.equal(sessions.sessions[1].createdAt, '2026-03-01T00:00:00.000Z')
// an untitled session reports null rather than failing
assert.equal(sessions.sessions[0].title, null)

// including archived sessions
const withArchived = await tool(definitions, 'workspace_sessions').execute({
  id: created.workspace.id,
  include_archived: true,
})
assert.equal(withArchived.total, 3)
assert.equal(withArchived.archivedExcluded, undefined)
assert.equal(withArchived.sessions[0].sessionId, 'session-archived')
assert.equal(withArchived.sessions[0].archived, true)

// limit truncates newest-first and reports it
const limited = await tool(definitions, 'workspace_sessions').execute({
  id: created.workspace.id,
  include_archived: true,
  limit: 1,
})
assert.equal(limited.total, 1)
assert.equal(limited.truncated, true)
assert.equal(limited.sessions[0].sessionId, 'session-archived')

// resolve by path works here too
const byPathSessions = await tool(definitions, 'workspace_sessions').execute({ path: nested })
assert.equal(byPathSessions.total, 1)
assert.equal(byPathSessions.sessions[0].title, 'Third session')
assert.equal(byPathSessions.sessions[0].parentSession, 'session-a')
assert.equal(byPathSessions.sessions[0].origin, 'subagent')

// a rejected title read and a missing header are contained per session
account(registry, created.workspace.id, ['session-broken', 'session-gone'])
const degraded = await tool(definitions, 'workspace_sessions').execute({ id: created.workspace.id })
assert.equal(degraded.total, 2)
const broken = degraded.sessions.find((entry) => entry.sessionId === 'session-broken')
assert.match(broken.unavailable, /log unreadable/)
const gone = degraded.sessions.find((entry) => entry.sessionId === 'session-gone')
assert.equal(gone.title, null)
assert.equal(gone.createdAt, null)

// argument validation
await assert.rejects(
  () => tool(definitions, 'workspace_sessions').execute({ id: created.workspace.id, limit: 0 }),
  /limit must be a positive integer/,
)
await assert.rejects(() => tool(definitions, 'workspace_sessions').execute({}), /supply either id/)

// workspace_list inlines sessions only when asked
const plain = await tool(definitions, 'workspace_list').execute({})
assert.equal(plain.workspaces.every((entry) => entry.sessions === undefined), true)
const inlined = await tool(definitions, 'workspace_list').execute({ include_sessions: true })
assert.equal(Array.isArray(inlined.workspaces[0].sessions), true)
assert.equal(inlined.workspaces[0].sessionCount, 2)
// --- delete ---------------------------------------------------------------

// delete by id keeps the directory
const deleted = await tool(definitions, 'workspace_delete').execute({ id: made.workspace.id })
assert.equal(deleted.deleted, true)
assert.equal(deleted.directoryKept, true)
assert.equal(deleted.workspace.title, 'By path')
assert.equal((await tool(definitions, 'workspace_list').execute({})).total, 1)

// deleting an unknown id fails informatively
await assert.rejects(() => tool(definitions, 'workspace_delete').execute({ id: 'ws-999' }), /unknown workspace id/)

// delete by path
const deletedByPath = await tool(definitions, 'workspace_delete').execute({ path: scratch })
assert.equal(deletedByPath.identifiedBy, 'path')
assert.equal((await tool(definitions, 'workspace_list').execute({})).total, 0)

// a deleted workspace can be re-added, proving the directory survived
const readded = await tool(definitions, 'workspace_create').execute({ path: scratch })
assert.equal(readded.created, true)

await rm(scratch, { recursive: true, force: true })
console.log('workspace-admin tool harness: all assertions passed')
