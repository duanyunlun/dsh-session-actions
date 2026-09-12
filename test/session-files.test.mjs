/**
 * On-disk behavior of permanent Session removal.
 *
 * The storage layout these tests build is the one the Harness actually
 * produces: a project bucket per cwd, one directory per Session holding a
 * compressed log, a projection cache keyed by Session id, and the Workspace
 * registry document carrying the id in both its archive set and a workspace's
 * accounting slot. Every assertion is about what survives on disk, because
 * that is the only thing "permanently deleted" can mean.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SESSION_ID_PATTERN, directorySize, encodeSegment, inspectSession, locateSessionDirs,
  pruneWorkspaceRegistry, purgeProjectionCache, removeSession, resolveHome, sessionsRoot,
} from '../session-files.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const OTHER = 'session-99999999-8888-7777-6666-555555555555'

/** One throwaway Harness home with storage shaped like the real one. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-actions-'))
  const bucket = join(sessionsRoot(home), '--Users-someone-project--')
  mkdirSync(join(bucket, SESSION), { recursive: true })
  mkdirSync(join(bucket, OTHER), { recursive: true })
  writeFileSync(join(bucket, SESSION, 'session.v3.jsonl.zstd'), Buffer.alloc(2048, 7))
  writeFileSync(join(bucket, SESSION, 'session.lock'), '')
  writeFileSync(join(bucket, OTHER, 'session.v3.jsonl.zstd'), Buffer.alloc(16, 1))
  return home
}

/** Write one Workspace registry document naming the Session in both places it can appear. */
function writeRegistry(home, sessionId) {
  const file = join(home, 'storages', 'workspace.json')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(file, JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: [sessionId, OTHER] },
    tables: {
      workspaces: {
        w1: { path: '/tmp/project', title: 'project', sessionIds: [sessionId, OTHER, sessionId] },
        w2: { path: '/tmp/other', title: 'other', sessionIds: [sessionId] },
      },
    },
  }, null, 2))
  return file
}

/** Write one projection-cache row for the Session. */
function writeProjectionCache(home, sessionId) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sessionId}.json`)
  writeFileSync(file, '{"title":"x"}')
  return file
}

test('encodeSegment neutralizes every path separator and traversal', () => {
  assert.equal(encodeSegment('session-abc'), 'session-abc')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('a\\b'), 'a~005Cb')
  assert.equal(encodeSegment('..'), '~002E~002E')
  assert.equal(encodeSegment('.'), '~002E')
  assert.equal(encodeSegment('~'), '~007E')
  assert.throws(() => encodeSegment(''), /empty path segment/)
})

test('the Session id pattern rejects traversal and separators', () => {
  assert.ok(SESSION_ID_PATTERN.test(SESSION))
  assert.ok(SESSION_ID_PATTERN.test('af68eedf-0256-42f2-a94b-de78c1011e4b'))
  assert.equal(SESSION_ID_PATTERN.test('../escape'), false)
  assert.equal(SESSION_ID_PATTERN.test('..'), false)
  assert.equal(SESSION_ID_PATTERN.test('.'), false)
  assert.equal(SESSION_ID_PATTERN.test('/abs'), false)
  assert.equal(SESSION_ID_PATTERN.test('a/b'), false)
  assert.equal(SESSION_ID_PATTERN.test(''), false)
  assert.equal(SESSION_ID_PATTERN.test('a'.repeat(129)), false)
})

test('resolveHome prefers the provided service, then DSH_HOME, then ~/.dsh', () => {
  assert.equal(resolveHome({ get: () => () => '/from/service' }, { DSH_HOME: '/from/env' }), '/from/service')
  assert.equal(resolveHome({ get: () => undefined }, { DSH_HOME: '/from/env' }), '/from/env')
  assert.equal(resolveHome({ get: () => undefined }, { DSH_HOME: '   ' }).endsWith('/.dsh'), true)
  assert.equal(resolveHome({ get: () => undefined }, {}).endsWith('/.dsh'), true)
})

test('locateSessionDirs finds the Session in whichever project bucket holds it', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual(
    await locateSessionDirs(home, SESSION),
    [join(sessionsRoot(home), '--Users-someone-project--', SESSION)],
  )
  assert.deepEqual(await locateSessionDirs(home, 'session-absent'), [])
})

test('locateSessionDirs tolerates a home with no sessions root', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-actions-'))
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual(await locateSessionDirs(home, SESSION), [])
})

test('directorySize totals a nested tree and reports 0 once it is gone', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const dir = join(sessionsRoot(home), '--Users-someone-project--', SESSION)
  assert.equal(await directorySize(dir), 2048)
  assert.equal(await directorySize(join(dir, 'absent')), 0)
})

test('inspectSession reports existence, size, and location without changing anything', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const report = await inspectSession(home, SESSION)
  assert.equal(report.exists, true)
  assert.equal(report.sizeBytes, 2048)
  assert.equal(report.directories.length, 1)
  assert.equal(existsSync(report.directories[0]), true)

  const missing = await inspectSession(home, 'session-absent')
  assert.deepEqual(missing, { exists: false, sizeBytes: 0, directories: [] })
})

test('removeSession destroys the log, the cache row, and both registry references', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const cache = writeProjectionCache(home, SESSION)
  const registryFile = writeRegistry(home, SESSION)

  const report = await removeSession(home, SESSION)

  assert.equal(report.freedBytes, 2048)
  assert.equal(report.cachePurged, true)
  assert.deepEqual(report.registry, { pruned: true, references: 4 })
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), false)
  assert.equal(existsSync(cache), false)

  const state = JSON.parse(readFileSync(registryFile, 'utf8'))
  assert.deepEqual(state.global.archivedSessionIds, [OTHER])
  assert.deepEqual(state.tables.workspaces.w1.sessionIds, [OTHER])
  assert.deepEqual(state.tables.workspaces.w2.sessionIds, [])
  // The registry's other content survives the prune untouched.
  assert.deepEqual(state.global.workspaceIds, ['w1'])
  assert.equal(state.unit.version, 2)

  // The sibling Conversation is untouched in every place it appears.
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', OTHER)), true)
})

test('removeSession leaves a registry it cannot parse alone and still deletes the log', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const file = join(home, 'storages', 'workspace.json')
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(file, '{ not json')

  const report = await removeSession(home, SESSION)

  assert.deepEqual(report.registry, { pruned: false, reason: 'unreadable' })
  assert.equal(readFileSync(file, 'utf8'), '{ not json')
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), false)
})

test('removeSession reports absent references rather than rewriting the registry', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const registryFile = writeRegistry(home, OTHER)
  const before = readFileSync(registryFile, 'utf8')

  const report = await removeSession(home, SESSION)

  assert.deepEqual(report.registry, { pruned: false, reason: 'absent' })
  assert.equal(readFileSync(registryFile, 'utf8'), before)
})

test('pruneWorkspaceRegistry tolerates a home with no registry at all', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-actions-'))
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  assert.deepEqual(await pruneWorkspaceRegistry(home, SESSION), { pruned: false, reason: 'missing' })
})

test('purgeProjectionCache is idempotent', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  writeProjectionCache(home, SESSION)
  assert.equal(await purgeProjectionCache(home, SESSION), true)
  assert.equal(await purgeProjectionCache(home, SESSION), false)
})

test('removeSession on an unknown id is a no-op that reports nothing removed', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const report = await removeSession(home, 'session-absent')
  assert.deepEqual(report.directories, [])
  assert.equal(report.freedBytes, 0)
  assert.equal(report.cachePurged, false)
})
