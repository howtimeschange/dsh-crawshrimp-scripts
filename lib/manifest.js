import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { parse } from 'yaml'
import { ScriptsError } from './errors.js'

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u
const MANIFEST_KEYS = new Set(['id', 'name', 'version', 'description', 'author', 'entry_url', 'tasks'])
const TASK_KEYS = new Set(['id', 'name', 'description', 'script'])

function assertRecord(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScriptsError('MANIFEST_INVALID', message)
  return value
}

function assertString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new ScriptsError('MANIFEST_INVALID', `${label} must be a non-empty string`)
  return value.trim()
}

function assertSlug(value, label) {
  const text = assertString(value, label)
  if (!SLUG_PATTERN.test(text)) throw new ScriptsError('MANIFEST_INVALID', `${label} must match ${SLUG_PATTERN}`)
  return text
}

function rejectUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length) {
    throw new ScriptsError(
      'UNSUPPORTED_MANIFEST_FIELD',
      `${label} contains unsupported field(s): ${unknown.join(', ')}; this plugin supports only the portable manifest subset`,
    )
  }
}

function assertHttpUrl(value, label) {
  const text = assertString(value, label)
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new ScriptsError('MANIFEST_INVALID', `${label} must be an absolute http(s) URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ScriptsError('MANIFEST_INVALID', `${label} must use http or https`)
  }
  return parsed.toString()
}

function relativePath(rawPath, label) {
  const text = assertString(rawPath, label).replaceAll('\\', '/')
  const parsed = normalize(text)
  if (isAbsolute(text) || parsed === '..' || parsed.startsWith(`..${normalize('/')}`) || text.split('/').includes('..')) {
    throw new ScriptsError('PATH_ESCAPE', `${label} must stay inside its adapter directory`)
  }
  if (text.includes('\0')) throw new ScriptsError('PATH_INVALID', `${label} contains a NUL byte`)
  return text
}

function isInside(base, candidate) {
  const distance = relative(base, candidate)
  return distance === '' || (distance !== '..' && !distance.startsWith(`..${normalize('/')}`) && !isAbsolute(distance))
}

async function realFileInside(base, rawPath, label) {
  const relativeName = relativePath(rawPath, label)
  let candidate
  try {
    candidate = await realpath(join(base, relativeName))
    const info = await stat(candidate)
    if (!info.isFile()) throw new Error('not a file')
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('PATH_INVALID', `${label} does not point to a readable file: ${relativeName}`)
  }
  if (!isInside(base, candidate)) throw new ScriptsError('PATH_ESCAPE', `${label} resolves outside its adapter directory`)
  return candidate
}

async function realDirectory(pathname, label) {
  let candidate
  try {
    candidate = await realpath(pathname)
    const info = await stat(candidate)
    if (!info.isDirectory()) throw new Error('not a directory')
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('ROOT_UNAVAILABLE', `${label} is not an existing directory: ${pathname}`)
  }
  return candidate
}

function validateTaskScriptContract(source, relativeName) {
  const compact = source.replace(/\s+/gu, ' ')
  const asyncIife = /\(\s*async\s*(?:(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>|function(?:\s+[A-Za-z_$][\w$]*)?\s*\()/u.test(compact)
  const iifeCall = /\}\s*\)\s*\(\s*\)\s*;?\s*$/u.test(compact)
  if (!asyncIife || !iifeCall) {
    throw new ScriptsError('SCRIPT_CONTRACT_INVALID', `${relativeName} must be an async IIFE`)
  }
}

export async function loadAdapter(adapterDirectory, rootDirectory, limits = {}) {
  const adapterDir = await realDirectory(adapterDirectory, 'adapter directory')
  if (!isInside(rootDirectory, adapterDir)) throw new ScriptsError('PATH_ESCAPE', `adapter directory resolves outside configured root: ${adapterDirectory}`)
  const manifestPath = await realFileInside(adapterDir, 'manifest.yaml', 'manifest.yaml')
  let manifest
  try {
    manifest = parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    if (error instanceof ScriptsError) throw error
    throw new ScriptsError('MANIFEST_INVALID', `cannot parse ${manifestPath}: ${error.message}`)
  }
  assertRecord(manifest, `manifest.yaml must contain an object: ${adapterDir}`)
  rejectUnknownKeys(manifest, MANIFEST_KEYS, 'manifest.yaml')
  const id = assertSlug(manifest.id, 'manifest.id')
  const name = assertString(manifest.name, 'manifest.name')
  const version = assertString(manifest.version, 'manifest.version')
  const entryUrl = assertHttpUrl(manifest.entry_url, 'manifest.entry_url')
  if (!Array.isArray(manifest.tasks) || !manifest.tasks.length) throw new ScriptsError('MANIFEST_INVALID', 'manifest.tasks must contain at least one task')

  const seenTaskIds = new Set()
  const tasks = []
  for (const [index, rawTask] of manifest.tasks.entries()) {
    const task = assertRecord(rawTask, `manifest.tasks[${index}] must be an object`)
    rejectUnknownKeys(task, TASK_KEYS, `manifest.tasks[${index}]`)
    const taskId = assertSlug(task.id, `manifest.tasks[${index}].id`)
    if (seenTaskIds.has(taskId)) throw new ScriptsError('DUPLICATE_TASK', `duplicate task id: ${taskId}`)
    seenTaskIds.add(taskId)
    const taskName = assertString(task.name, `manifest.tasks[${index}].name`)
    const scriptName = relativePath(task.script, `manifest.tasks[${index}].script`)
    if (!scriptName.toLowerCase().endsWith('.js')) throw new ScriptsError('SCRIPT_INVALID', `${taskId} script must use the .js suffix`)
    const scriptPath = await realFileInside(adapterDir, scriptName, `${taskId} script`)
    const source = await readFile(scriptPath, 'utf8')
    const maxScriptBytes = limits.maxScriptBytes ?? Number.POSITIVE_INFINITY
    if (Buffer.byteLength(source, 'utf8') > maxScriptBytes) throw new ScriptsError('SCRIPT_TOO_LARGE', `${scriptName} exceeds maxScriptBytes (${maxScriptBytes})`)
    validateTaskScriptContract(source, scriptName)
    tasks.push(Object.freeze({
      id: taskId,
      name: taskName,
      description: typeof task.description === 'string' ? task.description : '',
      script: scriptName,
      scriptPath,
      source,
    }))
  }
  return Object.freeze({ id, name, version, description: typeof manifest.description === 'string' ? manifest.description : '', author: typeof manifest.author === 'string' ? manifest.author : '', entryUrl, adapterDir, tasks })
}

async function adapterDirectories(rootDirectory) {
  const manifestAtRoot = join(rootDirectory, 'manifest.yaml')
  try {
    await stat(manifestAtRoot)
    return [rootDirectory]
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new ScriptsError('ROOT_UNAVAILABLE', `cannot inspect adapter root ${rootDirectory}: ${error.message}`)
  }
  let entries
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true })
  } catch (error) {
    throw new ScriptsError('ROOT_UNAVAILABLE', `cannot scan adapter root ${rootDirectory}: ${error.message}`)
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(rootDirectory, entry.name)
    try {
      await stat(join(candidate, 'manifest.yaml'))
      candidates.push(candidate)
    } catch (error) {
      // Adapter roots may also contain README/assets or other unrelated
      // directories. They are ignored unless they actually declare a
      // manifest; errors other than a missing manifest remain actionable.
      if (error?.code !== 'ENOENT') throw new ScriptsError('ROOT_UNAVAILABLE', `cannot inspect adapter directory ${candidate}: ${error.message}`)
    }
  }
  return candidates
}

export async function discoverAdapters(configuredRoots, limits = {}) {
  const roots = Array.isArray(configuredRoots) ? configuredRoots : []
  const adapters = new Map()
  for (const rawRoot of roots) {
    const root = await realDirectory(resolve(String(rawRoot)), 'adapter root')
    for (const candidate of await adapterDirectories(root)) {
      const adapter = await loadAdapter(candidate, root, limits)
      if (adapters.has(adapter.id)) throw new ScriptsError('DUPLICATE_ADAPTER', `duplicate adapter id: ${adapter.id}`)
      adapters.set(adapter.id, adapter)
    }
  }
  return [...adapters.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function publicAdapter(adapter) {
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    description: adapter.description,
    author: adapter.author,
    entry_url: adapter.entryUrl,
    tasks: adapter.tasks.map((task) => ({ id: task.id, name: task.name, description: task.description, script: task.script })),
  }
}

export function publicTask(adapter, task) {
  return { adapter_id: adapter.id, adapter_name: adapter.name, id: task.id, name: task.name, description: task.description, script: task.script, entry_url: adapter.entryUrl }
}
