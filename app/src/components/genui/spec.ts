// What a teammate may draw in chat with OpenUI Lang (openui.com): names, props and one-line descriptions. Kept free of
// React Native so `scripts/genui-prompt.ts` can turn it into the service's instructions (agent-service/app/genui.md);
// library.tsx gives each one its native look. Change a component here, then run `npm run genui-prompt`.
import { defineComponent } from '@openuidev/lang-core'
import { z } from 'zod'

const spec = <T extends z.ZodObject>(name: string, description: string, props: T) =>
  defineComponent({ name, description, props, component: null })

const tone = z.enum(['neutral', 'good', 'bad', 'warn', 'accent']).optional()

export const Series = spec('Series', 'One named set of numbers, one value per label.', z.object({
  name: z.string(),
  values: z.array(z.number()),
}))
export const Slice = spec('Slice', 'One part of a whole.', z.object({ label: z.string(), value: z.number() }))
export const Stat = spec('Stat', 'A headline number.', z.object({
  label: z.string(),
  value: z.string().describe('Formatted, e.g. "₹12.4k", "3h 20m", "84%"'),
  change: z.string().optional().describe('e.g. "+12% vs last week"'),
  tone,
}))
export const Event = spec('Event', 'A block of time in a Schedule.', z.object({
  start: z.string().describe('"09:30"'),
  end: z.string().optional(),
  title: z.string(),
  detail: z.string().optional().describe('Place, people or a note'),
  tone,
}))
export const Step = spec('Step', 'A stage in a Timeline.', z.object({
  title: z.string(),
  detail: z.string().optional(),
  when: z.string().optional(),
  status: z.enum(['done', 'current', 'todo', 'blocked']).optional(),
}))
export const Item = spec('Item', 'A row in a List.', z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  trailing: z.string().optional().describe('Short value on the right'),
  tone,
}))

const blocks = () => z.array(z.union([
  Heading.ref, Para.ref, Stats.ref, BarChart.ref, LineChart.ref, Donut.ref, Table.ref, Schedule.ref, Timeline.ref,
  List.ref, Progress.ref, Callout.ref, Choices.ref, LinkButton.ref,
]))

export const Heading = spec('Heading', 'A short section title.', z.object({ text: z.string() }))
export const Para = spec('Para', 'A paragraph (markdown: **bold**, lists, links).', z.object({ text: z.string() }))
export const Stats = spec('Stats', 'Two to four headline numbers side by side.', z.object({ items: z.array(Stat.ref) }))
export const BarChart = spec('BarChart', 'Compare amounts across up to 12 categories or periods; several Series group.', z.object({
  labels: z.array(z.string()),
  series: z.array(Series.ref),
  unit: z.string().optional().describe('Suffix like "h", "%", or prefix "₹"'),
  stacked: z.boolean().optional(),
}))
export const LineChart = spec('LineChart', 'A trend over time (up to 30 points per Series).', z.object({
  labels: z.array(z.string()),
  series: z.array(Series.ref),
  unit: z.string().optional(),
}))
export const Donut = spec('Donut', 'Shares of a whole, 2 to 7 slices.', z.object({
  slices: z.array(Slice.ref),
  center: z.string().optional().describe('Text in the middle, e.g. the total'),
  unit: z.string().optional(),
}))
export const Table = spec('Table', 'Rows and columns of exact values.', z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number()]))),
}))
export const Schedule = spec('Schedule', 'A day (or days) of time blocks, in order.', z.object({
  day: z.string().optional().describe('"Today, Fri 2 Oct"'),
  events: z.array(Event.ref),
}))
export const Timeline = spec('Timeline', 'Ordered stages of a plan, project or process.', z.object({ steps: z.array(Step.ref) }))
export const List = spec('List', 'Things with a short detail each (tasks, people, results).', z.object({ items: z.array(Item.ref) }))
export const Progress = spec('Progress', 'How far along something is.', z.object({
  label: z.string(),
  value: z.number(),
  max: z.number().optional().describe('Default 100'),
}))
export const Callout = spec('Callout', 'One important note, warning or takeaway.', z.object({ text: z.string(), tone }))
export const Choices = spec('Choices', 'Tappable next steps; tapping one sends it as the user\'s reply.', z.object({
  options: z.array(z.string()).describe('2 to 4 short replies'),
}))
export const LinkButton = spec('LinkButton', 'Opens a web page.', z.object({ label: z.string(), url: z.string() }))
export const Card = spec('Card', 'The root: a titled panel holding the blocks, top to bottom.', z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  children: blocks(),
}))

export const SPECS = [
  Card, Heading, Para, Stats, Stat, BarChart, LineChart, Series, Donut, Slice, Table, Schedule, Event, Timeline, Step,
  List, Item, Progress, Callout, Choices, LinkButton,
]
