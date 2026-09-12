# dsh-session-actions

English | [中文](README.md)

Three extra actions for the Conversation list in the DeepSeek Harness (DSH) Web UI.

The built-in row menu offers only **Rename / Fork / Archive**, and only from the
`⋯` button at the end of the row. Without patching DSH, this plugin adds:

| Action | Gesture |
| --- | --- |
| **Rename by double-click** | Double-click a Conversation row (outside its buttons); the Harness's own rename dialog opens |
| **Copy session ID** | Row menu → Copy session ID; the row confirms in place |
| **Delete session** | Row menu → Delete session (red, below Archive); permanent, behind a confirmation |

Delete is not Archive. Archive hides a Conversation and keeps both its log and
its accounting slot; Delete erases it from storage and **cannot be undone**, so
it always asks twice.

## Install

```sh
npm install dsh-session-actions
```

Then add an insert row to the DSH profile's `cordis.patch.yml` (for example
`$DSH_HOME/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: session-actions
      name: 'dsh-session-actions'
```

The package declares `dsh.client.platform: web` and ships both halves
(`index.js` for the Host, `client.js` for the browser) with no build step. The
Host half hot-loads from the profile config; the browser half loads on page
refresh.

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

- **A Conversation that is live in the process cannot be deleted.** The plugin
  refuses and asks for a restart instead. Its log writer still holds an open
  file handle and its Agent is registered for the process lifetime, so unlinking
  the log would leave a row the Client keeps rendering from memory while the
  storage underneath it is gone — harder to recover from than a refusal.
- **The workspace-registry prune can be reverted.** The plugin edits
  `workspace.json` directly, while the Workspace registry keeps its own
  in-memory copy and rewrites the whole document on its next mutation (archive,
  reorder). The residue is an id naming a Conversation that no longer exists,
  which no grouping surface renders; the Host's session index reconciles against
  storage on every read, so no ghost row survives in the list.
- **It depends on rendered DOM.** The row menu offers no plugin seat
  (`SessionNodeItem` builds its `Menu` items inline), so the browser half
  appends two rows after the menu renders. The Session id is never guessed from
  DOM text: it is read back from the row's own React fiber props (`node` /
  `onRename` / `onArchive`), whose names are not mangled in the shipped bundle.
  If a future DSH renames those props, this half degrades to adding nothing
  rather than to acting on the wrong Conversation.
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
`test/plugin.test.mjs` drives the trust fence, request validation, and live
refusal through a fake Cordis context; `test/client.test.mjs` runs the browser
half against a small fake DOM and a stateful React stand-in.

## License

MIT
