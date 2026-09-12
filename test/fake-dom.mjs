/**
 * Minimal DOM for the browser half's tests.
 *
 * It implements exactly the surface `client.js` touches — a compound selector
 * matcher limited to tag names and attribute tests, capture/bubble event
 * dispatch with `stopPropagation`, deep cloning, and a MutationObserver that
 * delivers synchronously — so the half's wiring is exercised without pulling a
 * browser engine into the package's zero-dependency test run.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

/** Document sentinel every connected subtree hangs from. */
const DOCUMENT = { nodeName: '#document', parentNode: null }

/** Observers that receive every structural change. */
const observers = new Set()

/**
 * Match one compound selector: `tag`, `[attr]`, `[attr="value"]`, or a
 * combination of one tag with any number of attribute tests.
 * @param element - the candidate.
 * @param selector - the selector text.
 * @returns whether the element matches.
 */
function matchesSelector(element, selector) {
  const text = selector.trim()
  const tag = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text)
  if (tag !== null && element.tagName !== tag[0].toLowerCase()) return false
  const attributes = text.slice(tag === null ? 0 : tag[0].length)
  for (const [, name, value] of attributes.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) {
    if (!Object.hasOwn(element.attributes, name)) return false
    if (value !== undefined && element.attributes[name] !== value) return false
  }
  return true
}

/** Whether `node` is `ancestor` or sits inside it. */
function isWithin(node, ancestor) {
  let current = node
  while (current !== null && current !== undefined) {
    if (current === ancestor) return true
    current = current.parentNode
  }
  return false
}

/**
 * One structural change, delivered to every observer watching that subtree.
 * A detached subtree (a clone being built) reaches no observer, exactly as in
 * a browser.
 */
function notify(target, added, removed) {
  for (const observer of [...observers]) {
    if (!observer.observing || !isWithin(target, observer.target)) continue
    observer.callback([{ type: 'childList', target, addedNodes: added, removedNodes: removed }])
  }
}

/** An element's declared box; zero-sized until a test gives it one. */
function boxOf(element) {
  return element.rect ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
}

/** One declaration block: the inline properties the half writes and re-reads. */
class FakeStyle {
  constructor() {
    this.properties = new Map()
  }

  setProperty(name, value, priority = '') {
    this.properties.set(name, { value: String(value), priority: String(priority) })
  }

  getPropertyValue(name) {
    return this.properties.get(name)?.value ?? ''
  }

  getPropertyPriority(name) {
    return this.properties.get(name)?.priority ?? ''
  }
}

/** A DOM node with the traversal, attribute, event, and box surface the half uses. */
export class FakeNode {
  constructor(tagName) {
    this.tagName = tagName
    this.attributes = {}
    this.childNodes = []
    this.parentNode = null
    this.listeners = new Map()
    this.style = new FakeStyle()
    this.rect = null
  }

  /** The laid-out width, zero until a test declares a box. */
  get offsetWidth() {
    return boxOf(this).width
  }

  /** The laid-out height, zero until a test declares a box. */
  get offsetHeight() {
    return boxOf(this).height
  }

  getBoundingClientRect() {
    return { ...boxOf(this) }
  }

  get parentElement() {
    return this.parentNode instanceof FakeNode ? this.parentNode : null
  }

  get children() {
    return this.childNodes.filter(node => node instanceof FakeNode)
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === DOCUMENT
  }

  get textContent() {
    return this.childNodes.map(node => node.textContent).join('')
  }

  set textContent(value) {
    this.replaceChildren()
    if (String(value).length > 0) this.appendChild(new FakeText(String(value)))
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  hasAttribute(name) {
    return Object.hasOwn(this.attributes, name)
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  /** Every descendant matching `selector`, in document order. */
  querySelectorAll(selector) {
    const found = []
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector) {
    let node = this
    while (node !== null) {
      if (node instanceof FakeNode && node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }

  appendChild(node) {
    // A fragment contributes its children, not itself.
    if (node.tagName === '#fragment') {
      for (const child of [...node.childNodes]) this.appendChild(child)
      return node
    }
    node.parentNode?.removeChild(node)
    this.childNodes.push(node)
    node.parentNode = this
    notify(this, [node], [])
    return node
  }

  removeChild(node) {
    const at = this.childNodes.indexOf(node)
    if (at < 0) return node
    this.childNodes.splice(at, 1)
    node.parentNode = null
    notify(this, [], [node])
    return node
  }

  replaceChildren(...nodes) {
    const removed = [...this.childNodes]
    for (const node of removed) node.parentNode = null
    this.childNodes = []
    if (removed.length > 0) notify(this, [], removed)
    for (const node of nodes) this.appendChild(node)
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  /**
   * Press this element, as a browser's own `HTMLElement.click()` does: one
   * bubbling, cancelable `click` event with this element as its target.
   */
  click() {
    this.dispatchEvent(makeEvent('click'))
  }

  cloneNode(deep = false) {
    const copy = new this.constructor(this.tagName)
    copy.attributes = { ...this.attributes }
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true))
    return copy
  }

  addEventListener(type, listener) {
    const bucket = this.listeners.get(type) ?? []
    bucket.push(listener)
    this.listeners.set(type, bucket)
  }

  removeEventListener(type, listener) {
    const bucket = (this.listeners.get(type) ?? []).filter(entry => entry !== listener)
    this.listeners.set(type, bucket)
  }

  /** Deliver one event through capture, target, and bubble listeners. */
  dispatchEvent(event) {
    // Defined rather than assigned: a real Event exposes `target` as a
    // prototype getter, so assignment throws in strict mode, and the half
    // dispatches genuine KeyboardEvents.
    Object.defineProperty(event, 'target', { value: this, writable: true, configurable: true })
    event._stopped = false
    const path = []
    let node = this
    while (node !== null) {
      path.push(node)
      node = node.parentNode
    }
    for (const current of [...path].reverse()) {
      if (typeof current.dispatchCapture === 'function') current.dispatchCapture(event)
    }
    for (const current of path) {
      if (event._stopped) break
      current.dispatchLocal?.(event)
      if (event._stopped) break
    }
    return true
  }

  /** Invoke this node's own non-capture listeners. A disabled button answers nothing. */
  dispatchLocal(event) {
    if (this.tagName === 'button' && this.hasAttribute('disabled')) return
    for (const listener of this.listeners.get(event.type) ?? []) listener(event)
  }
}

/** Text node; only concatenation and cloning matter here. */
class FakeText {
  constructor(text) {
    this.textContent = text
    this.parentNode = null
  }

  cloneNode() {
    return new FakeText(this.textContent)
  }
}

/** The document root: owns `head`/`body` and the capture/bubble listeners. */
class FakeDocument extends FakeNode {
  constructor() {
    super('#document')
    this.parentNode = DOCUMENT
    this.captureListeners = new Map()
    this.head = new FakeNode('head')
    this.body = new FakeNode('body')
    this.head.parentNode = this
    this.body.parentNode = this
  }

  createElement(tagName) {
    return new FakeNode(tagName)
  }

  createTextNode(text) {
    return new FakeText(text)
  }

  createDocumentFragment() {
    return new FakeNode('#fragment')
  }

  addEventListener(type, listener, capture = false) {
    if (!capture) {
      super.addEventListener(type, listener)
      return
    }
    const bucket = this.captureListeners.get(type) ?? []
    bucket.push(listener)
    this.captureListeners.set(type, bucket)
  }

  removeEventListener(type, listener, capture = false) {
    if (!capture) {
      super.removeEventListener(type, listener)
      return
    }
    const bucket = (this.captureListeners.get(type) ?? []).filter(entry => entry !== listener)
    this.captureListeners.set(type, bucket)
  }

  /** Capture-phase delivery happens at the document before the target. */
  dispatchCapture(event) {
    for (const listener of this.captureListeners.get(event.type) ?? []) {
      listener(event)
      if (event._stopped) return
    }
  }
}

/**
 * Install the fake document, Element class, and MutationObserver onto the
 * global scope, the way a browser would.
 * @returns the fake document.
 */
export function installDom() {
  const document = new FakeDocument()
  globalThis.document = document
  globalThis.Element = FakeNode
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback
      this.observing = false
    }

    observe(target) {
      this.target = target
      this.observing = true
      observers.add(this)
    }

    disconnect() {
      this.observing = false
      observers.delete(this)
    }

    takeRecords() {
      return []
    }
  }
  installWindow()
  return document
}

/**
 * Install the fake window, which the half reads for viewport size and listens
 * to for the scroll/resize that re-run the Harness's own menu placement.
 * @param options.width - the window's inner width.
 * @param options.height - the window's inner height.
 * @returns the fake window.
 */
export function installWindow({ width = 1200, height = 800 } = {}) {
  const listeners = new Map()
  const window = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).concat(listener))
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener))
    },
    /** Deliver one event to this window's listeners, as a resize/scroll does. */
    dispatchEvent(event) {
      for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event)
      return true
    },
    /** How many listeners of one type are registered: disposal assertions read this. */
    listenerCount(type) {
      return (listeners.get(type) ?? []).length
    },
  }
  globalThis.window = window
  return window
}

/** One synthetic event with the members the half reads. */
export function makeEvent(type) {
  return {
    type,
    target: null,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this._stopped = true },
  }
}
