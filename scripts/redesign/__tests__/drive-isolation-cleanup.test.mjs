import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('playwright', () => ({ _electron: { launch: () => { throw new Error('UNIT_TEST_MUST_NOT_LAUNCH_ELECTRON') } } }))
import { releaseCheckedSessionRoot } from '../drive.mjs'

let base, parent, root
const links = []
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-cleanup-test-'))
  parent = path.join(base, 'scratch')
  root = path.join(parent, 'd-fixture')
  fs.mkdirSync(root, { recursive: true })
})
afterEach(() => {
  for (const link of links.splice(0)) fs.unlinkSync(link)
  const resolved = fs.realpathSync(base)
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir())) throw new Error('TEST_CLEANUP_BOUNDARY')
  fs.rmSync(resolved, { recursive: true, force: true })
})

it('releases only a checked direct child and leaves the existing release contract unchanged', () => {
  fs.mkdirSync(path.join(root, 'project'))
  fs.writeFileSync(path.join(root, 'project', 'fixture.txt'), 'fictional')
  const remove = vi.fn(() => null), errors = []
  releaseCheckedSessionRoot(root, parent, true, errors, remove)
  expect(remove).toHaveBeenCalledExactlyOnceWith(root)
  expect(errors).toEqual([])
})

it.each(['parent', 'ancestor', 'sibling', 'nested', 'relative-root', 'relative-parent'])(
  'retains the scene and does not remove an unsafe %s target', kind => {
    const targets = { parent, ancestor: base, sibling: path.join(base, 'other'), nested: path.join(root, 'nested'),
      'relative-root': 'd-fixture', 'relative-parent': root }
    const target = targets[kind]
    if (path.isAbsolute(target)) fs.mkdirSync(target, { recursive: true })
    const remove = vi.fn(() => null), errors = []
    releaseCheckedSessionRoot(target, kind === 'relative-parent' ? 'scratch' : parent, true, errors, remove)
    expect(remove).not.toHaveBeenCalled()
    expect(errors).toEqual(['ISOLATION_CLEANUP_BOUNDARY'])
    expect(fs.existsSync(root)).toBe(true)
  },
)

it.each(['root', 'child'])('rejects a %s directory link or Windows junction without following it', kind => {
  const target = path.join(base, 'outside')
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.txt'), 'fictional')
  const link = kind === 'root' ? path.join(parent, 'linked-root') : path.join(root, 'linked-child')
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(link)
  const remove = vi.fn(() => null), errors = []
  releaseCheckedSessionRoot(kind === 'root' ? link : root, parent, true, errors, remove)
  expect(remove).not.toHaveBeenCalled()
  expect(errors).toEqual(['ISOLATION_CLEANUP_BOUNDARY'])
  expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('fictional')
  expect(fs.existsSync(root)).toBe(true)
})

it('retains an already failed scene without scanning or attempting removal', () => {
  const errors = ['original-failure'], remove = vi.fn(() => null)
  const stat = vi.spyOn(fs, 'realpathSync')
  releaseCheckedSessionRoot(root, parent, false, errors, remove)
  expect(remove).not.toHaveBeenCalled()
  expect(stat).not.toHaveBeenCalled()
  expect(errors).toEqual(['original-failure'])
  stat.mockRestore()
})
