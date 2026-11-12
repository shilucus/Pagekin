import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (...args: unknown[]) => Promise<unknown>
const mocks = vi.hoisted(() => ({ handlers: new Map<string, IpcHandler>(), showOpenDialog: vi.fn(), hashMeasurements: 0 }))

vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US' },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)) },
}))

vi.mock('../../services/performance-diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/performance-diagnostics')>()
  return {
    ...actual,
    measurePerformanceOperation<T>(name: Parameters<typeof actual.measurePerformanceOperation>[0], operation: () => T): T {
      if (name === 'import.hash.ms') mocks.hashMeasurements++
      return actual.measurePerformanceOperation(name, operation)
    },
  }
})

import { countDraftUnits } from '../../../src/shared/draft-units'
import { nodeTestSecureFileSystem } from '../../../test/helpers/node-test-secure-file-system'
import { ExternalFileGrantService } from '../../services/external-file-grant-service'
import { ImportInspectionStore } from '../../services/import-inspection-store'
import { storedZip } from '../../services/__tests__/epub-test-fixture'
import { registerImportController } from '../import-controller'

const senderId = 81
let temporaryParent = ''
let root = ''
let inspections: ImportInspectionStore
let grants: ExternalFileGrantService
const globalEnvironmentKeys = ['AI_NOVEL_APP_DATA_HOME', 'AI_NOVEL_LEGACY_SOURCE_HOME', 'AI_NOVEL_VELA_HOME'] as const
const previousGlobalEnvironment = new Map<string, string | undefined>()
let globalParent = ''
let globalRoot = ''

function normalized(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function cleanupGlobalFixture(): void {
  const target = path.resolve(globalRoot)
  if (!globalRoot || normalized(path.dirname(target)) !== normalized(globalParent)
    || !path.basename(target).startsWith('pk-author-global-')) throw new Error('AUTHOR_GLOBAL_CLEANUP_OUTSIDE_ROOT')
  for (const directory of [globalParent, target]) {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(directory)) !== normalized(directory)) {
      throw new Error('AUTHOR_GLOBAL_CLEANUP_REPARSE_POINT')
    }
  }
  const directories = [target]
  const files: string[] = []
  for (let index = 0; index < directories.length; index++) {
    for (const entry of fs.readdirSync(directories[index]!)) {
      const child = path.join(directories[index]!, entry)
      const relative = path.relative(target, child)
      const stat = fs.lstatSync(child)
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        || stat.isSymbolicLink() || normalized(fs.realpathSync.native(child)) !== normalized(child)) {
        throw new Error('AUTHOR_GLOBAL_CLEANUP_REPARSE_POINT')
      }
      if (stat.isDirectory()) directories.push(child)
      else if (stat.isFile()) files.push(child)
      else throw new Error('AUTHOR_GLOBAL_CLEANUP_UNEXPECTED_ENTRY')
    }
  }
  for (const file of files) fs.unlinkSync(file)
  for (const directory of directories.reverse()) fs.rmdirSync(directory)
}

beforeAll(async () => {
  for (const key of globalEnvironmentKeys) previousGlobalEnvironment.set(key, process.env[key])
  globalParent = fs.realpathSync.native(os.tmpdir())
  globalRoot = fs.mkdtempSync(path.join(globalParent, 'pk-author-global-'))
  process.env.AI_NOVEL_LEGACY_SOURCE_HOME = path.join(globalRoot, 'legacy')
  await (await import('../../services/__tests__/global-data-fixture')).prepareGlobalDataFixture(globalRoot)
})

afterAll(() => {
  for (const key of globalEnvironmentKeys) {
    const previous = previousGlobalEnvironment.get(key)
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  vi.resetModules()
  if (globalRoot) cleanupGlobalFixture()
  globalRoot = ''
})

function cleanupFixture(): void {
  const target = path.resolve(root)
  if (!root || normalized(path.dirname(target)) !== normalized(temporaryParent)
    || !path.basename(target).startsWith('pk-author-hash-')) throw new Error('AUTHOR_HASH_CLEANUP_OUTSIDE_ROOT')
  const parentStat = fs.lstatSync(temporaryParent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || normalized(fs.realpathSync.native(temporaryParent)) !== normalized(temporaryParent)) {
    throw new Error('AUTHOR_HASH_CLEANUP_REPARSE_POINT')
  }
  const stat = fs.lstatSync(target)
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalized(fs.realpathSync.native(target)) !== normalized(target)) {
    throw new Error('AUTHOR_HASH_CLEANUP_REPARSE_POINT')
  }
  const children = fs.readdirSync(target).map(entry => path.join(target, entry))
  for (const child of children) {
    const childStat = fs.lstatSync(child)
    if (!childStat.isFile() || childStat.isSymbolicLink() || normalized(fs.realpathSync.native(child)) !== normalized(child)) {
      throw new Error('AUTHOR_HASH_CLEANUP_REPARSE_POINT')
    }
  }
  for (const child of children) fs.unlinkSync(child)
  fs.rmdirSync(target)
}

beforeEach(() => {
  temporaryParent = fs.realpathSync.native(os.tmpdir())
  root = fs.mkdtempSync(path.join(temporaryParent, 'pk-author-hash-'))
  mocks.handlers.clear()
  mocks.showOpenDialog.mockReset()
  mocks.hashMeasurements = 0
  inspections = new ImportInspectionStore()
  grants = new ExternalFileGrantService()
  registerImportController(nodeTestSecureFileSystem, filePath => ({ canonicalLocation: filePath }), {}, grants, inspections, Buffer.alloc(32, 42))
})

afterEach(() => {
  if (root) cleanupFixture()
  root = ''
})

function epub(body: string): Buffer {
  return storedZip({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>',
    'book.opf': '<package><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/></spine></package>',
    'one.xhtml': `<html><head><title>Arrival</title></head><body>${body}</body></html>`,
  })
}

interface ExpectedChapter {
  number: number
  sourceChapterNumber: number
  title: string
  content: string
}

async function inspect(fileName: string, contents: string | Buffer, purpose: 'author-manuscript' | 'reference',
  mediaType: string, sourceText: string, expected: ExpectedChapter[], expectedHashes: number) {
  const selected = path.join(root, fileName)
  fs.writeFileSync(selected, contents)
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [selected] })
  const handler = mocks.handlers.get('dialog:select-novel-files')
  if (!handler) throw new Error('IMPORT_HANDLER_MISSING')
  const result = await handler({ sender: { id: senderId, once: vi.fn() } }, purpose) as {
    success: boolean
    inspection?: { inspectionId: string; purpose: string; sourceCount: number; sourceDisplayNames: string[];
      chapterCount: number; totalWords: number; totalBytes: number; preview: unknown[] }
  }
  expect(result.success).toBe(true)
  expect(result.inspection).toBeDefined()
  const summary = result.inspection!
  const inspection = inspections.peek(summary.inspectionId, senderId, purpose)
  const chapters = expected.map(chapter => ({
    ...chapter,
    sourceIndex: 0,
    wordCount: countDraftUnits(chapter.content),
    contentFingerprint: createHash('sha256').update(chapter.content, 'utf8').digest('hex'),
    contentSize: Buffer.byteLength(chapter.content, 'utf8'),
  }))
  expect(inspection.chapters).toEqual(chapters)
  expect(inspection.sources).toEqual([expect.objectContaining({
    displayName: fileName, mediaType, size: Buffer.byteLength(sourceText, 'utf8'),
    locationAliasDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
  })])
  expect(summary).toMatchObject({
    purpose, sourceCount: 1, sourceDisplayNames: [fileName], chapterCount: chapters.length,
    totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    totalBytes: chapters.reduce((sum, chapter) => sum + chapter.contentSize, 0),
    preview: chapters.map(({ number, title, wordCount }) => ({ number, title, wordCount })),
  })
  expect(mocks.hashMeasurements).toBe(expectedHashes)
  expect(grants.activeCount()).toBe(0)
}

describe('import inspection reuses parser chapter fingerprints', () => {
  it.each(['txt', 'md'])('preserves author chapters and hashes each parsed chapter once for %s', async extension => {
    const prefix = extension === 'md' ? '# ' : ''
    const source = `${prefix}第3章 雨夜\n雨落长安，Café 亮着灯。\n${prefix}第7章 重逢\n她听见旧日歌声。`
    await inspect(`author.${extension}`, source, 'author-manuscript', extension === 'md' ? 'text/markdown' : 'text/plain', source, [
      { number: 3, sourceChapterNumber: 3, title: '雨夜', content: '雨落长安，Café 亮着灯。' },
      { number: 7, sourceChapterNumber: 7, title: '重逢', content: '她听见旧日歌声。' },
    ], 2)
  })

  it('preserves a single-line author fallback and hashes its full content once', async () => {
    const source = '无标题的正文，Café 仍亮着灯。'
    await inspect('plain.txt', source, 'author-manuscript', 'text/plain', source,
      [{ number: 1, sourceChapterNumber: 1, title: 'plain', content: source }], 1)
  })

  it('retains the temporary parser hash for a multiline fallback without hashing the result again', async () => {
    const source = '没有章节标题\n第二行正文，Café 灯火。'
    await inspect('plain.md', source, 'author-manuscript', 'text/markdown', source,
      [{ number: 1, sourceChapterNumber: 1, title: 'plain', content: source }], 2)
  })

  it('reuses hashes for multiple chapter headings inside an EPUB spine document', async () => {
    const archive = epub('<h1>第3章 雨夜</h1><p>雨落长安。</p><h1>第7章 重逢</h1><p>Café 灯火。</p>')
    const extracted = '第3章 雨夜\n\n雨落长安。\n\n第7章 重逢\n\nCafé 灯火。'
    await inspect('nested.epub', archive, 'author-manuscript', 'application/epub+zip', extracted, [
      { number: 3, sourceChapterNumber: 3, title: '雨夜', content: '雨落长安。' },
      { number: 7, sourceChapterNumber: 7, title: '重逢', content: 'Café 灯火。' },
    ], 2)
  })

  it('computes missing legacy EPUB fingerprint and size when the spine has no chapter headings', async () => {
    const content = '夜色降临，Café 灯火。'
    await inspect('plain.epub', epub(`<p>${content}</p>`), 'author-manuscript', 'application/epub+zip', content,
      [{ number: 1, sourceChapterNumber: 1, title: 'Arrival', content }], 1)
  })

  it('preserves legacy reference numbering and source-local identities while reusing fingerprints', async () => {
    const source = '第3章 雨夜\n雨落长安。\n第7章 重逢\nCafé 灯火。'
    await inspect('reference.txt', source, 'reference', 'text/plain', source, [
      { number: 1, sourceChapterNumber: 3, title: '雨夜', content: '雨落长安。' },
      { number: 2, sourceChapterNumber: 7, title: '重逢', content: 'Café 灯火。' },
    ], 2)
  })
})
