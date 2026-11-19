/** Exercise the packaged sandbox smoke's acceptance rules without changing the test host's policy. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { checkLinuxSandbox } from './fixtures/linux-sandbox-smoke.mjs'

const workspace = '/private-fixture'
const command = ['/bin/echo', 'desktop-linux-sandbox-ready']
const stub = implementation => Object.assign(() => assert.fail('expected the promisified stub'), { [promisify.custom]: implementation })

for (const [runner, enforcement] of [['bwrap', 'full'], ['/resources/bin/landlock-run', 'partial']]) {
  test(`executes the selected ${runner} without a shell`, async () => {
    const args = ['--', ...command]
    const sandbox = { async confine(argv, policy) {
      assert.deepEqual(argv, command)
      assert.deepEqual(policy, { mode: 'workspace-write', workspaceRoot: workspace })
      return { argv: [runner, ...args], enforcement }
    } }
    const execute = stub(async (program, argv, options) => {
      assert.equal(program, runner)
      assert.deepEqual(argv, args)
      assert.equal(options.cwd, workspace)
      assert.equal(options.shell, undefined)
      assert.ok(options.timeout > 0)
      return { stdout: command[1] + '\n' }
    })
    assert.equal(await checkLinuxSandbox(sandbox, workspace, execute), `${runner.split('/').at(-1)}/${enforcement}`)
  })
}

test('fails before process launch when sandbox selection fails or returns bare argv', async () => {
  const execute = stub(() => assert.fail('unexpected process launch'))
  const unavailable = Object.assign(new Error('no working sandbox'), { code: 'SANDBOX_UNAVAILABLE' })
  await assert.rejects(checkLinuxSandbox({ async confine() { throw unavailable } }, workspace, execute), { code: 'SANDBOX_UNAVAILABLE' })
  await assert.rejects(checkLinuxSandbox({ async confine() { return { argv: command, enforcement: 'full' } } }, workspace, execute),
    /expected a Linux sandbox runner/u)
})

test('rejects a runner launch error or missing command output', async () => {
  const sandbox = { async confine() { return { argv: ['bwrap', '--', ...command], enforcement: 'full' } } }
  const denied = stub(async () => { throw new Error('runner did not start') })
  const empty = stub(async () => ({ stdout: '' }))
  await assert.rejects(checkLinuxSandbox(sandbox, workspace, denied), /runner did not start/u)
  await assert.rejects(checkLinuxSandbox(sandbox, workspace, empty), /did not return its marker/u)
})
