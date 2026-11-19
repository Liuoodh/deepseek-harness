/** Validate the assembled application, including native Office conversion outside ASAR. */
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { LINUX_DESKTOP_EXECUTABLE, desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'
import { readInstalledLinuxSmokeDescriptor } from './verify-runtime-archive.ts'

const { values } = parseArgs({ options: {
  unsigned: { type: 'boolean' },
  'skip-notarization': { type: 'boolean' },
  'installed-linux-root': { type: 'string' },
  'expected-runtime-dir': { type: 'string' },
  'expected-build-version': { type: 'string' },
}, allowPositionals: false })
const installedRoot = values['installed-linux-root']
const expectedRuntimeDir = values['expected-runtime-dir']
const expectedVersion = values['expected-build-version']
if (installedRoot !== undefined) {
  if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Run the installed Linux smoke as a non-root user on Linux')
  if (!isAbsolute(installedRoot) || expectedRuntimeDir === undefined || !isAbsolute(expectedRuntimeDir) || expectedVersion === undefined
    || values.unsigned || values['skip-notarization']) {
    throw new Error('Installed Linux smoke requires absolute --installed-linux-root and --expected-runtime-dir paths and --expected-build-version')
  }
  const resources = join(installedRoot, 'resources')
  const descriptor = await readInstalledLinuxSmokeDescriptor(join(resources, 'app.asar'), expectedRuntimeDir, expectedVersion, process.arch)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), join(installedRoot, LINUX_DESKTOP_EXECUTABLE), join(resources, 'runtime'), descriptor, true)
} else {
  if (expectedRuntimeDir !== undefined || expectedVersion !== undefined) throw new Error('Expected runtime directory and build version require --installed-linux-root')
  const paths = resolveDesktopTargetBuildPaths()
  const target = resolveDesktopPackageTarget(resolveDesktopBuildTarget())
  const unsigned = target.platform === 'linux' || values.unsigned === true
  const artifacts = desktopArtifactOutput(paths, { unsigned, skipNotarization: values['skip-notarization'] === true }).directory
  const application = target.platform === 'darwin'
    ? join(artifacts, target.arch === 'arm64' ? 'mac-arm64' : 'mac', 'DeepSeek Harness.app', 'Contents')
    : join(artifacts, target.platform === 'win32' ? 'win-unpacked'
      : (target.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked'))
  const resources = join(application, target.platform === 'darwin' ? 'Resources' : 'resources')
  const executable = target.platform === 'darwin' ? join(application, 'MacOS', 'DeepSeek Harness')
    : join(application, target.platform === 'win32' ? 'DeepSeek Harness.exe' : LINUX_DESKTOP_EXECUTABLE)
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version, target)
  if (target.platform === 'win32' && !unsigned) await verifyWindowsCode(application)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
}
