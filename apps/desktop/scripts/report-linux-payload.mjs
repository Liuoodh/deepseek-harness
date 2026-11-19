/** Inventory the ELF files installed outside ASAR without loading the application. */
import { execFileSync } from 'node:child_process'
import { open, readdir, realpath } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { LINUX_DESKTOP_EXECUTABLE } from './desktop-build-paths.mjs'

/** @typedef {{file: string, requires: string[], needed: string[]}} ElfRequirements */

const machineByArch = { x64: 62, arm64: 183 }

/**
 * Collect imported ABI symbol versions, excluding versions the binary itself defines.
 * @param {string} output - GNU readelf --wide --version-info output.
 * @returns {string[]} Sorted unique GLIBC, GLIBCXX and CXXABI requirements.
 */
export function readLinuxAbiRequirements(output) {
  const versions = new Set()
  let inVersionNeeds = false
  for (const line of output.split('\n')) {
    if (/^Version /u.test(line)) inVersionNeeds = line.startsWith('Version needs section ')
    if (!inVersionNeeds) continue
    for (const match of line.matchAll(/\bName:\s+((?:GLIBCXX|GLIBC|CXXABI)_[\w.]+)(?=\s|$)/gu)) versions.add(match[1])
  }
  return [...versions].sort()
}

/**
 * Collect direct shared-library names without executing the payload or resolving transitive dependencies.
 * @param {string} output - GNU readelf --wide --dynamic output.
 * @returns {string[]} Sorted unique names from DT_NEEDED entries.
 */
export function readLinuxNeededLibraries(output) {
  return [...new Set(Array.from(output.matchAll(/^\s+0x[\da-f]+\s+\(NEEDED\)\s+Shared library: \[([^\]\r\n]+)\]/gmu), match => match[1]))].sort()
}

/** @param {string} filename @returns {Promise<{machine: number, bits: 32 | 64, littleEndian: boolean} | undefined>} ELF identity, if ELF. */
async function linuxElfIdentity(filename) {
  const handle = await open(filename, 'r')
  const header = Buffer.alloc(20)
  const { bytesRead } = await handle.read(header).finally(() => handle.close())
  if (header.readUInt32BE(0) !== 0x7f454c46) return undefined
  if (bytesRead !== header.length || (header[4] !== 1 && header[4] !== 2)
    || (header[5] !== 1 && header[5] !== 2) || header[6] !== 1) {
    throw new Error(`Invalid ELF header: ${filename}`)
  }
  const littleEndian = header[5] === 1
  return { machine: littleEndian ? header.readUInt16LE(18) : header.readUInt16BE(18), bits: header[4] === 2 ? 64 : 32, littleEndian }
}

/**
 * Inspect regular ELF files in an installed or unpacked Linux Desktop tree, without following symlinks.
 * @param {string} application - App root containing the packaged Desktop executable.
 * @param {'x64' | 'arm64'} arch - Expected Desktop executable architecture.
 * @returns {Promise<{schemaVersion: number, arch: string, scope: string, elf: ElfRequirements[], otherElf: {file: string, machine: number, bits: number, littleEndian: boolean}[]}>} Host ABI requirements and the other-architecture files excluded from them.
 */
export async function reportLinuxPayload(application, arch) {
  const root = await realpath(application)
  const matchesTarget = (/** @type {{machine: number, bits: number, littleEndian: boolean} | undefined} */ identity) =>
    identity !== undefined && identity.machine === machineByArch[arch] && identity.bits === 64 && identity.littleEndian
  const main = join(root, LINUX_DESKTOP_EXECUTABLE)
  const entries = await readdir(root, { withFileTypes: true })
  if (!entries.some(entry => entry.name === LINUX_DESKTOP_EXECUTABLE && entry.isFile()) || !matchesTarget(await linuxElfIdentity(main))) {
    throw new Error(`${LINUX_DESKTOP_EXECUTABLE} is not a regular Linux ${arch} ELF executable in ${application}`)
  }
  /** @type {ElfRequirements[]} */
  const elf = []
  /** @type {{file: string, machine: number, bits: number, littleEndian: boolean}[]} */
  const otherElf = []
  const visit = async (/** @type {string} */ directory, /** @type {import('node:fs').Dirent[]} */ children) => {
    for (const entry of children) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path, await readdir(path, { withFileTypes: true }))
      else if (entry.isFile()) {
        const identity = await linuxElfIdentity(path)
        if (identity === undefined) continue
        const file = relative(root, path).split(sep).join('/')
        if (!matchesTarget(identity)) {
          otherElf.push({ file, ...identity })
          continue
        }
        const output = execFileSync('readelf', ['--wide', '--version-info', '--dynamic', '--', path], {
          encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
        })
        elf.push({ file, requires: readLinuxAbiRequirements(output), needed: readLinuxNeededLibraries(output) })
      }
    }
  }
  await visit(root, entries)
  const byPath = (/** @type {{file: string}} */ left, /** @type {{file: string}} */ right) =>
    left.file < right.file ? -1 : left.file > right.file ? 1 : 0
  return { schemaVersion: 1, arch, scope: 'regular ELF files outside application archives', elf: elf.sort(byPath), otherElf: otherElf.sort(byPath) }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'app-root': { type: 'string' }, arch: { type: 'string' } } })
  if (!values['app-root'] || (values.arch !== 'x64' && values.arch !== 'arm64')) {
    throw new Error('Usage: node report-linux-payload.mjs --app-root <directory> --arch <x64|arm64>')
  }
  console.log(JSON.stringify(await reportLinuxPayload(values['app-root'], values.arch), null, 2))
}
