/** Verify runtime bytes and executable permissions using ASAR records and physical unpacked files. */
import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readAsar, type Node } from 'app-builder-lib/out/asar/asar.js'
import { parseDesktopRelease } from '../src/release.ts'
import { readDesktopRuntime, type DesktopRuntimeDescriptor, type DesktopRuntimeFile } from '../src/runtime-tree.ts'
import { LINUX_DESKTOP_APP_ID } from './desktop-build-paths.mjs'

/**
 * Bind an installed Linux smoke run to its independently supplied build evidence.
 * @param archivePath - The installed application's ASAR file.
 * @param expectedDirectory - Directory holding the preparation descriptor obtained with the installer.
 * @param expectedVersion - Approved installer version, not its base runtime version.
 * @param arch - Architecture of the target machine.
 * @returns Expected runtime descriptor for complete archive verification before execution.
 */
export async function readInstalledLinuxSmokeDescriptor(
  archivePath: string, expectedDirectory: string, expectedVersion: string, arch: string,
): Promise<DesktopRuntimeDescriptor> {
  const expected = readDesktopRuntime(expectedDirectory)
  if (expected.schemaVersion !== 1 || expected.platform !== 'linux'
    || (arch !== 'x64' && arch !== 'arm64') || expected.arch !== arch) {
    throw new Error('desktop runtime: expected descriptor does not match this Linux architecture')
  }
  parseDesktopRelease(expected.release)
  const archive = await readAsar(archivePath)
  const metadata: unknown = await archive.readJson('package.json')
  if (typeof metadata !== 'object' || metadata === null
    || !('dshDesktopAppId' in metadata) || metadata.dshDesktopAppId !== LINUX_DESKTOP_APP_ID
    || !('version' in metadata) || metadata.version !== expectedVersion) {
    throw new Error('desktop runtime: installed application identity or build version differs')
  }
  return expected
}

/**
 * Compare the complete archived dsh tree with the sealed preparation inventory.
 * @param archivePath - Application ASAR file beside its unpacked directory.
 * @param expected - Verified preparation descriptor, including its complete file inventory.
 * @returns Resolves when bytes, file membership and meaningful executable permissions match.
 */
export async function verifyRuntimeArchive(archivePath: string, expected: DesktopRuntimeDescriptor): Promise<void> {
  const archive = await readAsar(archivePath)
  const descriptor = await archive.readFile(join('dsh', 'desktop-runtime.json'))
  if (!descriptor.equals(Buffer.from(`${JSON.stringify(expected, undefined, 2)}\n`))) {
    throw new Error('desktop runtime: archived descriptor differs from preparation')
  }
  const files: DesktopRuntimeFile[] = []
  const unpacked = new Set<string>()
  async function visit(node: Node, path: string): Promise<void> {
    if (node.link !== undefined) throw new Error(`desktop runtime: unexpected ASAR link ${path}`)
    if (node.files !== undefined) {
      for (const [name, child] of Object.entries(node.files)) await visit(child, path === '' ? name : `${path}/${name}`)
      return
    }
    const name = join('dsh', ...path.split('/'))
    const physical = node.unpacked === true ? await lstat(join(`${archivePath}.unpacked`, name)) : undefined
    if (physical !== undefined && !physical.isFile()) throw new Error(`desktop runtime: unexpected unpacked entry ${path}`)
    if (node.unpacked === true) unpacked.add(join(`${archivePath}.unpacked`, name))
    if (path === 'desktop-runtime.json') return
    const body = await archive.readFile(name)
    // ASAR stores only owner-execute; group/other-only executable files fail the inventory comparison.
    const executable = process.platform !== 'win32' && (physical !== undefined
      ? (physical.mode & 0o111) !== 0
      : node.executable === true)
    files.push({ path, bytes: body.byteLength, sha256: createHash('sha256').update(body).digest('hex'), executable })
  }
  await visit(archive.getFile('dsh', false), '')
  const entries = await readdir(join(`${archivePath}.unpacked`, 'dsh'), { recursive: true, withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && unpacked.size === 0) return []
      throw error
    })
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const path = join(entry.parentPath, entry.name)
    if (!entry.isFile() || !unpacked.has(path)) throw new Error(`desktop runtime: unexpected unpacked entry ${path}`)
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (JSON.stringify(files) !== JSON.stringify(expected.files)) throw new Error('desktop runtime: ASAR integrity verification failed')
}
