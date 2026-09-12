/**
 * `dsh-session-actions` Host half.
 *
 * Owns the one operation the browser cannot perform: permanently removing a
 * Conversation from disk. It mounts a small JSON surface on the Web server
 * (`/api2/dsh-session-actions/<op>`) that the browser half calls; the official
 * `/api` channel is a generated Remote assembly, and an out-of-tree plugin has
 * no seat in that code generation.
 *
 * The surface is destructive, so it carries the same trust fence as the other
 * plugin-owned `/api2` surface: POST only, `application/json` only, and a
 * loopback `Host`. The JSON content type is the load-bearing part — it forces a
 * CORS preflight that this route never answers, so a page on another origin
 * cannot drive a delete even though it can reach the loopback port.
 *
 * A Conversation that is live in this process is refused rather than deleted.
 * Its log writer still holds an open handle and the Agent that owns it is
 * registered for the process lifetime, so unlinking the log would leave a row
 * the Client keeps rendering from memory while the storage underneath it no
 * longer exists. Refusing is recoverable; a half-deleted live Conversation is
 * not.
 *
 * @module dsh-session-actions
 */

import { SESSION_ID_PATTERN, inspectSession, removeSession, resolveHome } from './session-files.js'

/** Base path of this plugin's JSON surface. */
const ROUTE_PREFIX = '/api2/dsh-session-actions'

/** Operations mounted, one route each. */
const OPERATIONS = ['inspect', 'delete']

/** Request bodies carry one id; anything larger is a malformed caller. */
const MAX_BODY_BYTES = 64 * 1024

/** Authorities that are always trusted (the Web UI binds loopback). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

/** Additional trusted authorities, comma-separated, for a non-loopback deployment. */
const TRUSTED_HOSTS_ENV = 'DSH_SESSION_ACTIONS_TRUSTED_HOSTS'

/**
 * Hostname part of an HTTP authority, with an IPv6 literal kept bracketed.
 * @param authority - the raw `Host` header value.
 * @returns the lowercased hostname, or the whole value when it has no port.
 */
function hostnameOf(authority) {
  const value = authority.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end >= 0 ? value.slice(0, end + 1) : value
  }
  const colon = value.lastIndexOf(':')
  return colon >= 0 ? value.slice(0, colon) : value
}

/**
 * Whether a request may drive a mutation.
 *
 * Cross-site pages can reach a loopback port; they cannot set a JSON content
 * type without a preflight, and they cannot forge `Host`. Both are checked,
 * matching the fence the official connection route uses.
 * @param req - the incoming request.
 * @returns true when the request is same-origin-shaped and locally addressed.
 */
function isTrustedRequest(req) {
  const extra = new Set(
    (process.env[TRUSTED_HOSTS_ENV] ?? '')
      .split(',')
      .map(entry => entry.trim().toLowerCase())
      .filter(entry => entry.length > 0),
  )
  const host = hostnameOf(String(req.headers?.host ?? ''))
  return LOOPBACK_HOSTS.has(host) || extra.has(host)
}

/**
 * Read and parse one bounded JSON object body.
 * @param req - the incoming request.
 * @returns the parsed object.
 * @throws when the body is not one JSON object within the byte budget.
 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed
}

/**
 * Whether one Conversation is live in this process.
 *
 * Read through `ctx.get` rather than a declared injection: this plugin is
 * useful with no Session service present (it then only ever reports `false`),
 * and an injection would leave the whole plugin PENDING there.
 * @param ctx - Host plugin context.
 * @param sessionId - the Session to test.
 * @returns true when a live Session owns the id.
 */
function isLive(ctx, sessionId) {
  const sessions = ctx.get('sessions')
  return sessions !== undefined && sessions.get(sessionId) !== undefined
}

/**
 * Validate one caller-supplied id before it is joined to a path.
 * @param body - the parsed request body.
 * @returns the validated Session id.
 * @throws when the id is absent or not a legal Session id.
 */
function requireSessionId(body) {
  const sessionId = body.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId must be a session id')
  }
  return sessionId
}

/**
 * Build the handler for one operation.
 * @param ctx - Host plugin context.
 * @param op - the operation name this route answers.
 * @returns an HTTP handler.
 */
function createHandler(ctx, op) {
  return async (req, res) => {
    /** Answer one request with a JSON envelope. */
    const respond = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    }
    try {
      if ((req.method ?? '') !== 'POST') {
        respond(405, { ok: false, error: { code: 'method-not-allowed', message: 'POST only' } })
        return
      }
      if (!String(req.headers?.['content-type'] ?? '').toLowerCase().includes('application/json')) {
        respond(415, { ok: false, error: { code: 'unsupported-media-type', message: 'application/json required' } })
        return
      }
      if (!isTrustedRequest(req)) {
        respond(403, { ok: false, error: { code: 'forbidden', message: 'untrusted request' } })
        return
      }
      const body = await readJsonBody(req)
      const sessionId = requireSessionId(body)
      const home = resolveHome(ctx)
      const live = isLive(ctx, sessionId)
      if (op === 'inspect') {
        const report = await inspectSession(home, sessionId)
        respond(200, { ok: true, value: { sessionId, live, ...report } })
        return
      }
      if (live) {
        respond(409, {
          ok: false,
          error: {
            code: 'session-live',
            message: `session "${sessionId}" is open in this process`,
            sessionId,
          },
        })
        return
      }
      const report = await removeSession(home, sessionId)
      respond(200, { ok: true, value: { sessionId, ...report } })
    } catch (error) {
      respond(400, {
        ok: false,
        error: { code: 'bad-request', message: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

/** Plugin name reported to the Loader. */
export const name = 'session-actions'

/**
 * Mount the JSON surface once a Web server exists.
 *
 * `webServer` is optional: a headless profile has none, and the plugin then
 * loads as a no-op instead of staying PENDING forever.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposers = OPERATIONS.map(op => webCtx.webServer.register({
        kind: 'exact',
        path: `${ROUTE_PREFIX}/${op}`,
        handler: createHandler(webCtx, op),
      }))
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-session-actions: routes')
  })
}
