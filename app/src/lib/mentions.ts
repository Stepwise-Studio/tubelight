/** The token an app is mentioned by: `@gmail`, `@googlecalendar`, `@microsoft_teams`. */
export const appToken = (toolkit: string) => toolkit.toLowerCase()

export interface Part { text: string; mention: boolean }

/**
 * Splits text into plain runs and @mentions of `known` tokens (teammate handles, `all`, app tokens). A mention counts
 * once it's finished: followed by a space or punctuation, or at the very end when `atEnd` (sent messages; while typing,
 * `@dev` at the cursor might still become `@devon`). `a@dev` in an email address is not a mention.
 */
export function mentionParts(text: string, known: Set<string>, atEnd = true): Part[] {
  const bits = text.split(/(@[a-z0-9][a-z0-9_-]*)/gi)
  const out: Part[] = []
  bits.forEach((bit, i) => {
    if (!bit) return
    const next = bits[i + 1] ?? ''
    const done = next ? /^[\s.,!?;:)'"’]/.test(next) : atEnd || i < bits.length - 2
    const mention = i % 2 === 1 && known.has(bit.slice(1).toLowerCase()) && (bits[i - 1] === '' || /[\s(]$/.test(bits[i - 1])) && done
    const last = out[out.length - 1]
    if (!mention && last && !last.mention) last.text += bit
    else out.push({ text: bit, mention })
  })
  return out
}

/** Known tokens mentioned (finished) in `text`, lowercased. */
export const mentionsIn = (text: string, known: Set<string>) =>
  new Set(mentionParts(text, known).filter((p) => p.mention).map((p) => p.text.slice(1).toLowerCase()))
