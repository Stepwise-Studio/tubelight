// Writes the OpenUI Lang instructions teammates read (agent-service/app/genui.md) from src/components/genui/spec.ts.
// Run: npm run genui-prompt
import { writeFileSync } from 'node:fs'
import { createLibrary } from '@openuidev/lang-core'

import { SPECS } from '../src/components/genui/spec.ts'

const library = createLibrary({ components: SPECS, root: 'Card' })
const text = library.prompt({
  preamble: [
    '## Drawing in chat',
    'You can draw: put OpenUI Lang in a ```openui fenced block inside your normal reply and the app renders it as native UI (text outside the fence shows as chat).',
    'Draw only to show data you actually have: numbers to compare, a trend, shares of a whole, a schedule, stages of a plan, many rows of exact values. Advice, explanations, writing, opinions and small talk stay plain text, however long; so do lists of tips, phrasings or ideas (use a markdown list).',
    'Every value in a drawing must come from the user, a tool result or your memory. With no real data, say what you would need (or fetch it with a tool) and draw nothing; a made-up chart is worse than none.',
  ].join('\n'),
  additionalRules: [
    'One Card per reply. Keep it phone-sized: short labels, at most 12 bars, 7 slices, 8 table rows.',
    'Keep a one-line takeaway in plain text before the block.',
    'Card children are only the block components listed in its signature; Stat, Series, Slice, Event, Step, Link and Item go inside their parent (Stats, charts, Donut, Schedule, Timeline, Flows, List).',
    'Prefer a chart, Flows or Stats over a Table; a Table is for short exact values (no sentences in cells, at most 4 columns).',
    'Choices only suggest next replies; when you need an answer before you can act, call ask_user instead.',
    'Most replies have no drawing at all. A Card that only holds text (Heading, Para, Callout) is never worth drawing: write the text. When in doubt, plain text.',
  ],
  examples: [
    '```openui\nroot = Card("This week", "Focus hours", [s, c])\ns = Stats([Stat("Total", "18h", "+3h vs last week", "good"), Stat("Best day", "Tue")])\nc = BarChart(["Mon","Tue","Wed","Thu","Fri"], [Series("Focus", [3, 5, 4, 2, 4])], "h")\n```',
    '```openui\nroot = Card("Today", null, [sch, ch])\nsch = Schedule("Fri 2 Oct", [Event("09:30", "10:00", "Standup", "Meet"), Event("14:00", "15:00", "Design review", "Ivy, Dev", "accent")])\nch = Choices(["Move the review", "Block focus time"])\n```',
  ],
})
writeFileSync(new URL('../../agent-service/app/genui.md', import.meta.url), text + '\n')
console.log(`genui.md: ${text.length} chars`)
