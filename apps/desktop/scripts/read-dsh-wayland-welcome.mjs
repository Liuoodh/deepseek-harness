// Check only a private CI client's Wayland trace. Never log raw trace lines.
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const maxTrace = 8 * 1024 * 1024
const id = '(0|[1-9]\\d{0,9})'
const linePattern = /^(?:\[\s*\d+\.\d+\])\s*(?:\{[^}\r\n]+\}\s*)?(?:(->)\s*)?(wl_surface|xdg_wm_base|xdg_surface|xdg_toplevel)@(\d+)\.(\w+)\(([^\r\n]*)\)\s*$/u
const getSurface = new RegExp(`^new id xdg_surface@${id}, wl_surface@${id}$`, 'u')
const getToplevel = new RegExp(`^new id xdg_toplevel@${id}$`, 'u')
const attach = new RegExp(`^wl_buffer@${id}, -?\\d+, -?\\d+$`, 'u')
const serial = /^\d{1,10}$/u

/** Look for a configured welcome toplevel that commits an actual buffer on its own wl_surface. */
export function findWelcomeBuffer(trace, welcomeTitle = 'DeepSeek Harness') {
  const roles = new Map()
  const toplevels = new Map()
  const liveRole = new Map()
  let presented
  const remove = (role, expected) => {
    if (role === undefined) return
    const removed = roles.get(role)
    if (removed && (expected === undefined || removed.surface === expected)) {
      if (removed.toplevel !== undefined) toplevels.delete(removed.toplevel)
      liveRole.delete(removed.surface)
      roles.delete(role)
      if (presented?.role === role) presented = undefined
    }
  }
  for (const raw of trace.split(/\r?\n/u)) {
    const event = linePattern.exec(raw)
    if (!event) continue
    const [, request, type, object, method, args] = event
    if (request && type === 'xdg_wm_base' && method === 'get_xdg_surface') {
      const ids = getSurface.exec(args)
      if (ids) {
        const [, role, surface] = ids
        remove(role)
        remove(liveRole.get(surface), surface)
        roles.set(role, { surface, configures: new Set(), acked: false, attached: undefined, titleMatches: false })
        liveRole.set(surface, role)
      }
    } else if (type === 'xdg_surface') {
      const state = roles.get(object)
      if (!state) continue
      if (request && method === 'get_toplevel') {
        const matches = getToplevel.exec(args)
        if (matches) {
          const previous = toplevels.get(matches[1])
          if (previous && previous !== object) remove(previous)
          if (state.toplevel !== undefined) toplevels.delete(state.toplevel)
          state.toplevel = matches[1]
          toplevels.set(state.toplevel, object)
          state.titleMatches = false
        }
      } else if (!request && method === 'configure' && serial.test(args)) {
        state.configures.add(args)
      } else if (request && method === 'ack_configure' && state.configures.has(args)) {
        state.acked = true
        // Every earlier configure was acknowledged implicitly as well.
        for (const pending of state.configures) {
          state.configures.delete(pending)
          if (pending === args) break
        }
      } else if (request && method === 'destroy') remove(object)
    } else if (request && type === 'xdg_toplevel') {
      const role = toplevels.get(object)
      const state = roles.get(role)
      if (method === 'set_title' && state) {
        state.titleMatches = args === JSON.stringify(welcomeTitle)
        if (!state.titleMatches && presented?.role === role) presented = undefined
      } else if (method === 'destroy') remove(role)
    } else if (request && type === 'wl_surface') {
      const role = liveRole.get(object)
      const state = roles.get(role)
      if (!state) continue
      if (method === 'attach') {
        const buffer = attach.exec(args)
        state.attached = Boolean(buffer && buffer[1] !== '0')
      } else if (method === 'commit' && state.attached !== undefined) {
        if (state.attached && state.acked && state.titleMatches) presented = { role, surface: object }
        if (!state.attached && presented?.role === role) {
          presented = undefined
          state.acked = false
          state.configures.clear()
        }
        state.attached = undefined
      } else if (method === 'destroy') remove(role, object)
    }
  }
  return presented !== undefined
}

/** Read at most one bounded snapshot so a growing trace cannot exhaust memory. */
export async function readWaylandTrace(path) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maxTrace) throw new Error('Expected a bounded regular client trace')
    const bytes = Buffer.alloc(info.size)
    let read = 0
    while (read < bytes.length) {
      const { bytesRead } = await file.read(bytes, read, bytes.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return bytes.subarray(0, read).toString('utf-8')
  } finally {
    await file.close()
  }
}

// Emit only fixed labels and counts, never text or identifiers from a client log.
export function summarizeWaylandTrace(trace) {
  const events = {
    surfaceRole: 'xdg_wm_base.get_xdg_surface', toplevel: 'xdg_surface.get_toplevel',
    title: 'xdg_toplevel.set_title', configure: 'xdg_surface.configure', ack: 'xdg_surface.ack_configure',
    attach: 'wl_surface.attach', commit: 'wl_surface.commit',
  }
  const count = Object.fromEntries(Object.keys(events).map(key => [key, 0]))
  let protocolLookingLines = 0
  let recognizedLines = 0
  let welcomeTitle = 0
  let bufferedAttach = 0
  for (const raw of trace.split(/\r?\n/u)) {
    if (/\b(?:wl_display|wl_registry|wl_surface|xdg_wm_base|xdg_surface|xdg_toplevel)[@#]\d+\./u.test(raw)) protocolLookingLines++
    const match = linePattern.exec(raw)
    if (!match) continue
    recognizedLines++
    const [, , type, , method, args] = match
    for (const [key, value] of Object.entries(events)) {
      if (`${type}.${method}` === value) count[key]++
    }
    if (type === 'xdg_toplevel' && method === 'set_title' && args === '"DeepSeek Harness"') welcomeTitle++
    if (type === 'wl_surface' && method === 'attach' && /^wl_buffer@[1-9]\d*,/u.test(args)) bufferedAttach++
  }
  return {
    protocolLookingLines, recognizedLines, ...count, welcomeTitle, bufferedAttach,
    missingWaylandDisplay: /failed to connect to (?:the |a )?wayland display/iu.test(trace),
    missingXDisplay: /missing x server or \$display/iu.test(trace),
    ozoneInitFailure: /the platform failed to initialize|failed to initialize ozone/iu.test(trace),
    gbmOrEglIssue: /(?:egl|gbm)[^\r\n]{0,180}(?:failed|error)|(?:failed|error)[^\r\n]{0,180}(?:egl|gbm)/iu.test(trace),
    gpuProcessIssue: /gpu process (?:is not usable|exited unexpectedly)|failed to launch gpu process/iu.test(trace),
    displayProtocolError: /\bwl_display[@#]\d+\.error\(/u.test(trace),
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = process.argv.length === 4 && process.argv[2] === '--summary'
  if (process.argv.length !== 3 && !summary) {
    console.error('Usage: node read-dsh-wayland-welcome.mjs [--summary] CLIENT_TRACE')
    process.exitCode = 2
  } else {
    try {
      const trace = await readWaylandTrace(process.argv[summary ? 3 : 2])
      if (summary) console.log(JSON.stringify(summarizeWaylandTrace(trace)))
      else if (findWelcomeBuffer(trace)) console.log('Wayland welcome surface committed a buffer.')
      else process.exitCode = 1
    } catch {
      console.error('Could not read a bounded Wayland client trace.')
      process.exitCode = 2
    }
  }
}
