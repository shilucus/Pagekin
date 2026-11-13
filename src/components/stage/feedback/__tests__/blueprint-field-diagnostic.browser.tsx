import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlueprintFieldFeedbackPanel, type BlueprintFieldsData } from '../BlueprintFieldFeedbackPanel'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('blueprint feedback inline diagnostics', () => {
  it.each([
    { locale: 'zh-CN', candidate: {}, code: 'BLUEPRINT_CHANGES_EMPTY', prefix: '发生错误：' },
    { locale: 'en-US', candidate: {}, code: 'BLUEPRINT_CHANGES_EMPTY', prefix: 'Something went wrong: ' },
    { locale: 'zh-CN', candidate: { characters: [''] }, code: 'BLUEPRINT_CHARACTERS_INVALID', prefix: '发生错误：' },
    { locale: 'en-US', candidate: { characters: [''] }, code: 'BLUEPRINT_CHARACTERS_INVALID', prefix: 'Something went wrong: ' },
  ] satisfies Array<{ locale: string; candidate: BlueprintFieldsData; code: string; prefix: string }>)('localizes the initial $code alert for $locale without adopting', async ({ locale, candidate, code, prefix }) => {
    const onAdoptFields = vi.fn()
    const original: BlueprintFieldsData = { notes: 'original notes', characters: ['existing'] }
    const input = structuredClone(candidate)
    await act(async () => root.render(
      <BlueprintFieldFeedbackPanel
        chapterNumber={1}
        originalBlueprint={original}
        candidateBlueprint={input}
        locale={locale}
        onAdoptFields={onAdoptFields}
      />,
    ))

    const alert = host.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe(`${prefix}${code}`)
    const button = host.querySelector<HTMLButtonElement>('[data-testid="adopt-blueprint-fields-button"]')
    expect(button?.disabled).toBe(true)
    await act(async () => button?.click())
    expect(onAdoptFields).not.toHaveBeenCalled()
    expect(input).toEqual(candidate)
    expect(original).toEqual({ notes: 'original notes', characters: ['existing'] })
    expect([...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(input => input.checked))
      .toEqual([true, true, true, true])
    expect(alert?.textContent).toBe(`${prefix}${code}`)
  })
})
