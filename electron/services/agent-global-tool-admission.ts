import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { WebContents } from 'electron'
import type { AgentGlobalToolExecution, AgentToolAction, AgentToolActionRef } from '../../src/shared/agent-generation'
import { projectRuntimeHost, type ProjectRuntime } from './project-runtime'

export type AgentGlobalToolEffect =
  | { kind: 'inspect-writing-skill'; sourceUrl: string }
  | { kind: 'install-writing-skill'; sourceUrl: string }
  | { kind: 'mcp'; serverId: string; toolName: string; args: Record<string, unknown> }

interface Issuance {
  sender: WebContents
  runtime: ProjectRuntime
  database: ProjectRuntime['database']
  databaseIdentity: ProjectRuntime['databaseIdentity']
  epoch: string
  action: AgentToolAction
  assertClaim: () => void
}

const issuances = new Map<string, Issuance>()
const senderTokens = new WeakMap<WebContents, Set<string>>()

function remove(token: string): void {
  const entry = issuances.get(token)
  if (!entry) return
  issuances.delete(token)
  senderTokens.get(entry.sender)?.delete(token)
}

export function isAgentGlobalToolAction(action: AgentToolAction): boolean {
  return action.name === 'inspect_writing_skill' || action.name === 'install_writing_skill' || action.name.startsWith('mcp__')
}

/** A claim receipt is not permission to start a global effect after its project closes. */
export function issueAgentGlobalToolExecution(input: {
  sender: WebContents
  runtime: ProjectRuntime
  action: AgentToolAction
  assertClaim: () => void
}): AgentGlobalToolExecution {
  if (!isAgentGlobalToolAction(input.action) || input.sender.isDestroyed()) throw new Error('GENERATION_AGENT_GLOBAL_EXECUTION_STALE')
  projectRuntimeHost.assertWorkAvailable(input.runtime)
  input.assertClaim()
  const token = randomUUID()
  issuances.set(token, { ...input, database: input.runtime.database,
    databaseIdentity: input.runtime.databaseIdentity, epoch: input.runtime.executionEpoch, action: structuredClone(input.action) })
  const sender = input.sender
  let tokens = senderTokens.get(sender)
  if (!tokens) {
    tokens = new Set()
    senderTokens.set(sender, tokens)
    sender.once('destroyed', () => {
      for (const issued of senderTokens.get(sender) ?? []) remove(issued)
    })
  }
  tokens.add(token)
  return { version: 1, token }
}

export function revokeAgentGlobalToolExecutions(runtime: ProjectRuntime, ref?: AgentToolActionRef): void {
  for (const [token, entry] of issuances) {
    if (entry.runtime === runtime && (!ref || isDeepStrictEqual(entry.action.ref, ref))) remove(token)
  }
}

function matches(action: AgentToolAction, effect: AgentGlobalToolEffect): boolean {
  if (effect.kind === 'mcp') return action.name === `mcp__${effect.serverId}__${effect.toolName}`
    && isDeepStrictEqual(action.arguments, effect.args)
  return action.name === (effect.kind === 'inspect-writing-skill' ? 'inspect_writing_skill' : 'install_writing_skill')
    && action.arguments.source_url === effect.sourceUrl
}

/** The returned release belongs to the actual main handler/transport, never its renderer waiter. */
export function acquireAgentGlobalToolOperation(sender: WebContents | undefined, execution: unknown, effect: AgentGlobalToolEffect): () => void {
  // Explicit application settings retain their existing author-global entrypoint.
  if (execution === undefined) return projectRuntimeHost.acquireApplicationOperation()
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
    || Object.keys(execution).length !== 2 || !('version' in execution) || execution.version !== 1
    || !('token' in execution) || typeof execution.token !== 'string') throw new Error('GENERATION_AGENT_GLOBAL_EXECUTION_INVALID')
  const token = execution.token, entry = issuances.get(token)
  if (!entry || entry.sender !== sender || entry.sender.isDestroyed()
    || entry.runtime.database !== entry.database || entry.runtime.databaseIdentity !== entry.databaseIdentity
    || entry.runtime.executionEpoch !== entry.epoch) throw new Error('GENERATION_AGENT_GLOBAL_EXECUTION_STALE')
  if (!matches(entry.action, effect)) throw new Error('GENERATION_AGENT_GLOBAL_EXECUTION_MISMATCH')
  const releaseProject = projectRuntimeHost.acquireWork(entry.runtime)
  let releaseApplication: (() => void) | undefined
  try {
    entry.assertClaim()
    releaseApplication = projectRuntimeHost.acquireApplicationOperation()
    remove(token)
  } catch (error) {
    releaseProject()
    throw error
  }
  let released = false
  return () => {
    if (released) return
    released = true
    releaseApplication!()
    releaseProject()
  }
}
