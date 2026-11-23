import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { findWelcomeBuffer, readWaylandTrace } from '../scripts/read-dsh-wayland-welcome.mjs'

const orders = {
  surface: '-> xdg_wm_base@20.get_xdg_surface(new id xdg_surface@32, wl_surface@33)',
  toplevel: '-> xdg_surface@32.get_toplevel(new id xdg_toplevel@34)',
  title: '-> xdg_toplevel@34.set_title("DeepSeek Harness")',
  initial: '-> wl_surface@33.commit()',
  configure: 'xdg_surface@32.configure(19211)',
  ack: '-> xdg_surface@32.ack_configure(19211)',
  attach: '-> wl_surface@33.attach(wl_buffer@36, 0, 0)',
  commit: '-> wl_surface@33.commit()',
}
const events = Object.values(orders)
const trace = (...lines) => lines.map((order, index) => `[   ${9 + index}.021] ${order}`).join('\r\n')
const extract = input => findWelcomeBuffer(trace(...input))

suiteForCoreTraces()
function suiteForCoreTraces() {
  test('the configured welcome toplevel submits a non-null buffer on the same surface', () => {
    assert.equal(extract(events), true)
    assert.equal(extract(events.map(order => `{Display Queue}  ${order}`)), true)
    assert.equal(findWelcomeBuffer(trace(...events.map(order => order.replace('DeepSeek Harness', 'Test Shell'))), 'Test Shell'), true)
  })

  test('connection, title, acknowledgement, and initial commits are not enough', () => {
    for (const without of ['configure', 'ack', 'attach', 'title', 'commit', 'surface', 'toplevel']) {
      assert.equal(extract(Object.entries(orders).filter(([key]) => key !== without).map(([, value]) => value)), false, without)
    }
    assert.equal(extract(events.map(order => order.replace('ack_configure(19211)', 'ack_configure(19212)'))), false)
    assert.equal(extract(events.map(order => order.replace('wl_buffer@36', 'nil'))), false)
    assert.equal(extract(events.map(order => order.replace('wl_buffer@36', 'wl_buffer@0'))), false)
  })

  test('unrelated or already destroyed Wayland objects cannot supply welcome evidence', () => {
    assert.equal(extract([...events.slice(0, -2), '-> wl_surface@42.attach(wl_buffer@36, 0, 0)', orders.commit]), false)
    assert.equal(extract([...events.slice(0, -1), '-> wl_surface@42.commit()']), false)
    assert.equal(extract([...events, '-> xdg_toplevel@34.destroy()']), false)
    assert.equal(extract([...events, '-> wl_surface@33.attach(nil, 0, 0)', orders.commit]), false)
    assert.equal(extract([...events, '-> xdg_toplevel@34.set_title("Unexpected")']), false)
    assert.equal(extract([...events, orders.surface, orders.toplevel, orders.title, orders.attach, orders.commit]), false)
  })
}

test('bounded CLI distinguishes success, not seen yet, and bad file without echoing traces', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-wayland-trace-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = join(directory, 'client.log')
  const script = fileURLToPath(new URL('../scripts/read-dsh-wayland-welcome.mjs', import.meta.url))
  const run = filename => spawnSync(process.execPath, [script, filename], { encoding: 'utf8', timeout: 5000 })
  await writeFile(input, 'host-provided private log line\n' + trace(...events.slice(0, -1)))
  const notYet = run(input)
  assert.equal(notYet.status, 1)
  assert.equal(notYet.stdout + notYet.stderr, '')
  await writeFile(input, 'host-provided private log line\n' + trace(...events))
  assert.equal(execFileSync(process.execPath, [script, input], { encoding: 'utf8', timeout: 5000 }).trim(), 'Wayland welcome surface committed a buffer.')
  const bad = run(join(directory, 'unavailable'))
  assert.equal(bad.status, 2)
  assert.doesNotMatch(bad.stderr, /unavailable/u)
  await writeFile(input, Buffer.alloc(8 * 1024 * 1024 + 1))
  await assert.rejects(readWaylandTrace(input), /bounded regular client trace/u)
})
