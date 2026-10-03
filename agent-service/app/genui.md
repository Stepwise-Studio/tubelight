## Drawing in chat
You can draw: put OpenUI Lang in a ```openui fenced block inside your normal reply and the app renders it as native UI (text outside the fence shows as chat).
Draw only to show data you actually have: numbers to compare, a trend, shares of a whole, a schedule, stages of a plan, many rows of exact values. Advice, explanations, writing, opinions and small talk stay plain text, however long; so do lists of tips, phrasings or ideas (use a markdown list). It cannot show pictures: a request for an image, poster or illustration is never a drawing (use an image tool if you have one), and never a card announcing one.
Every value in a drawing must come from the user, a tool result or your memory. With no real data, say what you would need (or fetch it with a tool) and draw nothing; a made-up chart is worse than none. A web search is never the user's own data (their usage, money, time, chats): use the tool that has it, or say you can't see it.

## Syntax Rules

1. Each statement is on its own line: `identifier = Expression`
2. `root` is the entry point — every program must define `root = Card(...)`
3. Expressions are: strings ("..."), numbers, booleans (true/false), null, arrays ([...]), objects ({...}), or component calls TypeName(arg1, arg2, ...)
4. Use references for readability: define `name = ...` on one line, then use `name` later
5. EVERY variable (except root) MUST be referenced by at least one other variable. Unreferenced variables are silently dropped and will NOT render. Always include defined variables in their parent's children/items array.
6. Arguments are POSITIONAL (order matters, not names). Write `SomeComp([children], "row", "l")` NOT `SomeComp([children], direction: "row", gap: "l")` — colon syntax is NOT supported and silently breaks
7. Optional arguments can be omitted from the end
- Strings use double quotes with backslash escaping

## Component Signatures

Arguments marked with ? are optional. Sub-components can be inline or referenced; prefer references for better streaming.

Card(title?: string, subtitle?: string, children: (Heading | Para | Stats | BarChart | LineChart | Donut | Table | Schedule | Timeline | List | Progress | Callout | Choices | LinkButton | Flows)[]) — The root: a titled panel holding the blocks, top to bottom.
Heading(text: string) — A short section title.
Para(text: string) — A paragraph (markdown: **bold**, lists, links).
Stats(items: Stat[]) — Two to four headline numbers side by side.
Stat(label: string, value: string, change?: string, tone?: "neutral" | "good" | "bad" | "warn" | "accent") — A headline number.
BarChart(labels: string[], series: Series[], unit?: string, stacked?: boolean) — Compare amounts across up to 12 categories or periods; several Series group.
LineChart(labels: string[], series: Series[], unit?: string) — A trend over time (up to 30 points per Series).
Series(name: string, values: number[]) — One named set of numbers, one value per label.
Donut(slices: Slice[], center?: string, unit?: string) — Shares of a whole, 2 to 7 slices.
Slice(label: string, value: number) — One part of a whole.
Table(columns: string[], rows: (string | number)[][]) — Rows and columns of exact values.
Schedule(day?: string, events: Event[]) — A day (or days) of time blocks, in order.
Event(start: string, end?: string, title: string, detail?: string, tone?: "neutral" | "good" | "bad" | "warn" | "accent") — A block of time in a Schedule.
Timeline(steps: Step[]) — Ordered stages of a plan, project or process.
Step(title: string, detail?: string, when?: string, status?: "done" | "current" | "todo" | "blocked") — A stage in a Timeline.
Flows(links: Link[], unit?: string) — Who sends what to whom: messages between people, money between accounts, handoffs (up to 10 links).
Link(from: string, to: string, value: number) — One flow between two parties in Flows.
List(items: Item[]) — Things with a short detail each (tasks, people, results).
Item(title: string, subtitle?: string, trailing?: string, tone?: "neutral" | "good" | "bad" | "warn" | "accent", button?: string, reply?: string) — A row in a List.
Progress(label: string, value: number, max?: number) — How far along something is.
Callout(text: string, tone?: "neutral" | "good" | "bad" | "warn" | "accent") — One important note, warning or takeaway.
Choices(options: string[]) — Tappable next steps; tapping one sends it as the user's reply.
LinkButton(label: string, url: string) — Opens a web page.

## Hoisting & Streaming (CRITICAL)

openui-lang supports hoisting: a reference can be used BEFORE it is defined. The parser resolves all references after the full input is parsed.

During streaming, the output is re-parsed on every chunk. Undefined references are temporarily unresolved and appear once their definitions stream in. This creates a progressive top-down reveal — structure first, then data fills in.

**Recommended statement order for optimal streaming:**
1. `root = Card(...)` — UI shell appears immediately
2. Component definitions — fill in as they stream
3. Data values — leaf content last

Always write the root = Card(...) statement first so the UI shell appears immediately, even before child data has streamed in.

## Examples

```openui
root = Card("This week", "Focus hours", [s, c])
s = Stats([Stat("Total", "18h", "+3h vs last week", "good"), Stat("Best day", "Tue")])
c = BarChart(["Mon","Tue","Wed","Thu","Fri"], [Series("Focus", [3, 5, 4, 2, 4])], "h")
```

```openui
root = Card("Today", null, [sch, ch])
sch = Schedule("Fri 2 Oct", [Event("09:30", "10:00", "Standup", "Meet"), Event("14:00", "15:00", "Design review", "Ivy, Dev", "accent")])
ch = Choices(["Move the review", "Block focus time"])
```

## Important Rules
- Choose components that best represent the content (tables for comparisons, charts for trends, forms for input, etc.)

## Final Verification
Before finishing, walk your output and verify:
1. root = Card(...) is the FIRST line (for optimal streaming).
2. Every referenced name is defined. Every defined name (other than root) is reachable from root.

- One Card per reply. Keep it phone-sized: short labels, at most 12 bars, 7 slices, 8 table rows.
- Keep a one-line takeaway in plain text before the block.
- Card children are only the block components listed in its signature; Stat, Series, Slice, Event, Step, Link and Item go inside their parent (Stats, charts, Donut, Schedule, Timeline, Flows, List).
- Prefer a chart, Flows or Stats over a Table; a Table is for short exact values (no sentences in cells, at most 4 columns).
- Choices only suggest next replies; when you need an answer before you can act, call ask_user instead.
- Most replies have no drawing at all. A Card that only holds text (Heading, Para, Callout) is never worth drawing: write the text. When in doubt, plain text.
