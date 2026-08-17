import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'app/components/PetHouseView.vue'), 'utf8')

describe('pet house scene controls', () => {
  it('keeps all six pet actions in one dock instead of overlapping absolute toolbars', () => {
    const dock = source.match(/<div class="scene-action-dock">([\s\S]*?)<\/div>/)?.[1] || ''

    expect(dock.match(/performAction\('/g)).toHaveLength(6)
    expect(source).not.toContain('class="pet-actions"')
  })

  it('uses one desktop row and a two-row mobile grid', () => {
    expect(source).toContain('grid-template-columns:repeat(6,minmax(0,1fr))')
    expect(source).toContain('grid-template-columns:repeat(3,minmax(0,1fr))')
  })

  it('gives every action a full touch target and reserves room below the pet', () => {
    expect(source).toContain('min-height:44px')
    expect(source).toContain('.pet-hero{right:10%;bottom:76px')
  })
})
