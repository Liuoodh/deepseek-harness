/** Exercise the upstream preflight against disposable Git histories. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/check-linux-upstream.mjs', import.meta.url))
const upstreamUrl = 'https://github.com/deepseek-ai/deepseek-harness.git'

function run(cwd, program, ...args) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(cwd, 'unused-global.gitconfig') }
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env })
  assert.ifError(result.error)
  return result
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', ...args)
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-port-merge-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  git(root, 'init', '-q', '-b', 'port/linux-desktop', '--object-format=sha1')
  git(root, 'config', 'user.email', 'fixture@example.test')
  git(root, 'config', 'user.name', 'Merge test')
  git(root, 'config', 'core.autocrlf', 'false')
  git(root, 'remote', 'add', 'upstream', upstreamUrl)
  async function commit(file, text) {
    await writeFile(join(root, file), `${text}\n`)
    git(root, 'add', file)
    git(root, 'commit', '-qm', text)
    return git(root, 'rev-parse', 'HEAD')
  }
  const base = await commit('desktop.txt', 'desktop base')
  const port = await commit('desktop.txt', 'port change')
  git(root, 'switch', '-qc', 'upstream-fixture', base)
  const incoming = await commit('new-web.txt', 'compatible update')
  const conflict = await commit('desktop.txt', 'conflicting upstream edit')
  git(root, 'update-ref', 'refs/remotes/upstream/master', conflict)
  git(root, 'switch', '-q', 'port/linux-desktop')
  return { root, base, port, incoming, conflict }
}

function check(root, sha) { return run(root, process.execPath, script, sha) }

test('predicts the merge of the reviewed upstream commit, without touching the checkout or refs', async t => {
  const { root, port, incoming, conflict } = await fixture(t)
  const dirtyFile = join(root, 'desktop.txt')
  await writeFile(dirtyFile, 'uncommitted work\n')
  const refs = git(root, 'show-ref')
  const status = git(root, 'status', '--short')
  const result = check(root, incoming)
  assert.equal(result.status, 0, result.stderr)
  const { mergeTree, ...commits } = JSON.parse(result.stdout)
  assert.deepEqual(commits, { portCommit: port, upstreamCommit: incoming, upstreamTip: conflict })
  assert.equal(git(root, 'show-ref'), refs)
  assert.equal(git(root, 'status', '--short'), status)
  assert.equal(await readFile(dirtyFile, 'utf8'), 'uncommitted work\n')
  git(root, 'restore', 'desktop.txt')
  git(root, 'switch', '-qc', 'port/linux-candidate/fixture')
  git(root, 'merge', '--no-ff', '--no-edit', incoming)
  assert.equal(git(root, 'rev-parse', 'HEAD^{tree}'), mergeTree)
})

test('reports real merge conflicts without creating a candidate or changing the port', async t => {
  const { root, port, conflict } = await fixture(t)
  const refs = git(root, 'show-ref')
  const result = check(root, conflict)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Merge conflicts[\s\S]*CONFLICT.*desktop\.txt/u)
  assert.equal(git(root, 'show-ref'), refs)
  assert.equal(git(root, 'rev-parse', 'HEAD'), port)
  assert.equal(git(root, 'status', '--short'), '')
})

test('rejects ambiguous, unrelated and already-integrated inputs', async t => {
  const { root, base, port, incoming } = await fixture(t)
  for (const [input, message] of [[incoming.slice(0, 12), /full 40-character/u], [port, /not in the fetched/u], [base, /already contains/u]]) {
    const result = check(root, input)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
  }
  git(root, 'remote', 'set-url', 'upstream', 'https://example.test/not-upstream.git')
  assert.match(check(root, incoming).stderr, /upstream fetch remote must be/u)
})

test('rejects shallow history rather than guessing at the merge base', async t => {
  const { root, incoming } = await fixture(t)
  const clone = join(root, 'shallow')
  git(root, 'clone', '-q', '--no-local', '--depth=1', root, clone)
  const result = check(clone, incoming)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /shallow history can hide the merge base/u)
})
