import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  all: vi.fn(() => []),
  publishRealtime: vi.fn(),
  requireSameOrigin: vi.fn(),
  requireUser: vi.fn(() => ({ id: 'user-1', coupleId: 'couple-1' })),
}))

vi.mock('../server/utils/auth', () => ({
  requireSameOrigin: mocks.requireSameOrigin,
  requireUser: mocks.requireUser,
}))

vi.mock('../server/utils/db', () => ({
  all: mocks.all,
  newId: vi.fn(() => 'new-id'),
  nowIso: vi.fn(() => '2026-08-17T00:00:00.000Z'),
  one: vi.fn(() => null),
  run: vi.fn(),
  transaction: vi.fn((callback: () => unknown) => callback()),
}))

vi.mock('../server/utils/realtime', () => ({
  publishRealtime: mocks.publishRealtime,
}))

import { handleDataRequest } from '../server/utils/data-api'

describe('local data API couple scoping', () => {
  beforeEach(() => {
    mocks.all.mockClear()
  })

  it('scopes the couples table by its id primary key', async () => {
    await handleDataRequest({} as never, {
      table: 'couples',
      operation: 'select',
    })

    expect(mocks.all).toHaveBeenCalledOnce()
    const [sql, ...params] = mocks.all.mock.calls[0]!
    expect(sql).toContain('FROM couples WHERE (id = ?)')
    expect(sql).not.toContain('couple_id = ?')
    expect(params).toEqual(['couple-1'])
  })
})
