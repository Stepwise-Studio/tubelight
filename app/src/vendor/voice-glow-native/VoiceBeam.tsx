/**
 * React Native (Skia) port of Libraries.dev `voice-glow` (VoiceBeam), `type="mobile"`.
 * Source: https://github.com/Jakubantalik/Libraries.dev/tree/main/packages/voice-glow (MIT, Jakub Antalik).
 *
 * The web original paints CSS layers (stroke ring, inner light, blurred bloom, epicentre wash), an SVG
 * displacement warp and a 2D-canvas band, all driven per frame by `voiceDriver.ts`. Here the driver runs
 * as-is on the UI thread and every layer is painted into one Skia picture per frame, with the same
 * geometry, palettes, filters (hue-rotate → brightness → saturate), masks and blend order.
 *
 * Tubelight patch: resolved to the `mobile` preset only; `level` is a shared value (0–1) or the demo's
 * synthetic voice while `speaking`; the host is the view this fills (radius 0, so no corner arcs).
 */
import {
  BlendMode, BlurStyle, Canvas, ClipOp, ColorChannel, PaintStyle, Picture, Skia, StrokeCap, StrokeJoin, TileMode,
  type SkCanvas, type SkPath, type SkPicture,
} from '@shopify/react-native-skia'
import { useEffect, useState } from 'react'
import { View, type ViewStyle } from 'react-native'
import { useFrameCallback, useSharedValue, type SharedValue } from 'react-native-reanimated'

export type VoiceBeamMode = 'idle' | 'listening' | 'processing' | 'speaking'
const MODES: Record<VoiceBeamMode, number> = { idle: 0, listening: 1, processing: 2, speaking: 3 }

// ── styles.ts ─────────────────────────────────────────────────────────────
const LOBES = [
  { x: 0, w: 74, h: 46, band: 0 },
  { x: -36, w: 54, h: 40, band: 1 },
  { x: 36, w: 54, h: 40, band: 1 },
  { x: -72, w: 48, h: 32, band: 2 },
  { x: 72, w: 48, h: 32, band: 2 },
  { x: -108, w: 42, h: 26, band: 1 },
  { x: 108, w: 42, h: 26, band: 1 },
]
const LOBE_SPAN = 36 * LOBES.length
const rgb = (r: number, g: number, b: number) => [r / 255, g / 255, b / 255]
const PALETTE = {
  dark: [rgb(255, 70, 120), rgb(60, 190, 255), rgb(175, 70, 255), rgb(60, 220, 130), rgb(255, 150, 40), rgb(90, 100, 255), rgb(40, 200, 190)],
  light: [rgb(255, 201, 21), rgb(126, 196, 255), rgb(180, 40, 230), rgb(235, 100, 160), rgb(255, 176, 122), rgb(154, 160, 255), rgb(127, 217, 238)],
}
const BAND_COLORS = {
  dark: { core: rgb(255, 255, 255), above: rgb(255, 70, 80), mid: rgb(90, 255, 150), below: rgb(80, 140, 255) },
  light: { core: rgb(197, 139, 255), above: rgb(255, 122, 182), mid: rgb(126, 196, 255), below: rgb(45, 255, 171) },
}

// ── presets.ts, resolved for type "mobile" ────────────────────────────────
function resolve(theme: 'dark' | 'light') {
  const sc = 1.25
  const dark = theme === 'dark'
  return {
    dark,
    threshold: 0.015, attack: 0.325, release: 0.86, idle: 0.18, breatheDuration: 5.2,
    reach: 3, spread: 0.45, flow: 60 * sc, bend: 70 * sc,
    bandStrength: dark ? 1.8 : 1.7, bandWidth: 2.4 * sc, bandPosition: 0.35, bandCurve: 1.55, bandSpread: 0.9,
    bandSkew: 0.12, bandOffset: -50 * sc, bandTail: 0.62, bandTailPosition: 0.42, bandTailCurve: 2.7,
    bandTailOverflow: 22 * sc, bandAberration: 0.89,
    distortion: 0.62, distortionDetail: 2 / sc,
    glowWidth: 1.15 * sc, glowHeight: 2.1 * sc, lobeSpacing: 1.35 * sc, rangeWidth: 1.25 * sc, rangeHeight: 1.2 * sc,
    fade: Math.round(Math.max(40, Math.min(95, 70 * 1.1))),
    coreSize: sc, coreLight: dark ? 0 : 1.8, scale: sc, blur: sc,
    processingDuration: 1.05, processingLevel: 0.35, processingEase: 0.6, processingTravel: 1, processingCurve: 2.1,
    // themePresets + voiceTypeStyle.mobile
    strokeOpacity: dark ? 1.16 : 1.2, innerOpacity: dark ? 0.47 : 0.85, bloomOpacity: dark ? 0.89 : 0.5,
    innerShadow: dark ? [1, 1, 1, 0.1] : [0, 0, 0, 0.08],
    brightness: dark ? 1.2 : 0.95, saturation: dark ? 1.5 : 1.6, strength: 1,
    hueRange: dark ? 24 : 40, hueDuration: dark ? 12 : 8.5, hueBase: dark ? 0 : 5,
    colors: PALETTE[theme], band: BAND_COLORS[theme],
  }
}
type Config = ReturnType<typeof resolve>

// ── voiceDriver.ts ────────────────────────────────────────────────────────
function clamp01(v: number) { 'worklet'; return v < 0 ? 0 : v > 1 ? 1 : v }
function wrapX(x: number, span: number) { 'worklet'; const half = span / 2; return ((((x + half) % span) + span) % span) - half }
function edgeEnvelope(x: number, span: number) { 'worklet'; const t = x / (span / 2 + 4); return Math.max(0, 1 - t * t) }
function shape(raw: number, threshold: number) {
  'worklet'
  if (raw <= threshold) return 0
  const t = (raw - threshold) / Math.max(0.001, 1 - threshold)
  return clamp01((1 - Math.exp(-3 * t)) / (1 - Math.exp(-3)))
}
function follow(prev: number, target: number, dt: number, attack: number, release: number) {
  'worklet'
  const tau = target > prev ? attack : release
  return prev + (target - prev) * (1 - Math.exp(-dt / Math.max(0.001, tau)))
}
function bell(t: number, p: number, sigma: number, skew: number) {
  'worklet'
  const s = Math.max(0.05, sigma * (t < 0 ? 1 - skew : 1 + skew))
  const v = Math.exp(-Math.pow(Math.abs(t) / s, p))
  const tail = Math.exp(-Math.pow(1 / s, p))
  return Math.max(0, (v - tail) / (1 - tail))
}
function tailLift(dist: number, edge: number, lift: number, position: number, curve: number) {
  'worklet'
  if (lift <= 0 || edge <= 0) return 0
  const start = edge * Math.max(0, Math.min(0.98, position))
  if (dist <= start) return 0
  return lift * Math.pow(Math.min(1, (dist - start) / Math.max(1, edge - start)), Math.max(0.5, curve))
}
/** voice-mocks.tsx `demoLevel`: the site's synthetic voice, used while the teammate speaks. */
function demoLevel(t: number) {
  'worklet'
  if (t % 9 > 6.6) return 0
  const syllable = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 3.1)
  const word = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.55 + 1)
  const rough = 0.86 + 0.14 * Math.sin(t * 23.7)
  return Math.min(1, Math.pow(syllable, 1.6) * (0.5 + 0.5 * word) * rough * 1.05)
}

const CEILING_HALF_WIDTH = 170
const CEILING_HEIGHT = 64
const BAND_SAMPLES = 56
const WARP_OUT_TAU = 0.06
const WARP_IN_TAU = 0.35
const WARP_OFF_BELOW = 0.03

interface State {
  level: number; b0: number; b1: number; b2: number; phase: number; scanA: number; scanT: number
  t: number; last: number; warp: number; opacity: number
}

/** CSS `hue-rotate(h) brightness(b) saturate(s)` as one Skia colour matrix (sRGB, applied left to right). */
function filterMatrix(hueDeg: number, b: number, s: number) {
  'worklet'
  const a = (hueDeg * Math.PI) / 180
  const c = Math.cos(a)
  const n = Math.sin(a)
  const H = [
    0.213 + c * 0.787 - n * 0.213, 0.715 - c * 0.715 - n * 0.715, 0.072 - c * 0.072 + n * 0.928,
    0.213 - c * 0.213 + n * 0.143, 0.715 + c * 0.285 + n * 0.14, 0.072 - c * 0.072 - n * 0.283,
    0.213 - c * 0.213 - n * 0.787, 0.715 - c * 0.715 + n * 0.715, 0.072 + c * 0.928 + n * 0.072,
  ]
  const S = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ]
  const m: number[] = []
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) {
      let v = 0
      for (let j = 0; j < 3; j++) v += S[r * 3 + j] * b * H[j * 3 + k]
      m.push(v)
    }
  }
  return [m[0], m[1], m[2], 0, 0, m[3], m[4], m[5], 0, 0, m[6], m[7], m[8], 0, 0, 0, 0, 0, 1, 0]
}

function color(c: number[], a: number) { 'worklet'; return Float32Array.of(c[0], c[1], c[2], a) }

/** A CSS `radial-gradient(ellipse rx ry at cx cy, ...)` painted over `rect` (or just its own box). */
function ellipse(canvas: SkCanvas, cx: number, cy: number, rx: number, ry: number, colors: Float32Array[], pos: number[],
  rect: [number, number, number, number] | null, blend: BlendMode | null) {
  'worklet'
  if (rx < 0.5 || ry < 0.5) {
    if (!rect || blend === null) return
    rx = Math.max(rx, 0.5)
    ry = Math.max(ry, 0.5)
  }
  const m = Skia.Matrix()
  m.translate(cx, cy)
  m.scale(1, ry / rx)
  m.translate(-cx, -cy)
  const p = Skia.Paint()
  p.setShader(Skia.Shader.MakeRadialGradient({ x: cx, y: cy }, rx, colors, pos, TileMode.Clamp, m))
  if (blend !== null) p.setBlendMode(blend)
  const r = rect ?? [cx - rx, cy - ry, 2 * rx, 2 * ry]
  canvas.drawRect(Skia.XYWHRect(r[0], r[1], r[2], r[3]), p)
}

interface Frame {
  W: number; H: number; w: number; h: number; cx: number; mw: number; bh: number
  x: number[]; l: number[]; glow: number; level: number; eff: number; lift: number; bendA: number
}

function paintLobes(canvas: SkCanvas, f: Frame, cfg: Config, alpha: number, sw: number, sh: number, y: number, fade: number) {
  'worklet'
  for (let i = LOBES.length - 1; i >= 0; i--) {
    const lobe = LOBES[i]
    const rx = Math.round(lobe.w * sw) * f.w
    const ry = Math.round(lobe.h * sh) * f.h * f.l[i]
    const c = cfg.colors[i]
    ellipse(canvas, f.W / 2 + (f.cx + f.x[i]) * f.w, f.H + y, rx, ry, [color(c, alpha), color(c, 0)], [0, fade / 100], null, null)
  }
}

/** The ellipse every layer is masked to (`edgeMask` in styles.ts), applied with `blend` over the whole host. */
function edgeMask(canvas: SkCanvas, f: Frame, cfg: Config, w: number, h: number, mid: number, tail: number, blend: BlendMode) {
  'worklet'
  const rx = w * cfg.rangeWidth * f.w * f.mw
  const ry = h * cfg.rangeHeight * f.h + f.bh
  const white = [1, 1, 1]
  const colors = tail > 0
    ? [color(white, 1), color(white, 0.5), color(white, tail), color(white, 0)]
    : [color(white, 1), color(white, 0.5), color(white, 0)]
  const pos = tail > 0 ? [0, mid / 100, 0.85, 1] : [0, mid / 100, 1]
  ellipse(canvas, f.W / 2 + f.cx * f.w, f.H, rx, ry, colors, pos, [0, 0, f.W, f.H], blend)
}

function bandPoints(cfg: Config, f: Frame, morph: number) {
  'worklet'
  const cw = f.W
  const ch = f.H
  const centre = cw / 2 + f.cx * f.w
  const half = CEILING_HALF_WIDTH * cfg.rangeWidth * f.w * f.mw
  const apex = Math.min(ch * 0.82 * Math.min(1, cfg.scale), (CEILING_HEIGHT * cfg.rangeHeight * f.h + f.lift) * cfg.bandPosition)
  const base = ch - cfg.bandOffset
  const tailT = Math.min(1, morph * 4)
  const tail = cfg.bandTail * (1 - tailT * tailT * (3 - 2 * tailT))
  const withTail = tail > 0.001
  const over = withTail ? cfg.bandTailOverflow : 0
  const x0 = withTail ? -over : centre - half
  const x1 = withTail ? cw + over : centre + half
  const pts: number[] = []
  for (let i = 0; i <= BAND_SAMPLES; i++) {
    const x = x0 + ((x1 - x0) * i) / BAND_SAMPLES
    const t = Math.max(-1, Math.min(1, (x - centre) / Math.max(1, half)))
    const edge = (x < centre ? centre : cw - centre) + over
    const y = bell(t, cfg.bandCurve, cfg.bandSpread, cfg.bandSkew)
      + tailLift(Math.abs(x - centre), edge, tail, cfg.bandTailPosition, cfg.bandTailCurve)
    pts.push(x, base - apex * y)
  }
  return pts
}

function linePath(pts: number[], ox: number, oy: number) {
  'worklet'
  const p = Skia.Path.Make()
  p.moveTo(pts[0] + ox, pts[1] + oy)
  for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i] + ox, pts[i + 1] + oy)
  return p
}

/** The clip polygons above and below the band line (`writeClips`). */
function clips(pts: number[], W: number, H: number): [SkPath, SkPath] {
  'worklet'
  const below = Skia.Path.Make()
  below.moveTo(0, H)
  for (let i = 0; i < pts.length; i += 2) below.lineTo(pts[i], pts[i + 1])
  below.lineTo(W, H)
  below.close()
  const above = Skia.Path.Make()
  above.moveTo(0, 0)
  above.lineTo(W, 0)
  above.lineTo(W, H)
  for (let i = pts.length - 2; i >= 0; i -= 2) above.lineTo(pts[i], pts[i + 1])
  above.lineTo(0, H)
  above.close()
  return [above, below]
}

/** `drawBand`: a ridge with a red fringe above, blue below, faint green between, and a wide halo under it. */
function drawBand(canvas: SkCanvas, cfg: Config, f: Frame, pts: number[]) {
  'worklet'
  const alpha = Math.min(1, 0.6 * cfg.bandStrength * f.bendA)
  if (alpha < 0.005 || cfg.bandWidth <= 0) return
  const bw = cfg.bandWidth * (1 + 0.35 * f.level)
  const split = cfg.bandAberration * (0.35 + 0.65 * f.level)
  const dy = (4 + 12 * split) * cfg.scale
  const dx = 4 * split * cfg.scale
  const base = (cfg.dark ? 0.42 : 0.4) * alpha
  const thickness = 14 * bw
  const blur = (3.5 * cfg.bandWidth) / 2
  const x0 = pts[0]
  const x1 = pts[pts.length - 2]
  const fade = cfg.bandTail > 0 ? 0.015 : 0.18
  const stroke = (path: SkPath, c: number[], a: number, width: number, sigma: number) => {
    const p = Skia.Paint()
    p.setStyle(PaintStyle.Stroke)
    p.setStrokeCap(StrokeCap.Round)
    p.setStrokeJoin(StrokeJoin.Round)
    p.setStrokeWidth(width)
    p.setShader(Skia.Shader.MakeLinearGradient({ x: x0, y: 0 }, { x: x1, y: 0 },
      [color(c, 0), color(c, a), color(c, a), color(c, 0)], [0, fade, 1 - fade, 1], TileMode.Clamp))
    p.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, true))
    canvas.drawPath(path, p)
  }
  stroke(linePath(pts, 0, 0), cfg.band.core, base * 0.3, thickness * 2.2, blur * 3)
  const ridges = [
    { c: cfg.band.above, a: 1, ox: dx, oy: -dy },
    { c: cfg.band.mid, a: 0.55, ox: dx * 0.35, oy: -dy * 0.35 },
    { c: cfg.band.below, a: 1, ox: -dx, oy: dy },
    { c: cfg.band.core, a: 0.9, ox: 0, oy: 0 },
  ]
  const ramp = [[1, 0.16], [0.72, 0.2], [0.46, 0.26], [0.22, 0.34]]
  for (let r = 0; r < ridges.length; r++) {
    const path = linePath(pts, ridges[r].ox, ridges[r].oy)
    for (let k = 0; k < ramp.length; k++) {
      stroke(path, ridges[r].c, base * ridges[r].a * ramp[k][1], Math.max(0.6, thickness * ramp[k][0]), blur)
    }
  }
}

/** One frame: the driver step, then every layer in the stylesheet's z order. */
function render(s: State, cfg: Config, mode: number, mic: number, W: number, H: number, ts: number): SkPicture {
  'worklet'
  const dt = s.last ? Math.min(0.05, (ts - s.last) / 1000) : 1 / 60
  s.last = ts
  s.t += dt
  const tSec = s.t
  s.opacity = Math.min(1, s.opacity + dt / 0.6)
  const fadeIn = s.opacity * s.opacity * (3 - 2 * s.opacity)

  // raw level: the mic while listening, the site's demo voice while speaking
  const raw = mode === 1 ? clamp01(mic) : mode === 3 ? demoLevel(tSec) : 0
  const bands = [raw, raw * (0.72 + 0.28 * Math.sin(tSec * 9.1)), raw * (0.6 + 0.4 * Math.sin(tSec * 13.7 + 2))]
  s.level = follow(s.level, shape(raw, cfg.threshold), dt, cfg.attack, cfg.release)
  s.b0 = follow(s.b0, shape(bands[0], cfg.threshold * 0.6), dt, cfg.attack, cfg.release * 1.15)
  s.b1 = follow(s.b1, shape(bands[1], cfg.threshold * 0.6), dt, cfg.attack, cfg.release * 1.15)
  s.b2 = follow(s.b2, shape(bands[2], cfg.threshold * 0.6), dt, cfg.attack, cfg.release * 1.15)
  const sb = [s.b0, s.b1, s.b2]

  // processing travel
  const processing = mode === 2
  const span = LOBE_SPAN * cfg.lobeSpacing
  if (processing && s.scanA < 0.001 && s.scanT === 0) s.scanT = cfg.processingDuration / 2
  s.scanA = follow(s.scanA, processing ? 1 : 0, dt, cfg.processingEase * 0.9, cfg.processingEase * 0.8)
  if (processing) s.scanT += dt
  else if (s.scanA < 0.001) s.scanT = 0
  const morph = s.scanA * s.scanA * (3 - 2 * s.scanA)
  const travel = (span / 2) * cfg.processingTravel
  const passes = s.scanT / cfg.processingDuration
  const passIndex = Math.floor(passes)
  const u = passes - passIndex
  const k = cfg.processingCurve
  const eased = u < 0.5 ? 0.5 * Math.pow(2 * u, k) : 1 - 0.5 * Math.pow(2 - 2 * u, k)
  const pass = passIndex % 2 === 0 ? 2 * eased - 1 : 1 - 2 * eased
  const cx = morph * travel * pass
  const gather = 1 - morph * 0.6
  const maskWidth = 1 - morph * 0.45
  const passWidth = 1 + morph * 0.3 * (1 - pass * pass)

  // idle breathing folded under the voice
  const breathe = 0.5 + 0.5 * Math.sin((Math.PI * 2 * tSec) / cfg.breatheDuration)
  const voiced = s.level + (1 - s.level) * cfg.idle * breathe
  const heldT = Math.max(0, Math.min(1, (morph - 0.25) / 0.75))
  const held = heldT * heldT * (3 - 2 * heldT)
  const eff = Math.max(voiced, cfg.processingLevel * held)
  const glow = 0.15 + 0.85 * eff
  const h = 0.5 + cfg.reach * eff
  const w = (0.85 + cfg.spread * eff) * passWidth
  s.phase = (((s.phase + cfg.flow * eff * dt) % span) + span) % span
  const lift = cfg.bend * eff
  const bendA = cfg.bend > 0 ? Math.min(1, lift / cfg.bend) : 0

  const x: number[] = []
  const l: number[] = []
  for (let i = 0; i < LOBES.length; i++) {
    const lx = wrapX(LOBES[i].x * cfg.lobeSpacing + s.phase, span)
    x.push(lx * gather)
    l.push((0.6 + 0.7 * sb[LOBES[i].band]) * edgeEnvelope(lx, span))
  }
  const f: Frame = { W, H, w, h, cx, mw: maskWidth, bh: Math.max(0, lift), x, l, glow, level: s.level, eff, lift, bendA }

  s.warp = follow(s.warp, processing ? 0 : 1, dt, WARP_IN_TAU, WARP_OUT_TAU)
  const warpOff = s.warp < WARP_OFF_BELOW
  const hue = -cfg.hueRange + 2 * cfg.hueRange * ((1 - Math.cos((Math.PI * 2 * tSec) / cfg.hueDuration)) / 2)
  const cf = Skia.ColorFilter.MakeMatrix(filterMatrix(cfg.hueBase + hue, cfg.brightness, cfg.saturation))
  const pts = bandPoints(cfg, f, morph)
  const [above, below] = clips(pts, W, H)

  // The glow only ever lives in the bottom of the host: keep every layer to that strip.
  const top = Math.max(0, H - 900)
  const bounds = Skia.XYWHRect(0, top, W, H - top)
  const rec = Skia.PictureRecorder()
  const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, W, H))
  const gw = cfg.glowWidth
  const gh = cfg.glowHeight
  const opacity = (layer: number) => fadeIn * glow * layer * cfg.strength

  // distortion: drifting fractal noise, green pinned to 0.5 so only x displaces
  const detail = cfg.distortionDetail
  const noise = Skia.ImageFilter.MakeOffset(8 * cfg.scale * Math.sin(tSec * 0.9), 4 * cfg.scale * Math.sin(tSec * 0.6 + 1.3),
    Skia.ImageFilter.MakeShader(Skia.Shader.MakeFractalNoise(0.012 * detail, 0.05 * detail, 2, 7, 0, 0)))
  const map = Skia.ImageFilter.MakeColorFilter(Skia.ColorFilter.MakeMatrix([1, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), noise)
  const amount = cfg.distortion * 120 * cfg.scale * (0.15 + 0.85 * eff) * s.warp
  const warped = (input: ReturnType<typeof Skia.ImageFilter.MakeColorFilter>) =>
    Skia.ImageFilter.MakeDisplacementMap(ColorChannel.R, ColorChannel.G, amount, map, input)

  // z1 · inner light: soft light inside the host, masked to the edge ellipse and faded off the corners
  const innerLayer = (clip: SkPath | null, warp: boolean) => {
    canvas.save()
    if (clip) canvas.clipPath(clip, ClipOp.Intersect, true)
    const op = Skia.Paint()
    op.setAlphaf(clamp01(opacity(cfg.innerOpacity)))
    canvas.saveLayer(op, bounds)
    const fp = Skia.Paint()
    const colorOnly = Skia.ImageFilter.MakeColorFilter(cf, null)
    fp.setImageFilter(warp ? warped(colorOnly) : colorOnly)
    canvas.saveLayer(fp, bounds)
    paintLobes(canvas, f, cfg, 0.46, gw * 0.9, gh * 0.9, 0, cfg.fade)
    const shadow = Skia.Paint()
    shadow.setStyle(PaintStyle.Stroke)
    shadow.setStrokeWidth(2)
    shadow.setColor(Float32Array.of(cfg.innerShadow[0], cfg.innerShadow[1], cfg.innerShadow[2], cfg.innerShadow[3]))
    shadow.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, (9 * cfg.scale) / 2, true))
    canvas.drawRect(Skia.XYWHRect(1, 1, W - 2, H - 2), shadow)
    canvas.restore()
    const mask = Skia.Paint()
    mask.setBlendMode(BlendMode.DstIn)
    canvas.saveLayer(mask, bounds)
    const fadePx = 28 * cfg.scale
    const white = [1, 1, 1]
    const v = Skia.Paint()
    v.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: 0, y: H },
      [color(white, 1), color(white, 0), color(white, 0), color(white, 1)], [0, fadePx / H, 1 - fadePx / H, 1], TileMode.Clamp))
    canvas.drawRect(Skia.XYWHRect(0, 0, W, H), v)
    const hz = Skia.Paint()
    hz.setBlendMode(BlendMode.Plus)
    hz.setShader(Skia.Shader.MakeLinearGradient({ x: 0, y: 0 }, { x: W, y: 0 },
      [color(white, 1), color(white, 0), color(white, 0), color(white, 1)], [0, fadePx / W, 1 - fadePx / W, 1], TileMode.Clamp))
    canvas.drawRect(Skia.XYWHRect(0, 0, W, H), hz)
    edgeMask(canvas, f, cfg, 170, 64, 45, 0.3, BlendMode.DstIn)
    canvas.restore()
    canvas.restore()
    canvas.restore()
  }
  if (warpOff) innerLayer(null, false)
  else { innerLayer(above, false); innerLayer(below, true) }

  // z2 · stroke: the colours in the 1px edge ring, with the hot core at the centre of the edge
  {
    const op = Skia.Paint()
    op.setAlphaf(clamp01(opacity(cfg.strokeOpacity)))
    canvas.saveLayer(op, bounds)
    const fp = Skia.Paint()
    fp.setColorFilter(cf)
    canvas.saveLayer(fp, bounds)
    const beamX = W / 2 + cx * w
    if (cfg.dark) {
      const r = 30 * cfg.coreSize
      ellipse(canvas, beamX, H + 2, r * w, r * h, [color([1, 1, 1], 0.45), color([1, 1, 1], 0.14), color([1, 1, 1], 0)], [0, 0.3, 0.65], null, null)
    } else {
      ellipse(canvas, beamX, H + 2, 40 * cfg.coreSize * w, 30 * cfg.coreSize * h, [color([0, 0, 0], 0.55), color([0, 0, 0], 0.22), color([0, 0, 0], 0)], [0, 0.35, 0.7], null, null)
    }
    paintLobes(canvas, f, cfg, 1, gw, gh, 2, cfg.fade)
    canvas.restore()
    const mask = Skia.Paint()
    mask.setBlendMode(BlendMode.DstIn)
    canvas.saveLayer(mask, bounds)
    const ring = Skia.Paint()
    ring.setStyle(PaintStyle.Stroke)
    ring.setStrokeWidth(1)
    ring.setColor(Float32Array.of(1, 1, 1, 1))
    canvas.drawRect(Skia.XYWHRect(0.5, 0.5, W - 1, H - 1), ring)
    edgeMask(canvas, f, cfg, 170, 64, 45, 0, BlendMode.DstIn)
    canvas.restore()
    canvas.restore()
  }

  // z3 · bloom: the blurred halo, tallest of the three
  const bloomLayer = (clip: SkPath | null, warp: boolean) => {
    canvas.save()
    if (clip) canvas.clipPath(clip, ClipOp.Intersect, true)
    const op = Skia.Paint()
    op.setAlphaf(clamp01(opacity(cfg.bloomOpacity)))
    canvas.saveLayer(op, bounds)
    const fp = Skia.Paint()
    const blurred = Skia.ImageFilter.MakeColorFilter(cf, Skia.ImageFilter.MakeBlur(10 * cfg.blur, 10 * cfg.blur, TileMode.Decal, null))
    fp.setImageFilter(warp ? warped(blurred) : blurred)
    canvas.saveLayer(fp, bounds)
    paintLobes(canvas, f, cfg, cfg.dark ? 0.9 : 0.7, gw * 1.15, gh * 1.5, 0, Math.min(95, cfg.fade + 2))
    canvas.restore()
    const mask = Skia.Paint()
    mask.setBlendMode(BlendMode.DstIn)
    canvas.saveLayer(mask, bounds)
    edgeMask(canvas, f, cfg, 200, 130, 35, 0, BlendMode.SrcOver)
    canvas.restore()
    canvas.restore()
    canvas.restore()
  }
  if (warpOff) bloomLayer(null, false)
  else { bloomLayer(above, false); bloomLayer(below, true) }

  // z4 · band
  {
    const bp = Skia.Paint()
    bp.setAlphaf(clamp01(fadeIn * cfg.strength))
    bp.setColorFilter(cf)
    canvas.saveLayer(bp, bounds)
    drawBand(canvas, cfg, f, pts)
    canvas.restore()
  }

  // z4 · epicentre wash under the band line (light theme)
  if (cfg.coreLight > 0) {
    const boost = Math.max(0, Math.min(2, cfg.coreLight - 1))
    const b1 = Math.min(1, boost)
    const b2 = Math.max(0, boost - 1)
    const grow = 1 + 0.3 * boost
    const solid = (45 * b1 + 27 * b2) / 100
    const midStop = (40 + 25 * b1 + 15 * b2) / 100
    const midAlpha = Math.min(1, 0.55 + 0.35 * b1 + 0.1 * b2)
    const endStop = (72 + 14 * b1 + 8 * b2) / 100
    const cp = Skia.Paint()
    cp.setAlphaf(clamp01(fadeIn * Math.min(1, glow * Math.min(1, cfg.coreLight) * (1.6 + 1.4 * boost))))
    cp.setImageFilter(Skia.ImageFilter.MakeBlur(8 * cfg.blur, 8 * cfg.blur, TileMode.Decal, null))
    canvas.saveLayer(cp, bounds)
    canvas.clipPath(below, ClipOp.Intersect, true)
    const white = [1, 1, 1]
    ellipse(canvas, W / 2 + cx * w, H, 120 * grow * cfg.scale * w, 70 * grow * cfg.scale * h + f.bh,
      [color(white, 1), color(white, 1), color(white, midAlpha), color(white, 0)], [0, solid, midStop, endStop], null, null)
    canvas.restore()
  }

  return rec.finishRecordingAsPicture()
}

export interface VoiceBeamProps {
  mode: VoiceBeamMode
  /** Raw 0–1 level while listening (the mic): shaped, gated and followed exactly as the web driver does. */
  level: SharedValue<number>
  theme: 'dark' | 'light'
  style?: ViewStyle
}

/** Fills its parent; draw it under the content, like the web component's layers. */
export function VoiceBeam({ mode, level, theme, style }: VoiceBeamProps) {
  'use no memo'
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [empty] = useState(() => { const r = Skia.PictureRecorder(); r.beginRecording(Skia.XYWHRect(0, 0, 1, 1)); return r.finishRecordingAsPicture() })
  const picture = useSharedValue<SkPicture>(empty)
  const modeValue = useSharedValue(MODES[mode])
  const state = useSharedValue<State>({ level: 0, b0: 0, b1: 0, b2: 0, phase: 0, scanA: 0, scanT: 0, t: 0, last: 0, warp: 1, opacity: 0 })
  const cfg = resolve(theme)
  const W = size.w
  const H = size.h

  useEffect(() => { modeValue.value = MODES[mode] }, [mode, modeValue])

  useFrameCallback(({ timestamp }) => {
    'worklet'
    if (!W || !H) return
    const s = state.value
    // ~60 fps cap, as the web driver's loop
    if (s.last && timestamp - s.last < 1000 / 60 - 2) return
    picture.value = render(s, cfg, modeValue.value, level.value, W, H, timestamp)
    state.value = s
  })

  return (
    <View pointerEvents="none" style={[{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }, style]}
      onLayout={(e) => setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
      {W > 0 && (
        <Canvas style={{ width: W, height: H }}>
          <Picture picture={picture} />
        </Canvas>
      )}
    </View>
  )
}
