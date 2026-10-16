import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { discoverAdapters, publicAdapter, publicTask } from './manifest.js'
import { ScriptsError } from './errors.js'

const DEFAULTS = Object.freeze({
  adapterRoots: [],
  workspaceDir: join(homedir(), '.dsh-crawshrimp-scripts'),
  browserChannel: 'chrome',
  executablePath: '',
  cdpEndpoint: '',
  storageStatePath: '',
  timeoutMs: 120000,
  maxScriptBytes: 512 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
})

const MAX_STORAGE_STATE_BYTES = 5 * 1024 * 1024
const MAX_PARAMS_BYTES = 1 * 1024 * 1024

function expandPath(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  return resolve(text === '~' ? homedir() : text.startsWith('~/') ? join(homedir(), text.slice(2)) : text)
}

function positiveBound(value, label, { min, max, fallback }) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new ScriptsError('CONFIG_INVALID', `${label} must be an integer from ${min} to ${max}`)
  return number
}

export function normalizeConfig(raw = {}) {
  const config = { ...DEFAULTS, ...(raw || {}) }
  const adapterRoots = Array.isArray(config.adapterRoots) ? config.adapterRoots.map(expandPath).filter(Boolean) : []
  const workspaceDir = expandPath(config.workspaceDir) || DEFAULTS.workspaceDir
  const executablePath = expandPath(config.executablePath || process.env.CHROME_PATH || '')
  const cdpEndpoint = String(config.cdpEndpoint || '').trim()
  const storageStatePath = expandPath(config.storageStatePath || '')
  if (executablePath && cdpEndpoint) throw new ScriptsError('CONFIG_INVALID', 'executablePath and cdpEndpoint are mutually exclusive')
  if (cdpEndpoint) {
    try {
      const parsed = new URL(cdpEndpoint)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) throw new Error('protocol')
    } catch {
      throw new ScriptsError('CONFIG_INVALID', 'cdpEndpoint must be an http(s) or ws(s) URL')
    }
  }
  const browserChannel = String(config.browserChannel || 'chrome').trim()
  if (!browserChannel && !executablePath && !cdpEndpoint) throw new ScriptsError('CONFIG_INVALID', 'browserChannel, executablePath or cdpEndpoint is required')
  return Object.freeze({
    adapterRoots,
    workspaceDir,
    browserChannel,
    executablePath,
    cdpEndpoint,
    storageStatePath,
    timeoutMs: positiveBound(config.timeoutMs, 'timeoutMs', { min: 1000, max: 1800000, fallback: DEFAULTS.timeoutMs }),
    maxScriptBytes: positiveBound(config.maxScriptBytes, 'maxScriptBytes', { min: 1024, max: 4 * 1024 * 1024, fallback: DEFAULTS.maxScriptBytes }),
    maxOutputBytes: positiveBound(config.maxOutputBytes, 'maxOutputBytes', { min: 1024, max: 16 * 1024 * 1024, fallback: DEFAULTS.maxOutputBytes }),
  })
}

function assertObjectParams(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScriptsError('PARAMS_INVALID', 'params must be a JSON object')
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ScriptsError('PARAMS_INVALID', 'params must be JSON-serializable and must not be circular')
  }
  if (encoded === undefined) throw new ScriptsError('PARAMS_INVALID', 'params must be a JSON object')
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PARAMS_BYTES) throw new ScriptsError('PARAMS_TOO_LARGE', `params exceed ${MAX_PARAMS_BYTES} bytes`)
  return JSON.parse(encoded)
}

function assertCallArgs(args, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ScriptsError('ARGS_INVALID', 'tool arguments must be a JSON object')
  for (const key of required) if (typeof args[key] !== 'string' || !args[key].trim()) throw new ScriptsError('ARGS_INVALID', `${key} is required`)
}

function jsonBytes(value, label) {
  let encoded
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ScriptsError('NON_JSON_RESULT', `${label} must be JSON-serializable and must not be circular`)
  }
  if (encoded === undefined) throw new ScriptsError('NON_JSON_RESULT', `${label} must be JSON-serializable`)
  return { encoded, bytes: Buffer.byteLength(encoded, 'utf8') }
}

async function closeQuietly(value) {
  try {
    if (value) await value.close()
  } catch {}
}

async function readStorageState(pathname) {
  if (!pathname) return undefined
  let info
  try {
    info = await stat(pathname)
  } catch (error) {
    throw new ScriptsError('STORAGE_STATE_INVALID', `storageStatePath is not readable: ${error.message}`)
  }
  if (!info.isFile()) throw new ScriptsError('STORAGE_STATE_INVALID', 'storageStatePath must point to a regular file')
  if (info.size > MAX_STORAGE_STATE_BYTES) throw new ScriptsError('STORAGE_STATE_TOO_LARGE', `storageStatePath exceeds ${MAX_STORAGE_STATE_BYTES} bytes`)
  let source
  try {
    source = await readFile(pathname, 'utf8')
  } catch (error) {
    throw new ScriptsError('STORAGE_STATE_INVALID', `storageStatePath is not readable: ${error.message}`)
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_STORAGE_STATE_BYTES) throw new ScriptsError('STORAGE_STATE_TOO_LARGE', `storageStatePath exceeds ${MAX_STORAGE_STATE_BYTES} bytes`)
  try {
    const value = JSON.parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('state must be a JSON object')
    return value
  } catch (error) {
    throw new ScriptsError('STORAGE_STATE_INVALID', `storageStatePath must contain valid Playwright storage state JSON: ${error.message}`)
  }
}

function pathInside(base, candidate) {
  const distance = relative(base, candidate)
  return distance === '' || (distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance))
}

async function createArtifactDirectory(workspaceReal, adapterId, taskId) {
  let current = workspaceReal
  for (const part of ['artifacts', adapterId, taskId]) {
    const candidate = join(current, part)
    try {
      await mkdir(candidate)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot create artifact directory: ${error.message}`)
    }
    let resolved
    try {
      resolved = await realpath(candidate)
      const info = await stat(resolved)
      if (!info.isDirectory()) throw new Error('path is not a directory')
    } catch (error) {
      if (error instanceof ScriptsError) throw error
      throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot inspect artifact directory: ${error.message}`)
    }
    if (!pathInside(workspaceReal, resolved)) throw new ScriptsError('ARTIFACT_WRITE_FAILED', 'artifact directory resolves outside workspaceDir')
    current = resolved
  }
  return current
}

export class ScriptsRuntime {
  constructor(ctx, rawConfig = {}) {
    this.ctx = ctx
    this.config = normalizeConfig(rawConfig)
    this.active = new Set()
    this.disposed = false
  }

  async dispose() {
    this.disposed = true
    const runs = [...this.active]
    for (const run of runs) run.controller.abort(new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded'))
    await Promise.allSettled(runs.map((run) => run.promise))
  }

  async list(args = {}) {
    if (this.disposed) throw new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded')
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    const adapterId = typeof args.adapter_id === 'string' ? args.adapter_id.trim() : ''
    if (adapterId) {
      const adapter = adapters.find((candidate) => candidate.id === adapterId)
      if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
      return { adapters: [publicAdapter(adapter)] }
    }
    return { adapters: adapters.map(publicAdapter) }
  }

  async run(args, execution) {
    if (this.disposed) throw new ScriptsError('PLUGIN_UNLOADED', 'scripts plugin unloaded')
    assertCallArgs(args, ['adapter_id', 'task_id'])
    const params = assertObjectParams(args.params ?? {})
    const controller = new AbortController()
    const state = { controller, promise: undefined }
    const promise = this.execute(args.adapter_id.trim(), args.task_id.trim(), params, execution, controller.signal)
      .finally(() => this.active.delete(state))
    state.promise = promise
    this.active.add(state)
    return promise
  }

  async execute(adapterId, taskId, params, execution, stopSignal) {
    const lifecycleSignal = AbortSignal.any([execution.signal, stopSignal])
    lifecycleSignal.throwIfAborted()
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    lifecycleSignal.throwIfAborted()
    const adapter = adapters.find((candidate) => candidate.id === adapterId)
    if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
    const task = adapter.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new ScriptsError('TASK_NOT_FOUND', `task not found: ${adapterId}/${taskId}`)
    const approval = await this.requestApproval(execution, adapter, task, params, lifecycleSignal)
    if (!approval) throw new ScriptsError('APPROVAL_REQUIRED', 'script execution requires native approval')
    lifecycleSignal.throwIfAborted()
    const timeout = AbortSignal.timeout(this.config.timeoutMs)
    const signal = AbortSignal.any([lifecycleSignal, timeout])
    let browser
    let context
    let page
    let closePromise
    const close = async () => {
      if (closePromise) return closePromise
      // An abort can fire while openBrowser is still starting. In that small
      // window the outer variables are empty; do not cache a no-op cleanup or
      // resources returned by a late setup would leak.
      if (!page && !context && !browser) return
      closePromise = (async () => {
        await closeQuietly(page)
        await closeQuietly(context)
        await closeQuietly(browser)
      })()
      return closePromise
    }
    const onAbort = () => { void close() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      ({ browser, context, page } = await this.openBrowser(signal))
      signal.throwIfAborted()
      await page.goto(adapter.entryUrl, { waitUntil: 'domcontentloaded', timeout: this.config.timeoutMs })
      signal.throwIfAborted()
      let rawResult
      try {
        rawResult = await page.evaluate(async ({ source, params: pageParams }) => {
          window.__PARAMS__ = pageParams
          return await (0, eval)(source)
        }, { source: task.source, params })
      } catch (error) {
        if (signal.aborted) throw new ScriptsError('ABORTED', 'script execution was cancelled or timed out')
        throw new ScriptsError('SCRIPT_FAILED', `page script failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) throw new ScriptsError('RESULT_INVALID', 'script must return { success, data, meta }')
      if (typeof rawResult.success !== 'boolean' || !Array.isArray(rawResult.data) || !rawResult.meta || typeof rawResult.meta !== 'object' || Array.isArray(rawResult.meta)) {
        throw new ScriptsError('RESULT_INVALID', 'script must return { success: boolean, data: array, meta: object }')
      }
      const baseResult = { success: rawResult.success, data: rawResult.data, meta: rawResult.meta }
      const serialized = jsonBytes(baseResult, 'script result')
      if (serialized.bytes > this.config.maxOutputBytes) throw new ScriptsError('OUTPUT_TOO_LARGE', `script result exceeds maxOutputBytes (${this.config.maxOutputBytes})`)
      const artifact = await this.writeArtifact(adapter, task, serialized.encoded, signal)
      return { ...baseResult, artifact }
    } finally {
      signal.removeEventListener('abort', onAbort)
      await close()
    }
  }

  async requestApproval(execution, adapter, task, params, signal = execution.signal) {
    const approval = typeof this.ctx?.get === 'function' ? this.ctx.get('approval') : undefined
    if (!approval || !execution.agent?.session) return false
    let removeAbortListener = () => {}
    try {
      signal.throwIfAborted()
      // `never` is a deny policy for actions that require approval. A script
      // run is such an action, so it must not silently become unattended
      // execution; only the native one-shot allowed-once result can pass.
      if (typeof approval.effectivePolicy === 'function' && approval.effectivePolicy(execution.agent.session) === 'never') return false
      const abort = new Promise((_, reject) => {
        const rejectAborted = () => reject(new ScriptsError('ABORTED', 'script execution was cancelled or timed out'))
        if (signal.aborted) {
          rejectAborted()
          return
        }
        signal.addEventListener('abort', rejectAborted, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', rejectAborted)
      })
      const outcome = await Promise.race([approval.request({
        agent: execution.agent,
        toolName: execution.name,
        callId: execution.callId,
        reason: `Crawshrimp script execution: ${adapter.id}/${task.id}`,
        arguments: { adapter_id: adapter.id, task_id: task.id, params },
        signal,
      }), abort])
      signal.throwIfAborted()
      return outcome === 'allowed-once'
    } catch (error) {
      if (signal.aborted) throw new ScriptsError('ABORTED', 'script execution was cancelled or timed out')
      return false
    } finally {
      removeAbortListener()
    }
  }

  async openBrowser(signal) {
    signal.throwIfAborted()
    let browser
    let context
    let page
    try {
      if (this.config.cdpEndpoint) browser = await chromium.connectOverCDP(this.config.cdpEndpoint)
      else {
        const launchOptions = { headless: true }
        if (this.config.executablePath) launchOptions.executablePath = this.config.executablePath
        else if (this.config.browserChannel) launchOptions.channel = this.config.browserChannel
        browser = await chromium.launch(launchOptions)
      }
      signal.throwIfAborted()
      try {
        const storageState = await readStorageState(this.config.storageStatePath)
        context = await browser.newContext(storageState ? { storageState } : {})
      } catch (error) {
        throw new ScriptsError('BROWSER_ISOLATION_UNAVAILABLE', `cannot create an isolated browser context${this.config.cdpEndpoint ? ' through the configured CDP endpoint' : ''}: ${error.message}`)
      }
      signal.throwIfAborted()
      page = await context.newPage()
      signal.throwIfAborted()
      return { browser, context, page }
    } catch (error) {
      await closeQuietly(page)
      await closeQuietly(context)
      await closeQuietly(browser)
      if (error instanceof ScriptsError) throw error
      if (signal.aborted) throw new ScriptsError('ABORTED', 'browser setup was cancelled')
      throw new ScriptsError('BROWSER_UNAVAILABLE', `cannot start an isolated browser: ${error.message}`)
    }
  }

  async writeArtifact(adapter, task, encoded, signal) {
    signal.throwIfAborted()
    const workspace = resolve(this.config.workspaceDir)
    await mkdir(workspace, { recursive: true })
    const workspaceReal = await realpath(workspace)
    const outputDirReal = await createArtifactDirectory(workspaceReal, adapter.id, task.id)
    const prefix = `${Date.now()}-${randomUUID()}`
    for (let index = 0; index < 20; index += 1) {
      signal.throwIfAborted()
      const filename = `${prefix}${index ? `-${index}` : ''}.json`
      const target = join(outputDirReal, filename)
      try {
        const handle = await open(target, 'wx', 0o600)
        try {
          await handle.writeFile(encoded, 'utf8')
        } finally {
          await handle.close()
        }
        return { path: relative(workspaceReal, target), bytes: Buffer.byteLength(encoded, 'utf8') }
      } catch (error) {
        if (error?.code === 'EEXIST') continue
        throw new ScriptsError('ARTIFACT_WRITE_FAILED', `cannot save JSON artifact: ${error.message}`)
      }
    }
    throw new ScriptsError('ARTIFACT_WRITE_FAILED', 'could not allocate a unique JSON artifact filename')
  }

  async getTask(adapterId, taskId) {
    const adapters = await discoverAdapters(this.config.adapterRoots, this.config)
    const adapter = adapters.find((candidate) => candidate.id === adapterId)
    if (!adapter) throw new ScriptsError('ADAPTER_NOT_FOUND', `adapter not found: ${adapterId}`)
    const task = adapter.tasks.find((candidate) => candidate.id === taskId)
    if (!task) throw new ScriptsError('TASK_NOT_FOUND', `task not found: ${adapterId}/${taskId}`)
    return publicTask(adapter, task)
  }
}
