/**
 * Browser-half behavior of `dsh-session-actions`.
 *
 * The half is a loader closure-factory artifact that decorates rendered
 * sidebar markup, so two failure modes only a browser would otherwise reveal
 * are covered here: a malformed factory face (the plugin silently never
 * applies) and a Conversation id that is resolved to the wrong row (the
 * destructive action lands on the wrong Conversation).
 *
 * A fake DOM and a minimal React stand in for the page. The React stub is
 * small but genuinely stateful, because the confirmation flow's whole point is
 * that it inspects before it offers the irreversible action — a stateless stub
 * could not reach the state where the delete button becomes pressable.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { installDom, installWindow, makeEvent } from './fake-dom.mjs'

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const FIBER_KEY = '__reactFiber$test'
const FRAGMENT = Symbol('Fragment')

/** Minimal React: element creation, a shared hook index, and dependency-aware effects. */
function makeReact() {
  let current = null
  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      return {
        type,
        props: {
          ...(props ?? {}),
          children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
        },
      }
    },
    useState(initial) {
      const instance = current
      const index = instance.hookIndex++
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial
      const set = (value) => {
        instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value
        instance.rerender()
      }
      return [instance.hooks[index], set]
    },
    useEffect(effect, deps) {
      const instance = current
      const index = instance.hookIndex++
      const previous = instance.hooks[index]
      const changed = previous === undefined || deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, at) => !Object.is(value, previous.deps[at]))
      if (!changed) return
      if (typeof previous?.cleanup === 'function') previous.cleanup()
      instance.hooks[index] = { deps, cleanup: effect() }
    },
    useMemo(factory) {
      const instance = current
      const index = instance.hookIndex++
      if (!(index in instance.hooks)) instance.hooks[index] = factory()
      return instance.hooks[index]
    },
    useRef(value) {
      const instance = current
      const index = instance.hookIndex++
      if (!(index in instance.hooks)) instance.hooks[index] = { current: value }
      return instance.hooks[index]
    },
  }
  return {
    React,
    /** Run `body` with `instance` as the component whose hooks are current. */
    withInstance(instance, body) {
      const previous = current
      current = instance
      try {
        return body()
      } finally {
        current = previous
      }
    },
  }
}

/** Render one element tree into the fake DOM. */
function makeRenderer(react, document) {
  function renderNode(element, instance) {
    if (element === null || element === undefined || typeof element === 'boolean') return null
    if (typeof element === 'string' || typeof element === 'number') return document.createTextNode(String(element))
    if (Array.isArray(element)) {
      const fragment = document.createDocumentFragment()
      for (const child of element) {
        const rendered = renderNode(child, instance)
        if (rendered !== null) fragment.appendChild(rendered)
      }
      return fragment
    }
    const { type, props } = element
    if (type === FRAGMENT) return renderNode(props?.children ?? null, instance)
    if (typeof type === 'function') {
      return react.withInstance(instance, () => renderNode(type(props ?? {}), instance))
    }
    const node = document.createElement(type)
    for (const [name, value] of Object.entries(props ?? {})) {
      if (name === 'children' || name === 'key' || value === undefined || value === null || value === false) continue
      if (name === 'className') {
        node.setAttribute('class', String(value))
        continue
      }
      if (name.startsWith('on') && typeof value === 'function') {
        node.addEventListener(name.slice(2).toLowerCase(), value)
        continue
      }
      node.setAttribute(name, value === true ? '' : String(value))
    }
    const children = props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      const rendered = renderNode(child, instance)
      if (rendered !== null) node.appendChild(rendered)
    }
    return node
  }

  const makeRoot = (container) => {
    let instance = null
    const root = {
      render(element) {
        // One persistent hook instance per root: the confirmation flow's state
        // only exists if a re-render resumes where the previous one stopped.
        if (instance === null) {
          instance = { hooks: [], hookIndex: 0, rerender: () => { root.render(instance.last) } }
        }
        instance.last = element
        instance.hookIndex = 0
        container.replaceChildren()
        const node = renderNode(element, instance)
        if (node !== null) container.appendChild(node)
      },
      unmount() {
        container.replaceChildren()
        instance = null
      },
    }
    return root
  }
  return { makeRoot }
}

/** Module table handed to the loader factory. */
function makeRequire(react, renderer, options) {
  const primitives = {
    IconCopyOutline16: () => react.React.createElement('svg', { 'data-icon': 'copy' }),
    IconTrashOutline16: () => react.React.createElement('svg', { 'data-icon': 'trash' }),
    writeClipboard: (text) => {
      // A denied write answers false, the way the real primitive reports a
      // refused permission instead of throwing.
      if (options.denyClipboard === true) return Promise.resolve(false)
      options.clipboard.push(text)
      return Promise.resolve(true)
    },
    fileSizeText: (bytes) => `${bytes}B`,
    Modal: (props) => react.React.createElement('div', {
      role: 'dialog',
      'aria-label': props.title,
    }, props.description, props.footer, props.children),
    Button: (props) => react.React.createElement('button', {
      type: 'button',
      className: props.className,
      disabled: props.disabled,
      onClick: props.onClick,
    }, props.children),
  }
  const modules = {
    react: react.React,
    'react-dom': { flushSync: (body) => body() },
    'react-dom/client': { createRoot: (container) => renderer.makeRoot(container) },
    '@deepseek-ai/dsh-client-ui-primitives': primitives,
  }
  return name => {
    if (!(name in modules)) throw new Error(`unexpected module request: ${name}`)
    return modules[name]
  }
}

/** Load the browser half and return the plugin face it registers. */
async function loadPlugin(require) {
  let captured = null
  globalThis.window = {
    ...(globalThis.window ?? {}),
    __ModuleLoader__: { load: (spec) => { captured = spec } },
  }
  await import(`../client.js?cachebust=${Math.random()}`)
  assert.notEqual(captured, null, 'the half must register itself on the module queue')
  return { spec: captured, face: captured.factory(require) }
}

/**
 * Build a Conversation row whose React fiber carries the row props, exactly as
 * the shipped `SessionNodeItem` publishes them.
 * @returns the row, its title span, its action button, and the recorded calls.
 */
function makeRow(document, { id = SESSION, title = 'A conversation', blank = false } = {}) {
  const calls = { rename: [], archive: [] }
  const rowProps = {
    node: { id, title, blank },
    onRename: (sessionId, currentTitle) => { calls.rename.push([sessionId, currentTitle]) },
    onArchive: (sessionId) => { calls.archive.push(sessionId) },
    onFork: () => {},
  }
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  const titleSpan = document.createElement('span')
  titleSpan.textContent = title
  row.appendChild(titleSpan)
  const actions = document.createElement('span')
  const button = document.createElement('button')
  button.setAttribute('aria-label', 'menu')
  actions.appendChild(button)
  row.appendChild(actions)
  const rowFiber = { memoizedProps: rowProps, return: null }
  row[FIBER_KEY] = { memoizedProps: { className: 'sessionRow' }, return: rowFiber }
  return { row, titleSpan, button, rowFiber, calls }
}

/**
 * Build one portalled Conversation menu, wired to `rowFiber` through the React
 * tree the way the Harness's own `Menu` portal is.
 * @returns the menu element and its three rendered rows.
 */
function makeMenu(document, rowFiber, labels = ['重命名', '分叉会话', '归档会话']) {
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  const viewport = document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  for (const label of labels) {
    const wrap = document.createElement('div')
    const item = document.createElement('button')
    item.setAttribute('role', 'menuitem')
    // A CSS-module hash: the half cannot name it, so it must clone it.
    item.setAttribute('class', 'item_hash')
    const icon = document.createElement('span')
    icon.appendChild(document.createElement('svg'))
    const text = document.createElement('span')
    text.textContent = label
    item.appendChild(icon)
    item.appendChild(text)
    wrap.appendChild(item)
    viewport.appendChild(wrap)
  }
  menu.appendChild(viewport)
  // list fiber -> portal fiber -> Menu fiber -> the row's own fiber.
  const menuFiber = { memoizedProps: { open: true, items: [] }, return: rowFiber }
  const portalFiber = { memoizedProps: { children: null }, return: menuFiber }
  menu[FIBER_KEY] = { memoizedProps: { role: 'menu' }, return: portalFiber }
  return menu
}

/** A browser context exposing only what the half reads. */
function makeCtx(options = {}) {
  const state = {
    refreshed: 0,
    cleared: 0,
    removed: [],
    current: undefined,
    cleanups: [],
    dictionary: null,
  }
  const sessions = {
    refresh: () => { state.refreshed += 1; return Promise.resolve() },
    clear: () => { state.cleared += 1 },
    list: { getSnapshot: () => ({ current: state.current }) },
  }
  // The Session store's removal entry point. A deployment without it exercises
  // the re-pull fallback, so the stub can drop it.
  if (options.withoutRemoval !== true) {
    sessions.handleSessionRemoved = (sessionId) => {
      if (options.removalThrows === true) throw new Error('store refused the removal')
      state.removed.push(sessionId)
    }
  }
  const ctx = {
    effect(fn) {
      const dispose = fn()
      state.cleanups.push(dispose)
      return dispose
    },
    locale: {
      register(_ns, dictionaries) {
        state.dictionary = dictionaries
        return () => {}
      },
      bind() {
        return (key, params) => {
          const template = state.dictionary?.zh?.[key] ?? key
          return Object.entries(params ?? {}).reduce(
            (text, [name, value]) => text.replace(`{${name}}`, String(value)),
            template,
          )
        }
      },
    },
    sessions,
  }
  return { ctx, state }
}

/** Install a fetch stub that answers the two Host operations. */
function stubFetch(options) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method, type: init.headers['content-type'] })
    const op = url.split('/').pop()
    if (op === 'inspect') {
      return { status: 200, json: async () => ({ ok: true, value: options.inspect }) }
    }
    if (options.deleteFails === true) {
      const code = options.deleteErrorCode ?? 'session-running'
      return { status: 409, json: async () => ({ ok: false, error: { code, message: code } }) }
    }
    return { status: 200, json: async () => ({ ok: true, value: { sessionId: SESSION, freedBytes: 2048 } }) }
  }
  return calls
}

/** Boot the half against a fresh fake page. */
async function boot(options = {}) {
  const document = installDom()
  const window = installWindow(options.viewport)
  const react = makeReact()
  const renderer = makeRenderer(react, document)
  const clipboard = []
  const clipboardOptions = { clipboard, denyClipboard: false }
  const require = makeRequire(react, renderer, clipboardOptions)
  const { face } = await loadPlugin(require)
  const { ctx, state } = makeCtx(options)
  face.apply(ctx)
  return { document, window, face, ctx, state, clipboard, clipboardOptions, renderer }
}

/** Let the confirmation flow's awaited Host calls settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

test('the artifact registers a well-formed browser plugin face', async () => {
  const document = installDom()
  const react = makeReact()
  const require = makeRequire(react, makeRenderer(react, document), { clipboard: [] })
  const { spec, face } = await loadPlugin(require)
  assert.equal(spec.id, 'dsh-session-actions')
  assert.equal(face.name, 'session-actions')
  assert.deepEqual(face.inject, ['sessions', 'locale'])
  assert.equal(typeof face.apply, 'function')
})

test('a Conversation menu gains a copy row and a destructive delete row, in that order', async (t) => {
  const { document, ctx, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)

  assert.equal(menu.getAttribute('data-dsa-menu'), SESSION)
  const rows = menu.querySelectorAll('[data-dsa-action]')
  assert.deepEqual(rows.map(item => item.getAttribute('data-dsa-action')), ['copy', 'delete'])
  const labels = rows.map(item => item.textContent)
  assert.equal(labels[0].includes(state.dictionary.zh.copyId), true)
  assert.equal(labels[1].includes(state.dictionary.zh.deleteSession), true)
  // The Harness's own rows are untouched and still first.
  assert.deepEqual(
    menu.querySelectorAll('[role="menuitem"]').slice(0, 3).map(item => item.textContent),
    ['重命名', '分叉会话', '归档会话'],
  )
  // Cloned rows keep the Harness's classes and gain their own glyph.
  assert.equal(rows[0].getAttribute('class'), 'item_hash')
  assert.equal(rows[1].getAttribute('class'), 'item_hash')
  assert.equal(rows[1].querySelector('svg').getAttribute('data-icon'), 'trash')
  assert.equal(rows[0].querySelector('svg').getAttribute('data-icon'), 'copy')
  assert.equal(ctx !== undefined, true)
})

test('a Workspace row menu is never decorated', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = document.createElement('div')
  row.setAttribute('role', 'treeitem')
  // A Workspace row carries a node but no archive verb.
  row[FIBER_KEY] = { memoizedProps: { node: { id: 'w1', label: 'work' }, onToggle: () => {} }, return: null }
  document.body.appendChild(row)
  const menu = makeMenu(document, row[FIBER_KEY], ['重命名', '删除工作区'])
  document.body.appendChild(menu)
  assert.equal(menu.getAttribute('data-dsa-menu'), null)
  assert.deepEqual(menu.querySelectorAll('[data-dsa-action]'), [])
})

test('Copy session ID writes the row id and dismisses the menu', async (t) => {
  const { document, state, clipboard } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  // The Harness's menu closes on the Escape the document receives; this stands
  // in for that listener, which the fake DOM has no React tree to install.
  const keys = []
  document.addEventListener('keydown', (event) => { keys.push(event.key) })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  const copy = menu.querySelector('[data-dsa-action="copy"]')
  copy.dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(clipboard, [SESSION])
  assert.deepEqual(keys, ['Escape'], 'the menu is dismissed once the id is copied')
})

test('a failed copy leaves the menu open to try again', async (t) => {
  const { document, state, clipboardOptions } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const keys = []
  document.addEventListener('keydown', (event) => { keys.push(event.key) })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  // The clipboard refuses this write, the way a denied permission does.
  clipboardOptions.denyClipboard = true
  menu.querySelector('[data-dsa-action="copy"]').dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(keys, [], 'nothing was copied, so the row stays for another try')
})

test('Delete session confirms before it destroys anything', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const calls = stubFetch({ inspect: { sessionId: SESSION, loaded: false, running: false, exists: true, sizeBytes: 2048, directories: ['/home/.dsh/sessions/p/' + SESSION] } })
  const row = makeRow(document, { title: 'Old chat' })
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))

  // Opening the surface only asks what would be destroyed; the destructive
  // call itself waits for a deliberate confirmation.
  assert.equal(calls.some(entry => entry.url.endsWith('/delete')), false)
  const dialog = document.body.querySelector('[role="dialog"]')
  assert.notEqual(dialog, null)
  assert.equal(dialog.getAttribute('aria-label'), state.dictionary.zh.deleteTitle)

  await settle()
  assert.deepEqual(calls.map(entry => entry.url), ['/api2/dsh-session-actions/inspect'])
  assert.deepEqual(calls[0].body, { sessionId: SESSION })
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].type, 'application/json')

  // Re-queried because the stub renderer rebuilds the tree on each state
  // change; the assertion is about the state the user can act on now.
  const buttons = document.body.querySelector('[role="dialog"]').querySelectorAll('button')
  assert.equal(buttons[1].hasAttribute('disabled'), false)
  buttons[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(calls.map(entry => entry.url), [
    '/api2/dsh-session-actions/inspect',
    '/api2/dsh-session-actions/delete',
  ])
  assert.deepEqual(state.removed, [SESSION], 'the list drops the row through its own removal path')
  assert.equal(state.refreshed, 0, 'a re-pull would merge the Host baseline back in')
})

test('a Conversation that is only attached is deletable, and the dialog says so', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const calls = stubFetch({ inspect: { sessionId: SESSION, loaded: true, running: false, exists: true, sizeBytes: 10, directories: ['/home/.dsh/sessions/p/' + SESSION] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()

  const dialog = document.body.querySelector('[role="dialog"]')
  const confirm = dialog.querySelectorAll('button')[1]
  assert.equal(confirm.hasAttribute('disabled'), false)
  assert.equal(dialog.textContent.includes(state.dictionary.zh.detailLoaded), true)
  confirm.dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(calls.map(entry => entry.url), [
    '/api2/dsh-session-actions/inspect',
    '/api2/dsh-session-actions/delete',
  ])
  assert.deepEqual(state.removed, [SESSION])
})

test('a running Conversation is reported as undeletable and the action stays disabled', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const calls = stubFetch({ inspect: { sessionId: SESSION, loaded: true, running: true, exists: true, sizeBytes: 10, directories: [] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()

  const dialog = document.body.querySelector('[role="dialog"]')
  assert.equal(dialog.textContent.includes(state.dictionary.zh.blockedRunning), true)
  const confirm = dialog.querySelectorAll('button')[1]
  assert.equal(confirm.hasAttribute('disabled'), true)
  confirm.dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(calls.map(entry => entry.url), ['/api2/dsh-session-actions/inspect'])
})

test('a rejected delete keeps the dialog open with the failure', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const calls = stubFetch({
    inspect: { sessionId: SESSION, loaded: false, running: false, exists: true, sizeBytes: 10, directories: [] },
    deleteFails: true,
  })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.equal(calls.length, 2)
  const dialog = document.body.querySelector('[role="dialog"]')
  assert.notEqual(dialog, null)
  assert.equal(dialog.textContent.includes(state.dictionary.zh.blockedRunning), true)
  assert.equal(state.refreshed, 0)
})

test('a turn that started between inspect and confirm is reported as running', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  // The Host half answers this code; the row was idle when it was inspected,
  // so only the delete itself can discover the turn.
  const calls = stubFetch({
    inspect: { sessionId: SESSION, loaded: true, running: false, exists: true, sizeBytes: 10, directories: [] },
    deleteFails: true,
  })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(document.body.querySelector('[role="dialog"]').textContent.includes(state.dictionary.zh.blockedRunning), true)
  assert.equal(state.refreshed, 0)
})

test('the renamed refusal code from an older Host half still blocks the action', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const calls = stubFetch({
    inspect: { sessionId: SESSION, loaded: true, running: false, exists: true, sizeBytes: 10, directories: [] },
    deleteFails: true,
    deleteErrorCode: 'session-live',
  })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.equal(calls.length, 2)
  assert.equal(document.body.querySelector('[role="dialog"]').textContent.includes(state.dictionary.zh.blockedRunning), true)
  assert.equal(state.refreshed, 0)
})

test('deleting the Conversation that is open clears the selection', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  state.current = SESSION
  stubFetch({ inspect: { sessionId: SESSION, loaded: true, running: false, exists: true, sizeBytes: 10, directories: [] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  // The pane renders the selection, so a removed row must not stay selected.
  assert.equal(state.cleared, 1)
  assert.deepEqual(state.removed, [SESSION])
})

test('deleting some other Conversation leaves the selection alone', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  state.current = 'session-99999999-8888-7777-6666-555555555555'
  stubFetch({ inspect: { sessionId: SESSION, loaded: false, running: false, exists: true, sizeBytes: 10, directories: [] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.equal(state.cleared, 0)
  assert.deepEqual(state.removed, [SESSION])
})

test('a store that rejects the local removal still converges by re-pulling', async (t) => {
  const { document, state } = await boot({ removalThrows: true })
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  stubFetch({ inspect: { sessionId: SESSION, loaded: false, running: false, exists: true, sizeBytes: 10, directories: [] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(state.removed, [])
  assert.equal(state.refreshed, 1)
})

test('a Session store without its removal entry point falls back to a re-pull', async (t) => {
  const { document, state } = await boot({ withoutRemoval: true })
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  stubFetch({ inspect: { sessionId: SESSION, loaded: false, running: false, exists: true, sizeBytes: 10, directories: [] } })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  menu.querySelector('[data-dsa-action="delete"]').dispatchEvent(makeEvent('click'))
  await settle()
  document.body.querySelector('[role="dialog"]').querySelectorAll('button')[1].dispatchEvent(makeEvent('click'))
  await settle()
  assert.deepEqual(state.removed, [])
  assert.equal(state.refreshed, 1)
})

test('a decorated menu is re-placed so its added rows stay inside the window', async (t) => {
  // A short window: the Harness placed the three-row menu from the height it
  // had before this half appended two more, so without a correction the card
  // would end below the fold.
  const { document, state } = await boot({ viewport: { width: 1200, height: 300 } })
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  row.button.rect = { left: 300, top: 240, right: 320, bottom: 268, width: 20, height: 28 }
  const menu = makeMenu(document, row.rowFiber)
  menu.rect = { left: 300, top: 272, right: 520, bottom: 452, width: 220, height: 180 }
  document.body.appendChild(menu)

  // No room below the trigger (272 + 180 > 300 - 12), but room above it, so the
  // card flips above: 240 - 4 - 180.
  assert.equal(menu.style.getPropertyValue('top'), '56px')
  assert.equal(menu.style.getPropertyPriority('top'), 'important')
  assert.equal(menu.style.getPropertyValue('left'), '300px')
})

test('a menu with room below stays under its trigger', async (t) => {
  const { document, state } = await boot({ viewport: { width: 1200, height: 800 } })
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  row.button.rect = { left: 300, top: 100, right: 320, bottom: 128, width: 20, height: 28 }
  const menu = makeMenu(document, row.rowFiber)
  menu.rect = { left: 300, top: 132, right: 520, bottom: 312, width: 220, height: 180 }
  document.body.appendChild(menu)
  assert.equal(menu.style.getPropertyValue('top'), '132px')
  assert.equal(menu.style.getPropertyValue('left'), '300px')
})

test('a menu taller than the window is pinned to the top margin', async (t) => {
  const { document, state } = await boot({ viewport: { width: 400, height: 300 } })
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  row.button.rect = { left: 380, top: 100, right: 400, bottom: 128, width: 20, height: 28 }
  const menu = makeMenu(document, row.rowFiber)
  // Taller than the window and wider than the space left of the trigger: the
  // card's own max-height scrolls, and the clamp keeps it against the margins.
  menu.rect = { left: 180, top: 132, right: 400, bottom: 532, width: 220, height: 400 }
  document.body.appendChild(menu)
  assert.equal(menu.style.getPropertyValue('top'), '12px')
  assert.equal(menu.style.getPropertyValue('left'), '168px')
})

test('an unmeasurable menu is left where the Harness put it', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  // No declared box: reading a position here would be guesswork.
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  assert.equal(menu.querySelectorAll('[data-dsa-action]').length, 2)
  assert.equal(menu.style.getPropertyValue('top'), '')
  assert.equal(menu.style.getPropertyValue('left'), '')
})

test('right-clicking a row opens that row\u2019s own menu and suppresses the native one', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, { title: 'Right me' })
  document.body.appendChild(row.row)
  const pressed = []
  row.button.addEventListener('click', () => { pressed.push('menu') })

  const event = makeEvent('contextmenu')
  row.titleSpan.dispatchEvent(event)
  assert.deepEqual(pressed, ['menu'], 'the Harness\u2019s own trigger is the only menu opened')
  assert.equal(event.defaultPrevented, true, 'the browser menu is replaced, not shown alongside')
})

test('right-clicking the row\u2019s own button opens the menu once, not twice', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const pressed = []
  row.button.addEventListener('click', () => { pressed.push('menu') })
  row.button.dispatchEvent(makeEvent('contextmenu'))
  assert.deepEqual(pressed, ['menu'])
})

test('right-clicking a blank New Session row or a non-row is ignored', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const blank = makeRow(document, { title: '新会话', blank: true })
  document.body.appendChild(blank.row)
  const pressed = []
  blank.button.addEventListener('click', () => { pressed.push('menu') })

  const onBlank = makeEvent('contextmenu')
  blank.titleSpan.dispatchEvent(onBlank)
  assert.deepEqual(pressed, [])
  assert.equal(onBlank.defaultPrevented, false, 'outside a Conversation row the native menu is untouched')

  const orphan = document.createElement('span')
  document.body.appendChild(orphan)
  const onOrphan = makeEvent('contextmenu')
  orphan.dispatchEvent(onOrphan)
  assert.equal(onOrphan.defaultPrevented, false)
})

test('right-clicking inside an open menu leaves it alone', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const pressed = []
  row.button.addEventListener('click', () => { pressed.push('menu') })
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)

  const event = makeEvent('contextmenu')
  menu.querySelector('[role="menuitem"]').dispatchEvent(event)
  assert.deepEqual(pressed, [], 'the menu the user is pointing at is not toggled shut')
  assert.equal(event.defaultPrevented, false)
})

test('double-clicking a row opens the built-in rename dialog through the row props', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, { title: 'Rename me' })
  document.body.appendChild(row.row)

  row.titleSpan.dispatchEvent(makeEvent('dblclick'))
  assert.deepEqual(row.calls.rename, [[SESSION, 'Rename me']])

  // The row's own controls keep their gestures.
  row.button.dispatchEvent(makeEvent('dblclick'))
  assert.equal(row.calls.rename.length, 1)
})

test('double-clicking a blank New Session row does nothing', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const row = makeRow(document, { title: '新会话', blank: true })
  document.body.appendChild(row.row)
  row.titleSpan.dispatchEvent(makeEvent('dblclick'))
  assert.deepEqual(row.calls.rename, [])
})

test('double-clicking outside any Conversation row is ignored', async (t) => {
  const { document, state } = await boot()
  t.after(() => { for (const dispose of state.cleanups) dispose() })
  const orphan = document.createElement('span')
  orphan.textContent = 'not a row'
  document.body.appendChild(orphan)
  assert.doesNotThrow(() => { orphan.dispatchEvent(makeEvent('dblclick')) })
})

test('disposing the plugin removes its chrome, listeners, and decoration', async (t) => {
  const { document, state } = await boot()
  const row = makeRow(document, {})
  document.body.appendChild(row.row)
  const menu = makeMenu(document, row.rowFiber)
  document.body.appendChild(menu)
  assert.equal(menu.querySelectorAll('[data-dsa-action]').length, 2)
  assert.notEqual(document.head.querySelector('[data-plugin]'), null)
  assert.notEqual(document.body.querySelector('[data-plugin]'), null)

  for (const dispose of state.cleanups) dispose()
  assert.equal(document.head.querySelector('[data-plugin]'), null)
  assert.equal(document.body.querySelector('[data-plugin]'), null)
  // The listener is gone: a later double-click reaches nothing.
  row.titleSpan.dispatchEvent(makeEvent('dblclick'))
  assert.deepEqual(row.calls.rename, [])
})
