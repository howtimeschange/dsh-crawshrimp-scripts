import z from '@deepseek-ai/schemastery'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { ScriptsRuntime } from './runtime.js'
import { errorMessage } from './errors.js'

export const name = 'crawshrimp-scripts'
export const inject = ['tools']

export const Config = z.object({
  adapterRoots: z.array(z.string()).default([]),
  workspaceDir: z.string().default('~/.dsh-crawshrimp-scripts'),
  browserChannel: z.string().default('chrome'),
  executablePath: z.string().default(''),
  cdpEndpoint: z.string().default(''),
  storageStatePath: z.string().default(''),
  timeoutMs: z.natural().default(120000),
  maxScriptBytes: z.natural().default(512 * 1024),
  maxOutputBytes: z.natural().default(2 * 1024 * 1024),
})

const listInputSchema = {
  type: 'object',
  properties: { adapter_id: { type: 'string' } },
  additionalProperties: false,
}

const runInputSchema = {
  type: 'object',
  properties: {
    adapter_id: { type: 'string' },
    task_id: { type: 'string' },
    params: { type: 'object', additionalProperties: true },
  },
  required: ['adapter_id', 'task_id'],
  additionalProperties: false,
}

const listOutputSchema = {
  type: 'object',
  properties: {
    adapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'string' },
          description: { type: 'string' },
          author: { type: 'string' },
          entry_url: { type: 'string' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, script: { type: 'string' } },
              required: ['id', 'name', 'description', 'script'],
              additionalProperties: false,
            },
          },
        },
        required: ['id', 'name', 'version', 'description', 'author', 'entry_url', 'tasks'],
        additionalProperties: false,
      },
    },
  },
  required: ['adapters'],
  additionalProperties: false,
}

const runOutputSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'array', items: {} },
    meta: { type: 'object', additionalProperties: true },
    artifact: {
      type: 'object',
      properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
      required: ['path', 'bytes'],
      additionalProperties: false,
    },
  },
  required: ['success', 'data', 'meta', 'artifact'],
  additionalProperties: false,
}

function mcpResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
}

export async function apply(ctx, config) {
  const runtime = new ScriptsRuntime(ctx, config)
  const registrations = []
  ctx.effect(() => () => runtime.dispose(), 'crawshrimp-scripts runtime')
  try {
    registrations.push(ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'crawshrimp_scripts_list',
      rawName: 'crawshrimp_scripts_list',
      description: 'List portable Crawshrimp script adapters and their declared tasks.',
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
      call: async (args) => mcpResult(await runtime.list(args)),
    })))
    registrations.push(ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'crawshrimp_scripts_run',
      rawName: 'crawshrimp_scripts_run',
      description: 'Run one declared portable Crawshrimp page script in a new isolated browser context. Native approval is required before page JavaScript runs.',
      inputSchema: runInputSchema,
      outputSchema: runOutputSchema,
      call: async (args, execution) => mcpResult(await runtime.run(args, execution)),
    })))
  } catch (error) {
    for (const dispose of registrations.reverse()) await dispose()
    throw error
  }
}

export { ScriptsRuntime }
export { ScriptsError } from './errors.js'
export { discoverAdapters, loadAdapter } from './manifest.js'
export { errorMessage }
