/**
 * Installability of the published package.
 *
 * The community market verifies three things before it will install this
 * plugin, and each of them lives in a file no unit test would otherwise read:
 * the manifest declares `dsh.bundle.patch`, that patch file is committed, and
 * the package ships it. A regression here is invisible locally and only shows
 * up as a refused install, so it is asserted directly.
 *
 * Run with `node --test 'test/*.test.mjs'`.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the manifest declares a bundle patch', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch is what the market verifies')
  assert.notEqual(patch.trim(), '')
  // The store resolves this path inside the package directory, so it may not
  // climb out of it.
  const target = resolve(ROOT, patch)
  assert.equal(target === ROOT || target.startsWith(ROOT + sep), true, 'the patch stays inside the package')
})

test('the declared patch is committed and ships in the tarball', () => {
  const target = resolve(ROOT, manifest.dsh.bundle.patch)
  const text = readFileSync(target, 'utf8')
  assert.equal(manifest.files.includes('cordis.patch.yml'), true, 'files[] must publish the patch')
  // The gate checks the path exists, not its contents; what matters here is
  // that the layer actually inserts this package, by name, as the Loader row.
  assert.match(text, /^-\s*insert:/m, 'the patch is a top-level insert layer')
  assert.match(text, new RegExp(`name:\\s*'${manifest.name}'`), 'the inserted row names this package')
})

test('the browser half stays a declared web client', () => {
  assert.equal(manifest.dsh?.client?.platform, 'web')
  assert.equal(typeof manifest.exports?.['./client'], 'string')
})
