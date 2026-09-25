import * as Clipboard from 'expo-clipboard'
import * as WebBrowser from 'expo-web-browser'
import { memo, useState, type ReactNode } from 'react'
import { Linking, ScrollView, Text as RNText, View, type TextStyle } from 'react-native'
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

class TubeRenderer extends Renderer {
  constructor(private c: Palette) { super({ selectable: false }) }
  code(text: string, language?: string): ReactNode {
    return <CodeBlock key={this.getKey()} code={text} language={language} />
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
    h1: { ...typeScale.heading, color: c.ink, marginTop: 4, marginBottom: 6 },
    h2: { ...typeScale.headline, color: c.ink, marginTop: 4, marginBottom: 6 },
    h3: { ...typeScale.bodyMedium, color: c.ink, marginBottom: 4 },
    h4: { ...typeScale.bodyMedium, color: c.ink2 },
    blockquote: { borderLeftWidth: 2, borderLeftColor: c.lineStrong, paddingLeft: 10, marginBottom: 8 },
    hr: { height: 1, backgroundColor: c.line, marginVertical: 10 },
    list: { marginBottom: 8 },
    li: { ...text },
    table: { borderWidth: 1, borderColor: c.line, marginBottom: 8 },
    tableCell: { padding: 6 },
  }
}

/** Light markdown for teammate messages: text, lists, links, code blocks with copy + horizontal scroll. */
export const Markdown = memo(function Markdown({ value }: { value: string }) {
  const { c, scheme } = useTheme()
  const renderer = new TubeRenderer(c)
  const elements = useMarkdown(value, {
    colorScheme: scheme,
    renderer,
    styles: useStyles(c),
    theme: { colors: { code: c.panel2, link: c.tube, text: c.ink, border: c.line } },
  })
  // Drop the trailing paragraph margin so bubbles hug their text.
  return <View style={{ marginBottom: -8 }}>{elements}</View>
})
