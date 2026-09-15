# dsh-session-actions

English | [中文](README.md)

Extra actions for the Conversation list in the DeepSeek Harness (DSH) Web UI.

The built-in row menu offers only **Rename / Fork / Archive**, and only from the
`⋯` button at the end of the row. Without patching DSH, this plugin adds:

| Action | Gesture |
| --- | --- |
| **Menu on right-click** | Right-click anywhere on a Conversation row; the Harness's own menu opens (Rename / Fork / Archive plus this plugin's two rows) |
| **Rename by double-click** | Double-click a Conversation row (outside its buttons); the Harness's own rename dialog opens |
| **Copy session ID** | Row menu → Copy session ID; the menu dismisses itself once the id is on the clipboard (a refused write leaves it open to retry) |
| **Delete session** | Row menu → Delete session (red, below Archive); permanent, behind a confirmation, and the row leaves the list with the storage |

Delete is not Archive. Archive hides a Conversation and keeps both its log and
its accounting slot; Delete erases it from storage and **cannot be undone**, so
it always asks twice.

Once the storage is gone the browser half calls the Session list's own removal
entry point (`sessions.handleSessionRemoved`, the very method the Host's
`api-session/removed` frame drives), so the row goes immediately. It
deliberately does **not** re-pull the list: that pull merges the Host's current
baseline back in, which would return any row the Host still reports. The Host
half also emits the official `api-session/removed`, as the same signal on the
wire. Deleting the Conversation that is *currently open* also clears the
selection back to the empty state, so the conversation pane cannot keep showing
a session the list no longer has.

## Install

This package is a **DSH bundle**: its manifest declares `dsh.bundle.patch`,
pointing at the `cordis.patch.yml` it ships. There are two ways to install it —
**pick one, never both**:

**Recommended: install it as a bundle** (the community market's Install button,
or by hand)

```sh
dsh plugin --profile desktop add dsh-session-actions
```

The package then appears in the profile's `dsh.profile.bundles`, and its patch
layer inserts the Loader row at startup, so no profile file needs editing. The
market verifies the `dsh.bundle.patch` declaration against npm before it
installs and refuses a package without one.

**Or: add the insert row by hand** (for a profile that does not use bundles)

In the DSH profile's `cordis.patch.yml` (for example
`$DSH_HOME/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: session-actions
      name: 'dsh-session-actions'
```

⚠️ If the profile already lists this package in `dsh.profile.bundles`, do
**not** also add that row: the plugin would load twice (the Host half fails on
a duplicate route registration, and the menu rows appear twice).

The package declares `dsh.client.platform: web` and ships both halves
(`index.js` for the Host, `client.js` for the browser) with no build step.

Both halves load at **application start**: the browser half's bytes are
snapshotted during the startup scan and the Host half is evaluated then, while
HMR is unavailable in the current DSH Desktop build (the log reports
`[hmr] Error: --expose-internals is required for HMR service`). Upgrading the
plugin therefore needs a **DSH restart**; a page refresh is not enough.

## What deletion actually removes

Deletion follows the layout DSH really produces, per Conversation:

```
$DSH_HOME/sessions/<projectKey(cwd)>/<sessionId>/session.v<N>.jsonl.zstd   the log (and its lock and siblings)
$DSH_HOME/storages/session_projcache/sessions/<sessionId>.json             the projection cache
$DSH_HOME/storages/workspace.json                                          the id, from archivedSessionIds[]
                                                                           and every workspaces[*].sessionIds[]
```

`projectKey` is a lossy encoding (separators collapse, long paths truncate), so
the owning directory is **found by scanning** the sessions root rather than
recomputed — which also means a Conversation whose header cannot be read is
still deletable.

**Attachments are not touched.** `$DSH_HOME/attachments/v1/objects/` holds
content-addressed (sha256-sharded) objects that several Conversations can
share, so removing them per Conversation would damage the others. The
confirmation dialog says so.

## Known Limitations and Deferred Work

- **A Conversation that is running cannot be deleted.** The guard reads DSH's own
  `agent/status`: while an Agent is executing a turn for the Conversation
  (`ctx.agents.get(id).status === 'running'`) the plugin refuses, because that
  turn is still appending to the log this surface would unlink — deleting it
  would discard the question and the answer together. **A Conversation that is
  merely open, and idle, deletes normally**: the files go, and the row goes with
  them.
  - The honest cost: for a Conversation already attached to this process, the
    in-memory object is owned by the fiber that created it and this plugin holds
    no capability to dispose it (`AgentHandle.dispose()` goes to the creator
    only). So after deleting an open-but-idle Conversation, the process keeps a
    copy of it until you **restart DSH**. Storage and list are already clean, and
    no new log content is produced in the meantime.
- **The workspace-registry prune can be reverted.** The plugin edits
  `workspace.json` directly, while the Workspace registry keeps its own
  in-memory copy and rewrites the whole document on its next mutation (archive,
  reorder). The residue is an id naming a Conversation that no longer exists,
  which no grouping surface renders; the Host's session index reconciles against
  storage on every read, so no ghost row survives in the list.
- **It depends on rendered DOM.** The row menu offers no plugin seat
  (`SessionNodeItem` builds its `Menu` items inline), so the browser half
  appends two rows after the menu renders; the right-click gesture likewise
  **presses the `⋯` trigger the row itself renders** instead of building a
  second menu. Having made the card taller, it then re-places that card from its
  **real size** — flipping it above the trigger when the space below cannot hold
  it, keeping the Harness's own 12px viewport margin, and repeating the
  correction after any scroll or resize. Without that, the two added rows fall
  below the fold whenever the menu opens near the bottom of a short window. The
  Session id is never guessed from DOM text: it is read back
  from the row's own React fiber props (`node` / `onRename` / `onArchive`),
  whose names are not mangled in the shipped bundle. If a future DSH renames
  those props, this half degrades to adding nothing rather than to acting on the
  wrong Conversation.
- Web only. Under a headless profile the Host half loads as a no-op.

## Security

`/api2/dsh-session-actions/*` is a plugin-owned JSON surface, not part of the
official `/api` channel (that is a generated Remote assembly an out-of-tree
plugin has no seat in). Because it is destructive it carries three fences,
matching the other plugin-owned `/api2` surface: `POST` only, `application/json`
only (a cross-site page cannot send that content type without a CORS preflight,
which this route never answers), and a loopback `Host` (extend with the
comma-separated `DSH_SESSION_ACTIONS_TRUSTED_HOSTS`).

A Session id is validated against `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` before it
is joined to a path, encoded the way the persistence backend encodes it, and the
result is re-checked to still sit under the sessions root.

## Development

```sh
node --test 'test/*.test.mjs'
```

Zero dependencies, `node:test`. Three layers: `test/session-files.test.mjs`
builds the real storage layout in a temp directory and asserts what survives;
`test/plugin.test.mjs` drives the trust fence, request validation, the
running-Session refusal, and the `api-session/removed` announcement through a
fake Cordis context; `test/client.test.mjs` runs the browser half against a
small fake DOM and a stateful React stand-in: fiber id lookup, double-click
rename, the right-click menu, menu decoration and re-placement, the dismiss
after a copy, the confirmation flow, and the list removal after a delete.

## License

MIT
