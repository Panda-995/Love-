import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const packageJson = JSON.parse(read('package.json')) as { version: string }
const packageLock = JSON.parse(read('package-lock.json')) as {
  version: string
  packages: Record<string, { version?: string }>
}
const updateManifest = JSON.parse(read('public/app-update.json')) as {
  version: string
  notes: string[]
}

describe('2.0 release version', () => {
  it('keeps web, desktop, lockfile and update manifest on the same version', () => {
    expect(packageJson.version).toBe('2.0.0')
    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
    expect(updateManifest.version).toBe(packageJson.version)
    expect(read('nuxt.config.ts')).toContain("appVersion: '2.0.0'")
    expect(read('app/composables/useAppUpdate.ts')).toContain("config.public.appVersion || '2.0.0'")
  })

  it('updates Android and PWA release identities', () => {
    const androidBuild = read('android/app/build.gradle')

    expect(androidBuild).toContain('versionCode 2')
    expect(androidBuild).toContain('versionName "2.0.0"')
    expect(read('public/sw.js')).toContain("const VERSION = 'love-home-shell-v2'")
    expect(updateManifest.notes.length).toBeGreaterThan(0)
  })
})
