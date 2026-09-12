/**
 * Permanent on-disk removal of one Conversation.
 *
 * The Harness owns no delete: `SessionPersistence` exposes create/open/stat/
 * list, and the Workspace registry exposes archive (which deliberately keeps
 * both the log and the accounting slot so unarchiving restores the row). This
 * module is the missing operation, written against the layout those two owners
 * actually produce rather than against their public APIs, because neither
 * offers a removal primitive:
 *
 *   $DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v<N>.jsonl.zstd
 *   $DSH_HOME/storages/session_projcache/sessions/<id>.json
 *   $DSH_HOME/storages/workspace.json          (sessionIds[] + archivedSessionIds[])
 *
 * `projectKey` is intentionally lossy (separators collapse, long paths
 * truncate), so the owning directory is **found by scanning** the sessions
 * root for a child named after the encoded id. Recomputing the key would mean
 * re-deriving the cwd from a header this module may not be able to read, and
 * would silently miss a session whose header is unreadable — exactly the case
 * permanent deletion most needs to handle.
 *
 * Everything here is pure filesystem work with an injectable home, so the
 * behavior is testable without a running Harness.
 *
 * @module dsh-session-actions/session-files
 */

import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

/** Session and Workspace ids addressable by this module. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Project-directory bucket the persistence backend uses for a cwd-less header. */
const NO_CWD_DIR = '_no-cwd'

/**
 * Filesystem-safe encoding of one path segment, mirroring the persistence
 * backend's `encodeSegment`: `/`, `\`, and `..` cannot survive it, so an id
 * that reaches this function can never escape the directory it is joined to.
 * @param raw - the raw id.
 * @returns one safe path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const character = String.fromCharCode(code)
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Resolve the Harness home whose storage this module edits.
 * @param ctx - Host plugin context; `dshHomePath` is provided by application boot.
 * @param env - environment mapping read for `DSH_HOME`.
 * @returns the absolute Harness home.
 */
export function resolveHome(ctx, env = process.env) {
  const dshHomePath = ctx.get('dshHomePath')
  if (typeof dshHomePath === 'function') return dshHomePath()
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return join(homedir(), '.dsh')
}

/** The sessions root beneath one Harness home. */
export function sessionsRoot(home) {
  return join(home, 'sessions')
}

/** Whether `candidate` resolves inside `root` (defence in depth behind {@link encodeSegment}). */
function isInside(root, candidate) {
  const base = resolve(root)
  const full = resolve(candidate)
  return full === base || full.startsWith(base + sep)
}

/**
 * Every directory owned by one Session, across each project bucket.
 *
 * A scan is deliberate: the owning bucket is derived from the session's cwd
 * through a lossy key, so the id is the only reliable locator.
 * @param home - the Harness home.
 * @param sessionId - the Session to locate.
 * @returns absolute session directories; empty when the Session has no log.
 */
export async function locateSessionDirs(home, sessionId) {
  const root = sessionsRoot(home)
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const segment = encodeSegment(sessionId)
  const found = []
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, segment)
    if (!isInside(root, candidate)) continue
    const info = await stat(candidate).catch(() => undefined)
    if (info?.isDirectory() === true) found.push(candidate)
  }
  return found
}

/**
 * Total size of one directory tree, in bytes.
 *
 * Symbolic links are measured as links, never followed: a link out of the
 * session directory is not this session's storage, and following one could
 * both inflate the reported figure and walk a cycle.
 * @param root - directory to measure.
 * @returns bytes beneath `root`, or 0 when it is already gone.
 */
export async function directorySize(root) {
  const info = await stat(root).catch(() => undefined)
  if (info === undefined) return 0
  if (!info.isDirectory()) return info.size
  let total = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += await directorySize(join(root, entry.name))
  }
  return total
}

/**
 * Remove the projection-cache rows keyed by one Session id.
 *
 * The cache is a pure derivation of the log, so a stale row only wastes space
 * and can briefly resurrect a title; deleting it keeps the store honest.
 * @param home - the Harness home.
 * @param sessionId - the Session whose cache rows are dropped.
 * @returns whether a cache row existed.
 */
export async function purgeProjectionCache(home, sessionId) {
  const file = join(home, 'storages', 'session_projcache', 'sessions', `${encodeSegment(sessionId)}.json`)
  const existed = (await stat(file).catch(() => undefined)) !== undefined
  await rm(file, { force: true })
  return existed
}

/**
 * Drop one Session id from the Workspace registry's durable state.
 *
 * Both references are removed: `global.archivedSessionIds` (otherwise an id
 * for a session that no longer exists stays in the archive set forever) and
 * every `tables.workspaces[*].sessionIds` accounting slot.
 *
 * The registry keeps its own in-memory copy of this document and rewrites the
 * whole file on its next mutation, so a prune performed here can be reverted
 * by a later archive/reorder. The residue is an id naming a session that no
 * longer exists, which no grouping surface renders; this module reports
 * whether the write landed rather than pretending the ordering is durable.
 * @param home - the Harness home.
 * @param sessionId - the Session id to drop.
 * @returns whether the document changed, and why not when it did not.
 */
export async function pruneWorkspaceRegistry(home, sessionId) {
  const file = join(home, 'storages', 'workspace.json')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { pruned: false, reason: 'missing' }
    throw error
  }
  let state
  try {
    state = JSON.parse(text)
  } catch {
    return { pruned: false, reason: 'unreadable' }
  }
  let removed = 0
  const withoutId = (ids) => {
    const next = ids.filter(id => id !== sessionId)
    removed += ids.length - next.length
    return next
  }
  if (Array.isArray(state?.global?.archivedSessionIds)) {
    state.global.archivedSessionIds = withoutId(state.global.archivedSessionIds)
  }
  const workspaces = state?.tables?.workspaces
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const record of Object.values(workspaces)) {
      if (Array.isArray(record?.sessionIds)) record.sessionIds = withoutId(record.sessionIds)
    }
  }
  if (removed === 0) return { pruned: false, reason: 'absent' }
  // Same-directory rename: a reader of the registry never observes a torn file.
  const staging = `${file}.dsh-session-actions.tmp`
  await writeFile(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(staging, file)
  return { pruned: true, references: removed }
}

/**
 * Permanently remove one Session: its log directory, its projection cache, and
 * its Workspace-registry references.
 *
 * The filesystem work runs to completion before the registry is touched, so a
 * registry that cannot be rewritten still leaves the Conversation deleted; the
 * returned report says which parts landed.
 * @param home - the Harness home.
 * @param sessionId - the Session to delete.
 * @returns what was removed, how many bytes it held, and the non-fatal outcomes.
 */
export async function removeSession(home, sessionId) {
  const directories = await locateSessionDirs(home, sessionId)
  let freedBytes = 0
  for (const directory of directories) {
    freedBytes += await directorySize(directory)
    await rm(directory, { recursive: true, force: true })
  }
  const cachePurged = await purgeProjectionCache(home, sessionId)
  const registry = await pruneWorkspaceRegistry(home, sessionId)
  return { directories, freedBytes, cachePurged, registry }
}

/**
 * Describe one Session without changing it, so a confirmation surface can name
 * what it is about to destroy.
 * @param home - the Harness home.
 * @param sessionId - the Session to describe.
 * @returns whether it exists on disk, its size, and the directories holding it.
 */
export async function inspectSession(home, sessionId) {
  const directories = await locateSessionDirs(home, sessionId)
  let sizeBytes = 0
  for (const directory of directories) sizeBytes += await directorySize(directory)
  return { exists: directories.length > 0, sizeBytes, directories }
}
