import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connection, Table } from '@lancedb/lancedb'
import { openCanonicalProjectFixture } from '../../../test/helpers/canonical-project-fixture'
import {
  captureReferenceImportResources, captureReferenceImportKnowledgeSnapshot,
  verifyReferenceImportKnowledgeSnapshot, captureWritingKnowledgeSnapshot, searchKnowledge, searchKnowledgeFTS,
} from '../../knowledge-base'
import { getProjectDb } from '../../database'
import { ImportRunRepository } from '../../repositories/import-run-repository'
import { projectRuntimeHost } from '../project-runtime'
import { isKnowledgeSourceBusy } from '../knowledge-source-gate'
import * as store from '../../vector-store'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const RUN = 'fictional-reference-material'
const model = { provider: 'openai', baseUrl: 'https://embedding.example/v1', apiKey: 'fictional', modelName: 'fixture' }
const configuration = { protocol: 'openai' as const, model }
const identity = { modelFingerprint: 'openai|https://embedding.example/v1|fixture', distanceMetric: 'l2' }
let tempBase = ''
let parent = ''

function book(name: string) {
  const root = path.join(parent, name)
  fs.mkdirSync(root)
  openCanonicalProjectFixture(root)
  const runtime = projectRuntimeHost.getActiveView()!
  const content = `Fictional source for ${name}`
  ImportRunRepository.prepare({
    runId: RUN, purpose: 'reference', sourceFingerprint: hash(content), locale: 'en-US',
    sourceDisplay: [{ displayName: 'fictional.txt', mediaType: 'text/plain', size: content.length }],
    chapters: [{ number: 1, title: 'One', content, contentSize: content.length, contentFingerprint: hash(content) }],
  })
  const execution = ImportRunRepository.startOrResume(RUN, 'fictional-owner', Date.now(), 60_000).execution
  const authority = { owner: execution.owner, epoch: execution.epoch }
  return { root, runtime, execution, authority, resources: captureReferenceImportResources(runtime) }
}
type Book = ReturnType<typeof book>
let a: Book
let b: Book
let beforeB: string

function assertAuthority() {
  ImportRunRepository.resolveReferenceImportAuthority(RUN, a.authority, 1, undefined, a.runtime.database)
}
function capture(query = 'harbor courier', config: typeof configuration | null = null, topK = 5) {
  return captureReferenceImportKnowledgeSnapshot({ query, resources: a.resources, configuration: config, topK, assertAuthority })
}
function verify(snapshot: Awaited<ReturnType<typeof capture>>) {
  return verifyReferenceImportKnowledgeSnapshot({ snapshot, resources: a.resources, assertAuthority })
}
async function seed(vectors = false) {
  const options = { corpusKind: 'reference' as const, replacementMode: 'stable-id' as const }
  expect(await store.addChunks(a.root, 'reference-one', 'same.txt', ['harbor courier alpha', 'harbor courier beta'],
    vectors ? [[1, 0], [0.8, 0.2]] : undefined, undefined, options, identity)).toMatchObject({ success: true })
  expect(await store.addChunks(a.root, 'reference-two', 'same.txt', ['harbor courier alpha'],
    vectors ? [[0, 1]] : undefined, undefined, options, identity)).toMatchObject({ success: true })
  expect(await store.addChunks(a.root, 'author', 'author.txt', ['harbor author material'],
    vectors ? [[0.2, 0.8]] : undefined, undefined, { corpusKind: 'project-knowledge' }, identity)).toMatchObject({ success: true })
}
async function mutate(name: string, operation: (table: Table) => Promise<unknown>) {
  const connection = await store.getConnection(a.root)
  const table = await connection.openTable(name)
  try { await operation(table) } finally { table.close() }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function embeddingResponse() {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } })
}
function physicalHash(root: string): string {
  const values: string[] = []
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else values.push(path.relative(root, target), hash(fs.readFileSync(target)))
    }
  }
  return hash(JSON.stringify(values))
}
function expectBUnchanged() {
  expect(getProjectDb()).toBe(b.runtime.database)
  expect(physicalHash(b.root)).toBe(beforeB)
}
function verifiedCleanupRoot(): string {
  const assertChild = (base: string, child: string) => {
    const relative = path.relative(base, child)
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  }
  const normalized = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  const absoluteRoot = path.resolve(parent)
  assertChild(tempBase, absoluteRoot)
  if (!path.basename(absoluteRoot).startsWith('pk-rks-')) throw new Error('FICTIONAL_CLEANUP_OUTSIDE_BASE')
  for (let directory = absoluteRoot; ; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) throw new Error('FICTIONAL_CLEANUP_LINK')
    if (normalized(directory) === normalized(tempBase)) break
  }
  const realRoot = fs.realpathSync.native(absoluteRoot)
  assertChild(fs.realpathSync.native(tempBase), realRoot)
  const pending = [absoluteRoot]
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const realTarget = fs.realpathSync.native(target)
      if (fs.lstatSync(target).isSymbolicLink() || normalized(realTarget) !== normalized(target)) throw new Error('FICTIONAL_CLEANUP_LINK')
      assertChild(realRoot, realTarget)
      if (entry.isDirectory()) pending.push(target)
    }
  }
  return absoluteRoot
}

beforeEach(async () => {
  tempBase = fs.realpathSync.native(os.tmpdir())
  parent = fs.mkdtempSync(path.join(tempBase, 'pk-rks-'))
  a = book('a')
  b = book('b')
  await store.addChunks(b.root, 'b-doc', 'b.txt', ['B harbor remains untouched'])
  beforeB = physicalHash(b.root)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('NETWORK_FORBIDDEN') }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const runtime of projectRuntimeHost.getOpenRuntimes()) {
    store.closeConnection(runtime.canonicalRoot)
    projectRuntimeHost.releaseIdle(runtime)
  }
  if (parent) fs.rmSync(verifiedCleanupRoot(), { recursive: true, force: true })
  parent = ''
})

describe('original reference import retrieval proof', () => {
  it('preserves actual FTS rank, text/name dedupe and topK with B current while writing still excludes reference', async () => {
    await seed()
    const connection = await store.getConnection(a.root)
    const documents = await connection.openTable('documents')
    try {
      expect((await documents.query().toArray()).map(row => row.id).sort()).toEqual(['author', 'reference-one', 'reference-two'])
    } finally { documents.close() }
    const chunks = await connection.openTable('chunks')
    try {
      expect(await chunks.query().where("`fileName` = 'same.txt' AND text = 'harbor courier alpha'").toArray()).toHaveLength(2)
    } finally { chunks.close() }
    const expected = await searchKnowledgeFTS('harbor courier', a.root, 3)
    const snapshot = await capture('harbor courier', null, 3)
    expect(snapshot.results).toEqual(expected)
    expect(snapshot.results).toHaveLength(3)
    expect(snapshot.results.filter(hit => hit.fileName === 'same.txt' && hit.text === 'harbor courier alpha')).toHaveLength(1)
    expect(snapshot.items.map(item => item.corpusKind)).toContain('reference')
    const selected = snapshot.items.find(item => item.documentId === 'reference-one')!
    expect(selected.documentChunks).toHaveLength(2)
    expect(selected.documentChunks.map(item => item.chunkIndex)).toEqual([0, 1])
    expect(selected.contentHash).toBe(hash(selected.text))
    await verify(snapshot)
    const writing = await captureWritingKnowledgeSnapshot('harbor', a.root, null)
    expect(writing.items.map(item => item.documentId)).toEqual(['author'])
    expect(fetch).not.toHaveBeenCalled()
    expectBUnchanged()
  })

  it('preserves the actual vector ranking and score rather than the writing capture algorithm', async () => {
    await seed(true)
    const fetch = vi.fn(async () => embeddingResponse())
    vi.stubGlobal('fetch', fetch)
    const expected = await searchKnowledge('harbor courier', a.root, 'openai', model, 3)
    const snapshot = await capture('harbor courier', configuration, 3)
    expect(snapshot.results).toEqual(expected)
    expect(snapshot.results).toEqual(await store.search(a.root, 'harbor courier', [1, 0], 3, identity))
    expect(snapshot.items).toHaveLength(3)
    expect(snapshot.items.every(item => item.chunkId && item.documentChunks.length)).toBe(true)
    await verify(snapshot)
    expect(fetch).toHaveBeenCalledTimes(2)
    expectBUnchanged()
  })

  it.each(['vector revision', 'registry evidence'] as const)('rejects a failed %s read without replacing vector hits with FTS proof', async fault => {
    await seed(true)
    const query = 'not present anywhere'
    const expected = await store.search(a.root, query, [1, 0], 3, identity)
    expect(expected).toHaveLength(3)
    const connection = await store.getConnection(a.root)
    const registry = await store.getEmbeddingSpaces(a.root)
    const active = registry.spaces.find(space => space.generation === registry.activeGeneration)!
    const table = await connection.openTable(active.tableName)
    const prototype = Object.getPrototypeOf(table) as Table
    const version = prototype.version
    table.close()
    let canonicalEvidenceRead = false
    let registryChecks = 0
    let failures = 0
    const versions = vi.spyOn(prototype, 'version').mockImplementation(async function (this: Table) {
      if (this.name === 'chunks') canonicalEvidenceRead = true
      if (fault === 'vector revision' && this.name === active.tableName) {
        failures++
        throw new Error('FICTIONAL_VECTOR_EVIDENCE_VERSION_FAULT')
      }
      return version.call(this)
    })
    const exists = fs.existsSync
    const registryPath = path.join(a.runtime.projectStorageRoot, 'embedding-spaces.json')
    vi.spyOn(fs, 'existsSync').mockImplementation(file => {
      if (fault === 'registry evidence' && canonicalEvidenceRead && file === registryPath) {
        registryChecks++
        // The first check is the existing registry loader; the next is evidence-only.
        if (registryChecks === 2) { failures++; throw new Error('FICTIONAL_REGISTRY_EVIDENCE_FAULT') }
      }
      return exists(file)
    })
    expect(await store.search(a.root, query, [1, 0], 3, identity)).toEqual(expected)
    expect(versions).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', vi.fn(async () => embeddingResponse()))
    await expect(capture(query, configuration, 3)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_SEARCH_UNAVAILABLE')
    expect(failures).toBe(1)
    if (fault === 'registry evidence') expect(registryChecks).toBe(2)
    expect(fetch).toHaveBeenCalledTimes(1)
    expectBUnchanged()
  })

  it('retains ordinary mismatched-space and failed-embedding FTS fallback without swallowing authority loss', async () => {
    await seed(true)
    vi.stubGlobal('fetch', vi.fn(async () => embeddingResponse()))
    const mismatched = { protocol: 'openai' as const, model: { ...model, modelName: 'different-model' } }
    expect((await capture('courier', mismatched)).results).toEqual(await searchKnowledgeFTS('courier', a.root))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fictional embedding unavailable') }))
    expect((await capture('courier', configuration)).results).toEqual(await searchKnowledgeFTS('courier', a.root))
    const started = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise }))
    const pending = capture('courier', configuration)
    await started.promise
    expect(isKnowledgeSourceBusy(a.runtime.projectStorageRoot)).toBe(false)
    ImportRunRepository.requestCancel(RUN, a.execution, a.runtime)
    response.resolve(embeddingResponse())
    await expect(pending).rejects.toThrow('IMPORT_RUN_CANCELLED')
    expectBUnchanged()
  })

  it.each(['mutation', 'remove', 'same-text replacement', 'partial', 'revision-only'] as const)(
    'rejects original %s sources without a second search or embedding', async action => {
      await seed()
      const snapshot = await capture()
      const item = snapshot.items.find(hit => hit.documentId === 'reference-one')!
      if (action === 'remove' || action === 'same-text replacement') {
        await store.removeDocument(a.root, item.documentId)
        if (action === 'same-text replacement') await store.addChunks(a.root, 'replacement', item.fileName,
          ['harbor courier alpha', 'harbor courier beta'], undefined, undefined, { corpusKind: 'reference' })
      } else if (action === 'partial') {
        await mutate('chunks', table => table.delete(`id = '${item.documentChunks[1].chunkId}'`))
      } else await mutate('chunks', table => table.update({ where: `id = '${item.chunkId}'`, values: action === 'mutation'
        ? { text: 'changed fictional source' } : { importedAt: 'revision-only-change' } }))
      const search = vi.spyOn(store, 'searchWithOriginalHits')
      await expect(verify(snapshot)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_SOURCE_STALE')
      expect(search).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expectBUnchanged()
    },
  )

  it('rejects partial documents and vector/canonical disagreement instead of proving false hits', async () => {
    await seed(true)
    const connection = await store.getConnection(a.root)
    const registry = await store.getEmbeddingSpaces(a.root)
    const active = registry.spaces.find(space => space.generation === registry.activeGeneration)!
    await mutate(active.tableName, table => table.update({ where: "`docId` = 'reference-one'", values: { text: 'false vector text' } }))
    vi.stubGlobal('fetch', vi.fn(async () => embeddingResponse()))
    await expect(capture('courier', configuration)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_SOURCE_MISMATCH')
    await store.removeDocument(a.root, 'reference-two')
    const chunks = await connection.openTable('chunks')
    try { await chunks.delete("`docId` = 'reference-one' AND `chunkIndex` = 1") } finally { chunks.close() }
    await expect(capture()).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_DOCUMENT_INCOMPLETE')
    expectBUnchanged()
  })

  it.each(['registry', 'vector revision'] as const)('rejects changed %s evidence even when canonical text is unchanged', async kind => {
    await seed(true)
    vi.stubGlobal('fetch', vi.fn(async () => embeddingResponse()))
    const snapshot = await capture('courier', configuration)
    if (kind === 'registry') {
      const file = path.join(a.runtime.projectStorageRoot, 'embedding-spaces.json')
      const registry = JSON.parse(fs.readFileSync(file, 'utf8'))
      registry.spaces[0].createdAt = 'changed-fictional-revision'
      fs.writeFileSync(file, JSON.stringify(registry))
    } else {
      const registry = await store.getEmbeddingSpaces(a.root)
      const active = registry.spaces.find(space => space.generation === registry.activeGeneration)!
      await mutate(active.tableName, table => table.update({ where: "`docId` = 'reference-one'", values: { importedAt: 'vector-revision-only' } }))
    }
    await expect(verify(snapshot)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_SOURCE_STALE')
    expect(fetch).toHaveBeenCalledTimes(1)
    expectBUnchanged()
  })

  it('detects a real concurrent mutation during pinned capture without returning a replacement proof', async () => {
    await seed()
    const connection = await store.getConnection(a.root)
    const table = await connection.openTable('chunks')
    const prototype = Object.getPrototypeOf(table) as Table
    const checkout = prototype.checkout
    table.close()
    let changed = false
    vi.spyOn(prototype, 'checkout').mockImplementation(async function (this: Table, version) {
      await checkout.call(this, version)
      if (!changed) {
        changed = true
        await mutate('chunks', target => target.update({ where: "`docId` = 'reference-one'", values: { text: 'concurrent fictional mutation' } }))
      }
    })
    await expect(capture()).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_CHANGED_DURING_READ')
    expectBUnchanged()
  })

  it('rejects lease expiry after a pending embedding instead of treating it as an embedding fallback', async () => {
    await seed()
    const started = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise }))
    const pending = capture('courier', configuration)
    await started.promise
    a.runtime.database.prepare('UPDATE import_runs SET lease_expires_at = 0 WHERE id = ?').run(RUN)
    response.resolve(embeddingResponse())
    await expect(pending).rejects.toThrow('IMPORT_RUN_EXECUTION_STALE')
    expectBUnchanged()
  })

  it('keeps real empty retrieval and rejects empty-to-populated or pending-migration changes', async () => {
    const empty = await capture()
    expect(empty.results).toEqual(await searchKnowledgeFTS('harbor courier', a.root))
    expect(empty.state).toBe('empty')
    await verify(empty)
    await seed()
    await expect(verify(empty)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_SOURCE_STALE')
    const snapshot = await capture()
    fs.writeFileSync(path.join(a.runtime.projectStorageRoot, 'vectors.json.migration-journal.json'), '{}', { flag: 'wx' })
    await expect(capture()).rejects.toThrow('LEGACY_VECTOR_MIGRATION_BLOCKED')
    await expect(verify(snapshot)).rejects.toThrow('LEGACY_VECTOR_MIGRATION_BLOCKED')
    expectBUnchanged()
  })

  it('holds physical work but not the source gate while embedding is pending, then rejects stale reopen proof', async () => {
    await seed(true)
    const started = deferred<void>()
    const response = deferred<Response>()
    vi.stubGlobal('fetch', vi.fn(() => { started.resolve(); return response.promise }))
    const pending = capture('courier', configuration)
    await started.promise
    expect(isKnowledgeSourceBusy(a.runtime.projectStorageRoot)).toBe(false)
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => store.closeConnection(runtime.canonicalRoot))
    try {
      let closed = false
      const closing = projectRuntimeHost.requestClose(a.runtime)
      void closing.then(() => { closed = true }, () => {})
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(a.runtime.database.open).toBe(true)
      response.resolve(embeddingResponse())
      const snapshot = await pending
      await closing
      await expect(verify(snapshot)).rejects.toThrow('PROJECT_RUNTIME_HANDLE_INVALID')
      openCanonicalProjectFixture(a.root)
      const runtime = projectRuntimeHost.getActiveView()!
      const execution = ImportRunRepository.startOrResume(RUN, 'fictional-reopened-owner', Date.now(), 60_000, runtime).execution
      a = { ...a, runtime, resources: captureReferenceImportResources(runtime), execution, authority: { owner: execution.owner, epoch: execution.epoch } }
      projectRuntimeHost.activateView(b.runtime)
      await expect(verify(snapshot)).rejects.toThrow('REFERENCE_IMPORT_KNOWLEDGE_RUNTIME_CHANGED')
      expectBUnchanged()
    } finally { response.resolve(embeddingResponse()); unregister() }
  })

  it.each(['success', 'authority failure'] as const)('preserves %s error precedence and attempts every owned native close despite cleanup faults', async outcome => {
    await seed()
    const snapshot = await capture()
    const connection = await store.getConnection(a.root)
    const names = (await connection.tableNames()).sort()
    const table = await connection.openTable('chunks')
    const tablePrototype = Object.getPrototypeOf(table) as Table
    const connectionPrototype = Object.getPrototypeOf(connection) as Connection
    const checkout = tablePrototype.checkout
    const closeTable = tablePrototype.close
    const closeConnection = connectionPrototype.close
    table.close()
    const pinned = new Set<Table>()
    const closed: string[] = []
    const authorityError = new Error('FICTIONAL_SOURCE_AUTHORITY_FAULT')
    const tableError = new Error('FICTIONAL_TABLE_CLOSE_FAULT')
    const connectionError = new Error('FICTIONAL_CONNECTION_CLOSE_FAULT')
    vi.spyOn(tablePrototype, 'checkout').mockImplementation(async function (this: Table, version) {
      await checkout.call(this, version)
      pinned.add(this)
    })
    vi.spyOn(tablePrototype, 'close').mockImplementation(function (this: Table) {
      const name = this.name
      const result = closeTable.call(this)
      if (pinned.has(this)) {
        closed.push(name)
        if (closed.length === 1) throw tableError
      }
      return result
    })
    vi.spyOn(connectionPrototype, 'close').mockImplementation(function (this: Connection) {
      const result = closeConnection.call(this)
      if (this !== connection) { closed.push('connection'); throw connectionError }
      return result
    })
    let failure: unknown
    try {
      await verifyReferenceImportKnowledgeSnapshot({ snapshot, resources: a.resources, assertAuthority: () => {
        assertAuthority()
        if (outcome === 'authority failure' && pinned.size === names.length) throw authorityError
      } })
    } catch (error) { failure = error }
    expect(failure).toBe(outcome === 'authority failure' ? authorityError : tableError)
    expect(closed).toEqual([...names].reverse().concat('connection'))
    expect(pinned.size).toBe(names.length)
    expectBUnchanged()
  })

  it('closes its native proof handles before releasing work after a delayed native read fault', async () => {
    await seed()
    const connection = await store.getConnection(a.root)
    const table = await connection.openTable('chunks')
    const prototype = Object.getPrototypeOf(table) as Table
    const checkout = prototype.checkout
    const close = prototype.close
    table.close()
    const started = deferred<void>()
    const finish = deferred<void>()
    const events: string[] = []
    let held = false
    vi.spyOn(prototype, 'checkout').mockImplementation(async function (this: Table, version) {
      await checkout.call(this, version)
      if (!held) { held = true; started.resolve(); await finish.promise; throw new Error('FICTIONAL_NATIVE_READ_FAULT') }
    })
    vi.spyOn(prototype, 'close').mockImplementation(function (this: Table) { events.push('table-close'); return close.call(this) })
    const pending = capture()
    const failure = expect(pending).rejects.toThrow('FICTIONAL_NATIVE_READ_FAULT')
    await started.promise
    events.length = 0
    const unregister = projectRuntimeHost.onBeforeRelease(runtime => { events.push('runtime-close'); store.closeConnection(runtime.canonicalRoot) })
    try {
      const closing = projectRuntimeHost.requestClose(a.runtime)
      expect(a.runtime.database.open).toBe(true)
      finish.resolve()
      await failure
      await closing
      expect(events.indexOf('table-close')).toBeLessThan(events.indexOf('runtime-close'))
      expect(a.runtime.database.open).toBe(false)
      expectBUnchanged()
    } finally { finish.resolve(); unregister() }
  })
})
