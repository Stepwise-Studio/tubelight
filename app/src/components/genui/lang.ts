// Parsing a drawing (OpenUI Lang) and repairing the usual model slips. No React Native here, so scripts and checks can
// import it (`npx tsx`).
import { createLibrary, createParser } from '@openuidev/lang-core'

import { SPECS } from './spec'

const parser = createParser(createLibrary({ components: SPECS, root: 'Card' }).toJSONSchema(), 'Card')

export function parse(source: string) {
  try { return parser.parse(source).root } catch { return null }
}

/**
 * The common slip in model-written blocks: the root Card without its children list, or with blocks defined but never
 * put in it (both draw nothing). Rebuild the root with every top-level block nothing else uses, like OpenUI's Gateway
 * repairs output before it reaches people.
 */
export function repair(source: string): string {
  if (parse(source)) return source
  const head = /^root\s*=\s*Card\(\s*("(?:[^"\\]|\\.)*"|null)?\s*,?\s*("(?:[^"\\]|\\.)*"|null)?/m.exec(source)
  const names = [...source.matchAll(/^([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]).filter((n) => n !== 'root')
  const loose = names.filter((n) => !new RegExp(`[\\[(,]\\s*${n}\\s*[\\]),]`).test(source))
  if (!head || !loose.length) return source
  return `${source}\nroot = Card(${head[1] ?? 'null'}, ${head[2] ?? 'null'}, [${loose.join(', ')}])`
}

/** Whether a block draws something (a reply whose drawing doesn't is shown without it). */
export function drawable(source: string) {
  return !!parse(repair(source))
}

