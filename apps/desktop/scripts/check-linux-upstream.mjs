/** Rehearse a Linux port merge using reviewed Git commits without changing branches or checkout files. */
import { spawnSync } from 'node:child_process'

const upstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'
const upstreamRef = 'refs/remotes/upstream/master'
const fullSha = /^[0-9a-f]{40}$/u

function git(...args) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return result
}

function output(result, failure) {
  if (result.status !== 0) throw new Error([failure, result.stderr.trim()].filter(Boolean).join('\n'))
  return result.stdout.trim()
}

function ancestor(older, newer) {
  const result = git('merge-base', '--is-ancestor', older, newer)
  if (result.status === 1) return false
  output(result, 'Could not inspect commit ancestry.')
  return true
}

function check(upstreamSha, portRef) {
  if (!fullSha.test(upstreamSha)) throw new Error('Pass the reviewed upstream commit as a full 40-character lowercase SHA.')
  if (!portRef.startsWith('refs/heads/port/') || git('check-ref-format', portRef).status !== 0) {
    throw new Error('Pass an exact local maintenance branch ref under refs/heads/port/.')
  }
  if (output(git('rev-parse', '--is-shallow-repository'), 'Run inside the fork checkout.') !== 'false') {
    throw new Error('Use a full Git checkout; shallow history can hide the merge base.')
  }
  const remote = git('remote', 'get-url', 'upstream')
  if (remote.status !== 0 || remote.stdout.trim() !== upstreamUrl) {
    throw new Error(`The upstream fetch remote must be ${upstreamUrl}.`)
  }
  const upstreamTip = output(git('rev-parse', '--verify', `${upstreamRef}^{commit}`), 'Fetch upstream master first.')
  const portCommit = output(git('show-ref', '--verify', '--hash', portRef), `Create and commit the local maintenance branch ${portRef} first.`)
  if (output(git('cat-file', '-t', upstreamSha), 'The reviewed upstream commit is not available locally.') !== 'commit') {
    throw new Error('The reviewed SHA must identify a commit, not a tag or tree.')
  }
  if (!ancestor(upstreamSha, upstreamTip)) throw new Error('The reviewed commit is not in the fetched upstream/master history.')
  if (ancestor(upstreamSha, portCommit)) throw new Error('The port already contains the reviewed upstream commit; no new merge is needed.')

  const result = git('merge-tree', '--write-tree', '--messages', portCommit, upstreamSha)
  if (result.status === 1) {
    const details = result.stdout.trim().split('\n').slice(1).join('\n')
    throw new Error(`Merge conflicts between ${portCommit} and ${upstreamSha}.\n${details}`)
  }
  const mergeTree = output(result, 'Could not rehearse the upstream merge.').split(/\r?\n/u)[0]
  if (!fullSha.test(mergeTree)) throw new Error('Git did not report the merged tree SHA.')
  return { portRef, portCommit, upstreamCommit: upstreamSha, upstreamTip, mergeTree }
}

try {
  if (process.argv.length !== 4) throw new Error('Usage: node apps/desktop/scripts/check-linux-upstream.mjs <reviewed-upstream-sha> <refs/heads/port/maintenance-branch>')
  console.log(JSON.stringify(check(process.argv[2], process.argv[3]), null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
