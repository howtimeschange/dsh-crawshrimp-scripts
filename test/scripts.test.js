import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright-core'
import * as plugin from '../lib/index.js'
import { ScriptsError, ScriptsRuntime } from '../lib/index.js'
import { discoverAdapters } from '../lib/manifest.js'

const chromeCandidates = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

let server
let baseUrl

before(async () => {
  server = createServer((request, response) => {
    if (request.url === '/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<title>Slow fixture</title><p>slow</p>')
      }, 250)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>DSH scripts fixture</title>
      <table><tr><th>name</th><th>price</th></tr><tr><td>shirt</td><td>39</td></tr></table>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

async function tempDir(t, prefix = 'dsh-scripts-test-') {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

const successScript = `;(async () => {
  const params = window.__PARAMS__ || {}
  const rows = [...document.querySelectorAll('table tr')].map((row) => [...row.cells].map((cell) => cell.textContent.trim()))
  return { success: true, data: [{ title: document.title, rows, label: params.label || '' }], meta: { source: location.href } }
})()`

const failureScript = `;(async () => {
  return { success: false, data: [], meta: { error: 'fixture failed' } }
})()`

const cookieScript = `;(async () => {
  return { success: true, data: [{ cookie: document.cookie }], meta: {} }
})()`

const timeoutScript = `;(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  return { success: true, data: [], meta: {} }
})()`

async function createAdapter(t, root, { id = 'fixture-adapter', tasks = [{ id: 'read-table', name: 'Read table', script: 'read-table.js', source: successScript }], entryUrl = baseUrl } = {}) {
  const adapter = path.join(root, id)
  await mkdir(adapter, { recursive: true })
  const manifestTasks = []
  for (const task of tasks) {
    await writeFile(path.join(adapter, task.script), task.source)
    manifestTasks.push(`  - id: ${task.id}\n    name: ${task.name}\n    script: ${task.script}`)
  }
  await writeFile(path.join(adapter, 'manifest.yaml'), [
    `id: ${id}`,
    `name: ${id} fixture`,
    'version: 1.0.0',
    `entry_url: ${entryUrl}`,
    'tasks:',
    ...manifestTasks,
    '',
  ].join('\n'))
  return adapter
}

function execution(agent = { id: 'test-agent', session: {} }, signal = new AbortController().signal) {
  return { name: 'crawshrimp_scripts_run', callId: `call-${Math.random().toString(16).slice(2)}`, agent, signal }
}

function runtimeFor(root, workspace, extra = {}, approval = { effectivePolicy: () => 'ask', request: async () => 'allowed-once' }) {
  const launchConfig = extra.cdpEndpoint ? {} : (chromePath ? { executablePath: chromePath } : {})
  return new ScriptsRuntime({ get: () => approval }, {
    adapterRoots: [root],
    workspaceDir: workspace,
    ...launchConfig,
    browserChannel: 'chrome',
    timeoutMs: 5000,
    ...extra,
  })
}

function waitForDevtoolsEndpoint(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`Chrome did not report a DevTools endpoint: ${output.slice(-500)}`)), timeoutMs)
    const finish = (error, endpoint) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(endpoint)
    }
    const onOutput = (chunk) => {
      output += chunk.toString()
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/)
      if (!match) return
      const websocket = new URL(match[1])
      finish(undefined, `http://${websocket.host}`)
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.once('error', (error) => finish(error))
    child.once('exit', (code, signal) => finish(new Error(`Chrome exited before DevTools startup (code=${code}, signal=${signal})`)))
  })
}

async function waitForDevtoolsVersion(endpoint, timeoutMs = 10000) {
  const url = new URL('/json/version', endpoint)
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
      lastError = new Error(`DevTools returned HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw lastError || new Error('DevTools endpoint did not become ready')
}

async function stopChrome(child) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.signalCode) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

test('manifest discovery ignores unrelated directories and returns the portable adapter', async (t) => {
  const root = await tempDir(t)
  await mkdir(path.join(root, 'README-assets'))
  await writeFile(path.join(root, 'README-assets', 'note.txt'), 'ignored')
  await createAdapter(t, root)
  const adapters = await discoverAdapters([root])
  assert.deepEqual(adapters.map((adapter) => adapter.id), ['fixture-adapter'])
  assert.equal(adapters[0].tasks[0].script, 'read-table.js')
})

test('manifest validation rejects duplicate tasks, unsupported fields, traversal and symlink escape', async (t) => {
  const root = await tempDir(t)
  const duplicate = path.join(root, 'duplicate')
  await mkdir(duplicate, { recursive: true })
  await writeFile(path.join(duplicate, 'task.js'), successScript)
  await writeFile(path.join(duplicate, 'manifest.yaml'), `id: duplicate\nname: Duplicate\nversion: 1.0.0\nentry_url: ${baseUrl}\ntasks:\n  - id: same\n    name: One\n    script: task.js\n  - id: same\n    name: Two\n    script: task.js\n`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'DUPLICATE_TASK')
  await rm(duplicate, { recursive: true, force: true })

  const traversal = path.join(root, 'traversal')
  await mkdir(traversal, { recursive: true })
  await writeFile(path.join(root, 'outside.js'), successScript)
  await writeFile(path.join(traversal, 'manifest.yaml'), `id: traversal\nname: Traversal\nversion: 1.0.0\nentry_url: ${baseUrl}\ntasks:\n  - id: escape\n    name: Escape\n    script: ../outside.js\n`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'PATH_ESCAPE')
  await rm(traversal, { recursive: true, force: true })

  const escaped = path.join(root, 'escaped')
  await mkdir(escaped, { recursive: true })
  await writeFile(path.join(root, 'secret.js'), successScript)
  await symlink(path.join(root, 'secret.js'), path.join(escaped, 'task.js'))
  await writeFile(path.join(escaped, 'manifest.yaml'), `id: escaped\nname: Escaped\nversion: 1.0.0\nentry_url: ${baseUrl}\ntasks:\n  - id: escape\n    name: Escape\n    script: task.js\n`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'PATH_ESCAPE')
  await rm(escaped, { recursive: true, force: true })

  const unsupported = path.join(root, 'unsupported')
  await mkdir(unsupported, { recursive: true })
  await writeFile(path.join(unsupported, 'task.js'), successScript)
  await writeFile(path.join(unsupported, 'manifest.yaml'), `id: unsupported\nname: Unsupported\nversion: 1.0.0\nentry_url: ${baseUrl}\nauth: true\ntasks:\n  - id: task\n    name: Task\n    script: task.js\n`)
  await assert.rejects(discoverAdapters([root]), (error) => error instanceof ScriptsError && error.code === 'UNSUPPORTED_MANIFEST_FIELD')
})

test('real headless Chrome runs a task with params, returns declared failures and writes unique artifacts', { skip: !chromePath }, async (t) => {
  const root = await tempDir(t)
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  const storageStatePath = path.join(workspace, 'fixture-storage-state.json')
  await writeFile(storageStatePath, JSON.stringify({
    cookies: [{ name: 'fixture_auth', value: 'state-cookie', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [],
  }))
  await createAdapter(t, root, {
    tasks: [
      { id: 'read-table', name: 'Read table', script: 'read-table.js', source: successScript },
      { id: 'declared-failure', name: 'Declared failure', script: 'failure.js', source: failureScript },
      { id: 'read-cookie', name: 'Read cookie', script: 'cookie.js', source: cookieScript },
      { id: 'timeout', name: 'Timeout', script: 'timeout.js', source: timeoutScript },
    ],
  })
  const runtime = runtimeFor(root, workspace)
  t.after(() => runtime.dispose())

  const listed = await runtime.list()
  assert.equal(listed.adapters[0].tasks.length, 4)
  const first = await runtime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table', params: { label: '蓝色衬衫' } }, execution())
  assert.equal(first.success, true)
  assert.equal(first.data[0].label, '蓝色衬衫')
  assert.equal(first.data[0].rows[1][0], 'shirt')
  assert.match(first.artifact.path, /^artifacts\/fixture-adapter\/read-table\/.+\.json$/)
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, first.artifact.path), 'utf8')), {
    success: true,
    data: first.data,
    meta: first.meta,
  })

  const second = await runtime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table', params: {} }, execution())
  assert.notEqual(second.artifact.path, first.artifact.path)
  const declaredFailure = await runtime.run({ adapter_id: 'fixture-adapter', task_id: 'declared-failure', params: {} }, execution())
  assert.equal(declaredFailure.success, false)
  assert.equal(declaredFailure.meta.error, 'fixture failed')
  assert.equal((await readdir(path.join(workspace, 'artifacts', 'fixture-adapter', 'read-table'))).length, 2)

  const stateRuntime = runtimeFor(root, workspace, { storageStatePath })
  const withState = await stateRuntime.run({ adapter_id: 'fixture-adapter', task_id: 'read-cookie', params: {} }, execution())
  assert.equal(withState.data[0].cookie, 'fixture_auth=state-cookie')
  await stateRuntime.dispose()
  const isolatedWorkspace = await tempDir(t, 'dsh-scripts-workspace-')
  const withoutStateRuntime = runtimeFor(root, isolatedWorkspace)
  const withoutState = await withoutStateRuntime.run({ adapter_id: 'fixture-adapter', task_id: 'read-cookie', params: {} }, execution())
  assert.equal(withoutState.data[0].cookie, '')
  await withoutStateRuntime.dispose()
  const timeoutRuntime = runtimeFor(root, await tempDir(t, 'dsh-scripts-workspace-'), { timeoutMs: 1000 })
  await assert.rejects(
    timeoutRuntime.run({ adapter_id: 'fixture-adapter', task_id: 'timeout', params: {} }, execution()),
    (error) => error instanceof ScriptsError && error.code === 'ABORTED',
  )
  await timeoutRuntime.dispose()
})

test('approval fails closed, accepts one-shot approval and is interrupted by disposal', async (t) => {
  const root = await tempDir(t)
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  await createAdapter(t, root)
  let neverRequests = 0
  const neverRuntime = runtimeFor(root, workspace, {}, {
    effectivePolicy: () => 'never',
    request: async () => {
      neverRequests += 1
      return 'rejected'
    },
  })
  await assert.rejects(
    neverRuntime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table' }, execution()),
    (error) => error instanceof ScriptsError && error.code === 'APPROVAL_REQUIRED',
  )
  assert.equal(neverRequests, 1)
  await neverRuntime.dispose()

  const paramsRuntime = runtimeFor(root, workspace)
  await assert.rejects(
    paramsRuntime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table', params: { payload: 'x'.repeat(1024 * 1024) } }, execution()),
    (error) => error instanceof ScriptsError && error.code === 'PARAMS_TOO_LARGE',
  )
  await paramsRuntime.dispose()

  let requests = 0
  const pendingApproval = {
    effectivePolicy: () => 'ask',
    request: async ({ signal }) => {
      requests += 1
      await new Promise((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason)
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return 'allowed-once'
    },
  }
  const runtime = runtimeFor(root, workspace, { timeoutMs: 1000 }, pendingApproval)
  const controller = new AbortController()
  const pending = runtime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table' }, execution(undefined, controller.signal))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(requests, 1)
  await runtime.dispose()
  await assert.rejects(pending, (error) => error instanceof ScriptsError && error.code === 'ABORTED')
})

test('artifact writing rejects a workspace symlink escape and preserves existing artifacts', async (t) => {
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  const outside = await tempDir(t, 'dsh-scripts-outside-')
  await symlink(outside, path.join(workspace, 'artifacts'))
  const runtime = new ScriptsRuntime({ get: () => undefined }, { workspaceDir: workspace })
  await assert.rejects(
    runtime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, '{"ok":true}', new AbortController().signal),
    (error) => error instanceof ScriptsError && error.code === 'ARTIFACT_WRITE_FAILED',
  )
  assert.deepEqual(await readdir(outside), [])
})

test('artifact writing cancels before publication and removes temporary files', async (t) => {
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  const runtime = new ScriptsRuntime({ get: () => undefined }, { workspaceDir: workspace })
  const controller = new AbortController()
  const originalThrowIfAborted = controller.signal.throwIfAborted.bind(controller.signal)
  let checks = 0
  controller.signal.throwIfAborted = () => {
    checks += 1
    if (checks === 3) controller.abort()
    originalThrowIfAborted()
  }

  await assert.rejects(
    runtime.writeArtifact({ id: 'fixture-adapter' }, { id: 'read-table' }, JSON.stringify({ ok: true }), controller.signal),
    (error) => error instanceof ScriptsError && error.code === 'ABORTED',
  )
  const artifactDir = path.join(workspace, 'artifacts', 'fixture-adapter', 'read-table')
  assert.deepEqual(await readdir(artifactDir), [])
})

test('real external CDP browser preserves its existing page and context after scripts run', { skip: !chromePath }, async (t) => {
  const root = await tempDir(t)
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  await createAdapter(t, root)
  const profileDir = await mkdtemp(path.join(tmpdir(), 'dsh-scripts-cdp-'))
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  let connected
  let runtime
  try {
    const endpoint = await waitForDevtoolsEndpoint(chrome)
    const version = await waitForDevtoolsVersion(endpoint)
    assert.match(version.Browser, /Chrome|Chromium/i)

    connected = await chromium.connectOverCDP(endpoint)
    const externalContext = connected.contexts()[0]
    assert.ok(externalContext)
    const externalPage = externalContext.pages()[0] || await externalContext.newPage()
    await externalPage.goto(`${baseUrl}/?external=before`)
    assert.equal(await externalPage.title(), 'DSH scripts fixture')
    assert.equal(await externalPage.locator('table').count(), 1)

    runtime = runtimeFor(root, workspace, { cdpEndpoint: endpoint })
    const result = await runtime.run({ adapter_id: 'fixture-adapter', task_id: 'read-table', params: {} }, execution())
    assert.equal(result.success, true)
    assert.equal(result.data[0].rows[1][0], 'shirt')
    assert.equal(externalContext.pages().includes(externalPage), true)
    assert.equal(await externalPage.url(), `${baseUrl}/?external=before`)

    await runtime.dispose()
    runtime = undefined
    const afterDispose = await waitForDevtoolsVersion(endpoint)
    assert.match(afterDispose.Browser, /Chrome|Chromium/i)
    assert.equal(await externalPage.title(), 'DSH scripts fixture')
    await externalPage.goto(`${baseUrl}/?external=after`)
    assert.equal(await externalPage.title(), 'DSH scripts fixture')
  } finally {
    if (runtime) await runtime.dispose()
    if (connected) await connected.close()
    await stopChrome(chrome)
    await rm(profileDir, { recursive: true, force: true })
  }
})

test('real Cordis and ToolRuntime register both tools and unload removes both', { skip: !chromePath }, async (t) => {
  const root = await tempDir(t)
  const workspace = await tempDir(t, 'dsh-scripts-workspace-')
  await createAdapter(t, root)
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools: () => () => {}, section: () => () => {} })
  const toolFiber = ctx.plugin(ToolRuntime)
  await toolFiber
  const pluginFiber = ctx.plugin(plugin, {
    adapterRoots: [root],
    workspaceDir: workspace,
    executablePath: chromePath,
    browserChannel: 'chrome',
  })
  await pluginFiber
  t.after(async () => {
    if (ctx.fiber.uid !== null) await ctx.fiber.dispose()
  })
  assert.equal(ctx.tools.get('crawshrimp_scripts_list') !== undefined, true)
  assert.equal(ctx.tools.get('crawshrimp_scripts_run') !== undefined, true)
  const denied = await ctx.tools.execute({
    name: 'crawshrimp_scripts_run',
    callId: 'denied',
    arguments: { adapter_id: 'fixture-adapter', task_id: 'read-table' },
    agent: { id: 'runtime-agent', session: {} },
    signal: new AbortController().signal,
  })
  assert.equal(denied.isError, true)
  const approval = ctx.provide('approval', { effectivePolicy: () => 'ask', request: async () => 'allowed-once' })
  const result = await ctx.tools.execute({
    name: 'crawshrimp_scripts_run',
    callId: 'allowed',
    arguments: { adapter_id: 'fixture-adapter', task_id: 'read-table', params: { label: 'runtime' } },
    agent: { id: 'runtime-agent', session: {} },
    signal: new AbortController().signal,
  })
  assert.equal(result.isError, false, JSON.stringify(result))
  assert.equal(result.value?.structuredContent?.data?.[0]?.label, 'runtime')
  await pluginFiber.dispose()
  assert.equal(ctx.tools.get('crawshrimp_scripts_list'), undefined)
  assert.equal(ctx.tools.get('crawshrimp_scripts_run'), undefined)
  await approval()
  await toolFiber.dispose()
})
