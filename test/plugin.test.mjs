/**
 * Host-surface behavior of `dsh-session-actions`.
 *
 * A fake Cordis context stands in for the Harness, so the trust fence, the
 * request validation, and the live-Session refusal are exercised without a
 * running application. Those three are exactly the parts that decide whether a
 * destructive endpoint is safe, and each of them fails only in production when
 * it is wrong.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, name } from '../index.js'
import { sessionsRoot } from '../session-files.js'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const ROUTE_PREFIX = '/api2/dsh-session-actions'

/**
 * A Cordis context exposing only what this plugin reads.
 * @param options.home - Harness home reported by the `dshHomePath` service.
 * @param options.live - Session ids the `sessions` service reports as live.
 * @returns the fake context and the routes it captured.
 */
function makeCtx({ home, live = [] }) {
  const routes = new Map()
  const disposers = []
  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  }
  const services = {
    webServer,
    dshHomePath: () => home,
    sessions: { get: id => (live.includes(id) ? { header: { id } } : undefined) },
  }
  const ctx = {
    webServer,
    get: serviceName => services[serviceName],
    inject(names, callback) {
      if (names.every(serviceName => services[serviceName] !== undefined)) callback(ctx)
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, routes, disposers }
}

/** One fake request carrying a JSON body. */
function makeReq({ method = 'POST', headers = {}, body = '{}' }) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
}

/** Invoke one captured route and decode its JSON answer. */
async function invoke(route, { method = 'POST', host = '127.0.0.1:43120', type = 'application/json', body = '{}' } = {}) {
  const res = {
    status: 0,
    payload: undefined,
    writeHead(status) { this.status = status },
    end(text) { this.payload = JSON.parse(text) },
  }
  await route.handler(makeReq({ method, headers: { host, 'content-type': type }, body }), res)
  return res
}

/** One Harness home holding a single stored Conversation. */
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-actions-'))
  const dir = join(sessionsRoot(home), '--Users-someone-project--', SESSION)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.alloc(512, 3))
  return home
}

/** Mount the plugin against a fake context. */
function mount(options) {
  const mounted = makeCtx(options)
  apply(mounted.ctx)
  return mounted
}

test('the plugin declares its name and mounts one route per operation', (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes, disposers } = mount({ home })
  assert.equal(name, 'session-actions')
  assert.deepEqual([...routes.keys()].sort(), [`${ROUTE_PREFIX}/delete`, `${ROUTE_PREFIX}/inspect`])
  // Unloading the plugin releases every route it claimed.
  for (const dispose of disposers) dispose()
  assert.equal(routes.size, 0)
})

test('a profile without a Web server loads the plugin as a no-op', () => {
  const ctx = { get: () => undefined, inject: () => {}, effect: () => {} }
  assert.doesNotThrow(() => { apply(ctx) })
})

test('inspect describes a stored Conversation', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/inspect`), { body: JSON.stringify({ sessionId: SESSION }) })
  assert.equal(res.status, 200)
  assert.deepEqual(res.payload.value, {
    sessionId: SESSION,
    live: false,
    exists: true,
    sizeBytes: 512,
    directories: [join(sessionsRoot(home), '--Users-someone-project--', SESSION)],
  })
})

test('inspect reports a Session that is live in this process', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home, live: [SESSION] })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/inspect`), { body: JSON.stringify({ sessionId: SESSION }) })
  assert.equal(res.status, 200)
  assert.equal(res.payload.value.live, true)
})

test('the trust fence refuses a non-POST method', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/delete`), { method: 'GET' })
  assert.equal(res.status, 405)
  assert.equal(res.payload.error.code, 'method-not-allowed')
})

test('the trust fence refuses a non-JSON content type', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/delete`), { type: 'text/plain' })
  assert.equal(res.status, 415)
  assert.equal(res.payload.error.code, 'unsupported-media-type')
})

test('the trust fence refuses a cross-origin Host', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/delete`), { host: 'evil.example.com' })
  assert.equal(res.status, 403)
  assert.equal(res.payload.error.code, 'forbidden')
  // The body is never even read for an untrusted request.
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), true)
})

test('the trust fence accepts every loopback spelling and an opted-in authority', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const inspect = routes.get(`${ROUTE_PREFIX}/inspect`)
  const body = JSON.stringify({ sessionId: SESSION })
  for (const host of ['127.0.0.1', '127.0.0.1:43120', 'localhost:43120', '[::1]:43120', 'LOCALHOST']) {
    const res = await invoke(inspect, { host, body })
    assert.equal(res.status, 200, `host ${host}`)
  }
  process.env.DSH_SESSION_ACTIONS_TRUSTED_HOSTS = 'dsh.internal, 10.0.0.5'
  t.after(() => { delete process.env.DSH_SESSION_ACTIONS_TRUSTED_HOSTS })
  assert.equal((await invoke(inspect, { host: 'dsh.internal:43120', body })).status, 200)
  assert.equal((await invoke(inspect, { host: 'other.internal', body })).status, 403)
})

test('a malformed Session id never reaches the filesystem', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const del = routes.get(`${ROUTE_PREFIX}/delete`)
  for (const sessionId of ['../escape', '..', 'a/b', '', 42, null, undefined, 'a'.repeat(200)]) {
    const res = await invoke(del, { body: JSON.stringify({ sessionId }) })
    assert.equal(res.status, 400, `id ${String(sessionId)}`)
    assert.equal(res.payload.error.code, 'bad-request')
  }
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), true)
})

test('a malformed or oversized body is rejected', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const del = routes.get(`${ROUTE_PREFIX}/delete`)
  assert.equal((await invoke(del, { body: 'not json' })).status, 400)
  assert.equal((await invoke(del, { body: '[]' })).status, 400)
  assert.equal((await invoke(del, { body: 'null' })).status, 400)
  assert.equal((await invoke(del, { body: JSON.stringify({ sessionId: SESSION, pad: 'x'.repeat(70000) }) })).status, 400)
})

test('delete refuses a Session that is live in this process, and destroys nothing', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home, live: [SESSION] })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/delete`), { body: JSON.stringify({ sessionId: SESSION }) })
  assert.equal(res.status, 409)
  assert.equal(res.payload.error.code, 'session-live')
  assert.equal(res.payload.error.sessionId, SESSION)
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), true)
})

test('delete permanently removes a cold Session and reports what it freed', async (t) => {
  const home = makeHome()
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  const { routes } = mount({ home })
  const res = await invoke(routes.get(`${ROUTE_PREFIX}/delete`), { body: JSON.stringify({ sessionId: SESSION }) })
  assert.equal(res.status, 200)
  assert.equal(res.payload.value.sessionId, SESSION)
  assert.equal(res.payload.value.freedBytes, 512)
  assert.equal(res.payload.value.registry.pruned, false)
  assert.equal(existsSync(join(sessionsRoot(home), '--Users-someone-project--', SESSION)), false)
})
