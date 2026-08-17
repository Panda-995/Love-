import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'app/components/HeartAiView.vue'), 'utf8')

describe('Heart AI result layout', () => {
  it('allows the result column to shrink so long content scrolls above the save bar', () => {
    const mainRule = source.match(/\.maker>main\{([^}]*)\}/)?.[1] || ''
    const resultBodyRule = source.match(/\.result-body\{([^}]*)\}/)?.[1] || ''

    expect(mainRule).toContain('grid-template-rows:auto minmax(0,1fr) auto')
    expect(mainRule).toContain('min-height:0')
    expect(resultBodyRule).toContain('overflow:auto')
  })

  it('renders the save bar whenever a generated result exists', () => {
    expect(source).toContain('<footer v-if="result" class="save-bar">')
  })
})
