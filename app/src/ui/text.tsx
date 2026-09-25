import { Text as RNText, type TextProps as RNTextProps } from 'react-native'

import { type Palette, type TypeVariant, type as typeScale, useTheme } from '@/theme'

export interface TextProps extends RNTextProps {
  variant?: TypeVariant
  /** A palette key (`ink`, `ink2`, `tube`, ...) or any colour. */
  color?: keyof Palette | (string & {})
  /** Tabular figures, for numbers and times that change. */
  tabular?: boolean
  align?: 'left' | 'center' | 'right'
}

/** Typed text. Inter Display at the Tubelight scale, `ink` by default. Font scaling capped at 1.3. */
export function Text({ variant = 'body', color = 'ink', tabular, align, style, maxFontSizeMultiplier = 1.3, ...props }: TextProps) {
  const { c } = useTheme()
  const resolved = (c as Record<string, string>)[color] ?? color
  return (
    <RNText
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[
        typeScale[variant],
        { color: resolved },
        tabular && { fontVariant: ['tabular-nums'] },
        align && { textAlign: align },
        style,
      ]}
      {...props}
    />
  )
}
