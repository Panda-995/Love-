import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const entrypoint = readFileSync(resolve(process.cwd(), 'infra/coturn/docker-entrypoint.sh'), 'utf8')

describe('coturn generated configuration', () => {
  it('uses only shared-secret authentication', () => {
    expect(entrypoint).toContain('echo "use-auth-secret"')
    expect(entrypoint).toContain("printf 'static-auth-secret=%s\\n'")
    expect(entrypoint).not.toContain('echo "lt-cred-mech"')
  })

  it('does not start certificate listeners without configured certificates', () => {
    expect(entrypoint).toContain('echo "no-tls"')
    expect(entrypoint).toContain('echo "no-dtls"')
  })

  it('relies on the secure loopback default instead of a removed option', () => {
    expect(entrypoint).not.toContain('no-loopback-peers')
  })
})
