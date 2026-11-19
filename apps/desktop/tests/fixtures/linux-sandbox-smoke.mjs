/** Run one fixed command through the sandbox provider loaded by the packaged Host. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'

/**
 * Require the selected runner to execute a fixed, read-only probe, never bare argv.
 * @param {import('@deepseek-ai/dsh-sandbox').SandboxProvider} sandbox Packaged Host provider.
 * @param {string} workspaceRoot Private fixture directory owned by the smoke run.
 * @param {typeof execFile} [execute] Process launch implementation (substituted only in fixture tests).
 * @returns {Promise<string>} Runner name and the provider's reported enforcement level.
 */
export async function checkLinuxSandbox(sandbox, workspaceRoot, execute = execFile) {
  const marker = 'desktop-linux-sandbox-ready'
  const { argv: [runner, ...args], enforcement } = await sandbox.confine(['/bin/echo', marker], { mode: 'workspace-write', workspaceRoot })
  const backend = runner === undefined ? '' : basename(runner)
  if (runner === undefined || (backend !== 'bwrap' && backend !== 'landlock-run')) {
    throw new Error('desktop runtime: expected a Linux sandbox runner')
  }
  const { stdout } = await promisify(execute)(runner, args, {
    cwd: workspaceRoot, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 8_192,
  })
  if (stdout !== `${marker}\n`) throw new Error('desktop runtime: sandboxed command did not return its marker')
  return `${backend}/${enforcement}`
}
