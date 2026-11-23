/** Inventory the ELF files installed outside ASAR without loading the application. */
import { execFileSync } from 'node:child_process'
import { open, readFile, readdir, realpath } from 'node:fs/promises'
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

/** @param {string} version @returns {number[] | undefined} A numeric glibc version, or undefined for a named ABI. */
function glibcVersion(version) {
  if (!/^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?$/u.test(version)) return undefined
  return version.split('.').map(Number)
}

/**
 * Compare numeric GLIBC imports to a target version and keep named imports unresolved.
 * @param {unknown} report - An ELF report read from an independent build or input audit.
 * @param {'x64' | 'arm64'} arch - Expected report architecture.
 * @param {string} version - Target glibc as reported by getconf, with no prefix.
 * @returns {{arch: string, targetGlibc: string, scope: string, elfCount: number, aboveTarget: {file: string, symbol: string}[], unresolved: {file: string, symbol: string}[]}} Static findings, not a loader or distro test.
 */
export function compareLinuxGlibc(report, arch, version) {
  const target = glibcVersion(version)
  if (!target) throw new Error('Expected a numeric glibc version, for example 2.31')
  if (!report || typeof report !== 'object' || !('schemaVersion' in report) || report.schemaVersion !== 1
    || !('arch' in report) || report.arch !== arch || !('scope' in report) || typeof report.scope !== 'string'
    || !('elf' in report) || !Array.isArray(report.elf) || report.elf.length === 0) {
    throw new Error(`Expected a nonempty ELF ABI report for Linux ${arch}`)
  }
  /** @type {{file: string, symbol: string}[]} */
  const aboveTarget = []
  /** @type {{file: string, symbol: string}[]} */
  const unresolved = []
  for (const entry of /** @type {unknown[]} */ (report.elf)) {
    if (!entry || typeof entry !== 'object' || !('file' in entry) || typeof entry.file !== 'string'
      || !('requires' in entry) || !Array.isArray(entry.requires)
      || entry.requires.some((/** @type {unknown} */ symbol) => typeof symbol !== 'string')) {
      throw new Error('Invalid ELF ABI report entry')
    }
    for (const symbol of new Set(/** @type {string[]} */ (entry.requires))) {
      if (!symbol.startsWith('GLIBC_')) continue
      const required = glibcVersion(symbol.slice('GLIBC_'.length))
      if (!required) {
        unresolved.push({ file: entry.file, symbol })
        continue
      }
      for (let i = 0; i < 3; i++) {
        const difference = (required[i] ?? 0) - (target[i] ?? 0)
        if (difference > 0) aboveTarget.push({ file: entry.file, symbol })
        if (difference !== 0) break
      }
    }
  }
  return { arch, targetGlibc: version, scope: report.scope, elfCount: report.elf.length, aboveTarget, unresolved }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    'app-root': { type: 'string' }, arch: { type: 'string' }, report: { type: 'string' }, 'target-glibc': { type: 'string' },
  } })
  const arch = values.arch
  if (arch !== 'x64' && arch !== 'arm64') throw new Error('Expected --arch <x64|arm64>')
  if (values['app-root'] && values.report === undefined && values['target-glibc'] === undefined) {
    console.log(JSON.stringify(await reportLinuxPayload(values['app-root'], arch), null, 2))
  } else if (values['app-root'] === undefined && values.report && values['target-glibc']) {
    const findings = compareLinuxGlibc(JSON.parse(await readFile(values.report, 'utf8')), arch, values['target-glibc'])
    console.log(JSON.stringify(findings, null, 2))
    if (findings.aboveTarget.length || findings.unresolved.length) process.exitCode = 1
  } else {
    throw new Error('Expected --app-root <directory> or --report <file> --target-glibc <version>')
  }
}
