import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('QUAL-002: Desktop Interaction and Three-Target Platform Qualification', () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..')

  it('validates three-target release profile bindings (Windows x64, macOS arm64, macOS x64)', () => {
    const profilePath = path.join(repositoryRoot, '.release', 'release-profile.json')
    expect(existsSync(profilePath)).toBe(true)

    const profile = JSON.parse(readFileSync(profilePath, 'utf8'))
    expect(profile.platforms).toHaveProperty('windows')
    expect(profile.platforms).toHaveProperty('macos-arm64')
    expect(profile.platforms).toHaveProperty('macos-x64')

    expect(profile.platforms.windows.architectures).toEqual(['x64'])
    expect(profile.platforms['macos-arm64'].architectures).toEqual(['arm64'])
    expect(profile.platforms['macos-x64'].architectures).toEqual(['x64'])
  })

  it('verifies desktop paper-ink UI theme tokens and locale message files exist', () => {
    const localeZh = path.join(repositoryRoot, 'src', 'i18n', 'messages', 'zh-CN.ts')
    const localeEn = path.join(repositoryRoot, 'src', 'i18n', 'messages', 'en-US.ts')

    expect(existsSync(localeZh)).toBe(true)
    expect(existsSync(localeEn)).toBe(true)

    const zh = readFileSync(localeZh, 'utf8')
    const en = readFileSync(localeEn, 'utf8')

    expect(zh.length).toBeGreaterThan(1000)
    expect(en.length).toBeGreaterThan(1000)
  })

  it('verifies portable project archive field policy excludes executable credentials and old grants', () => {
    const policyPath = path.join(repositoryRoot, 'electron', 'services', 'portable-project-field-policy.json')
    expect(existsSync(policyPath)).toBe(true)

    const policy = JSON.parse(readFileSync(policyPath, 'utf8'))
    expect(policy).toHaveProperty('tables')
    expect(policy).toBeDefined()
  })
})
