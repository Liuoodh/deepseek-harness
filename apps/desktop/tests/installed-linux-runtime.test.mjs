import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finished } from 'node:stream/promises'
import { test } from 'node:test'
import { LINUX_DESKTOP_APP_ID } from '../scripts/desktop-build-paths.mjs'
import { readInstalledLinuxSmokeDescriptor, verifyRuntimeArchive } from '../scripts/verify-runtime-archive.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { writeDesktopRuntime } from '../src/runtime-tree.ts'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
const { createPackage } = builderRequire('@electron/asar')
const version = '0.2.2-rc.5.20261118.1'
const release = {
  schemaVersion: 1, version: '0.2.2-rc.5', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  nodeVersion: '24.12.0', pnpmVersion: '11.28.5',
}

/** Make separate CI evidence and a minimal real installed ASAR. */
async function installedFixture(t, { appId = LINUX_DESKTOP_APP_ID, archiveArch = 'x64', changedFile = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-installed-linux-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const evidence = join(root, 'evidence')
  const source = join(root, 'source')
  const staged = join(root, 'staged-runtime')
  const runtime = join(source, 'dsh')
  const archive = join(root, 'installed.asar')
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
  for (const name of names) {
    const path = join(staged, 'node_modules', name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'package.json'), JSON.stringify({ name, version: release.version }))
  }
  const expected = writeDesktopRuntime(staged, release, names, { platform: 'linux', arch: 'x64' })
  await mkdir(evidence)
  await cp(join(staged, 'desktop-runtime.json'), join(evidence, 'desktop-runtime.json'))
  await cp(staged, runtime, { recursive: true })
  if (archiveArch !== 'x64') writeDesktopRuntime(runtime, release, names, { platform: 'linux', arch: archiveArch })
  if (changedFile) await writeFile(join(runtime, 'node_modules', names[0], 'package.json'), '{}')
  await writeFile(join(source, 'package.json'), JSON.stringify({ dshDesktopAppId: appId, version }))
  await finished(await createPackage(source, archive))
  await rm(staged, { recursive: true })
  return { evidence, archive, expected }
}

test('verifies the installed archive against separately supplied evidence without a staging tree', async t => {
  const { evidence, archive, expected } = await installedFixture(t)
  const descriptor = await readInstalledLinuxSmokeDescriptor(archive, evidence, version, 'x64')
  assert.deepEqual(descriptor, expected)
  await verifyRuntimeArchive(archive, descriptor)
})

test('rejects a different installer version or target architecture', async t => {
  const { evidence, archive } = await installedFixture(t)
  await assert.rejects(readInstalledLinuxSmokeDescriptor(archive, evidence, release.version, 'x64'), /build version differs/u)
  await assert.rejects(readInstalledLinuxSmokeDescriptor(archive, evidence, version, 'arm64'), /Linux architecture/u)
})

test('rejects matching-version archives with another application identity', async t => {
  const { evidence, archive } = await installedFixture(t, { appId: 'example.other-app' })
  await assert.rejects(readInstalledLinuxSmokeDescriptor(archive, evidence, version, 'x64'), /identity or build version differs/u)
})

test('rejects a changed descriptor or archived payload even with correct app metadata', async t => {
  for (const [options, diagnostic] of [[{ archiveArch: 'arm64' }, /descriptor differs/u], [{ changedFile: true }, /ASAR integrity/u]]) {
    const { evidence, archive } = await installedFixture(t, options)
    const descriptor = await readInstalledLinuxSmokeDescriptor(archive, evidence, version, 'x64')
    await assert.rejects(verifyRuntimeArchive(archive, descriptor), diagnostic)
  }
})
