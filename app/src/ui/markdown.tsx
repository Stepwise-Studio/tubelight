import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { Children, isValidElement, memo, useState, type ReactElement, type ReactNode } from 'react'
import { Linking, ScrollView, Text as RNText, View, type TextStyle, type ViewStyle } from 'react-native'
import { Renderer, useMarkdown, type MarkedStyles } from 'react-native-marked'
import { Highlight, themes } from 'prism-react-renderer'
import { Copy01Icon, Tick02Icon } from '@hugeicons/core-free-icons'

import { type Palette, fonts, radius, type as typeScale, useTheme } from '@/theme'

import { haptic } from './haptics'
import { Icon } from './icon'
import { IconSwap } from './motion'
import { Press } from './press'
import { Squircle } from './squircle'
import { Text } from './text'

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const { c, scheme } = useTheme()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await Clipboard.setStringAsync(code)
    haptic.light()
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Squircle style={{ borderRadius: radius.md, backgroundColor: c.panel2, borderWidth: 1, borderColor: c.line, marginVertical: 6, overflow: 'hidden' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 12, height: 36, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <Text variant="footnote" color="ink3">{language || 'code'}</Text>
        <Press radius={10} onPress={copy} accessibilityLabel={copied ? 'Copied' : 'Copy code'} style={{ height: 36, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <IconSwap swapKey={copied ? 'y' : 'n'}><Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} color={copied ? 'success' : 'ink3'} /></IconSwap>
          <Text variant="footnote" color="ink3">{copied ? 'Copied' : 'Copy'}</Text>
        </Press>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 12 }}>
        <Highlight code={code.replace(/\n$/, '')} language={(language || 'text').toLowerCase()} theme={scheme === 'dark' ? themes.oneDark : themes.oneLight}>
          {({ tokens, getTokenProps }) => (
            <RNText selectable style={[typeScale.mono, { color: c.ink }]}>
              {tokens.map((line, i) => (
                <RNText key={i}>
                  {line.map((token, k) => {
                    const { style } = getTokenProps({ token })
                    return <RNText key={k} style={{ color: style?.color as string | undefined, fontStyle: style?.fontStyle === 'italic' ? 'italic' : 'normal' }}>{token.content}</RNText>
                  })}
                  {i < tokens.length - 1 ? '\n' : null}
                </RNText>
              ))}
            </RNText>
          )}
        </Highlight>
      </ScrollView>
    </Squircle>
  )
}

/** Plain text of an already-rendered cell (the library parses cells to Text elements before the table sees them). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ''
}

const CELL_MIN = 64
const CELL_MAX = 220
const CHAR_W = 7.6 // average width of a 14px Inter character

/**
 * Tables sized from their content: each column is as wide as its longest cell needs, between 64 and 220, so short
 * columns stay tight and long cells wrap to a readable measure instead of one word per line. Wider than the bubble:
 * it scrolls sideways. Header row on a wash, hairlines between rows.
 */
function Table({ header, rows, c }: { header: ReactNode[][]; rows: ReactNode[][][]; c: Palette }) {
  const cols = header.length
  const widths = Array.from({ length: cols }, (_, i) => {
    const longest = Math.max(...[header[i], ...rows.map((r) => r[i])].map((cell) => {
      const words = textOf(cell).split(/\s+/)
      // A column needs at least its longest word; beyond that, wrap long text around ~26 characters a line.
      return Math.max(Math.max(...words.map((w) => w.length)), Math.min(textOf(cell).length, 26))
    }))
    return Math.round(Math.min(CELL_MAX, Math.max(CELL_MIN, longest * CHAR_W + 24)))
  })
  const cell = (content: ReactNode[], i: number, head: boolean): ReactNode => (
    <View key={i} style={{ flexBasis: widths[i], flexGrow: widths[i], paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center' } as ViewStyle}>
      {head ? <RNText style={{ fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18, color: c.ink }}>{Children.map(content, (n) => n)}</RNText> : content}
    </View>
  )
  return (
    <Squircle style={{ borderRadius: radius.md, borderWidth: 1, borderColor: c.line, overflow: 'hidden', marginVertical: 6 }}>
      {/* Columns keep their content widths and share out any room left, so a narrow table still spans the chat. */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled contentContainerStyle={{ minWidth: '100%' }}>
        <View style={{ flexGrow: 1 }}>
          <View style={{ flexDirection: 'row', backgroundColor: c.panel2 }}>{header.map((h, i) => cell(h, i, true))}</View>
          {rows.map((r, k) => (
            <View key={k} style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.line }}>{r.map((d, i) => cell(d, i, false))}</View>
          ))}
        </View>
      </ScrollView>
    </Squircle>
  )
}

class TubeRenderer extends Renderer {
  constructor(private c: Palette, private mentions?: Set<string>) { super({ selectable: false }) }
  text(text: string | ReactNode[], styles?: TextStyle): ReactNode {
    if (typeof text !== 'string' || !this.mentions?.size || !text.includes('@')) return super.text(text, styles)
    // @handles of people in the chat, tinted like in your own messages.
    return super.text(text.split(/(@[a-z0-9][a-z0-9_-]*)/gi).map((part, i) =>
      part.startsWith('@') && this.mentions!.has(part.slice(1).toLowerCase())
        ? <RNText key={i} style={{ color: this.c.tube, fontFamily: fonts.medium }}>{part}</RNText>
        : part), styles)
  }
  code(text: string, language?: string): ReactNode {
    return <CodeBlock key={this.getKey()} code={text} language={language} />
  }
  table(header: ReactNode[][], rows: ReactNode[][][]): ReactNode {
    return <Table key={this.getKey()} header={header} rows={rows} c={this.c} />
  }
  codespan(text: string): ReactNode {
    // Upright mono on a panel2 wash; thin spaces stand in for padding (inline Text can't pad).
    return (
      <RNText key={this.getKey()} style={[typeScale.mono, { fontSize: 13.5, fontStyle: 'normal', fontWeight: 'normal', color: this.c.ink, backgroundColor: this.c.panel2 }]}>
        {`\u2009${text}\u2009`}
      </RNText>
    )
  }
  link(children: string | ReactNode[], href: string, styles?: TextStyle): ReactNode {
    return (
      <RNText
        key={this.getKey()}
        accessibilityRole="link"
        style={[styles, { color: this.c.tube }]}
        onPress={() => (/^https?:/i.test(href) ? WebBrowser.openBrowserAsync(href) : Linking.openURL(href)).catch(() => {})}
      >
        {children}
      </RNText>
    )
  }
}

function useStyles(c: Palette): MarkedStyles {
  const text = { ...typeScale.body, color: c.ink }
  return {
    text,
    paragraph: { paddingVertical: 0, marginBottom: 8 },
    strong: { fontFamily: fonts.semibold, fontWeight: 'normal' },
    em: { fontStyle: 'italic' },
    link: { color: c.tube, textDecorationLine: 'none', fontStyle: 'normal' },
    h1: { ...typeScale.heading, fontFamily: fonts.semibold, fontWeight: 'normal', color: c.ink, marginTop: 4, marginBottom: 6, borderBottomWidth: 0, paddingBottom: 0 },
    h2: { ...typeScale.headline, fontWeight: 'normal', color: c.ink, marginTop: 4, marginBottom: 6, borderBottomWidth: 0, paddingBottom: 0 },
    h3: { ...typeScale.bodyMedium, fontFamily: fonts.semibold, fontWeight: 'normal', color: c.ink, marginBottom: 4 },
    h4: { ...typeScale.bodyMedium, color: c.ink2 },
    blockquote: { borderLeftWidth: 2, borderLeftColor: c.lineStrong, paddingLeft: 10, marginBottom: 8 },
    hr: { height: 1, backgroundColor: c.line, marginVertical: 10 },
    list: { marginBottom: 8 },
    li: { ...text },
    tableCell: { padding: 0 },
  }
}

/** Light markdown for teammate messages: text, lists, links, tables and code blocks (both scroll sideways when wide). */
export const Markdown = memo(function Markdown({ value, mentions }: { value: string; mentions?: Set<string> }) {
  const { c, scheme } = useTheme()
  const renderer = new TubeRenderer(c, mentions)
  const elements = useMarkdown(value, {
    colorScheme: scheme,
    renderer,
    styles: useStyles(c),
    theme: { colors: { code: c.panel2, link: c.tube, text: c.ink, border: c.line } },
  })
  // Drop the trailing paragraph margin so bubbles hug their text.
  return <View style={{ marginBottom: -8 }}>{elements}</View>
})
