/**
 * `dsh-session-actions` browser half.
 *
 * The sidebar's Conversation rows are not extensible: `SessionNodeItem` builds
 * its own `Menu` items inline and registers no seat for a plugin to contribute
 * to, so this half decorates the rendered result instead of composing into it.
 * Four gestures are added:
 *
 *   1. double-clicking a row (outside its buttons) opens the **built-in**
 *      rename dialog, by calling the very `onRename` callback the row's own
 *      menu item calls — no second rename implementation exists;
 *   2. right-clicking a row opens that same built-in menu, by pressing the
 *      trigger the row already renders, so no second menu exists either;
 *   3. **Copy session ID** is appended to the row menu, and dismisses that menu
 *      once the id is on the clipboard;
 *   4. **Delete session** is appended below it, styled destructive, and opens a
 *      confirmation dialog that inspects the Conversation before offering the
 *      irreversible action. On success the row leaves the list through the
 *      Session store's own removal entry point, and deleting the Conversation
 *      that is open returns the layout to its empty state.
 *
 * Appending rows makes the menu taller than the Harness measured it while
 * placing it, so this half also re-places every menu it decorated from the
 * card's real size — otherwise the last rows of a menu opened in the lower part
 * of a short window fall below the fold.
 *
 * Every session id here comes from the React tree, never from the DOM text:
 * the row's own fiber carries the row props (`node`, `onRename`, `onArchive`),
 * so this half reads the id, the title, and the callback that the Harness
 * itself would have used. Matching rendered titles against the session list
 * would be ambiguous for two Conversations with the same name, and the row
 * markup carries no id attribute to read.
 *
 * The cost is a dependency on React's internal fiber property and on the row
 * props' names. Those props are not minified in the shipped Client bundle
 * (`onRename`/`onArchive`/`sessionMenuItems` are present verbatim in the
 * packaged application), and every lookup degrades to "no decoration" rather
 * than to a wrong Conversation: if the fiber walk finds nothing, the menu is
 * left exactly as the Harness rendered it and the double-click is ignored.
 *
 * This file is the loader's closure-factory artifact by hand, so the package
 * needs no client build step: it registers a factory on the page's module
 * queue and resolves React, React DOM, and the primitives through the module
 * table the shell seeds.
 */

window.__ModuleLoader__.load({
	id: 'dsh-session-actions',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports

		/** Locale namespace owning this half's copy. */
		const COPY_NS = 'dsh.sessionTools'

		/** Marks a menu this half decorated; the value is the Session id. */
		const MENU_ATTR = 'data-dsa-menu'

		/** Marks one of this half's rows; the value is its action. */
		const ACTION_ATTR = 'data-dsa-action'

		/** Carries the Session id on this half's menu rows. */
		const SESSION_ATTR = 'data-dsa-session'

		/** Carries the displayed title on this half's delete row. */
		const TITLE_ATTR = 'data-dsa-title'

		/** React's own expando keys on a DOM node, one per rendered root. */
		const FIBER_KEY = /^__reactFiber\$|^__reactInternalInstance\$/

		/** The two operations this half drives on the Host surface. */
		const ROUTE_PREFIX = '/api2/dsh-session-actions'

		/** Distance the Harness keeps between a menu card and the viewport edge. */
		const MENU_MARGIN = 12

		/** Distance the Harness keeps between a menu card and its trigger. */
		const MENU_GAP = 4

		const zh = {
			copyId: '复制会话 ID',
			deleteSession: '删除会话',
			deleteTitle: '永久删除会话',
			deleteDesc: '“{title}”的对话记录、投影缓存与工作区记录将被永久删除，且无法恢复。',
			deleteShared: '附件对象按内容寻址并可能与其他会话共享，不会一并删除。',
			deletePending: '正在删除…',
			deleteConfirm: '永久删除',
			inspecting: '正在检查该会话…',
			cancel: '取消',
			close: '关闭',
			blockedRunning: '该会话正在运行中（有回合正在执行），此时删除会丢掉它正在写入的内容。请等这一轮结束后再删除。',
			blockedMissing: '磁盘上已经没有这个会话的记录，但会话列表里还留着它这一行。继续即把它从列表里清掉，不留任何痕迹。',
			removeRow: '从列表移除',
			detail: '将删除 {size} 数据，共 {count} 个目录。',
			detailPath: '位置：{path}',
			detailLoaded: '该会话当前处于打开状态：确认后它会立即从会话列表消失，进程内的副本在重启应用后彻底释放。',
			failed: '删除失败：{message}',
		}

		const en = {
			copyId: 'Copy session ID',
			deleteSession: 'Delete session',
			deleteTitle: 'Delete session permanently',
			deleteDesc: '“{title}”, its transcript, its projection cache, and its workspace record will be permanently deleted. This cannot be undone.',
			deleteShared: 'Attachment objects are content-addressed and may be shared with other sessions, so they are not removed.',
			deletePending: 'Deleting…',
			deleteConfirm: 'Delete permanently',
			inspecting: 'Inspecting this session…',
			cancel: 'Cancel',
			close: 'Close',
			removeRow: 'Remove from list',
			blockedRunning: 'This session is running a turn right now; deleting it would discard what that turn is writing. Wait for it to finish, then delete it.',
			blockedMissing: 'Disk no longer holds this session, and the conversation list is still showing its row. Continuing clears the row, leaving no trace.',
			detail: 'Deletes {size} across {count} directories.',
			detailPath: 'Location: {path}',
			detailLoaded: 'This session is open right now: it leaves the list immediately, and the in-process copy is released when the app restarts.',
			failed: 'Delete failed: {message}',
		}

		/** Destructive row and action styling; the base classes stay the Harness's own. */
		const CSS = [
			'[' + ACTION_ATTR + '="delete"][role="menuitem"],',
			'[' + ACTION_ATTR + '="delete"][role="menuitem"] span,',
			'[' + ACTION_ATTR + '="delete"][role="menuitem"] svg {',
			'  color: var(--dsw-alias-state-error-primary);',
			'}',
			'[' + ACTION_ATTR + '="delete"][role="menuitem"]:hover:not(:disabled) {',
			'  background: var(--dsw-alias-interactive-bg-hover-danger);',
			'}',
			'.dsa-danger:not(:disabled) { color: var(--dsw-alias-state-error-primary); }',
			'.dsa-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }',
			'.dsa-error { margin-top: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }',
			'.dsa-detail { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }',
		].join('\n')

		/**
		 * Resolve the two React DOM entrypoints this half needs.
		 *
		 * `createRoot` lives on `react-dom/client` and `flushSync` on
		 * `react-dom`; both are seeded by the shell, but the module table hands
		 * back a namespace whose `default` member varies with how the shell
		 * interops the package.
		 * @param req - the factory's module resolver.
		 * @returns the constructor and the synchronous-flush helper, when present.
		 */
		function reactDomOf(req) {
			const client = req('react-dom/client')
			const dom = req('react-dom')
			const root = client?.createRoot ?? client?.default?.createRoot ?? dom?.createRoot ?? dom?.default?.createRoot
			const flush = dom?.flushSync ?? dom?.default?.flushSync
			return { createRoot: root, flushSync: flush }
		}

		/**
		 * Enumerable own properties of one DOM node whose name is a React expando.
		 * @param node - a rendered DOM element.
		 * @returns the expando property names.
		 */
		function fiberKeys(node) {
			const own = Object.keys(node)
			const found = own.filter(key => FIBER_KEY.test(key))
			if (found.length > 0) return found
			return Object.getOwnPropertyNames(node).filter(key => FIBER_KEY.test(key))
		}

		/**
		 * Whether one fiber's props are a Conversation row's props.
		 *
		 * `onArchive` is the discriminator: a Workspace row carries `node` and
		 * `onToggle`/`onCreate`, but only a Conversation row is archivable and
		 * renameable together.
		 * @param props - a fiber's `memoizedProps`.
		 * @returns true for a Conversation row's props.
		 */
		function isRowProps(props) {
			return props !== null && typeof props === 'object'
				&& props.node !== null && typeof props.node === 'object'
				&& typeof props.node.id === 'string'
				&& typeof props.onRename === 'function'
				&& typeof props.onArchive === 'function'
		}

		/**
		 * Read the Conversation row props above one rendered element.
		 * @param node - any element inside a row, or the portalled menu itself.
		 * @returns the row props, or null when none owns this element.
		 */
		function rowPropsFrom(node) {
			if (!(node instanceof Element)) return null
			for (const key of fiberKeys(node)) {
				let fiber = node[key]
				while (fiber !== null && fiber !== undefined) {
					if (isRowProps(fiber.memoizedProps)) return fiber.memoizedProps
					fiber = fiber.return
				}
			}
			return null
		}

		/**
		 * Every element in one added subtree matching a selector, including the
		 * subtree root.
		 * @param node - a node the observer just saw added.
		 * @param selector - the selector to match.
		 * @returns the matching elements.
		 */
		function collect(node, selector) {
			if (!(node instanceof Element)) return []
			const found = Array.from(node.querySelectorAll(selector))
			return node.matches(selector) ? [node].concat(found) : found
		}

		/**
		 * The icon and label slots of a rendered menu row.
		 *
		 * The Harness's menu classes are CSS-module hashes this half cannot
		 * name, so the slots are found by what they contain: the icon slot holds
		 * the glyph, the label slot holds the text.
		 * @param button - a rendered `role="menuitem"` button.
		 * @returns the two slots, either of which may be absent.
		 */
		function slotsOf(button) {
			const spans = Array.from(button.children)
			const icon = spans.find(span => span.querySelector('svg') !== null) ?? null
			const label = spans.find(span => span !== icon && span.querySelector('svg') === null) ?? null
			return { icon, label }
		}

		/**
		 * Build one extra menu row by cloning a rendered one, so every class,
		 * size, and hover behaviour stays the Harness's instead of a restatement
		 * of it, then replacing the glyph and the text.
		 * @param template - a rendered `role="menuitem"` button to clone.
		 * @param action - this row's action id.
		 * @param label - localized row text.
		 * @param icon - the glyph node to place in the icon slot.
		 * @returns the cloned row wrapper, or null when the template is unexpected.
		 */
		function buildRow(template, action, label, icon) {
			const wrapper = template.parentElement
			if (wrapper === null) return null
			const clone = wrapper.cloneNode(true)
			const button = clone.querySelector('button')
			if (button === null) return null
			button.removeAttribute('disabled')
			button.setAttribute(ACTION_ATTR, action)
			const slots = slotsOf(button)
			// The clone drops React's fiber, so nothing here re-enters the row's
			// own click handling; this half owns the row from now on.
			if (slots.icon !== null) slots.icon.replaceChildren(icon.cloneNode(true))
			if (slots.label !== null) slots.label.textContent = label
			return { wrapper: clone, button, label: slots.label }
		}

		/**
		 * Register this half against the browser context.
		 * @param ctx - browser Cordis context carrying `sessions` and `locale`.
		 */
		function apply(ctx) {
			const React = require('react')
			const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
			const { createRoot, flushSync } = reactDomOf(require)
			const h = React.createElement

			ctx.effect(() => ctx.locale.register(COPY_NS, { zh, en }), 'dsh-session-actions: copy')
			const t = ctx.locale.bind(COPY_NS)

			/**
			 * Render one React element to a detached DOM node, synchronously.
			 *
			 * The menu rows are built during a mutation callback, so an
			 * asynchronously committed render would hand back an empty node.
			 * @param element - the element to rasterize.
			 * @returns the rendered node.
			 */
			function rasterize(element) {
				const holder = document.createElement('div')
				const root = createRoot(holder)
				flushSync(() => { root.render(element) })
				const rendered = holder.firstElementChild
				root.unmount()
				return rendered
			}

			// Glyphs are rasterized once: the menu is rebuilt on every open, and a
			// render per row would put React work inside the observer callback.
			const glyphs = {
				copy: rasterize(h(primitives.IconCopyOutline16, null)),
				delete: rasterize(h(primitives.IconTrashOutline16, null)),
			}

			const style = document.createElement('style')
			style.setAttribute('data-plugin', COPY_NS)
			style.textContent = CSS
			document.head.appendChild(style)

			/** Portalled host for the confirmation dialog, mounted once. */
			const dialogHost = document.createElement('div')
			dialogHost.setAttribute('data-plugin', COPY_NS)
			document.body.appendChild(dialogHost)
			const dialogRoot = createRoot(dialogHost)

			/**
			 * Call one Host operation on the plugin's JSON surface.
			 * @param op - the operation name.
			 * @param sessionId - the Conversation the operation addresses.
			 * @returns the parsed envelope; a transport failure becomes one too.
			 */
			async function call(op, sessionId) {
				let response
				try {
					response = await fetch(`${ROUTE_PREFIX}/${op}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId }),
					})
				} catch (error) {
					return { ok: false, error: { code: 'transport', message: String(error) } }
				}
				try {
					return await response.json()
				} catch {
					return { ok: false, error: { code: 'transport', message: `HTTP ${response.status}` } }
				}
			}

			/**
			 * The confirmation surface.
			 *
			 * It inspects the Conversation before offering the irreversible
			 * action: a Session whose Agent is running cannot be removed
			 * without losing what that turn is writing, and saying so up front
			 * is better than unlinking a log a running turn still appends to.
			 * An attached-but-idle Session is deletable — the row leaves the
			 * list with the storage.
			 * @param props.request - the pending deletion.
			 * @param props.onClose - withdraw the request.
			 * @param props.onDeleted - the Conversation is gone; refresh the list.
			 * @returns the dialog.
			 */
			function ConfirmDelete({ request, onClose, onDeleted }) {
				const [phase, setPhase] = React.useState('checking')
				const [report, setReport] = React.useState(null)
				const [message, setMessage] = React.useState(null)

				React.useEffect(() => {
					let cancelled = false
					void (async () => {
						const result = await call('inspect', request.sessionId)
						if (cancelled) return
						if (result.ok !== true) {
							setPhase('error')
							setMessage(result.error?.message ?? 'inspect failed')
							return
						}
						setReport(result.value)
						setPhase(result.value.running === true
							? 'blocked-running'
							: result.value.exists === true ? 'ready' : 'blocked-missing')
					})()
					return () => { cancelled = true }
				}, [request.sessionId])

				const busy = phase === 'deleting'
				// A row whose storage is already gone is still removable: the
				// Host's delete path prunes what is left and announces the
				// removal, so the list drops it exactly like a real deletion.
				const actionable = phase === 'ready' || phase === 'blocked-missing'
				const confirm = () => {
					setPhase('deleting')
					setMessage(null)
					void (async () => {
						const result = await call('delete', request.sessionId)
						if (result.ok === true) {
							onDeleted()
							return
						}
						// `session-live` is the code an older Host half answers
						// with; both mean the same refusal to this surface.
						const code = result.error?.code
						setPhase(code === 'session-running' || code === 'session-live'
							? 'blocked-running'
							: 'error')
						setMessage(result.error?.message ?? 'delete failed')
					})()
				}

				const body = []
				if (phase === 'checking') {
					body.push(h('div', { key: 'checking', className: 'dsa-status' }, t('inspecting')))
				}
				if (phase === 'deleting') {
					body.push(h('div', { key: 'deleting', className: 'dsa-status', role: 'status' }, t('deletePending')))
				}
				if (phase === 'blocked-running' || phase === 'blocked-missing') {
					body.push(h('div', {
						key: 'blocked',
						className: 'dsa-error',
						role: 'alert',
					}, phase === 'blocked-running' ? t('blockedRunning') : t('blockedMissing')))
				}
				if (report !== null && (phase === 'ready' || phase === 'deleting')) {
					body.push(h('div', { key: 'detail', className: 'dsa-detail' }, t('detail', {
						size: primitives.fileSizeText(report.sizeBytes),
						count: String(report.directories.length),
					})))
					if (report.directories.length > 0) {
						body.push(h('div', { key: 'path', className: 'dsa-detail' }, t('detailPath', {
							path: report.directories[0],
						})))
					}
					if (report.loaded === true) {
						body.push(h('div', { key: 'loaded', className: 'dsa-detail' }, t('detailLoaded')))
					}
					body.push(h('div', { key: 'shared', className: 'dsa-detail' }, t('deleteShared')))
				}
				if (phase === 'error' && message !== null) {
					body.push(h('div', { key: 'error', className: 'dsa-error', role: 'alert' }, t('failed', { message })))
				}

				return h(primitives.Modal, {
					open: true,
					onClose: onClose,
					closeLabel: t('close'),
					title: t('deleteTitle'),
					description: t('deleteDesc', { title: request.title }),
					footer: h(React.Fragment, null,
						h(primitives.Button, { variant: 'outline', disabled: busy, onClick: onClose }, t('cancel')),
						h(primitives.Button, {
							variant: 'outline',
							className: 'dsa-danger',
							disabled: busy || !actionable,
							onClick: confirm,
						}, phase === 'blocked-missing' ? t('removeRow') : t('deleteConfirm'))),
				}, body)
			}

			/** The deletion awaiting confirmation, or null. */
			let pending = null

			/** Show the confirmation dialog for one row. */
			function openDialog(sessionId, title) {
				pending = { sessionId, title }
				dialogRoot.render(h(ConfirmDelete, {
					request: pending,
					onClose: () => {
						pending = null
						dialogRoot.render(null)
					},
					onDeleted: () => {
						pending = null
						dialogRoot.render(null)
						const sessions = ctx.sessions
						try {
							// The conversation pane renders the *selection*, so deleting
							// the Conversation that is open right now has to take the pane
							// with it; the selection returns to the empty state.
							if (sessions.list?.getSnapshot?.().current === sessionId) sessions.clear()
							// Drive the Session store's own removal entry point — the very
							// method the Host's `api-session/removed` frame calls — rather
							// than wait for that frame and then re-pull: a re-pull merges
							// the Host's baseline back in, so any row the Host still
							// reports would return with it.
							if (typeof sessions.handleSessionRemoved === 'function') {
								sessions.handleSessionRemoved(sessionId)
								return
							}
						} catch {
							// The storage is already gone; a store that refuses the local
							// removal still converges by re-reading the Host below.
						}
						sessions.refresh().catch(() => {})
					},
				}))
			}

			/** Menus this half decorated, so a re-render that dropped rows is repaired. */
			const decorated = new Set()

			/** The trigger each decorated menu was opened from, for re-placement. */
			const anchors = new WeakMap()

			/**
			 * Where one menu belongs once its real size is known.
			 *
			 * The Harness places a portalled menu from the height it measures in
			 * the commit that opens it — before this half appends its two rows —
			 * so a menu opened from the lower part of a short window ends up
			 * with its last rows below the fold. This restates that placement
			 * (one gap below the trigger, one margin inside the viewport) using
			 * the menu's actual size, and flips the card above the trigger when
			 * the space below cannot hold it and the space above can.
			 * @param anchor - the trigger button's client rect.
			 * @param size - the menu's laid-out size.
			 * @param viewport - the window's inner size.
			 * @returns the fixed-position coordinates to apply.
			 */
			function menuPlacement(anchor, size, viewport) {
				const below = anchor.bottom + MENU_GAP
				const above = anchor.top - MENU_GAP - size.height
				const top = below + size.height > viewport.height - MENU_MARGIN && above >= MENU_MARGIN
					? above
					: below
				// A menu taller than the window stays at the top margin; its own
				// max-height scrolls the overflow rather than pushing it off-screen.
				return {
					left: Math.min(
						Math.max(anchor.left, MENU_MARGIN),
						Math.max(viewport.width - size.width - MENU_MARGIN, MENU_MARGIN),
					),
					top: Math.min(
						Math.max(top, MENU_MARGIN),
						Math.max(viewport.height - size.height - MENU_MARGIN, MENU_MARGIN),
					),
				}
			}

			/**
			 * Put one decorated menu where its real size allows.
			 * @param menu - a decorated `role="menu"` element.
			 */
			function place(menu) {
				const trigger = anchors.get(menu)
				if (trigger === undefined || !trigger.isConnected) return
				const width = menu.offsetWidth
				const height = menu.offsetHeight
				if (width === 0 || height === 0) return
				const position = menuPlacement(
					trigger.getBoundingClientRect(),
					{ width, height },
					{ width: window.innerWidth, height: window.innerHeight },
				)
				// `important` because the Harness owns these two properties on the
				// same element and would otherwise win with its stale-height value.
				menu.style.setProperty('left', `${position.left}px`, 'important')
				menu.style.setProperty('top', `${position.top}px`, 'important')
			}

			/**
			 * Re-place every decorated menu on the next macrotask.
			 *
			 * The Harness commits its own position from the pre-decoration
			 * height, both when the menu opens and again on every scroll or
			 * resize while it is open. Scheduling the correction means the write
			 * that survives is this half's, whichever order the two land in.
			 */
			function replaceAll() {
				setTimeout(() => {
					for (const menu of decorated) {
						if (menu.isConnected) place(menu)
					}
				}, 0)
			}

			/**
			 * Append this half's rows to one rendered Conversation menu.
			 *
			 * The menu is marked only once both rows are in place: a marker
			 * written first would describe a menu that a concurrent scan could
			 * then find rowless and decorate a second time.
			 * @param menu - the portalled `role="menu"` element.
			 */
			function decorate(menu) {
				const props = rowPropsFrom(menu)
				if (props === null) return
				const template = menu.querySelector('[role="menuitem"]')
				if (template === null) return
				const viewport = template.parentElement?.parentElement
				if (viewport === null || viewport === undefined) return
				const sessionId = props.node.id
				const title = typeof props.node.title === 'string' ? props.node.title : sessionId
				const rows = [
					{ action: 'copy', label: t('copyId'), icon: glyphs.copy },
					{ action: 'delete', label: t('deleteSession'), icon: glyphs.delete },
				]
				for (const row of rows) {
					const built = buildRow(template, row.action, row.label, row.icon)
					if (built === null) continue
					built.button.setAttribute(SESSION_ATTR, sessionId)
					built.button.setAttribute(TITLE_ATTR, title)
					viewport.appendChild(built.wrapper)
				}
				if (menu.querySelector('[' + ACTION_ATTR + ']') === null) return
				menu.setAttribute(MENU_ATTR, sessionId)
				decorated.add(menu)
				// Anchored on the row's own trigger, so the correction lands under
				// the same card the Harness positioned; the marker above is written
				// first so a second scan of this menu repairs rows, not placement.
				const row = rowElementFor(sessionId)
				const trigger = row === null ? null : menuTriggerOf(row)
				if (trigger === null) return
				anchors.set(menu, trigger)
				place(menu)
				// The Harness's own write for this open may still be in flight, so
				// the correction is repeated once that task has settled.
				replaceAll()
			}

			/** Guards the observer against the mutations this half's own decoration causes. */
			let scanning = false

			/**
			 * Decorate every Conversation menu in one added subtree, and repair a
			 * decorated menu whose rows a re-render removed.
			 * @param node - a node the observer just saw added.
			 */
			function scan(node) {
				if (scanning) return
				scanning = true
				try {
					for (const menu of collect(node, '[role="menu"]')) {
						if (menu.getAttribute(MENU_ATTR) === null) decorate(menu)
					}
					for (const menu of [...decorated]) {
						if (!menu.isConnected) {
							decorated.delete(menu)
							continue
						}
						if (menu.querySelector('[' + ACTION_ATTR + ']') === null) decorate(menu)
					}
				} finally {
					scanning = false
				}
			}

			/**
			 * One Escape keydown: the event the Harness's menu closes on.
			 *
			 * A real `KeyboardEvent` everywhere this half ships; the plain-`Event`
			 * arm is for a host without the constructor (the `node:test` harness),
			 * which still needs the `key` the listener reads.
			 * @returns the event to dispatch.
			 */
			function escapeKeydown() {
				return typeof KeyboardEvent === 'function'
					? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
					: Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' })
			}

			/**
			 * Dismiss the menu one of this half's rows belongs to.
			 *
			 * The row component owns the menu's open state and listens for Escape
			 * on the document, so this sends the gesture the user would send
			 * instead of fabricating an outside click that other surfaces would
			 * also see.
			 * @param node - any node inside the menu to dismiss.
			 */
			function closeMenu(node) {
				const holder = node.ownerDocument ?? document
				holder.dispatchEvent(escapeKeydown())
			}

			/**
			 * Handle one of this half's menu rows.
			 * @param event - the captured click.
			 * @returns whether the click belonged to this half.
			 */
			function onMenuClick(event) {
				const target = event.target instanceof Element ? event.target.closest('[' + ACTION_ATTR + ']') : null
				if (target === null) return false
				const action = target.getAttribute(ACTION_ATTR)
				const sessionId = target.getAttribute(SESSION_ATTR)
				if (sessionId === null) return false
				if (action === 'copy') {
					primitives.writeClipboard(sessionId).then((written) => {
						// The menu has done its job. A menu that stays open after a
						// copy is one the user has to dismiss by hand, so a successful
						// copy dismisses it — and a failed one leaves it, so the row is
						// still there to try again.
						if (written) closeMenu(target)
					}).catch(() => {})
					return true
				}
				if (action === 'delete') {
					openDialog(sessionId, target.getAttribute(TITLE_ATTR) ?? sessionId)
					return true
				}
				return false
			}

			/** Claim this half's menu rows before the portalled menu's own handlers see them. */
			function onClick(event) {
				if (onMenuClick(event)) event.stopPropagation()
			}

			/**
			 * Open the built-in rename dialog for the row a double-click landed on.
			 *
			 * Buttons are excluded so the row's own actions (open, menu, drag)
			 * keep their gestures; a blank New Session row carries no verbs at
			 * all, so it is skipped rather than opening a dialog that cannot be
			 * confirmed.
			 * @param event - the captured double-click.
			 */
			function onDoubleClick(event) {
				const target = event.target instanceof Element ? event.target : null
				if (target === null || target.closest('button') !== null) return
				const row = target.closest('[role="treeitem"]')
				if (row === null) return
				const props = rowPropsFrom(row)
				if (props === null || props.node.blank === true) return
				event.preventDefault()
				props.onRename(props.node.id, props.node.title)
			}

			/**
			 * The row's own menu trigger, found structurally.
			 *
			 * The menu's classes are CSS-module hashes this half cannot name, so
			 * the trigger is located by position: `rowActions` is the last cell
			 * of a Conversation row, and its only button is the one the
			 * Harness's own menu anchors to.
			 * @param row - the rendered `role="treeitem"` row.
			 * @returns the trigger button, or null when the row has none.
			 */
			function menuTriggerOf(row) {
				const buttons = row.querySelectorAll('button')
				return buttons.length === 0 ? null : buttons[buttons.length - 1]
			}

			/**
			 * The rendered row of one Conversation, located through the rows' own
			 * props because the markup carries no id attribute to read.
			 *
			 * Queried from `body`: the sidebar is rendered inside it, and a
			 * conversation row is never portalled anywhere else.
			 * @param sessionId - the Conversation to find.
			 * @returns the row element, or null when it is not rendered.
			 */
			function rowElementFor(sessionId) {
				for (const row of document.body.querySelectorAll('[role="treeitem"]')) {
					const props = rowPropsFrom(row)
					if (props !== null && props.node.id === sessionId) return row
				}
				return null
			}

			/**
			 * Open a Conversation's own menu from a right-click anywhere on its row.
			 *
			 * The menu is opened by pressing the trigger the Harness rendered,
			 * so every item — rename, fork, archive, and this half's two — stays
			 * exactly the one built-in menu; nothing is re-implemented and no
			 * second menu exists to drift. The native browser menu is suppressed
			 * in exchange, which is the point of claiming the gesture.
			 *
			 * A press always toggles from the closed state: the right-click's own
			 * `pointerdown` has already closed any menu that was open (the
			 * Harness closes on outside pointerdown), so the toggle this
			 * dispatches can only open one.
			 * @param event - the captured context-menu event.
			 */
			function onContextMenu(event) {
				const target = event.target instanceof Element ? event.target : null
				if (target === null || target.closest('[role="menu"]') !== null) return
				const row = target.closest('[role="treeitem"]')
				if (row === null) return
				const props = rowPropsFrom(row)
				// A blank row renders no menu and has no verbs to offer.
				if (props === null || props.node.blank === true) return
				const trigger = menuTriggerOf(row)
				if (trigger === null) return
				event.preventDefault()
				trigger.click()
			}

			const observer = new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) scan(node)
			})
			observer.observe(document.body, { childList: true, subtree: true })
			for (const menu of document.querySelectorAll('[role="menu"]')) scan(menu)
			document.addEventListener('click', onClick, true)
			document.addEventListener('dblclick', onDoubleClick, true)
			document.addEventListener('contextmenu', onContextMenu, true)
			window.addEventListener('scroll', replaceAll, true)
			window.addEventListener('resize', replaceAll)

			ctx.effect(() => () => {
				observer.disconnect()
				document.removeEventListener('click', onClick, true)
				document.removeEventListener('dblclick', onDoubleClick, true)
				document.removeEventListener('contextmenu', onContextMenu, true)
				window.removeEventListener('scroll', replaceAll, true)
				window.removeEventListener('resize', replaceAll)
				dialogRoot.unmount()
				dialogHost.remove()
				style.remove()
				decorated.clear()
			})
		}

		exports.name = 'session-actions'
		exports.inject = ['sessions', 'locale']
		exports.apply = apply
		return module.exports
	},
})
