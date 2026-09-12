/**
 * `dsh-session-actions` browser half.
 *
 * The sidebar's Conversation rows are not extensible: `SessionNodeItem` builds
 * its own `Menu` items inline and registers no seat for a plugin to contribute
 * to, so this half decorates the rendered result instead of composing into it.
 * Three gestures are added:
 *
 *   1. double-clicking a row (outside its buttons) opens the **built-in**
 *      rename dialog, by calling the very `onRename` callback the row's own
 *      menu item calls — no second rename implementation exists;
 *   2. **Copy session ID** is appended to the row menu;
 *   3. **Delete session** is appended below it, styled destructive, and opens a
 *      confirmation dialog that inspects the Conversation before offering the
 *      irreversible action.
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

		/** How long a copied row keeps its confirmation label. */
		const COPIED_LABEL_MS = 1200

		const zh = {
			copyId: '复制会话 ID',
			copied: '已复制',
			deleteSession: '删除会话',
			deleteTitle: '永久删除会话',
			deleteDesc: '“{title}”的对话记录、投影缓存与工作区记录将被永久删除，且无法恢复。',
			deleteShared: '附件对象按内容寻址并可能与其他会话共享，不会一并删除。',
			deletePending: '正在删除…',
			deleteConfirm: '永久删除',
			inspecting: '正在检查该会话…',
			cancel: '取消',
			close: '关闭',
			blockedLive: '该会话当前在本应用进程中处于打开状态，无法彻底删除。请先重启 DSH，再执行删除。',
			blockedMissing: '未在磁盘上找到该会话的记录，可能已被删除。',
			detail: '将删除 {size} 数据，共 {count} 个目录。',
			detailPath: '位置：{path}',
			failed: '删除失败：{message}',
		}

		const en = {
			copyId: 'Copy session ID',
			copied: 'Copied',
			deleteSession: 'Delete session',
			deleteTitle: 'Delete session permanently',
			deleteDesc: '“{title}”, its transcript, its projection cache, and its workspace record will be permanently deleted. This cannot be undone.',
			deleteShared: 'Attachment objects are content-addressed and may be shared with other sessions, so they are not removed.',
			deletePending: 'Deleting…',
			deleteConfirm: 'Delete permanently',
			inspecting: 'Inspecting this session…',
			cancel: 'Cancel',
			close: 'Close',
			blockedLive: 'This session is open in the running application, so it cannot be removed completely. Restart DSH, then delete it.',
			blockedMissing: 'No record of this session was found on disk; it may already be deleted.',
			detail: 'Deletes {size} across {count} directories.',
			detailPath: 'Location: {path}',
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
			 * action: a Session that is live in the Host process cannot be
			 * removed completely, and saying so up front is better than
			 * unlinking a log the running application still renders.
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
						setPhase(result.value.live === true
							? 'blocked-live'
							: result.value.exists === true ? 'ready' : 'blocked-missing')
					})()
					return () => { cancelled = true }
				}, [request.sessionId])

				const busy = phase === 'deleting'
				const confirm = () => {
					setPhase('deleting')
					setMessage(null)
					void (async () => {
						const result = await call('delete', request.sessionId)
						if (result.ok === true) {
							onDeleted()
							return
						}
						setPhase(result.error?.code === 'session-live' ? 'blocked-live' : 'error')
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
				if (phase === 'blocked-live' || phase === 'blocked-missing') {
					body.push(h('div', {
						key: 'blocked',
						className: 'dsa-error',
						role: 'alert',
					}, phase === 'blocked-live' ? t('blockedLive') : t('blockedMissing')))
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
							disabled: busy || phase !== 'ready',
							onClick: confirm,
						}, t('deleteConfirm'))),
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
						// The Host re-lists from storage on every pull, so the removed
						// Conversation leaves the snapshot after this refresh.
						ctx.sessions.refresh().catch(() => {})
					},
				}))
			}

			/** Menus this half decorated, so a re-render that dropped rows is repaired. */
			const decorated = new Set()

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
					const label = slotsOf(target).label
					primitives.writeClipboard(sessionId).then((written) => {
						if (!written || label === null) return
						const original = label.textContent
						label.textContent = t('copied')
						setTimeout(() => { label.textContent = original }, COPIED_LABEL_MS)
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

			const observer = new MutationObserver((records) => {
				for (const record of records) for (const node of record.addedNodes) scan(node)
			})
			observer.observe(document.body, { childList: true, subtree: true })
			for (const menu of document.querySelectorAll('[role="menu"]')) scan(menu)
			document.addEventListener('click', onClick, true)
			document.addEventListener('dblclick', onDoubleClick, true)

			ctx.effect(() => () => {
				observer.disconnect()
				document.removeEventListener('click', onClick, true)
				document.removeEventListener('dblclick', onDoubleClick, true)
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
