/** Test ELF inventory and ABI symbol parsing without launching a Desktop application. */
import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compareLinuxGlibc, readLinuxAbiRequirements, readLinuxNeededLibraries, reportLinuxPayload } from '../scripts/report-linux-payload.mjs'

const machines = { x64: 62, arm64: 183 }

function elfHeader(machine) {
  const header = Buffer.alloc(64)
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1])
  header.writeUInt16LE(machine, 18)
  return header
}

test('reports only imported ABI versions, including non-numeric labels', () => {
  const output = `
Version symbols section '.gnu.version' contains 9 entries:
  004:   1 (*global*)      1 (*global*)      3 (GLIBC_99.0)
Version definition section '.gnu.version_d' contains 2 entries:
  0x001c: Rev: 1  Flags: none  Index: 2  Cnt: 1  Name: GLIBCXX_9.9
Version needs section '.gnu.version_r' contains 3 entries:
  000000: Version: 1  File: libstdc++.so.6  Cnt: 2
  0x0010:   Name: CXXABI_1.3.9  Flags: none  Version: 9
  0x0020:   Name: GLIBCXX_3.4.22  Flags: none  Version: 8
  0x0040:   Name: GLIBC_2.28  Flags: none  Version: 6
  0x0050:   Name: GLIBC_ABI_DT_RELR  Flags: none  Version: 7
  0x0060:   Name: GLIBC_2.28  Flags: none  Version: 6
  0x0070:   Name: GCC_3.0  Flags: none  Version: 4`
  assert.deepEqual(readLinuxAbiRequirements(output), ['CXXABI_1.3.9', 'GLIBCXX_3.4.22', 'GLIBC_2.28', 'GLIBC_ABI_DT_RELR'])
  assert.deepEqual(readLinuxAbiRequirements('No version information found in this file.'), [])
})

test('reports shared-library names from DT_NEEDED only', () => {
  const output = `
Dynamic section at offset 0x00000000 contains 6 entries:
 0x0000000000000001 (NEEDED)             Shared library: [libasound.so.2]
 0x0000000000000001 (NEEDED)             Shared library: [libX11.so.6]
 0x000000000000000e (SONAME)             Library soname: [libapp.so]
 0x0000000000000001 (NEEDED)             Shared library: [libasound.so.2]
 0x000000000000001d (RUNPATH)            Library runpath: [$ORIGIN]
 0x0000000000000000 (NULL)               0x0`
  assert.deepEqual(readLinuxNeededLibraries(output), ['libX11.so.6', 'libasound.so.2'])
  assert.deepEqual(readLinuxNeededLibraries('There is no dynamic section in this file.'), [])
})

test('compares GLIBC versions numerically and leaves named ABI imports unresolved', () => {
  const elf = [
    { file: 'dsh-linux', requires: ['GLIBC_2.9', 'GLIBC_2.31.0', 'GLIBC_2.31.1', 'GLIBCXX_3.4.99'] },
    { file: 'binary.node', requires: ['GLIBC_2.34', 'GLIBC_ABI_DT_RELR', 'GLIBC_2.34'] },
  ]
  const report = { schemaVersion: 1, arch: 'arm64', scope: 'fixture', elf }
  assert.deepEqual(compareLinuxGlibc(report, 'arm64', '2.31'), {
    arch: 'arm64', targetGlibc: '2.31', scope: 'fixture', elfCount: 2,
    aboveTarget: [{ file: 'dsh-linux', symbol: 'GLIBC_2.31.1' }, { file: 'binary.node', symbol: 'GLIBC_2.34' }],
    unresolved: [{ file: 'binary.node', symbol: 'GLIBC_ABI_DT_RELR' }],
  })
  assert.deepEqual(compareLinuxGlibc({ ...report, elf: [elf[0]] }, 'arm64', '2.31.1').aboveTarget, [])
})

test('rejects a different architecture, an empty report, and invalid entries or target versions', () => {
  const report = { schemaVersion: 1, arch: 'arm64', scope: 'fixture', elf: [{ file: 'test', requires: [] }] }
  assert.throws(() => compareLinuxGlibc(report, 'x64', '2.31'), /nonempty ELF ABI report for Linux x64/u)
  assert.throws(() => compareLinuxGlibc({ ...report, elf: [] }, 'arm64', '2.31'), /nonempty ELF ABI report/u)
  assert.throws(() => compareLinuxGlibc({ ...report, elf: [{ file: 'test', requires: [5] }] }, 'arm64', '2.31'), /Invalid ELF ABI report entry/u)
  assert.throws(() => compareLinuxGlibc(report, 'arm64', '2.x'), /numeric glibc version/u)
})

test('rejects a missing or wrong-architecture main executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-abi-'))
  try {
    await assert.rejects(reportLinuxPayload(root, 'arm64'), /not a regular Linux arm64 ELF executable/u)
    await writeFile(join(root, 'dsh-linux'), elfHeader(machines.x64))
    await assert.rejects(reportLinuxPayload(root, 'arm64'), /not a regular Linux arm64 ELF executable/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const linux = process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')
test('uses readelf on a real target binary and lists other-architecture prebuilds separately', { skip: !linux }, async () => {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const foreign = arch === 'x64' ? 'arm64' : 'x64'
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-abi-'))
  try {
    await copyFile(process.execPath, join(root, 'dsh-linux'))
    await mkdir(join(root, 'prebuilds'))
    await writeFile(join(root, 'prebuilds', 'other-arch.node'), elfHeader(machines[foreign]))
    await writeFile(join(root, 'text'), 'not an ELF')
    const report = await reportLinuxPayload(root, arch)
    assert.equal(report.arch, arch)
    assert.deepEqual(report.elf.map(item => item.file), ['dsh-linux'])
    assert.ok(report.elf[0].requires.some(version => version.startsWith('GLIBC_')))
    assert.ok(report.elf[0].needed.includes('libc.so.6'))
    assert.deepEqual(report.otherElf, [{ file: 'prebuilds/other-arch.node', machine: machines[foreign], bits: 64, littleEndian: true }])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
