/** Exercise the Office engine resolver with Electron's actual ASAR filesystem. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { finished } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createEnginePackageResolver } from '../../../../packages/document/office-kit/src/locate.ts'

const scope = '@deepseek-ai'
const native = `${scope}/libreoffice-kit-linux-${process.arch}-glibc`
const wasm = `${scope}/libreoffice-kit-wasm`
const kitPath = join('node_modules', scope, 'libreoffice-kit', 'index.js')
const [argument] = process.argv.slice(2)
assert.ok(argument, 'Expected an Electron executable or, in Electron, a fixture directory')

if (process.versions.electron) {
  const archive = join(argument, 'app.asar')
  const resolve = createEnginePackageResolver(join(archive, kitPath))
  assert.throws(() => resolve(native), { code: 'MODULE_NOT_FOUND' })
  assert.equal(resolve(wasm), join(archive, 'node_modules', wasm, 'package.json'))
  const broken = join(argument, 'broken.asar')
  assert.throws(() => createEnginePackageResolver(join(broken, kitPath))(native), error => {
    assert.match(error.message, /Installed LibreOfficeKit package is incomplete/u)
    assert.equal(error.cause?.code, 'MODULE_NOT_FOUND')
    return true
  })
} else {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'))
  const { createPackage } = builderRequire('@electron/asar')
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-engine-asar-'))
  try {
    const source = join(root, 'source')
    const entry = join(source, kitPath)
    const wasmDirectory = join(source, 'node_modules', wasm)
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, '')
    await mkdir(wasmDirectory, { recursive: true })
    await writeFile(join(wasmDirectory, 'package.json'), JSON.stringify({ name: wasm }))
    await finished(await createPackage(source, join(root, 'app.asar')))

    const nativeDirectory = join(source, 'node_modules', native)
    await mkdir(nativeDirectory, { recursive: true })
    await writeFile(join(nativeDirectory, 'not-a-manifest'), 'fixture')
    await finished(await createPackage(source, join(root, 'broken.asar')))

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    delete env.ELECTRON_NO_ASAR
    delete env.NODE_PATH
    delete env.NODE_OPTIONS
    const { stderr } = await promisify(execFile)(argument, [fileURLToPath(import.meta.url), root], {
      env, timeout: 30_000, windowsHide: true,
    })
    if (stderr) process.stderr.write(stderr)
    console.log('Electron ASAR: absent native engine permits WASM; incomplete engine still fails.')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
