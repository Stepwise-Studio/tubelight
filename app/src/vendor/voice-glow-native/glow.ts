// voice-glow (mobile) as numbers and a shader source: the driver step and the SkSL, free of React Native so
// it can be checked off-device (CanvasKit). See VoiceBeam.tsx for the story.

export type VoiceBeamMode = 'idle' | 'listening' | 'processing' | 'speaking'
export const MODES: Record<VoiceBeamMode, number> = { idle: 0, listening: 1, processing: 2, speaking: 3 }

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
const rgb = (r: number, g: number, b: number) => [r / 255, g / 255, b / 255]
const PALETTE = {
  dark: [rgb(255, 70, 120), rgb(60, 190, 255), rgb(175, 70, 255), rgb(60, 220, 130), rgb(255, 150, 40), rgb(90, 100, 255), rgb(40, 200, 190)],
  light: [rgb(255, 201, 21), rgb(126, 196, 255), rgb(180, 40, 230), rgb(235, 100, 160), rgb(255, 176, 122), rgb(154, 160, 255), rgb(127, 217, 238)],
}
const BAND_COLORS = {
  dark: [rgb(255, 255, 255), rgb(255, 70, 80), rgb(90, 255, 150), rgb(80, 140, 255)], // core, above, mid, below
  light: [rgb(197, 139, 255), rgb(255, 122, 182), rgb(126, 196, 255), rgb(45, 255, 171)],
}

// ── presets.ts, resolved for type "mobile" (scale 1.25 multiplied in, as the component does) ────────────────
export function resolve(theme: 'dark' | 'light') {
  const sc = 1.25
  const dark = theme === 'dark'
  const gw = 1.15 * sc
  const gh = 2.1 * sc
  return {
    dark,
    threshold: 0.015, attack: 0.325, release: 0.86, idle: 0.18, breathe: 5.2,
    reach: 3, spread: 0.45, flow: 60 * sc, bend: 70 * sc,
    bandStrength: dark ? 1.8 : 1.7, bandWidth: 2.4 * sc, bandPosition: 0.35, bandOffset: -50 * sc, bandTail: 0.62,
    bandAberration: 0.89,
    distortion: 0.62,
    rangeWidth: 1.25 * sc, rangeHeight: 1.2 * sc, lobeSpacing: 1.35 * sc, coreSize: sc, scale: sc,
    // Lobe radii per layer (rounded like the CSS px), before the frame's w / h.
    rx: [0.9, 1, 1.15].map((k) => LOBES.map((l) => Math.round(l.w * gw * k))),
    ry: [0.9, 1, 1.5].map((k) => LOBES.map((l) => Math.round(l.h * gh * k))),
    // themePresets + voiceTypeStyle.mobile
    strokeOpacity: dark ? 1.16 : 1.2, innerOpacity: dark ? 0.47 : 0.85, bloomOpacity: dark ? 0.89 : 0.5,
    shadow: dark ? [1, 1, 1] : [0, 0, 0],
    brightness: dark ? 1.2 : 0.95, saturation: dark ? 1.5 : 1.6,
    hueRange: dark ? 24 : 40, hueDuration: dark ? 12 : 8.5, hueBase: dark ? 0 : 5,
    colors: PALETTE[theme], band: BAND_COLORS[theme],
    processingDuration: 1.05, processingLevel: 0.35, processingEase: 0.6, processingCurve: 2.1,
  }
}
export type Config = ReturnType<typeof resolve>

// ── The shader: every layer, one pass ──────────────────────────────────────
const f = (n: number) => (Number.isInteger(n) ? `${n}.0` : `${n}`)
export function source(dark: boolean) {
  const fade = Math.round(Math.max(40, Math.min(95, 70 * 1.1))) / 100
  const hi = dark ? [0.45, 0.3, 0.14, 0.65] : [0.55, 0.35, 0.22, 0.7]
  return `
uniform float2 uSize;
uniform float uScale;
uniform float uR;
uniform float uTop;
uniform float4 uA[7];
uniform float4 uB[7];
uniform float4 uC[7];
uniform float4 uMI;
uniform float4 uMB;
uniform float4 uHi;
uniform float3 uHiC;
uniform float3 uShadowC;
uniform float3 uOp;
uniform float4 uBand;
uniform float4 uBand2;
uniform float4 uRidge;
uniform float3 uK0;
uniform float3 uK1;
uniform float3 uK2;
uniform float3 uK3;
uniform float4 uWarp;
uniform float4 uCore;

const float FADE_I = ${f(fade)};
const float FADE_B = ${f(Math.min(0.95, fade + 0.02))};
const float CORNER_FADE = 35.0;
const float INSET_BLUR = 11.25;
const float SHADOW_A = ${f(dark ? 0.1 : 0.08)};
const float BLOOM_SIGMA = 12.5;
const float BAND_SIGMA = 5.25;
const float CORE_SIGMA = 10.0;
const float CURVE = 1.55;
const float SPREAD = 0.9;
const float SKEW = 0.12;
const float TAIL_POS = 0.42;
const float TAIL_CURVE = 2.7;
const float OVER = 27.5;
const float END_FADE = 0.015;

float4 over(float4 src, float4 dst) { return src + dst * (1.0 - src.a); }

float rrect(float2 p, float2 hs, float r) {
  float2 q = abs(p - hs) - hs + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float edist(float2 p, float2 c, float2 r) { return length((p - c) / max(r, float2(0.5))); }

// The ellipse mask: 1 at the centre, 0.5 at mid, tail at 85% (when >= 0), 0 at the edge.
float maskA(float d, float mid, float tail) {
  if (d >= 1.0) return 0.0;
  if (d <= mid) return mix(1.0, 0.5, d / mid);
  if (tail < 0.0) return mix(0.5, 0.0, (d - mid) / (1.0 - mid));
  if (d <= 0.85) return mix(0.5, tail, (d - mid) / (0.85 - mid));
  return mix(tail, 0.0, (d - 0.85) / 0.15);
}

// The Gaussian CDF (logistic fit), and the coverage of a blurred stroke of half-width hw at distance d.
float phi(float z) { return 1.0 / (1.0 + exp(-1.702 * z)); }
float cover(float d, float hw, float s) { float a = abs(d); return phi((hw - a) / s) - phi((-hw - a) / s); }

float bell(float t) {
  float s = max(0.05, SPREAD * (t < 0.0 ? 1.0 - SKEW : 1.0 + SKEW));
  float v = exp(-pow(abs(t) / s, CURVE));
  float tail = t < 0.0 ? 0.238018 : 0.372423; // exp(-(1 / s)^CURVE), per side
  return max(0.0, (v - tail) / (1.0 - tail));
}

float cornerLift(float x) {
  float r = uR;
  if (r <= 0.0) return 0.0;
  float d = min(x, uSize.x - x);
  if (d >= r) return 0.0;
  if (d <= 0.0) return r;
  float dx = r - d;
  return r - sqrt(max(0.0, r * r - dx * dx));
}

// bandPoints: an organic bell on the ceiling, hooks rising toward the corners, riding the arcs while gathered.
float bandY(float x) {
  float centre = uBand.x;
  float tail = uBand2.x;
  float t = clamp((x - centre) / max(1.0, uBand.y), -1.0, 1.0);
  float y = bell(t);
  if (tail > 0.001) {
    float edge = (x < centre ? centre : uSize.x - centre) + OVER;
    float start = edge * TAIL_POS;
    float dist = abs(x - centre);
    if (dist > start) y += tail * pow(min(1.0, (dist - start) / max(1.0, edge - start)), TAIL_CURVE);
  }
  return uBand.w - uBand.z * y - cornerLift(x) * uBand2.w;
}

// feTurbulence-like drifting fractal noise: Perlin gradient noise (unit gradients), two octaves, about -1..1.
float2 hash(float2 p) {
  float3 p3 = fract(float3(p.xyx) * float3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return normalize(-1.0 + 2.0 * fract((p3.xx + p3.yz) * p3.zy) + 0.0001);
}
float gnoise(float2 p) {
  float2 i = floor(p);
  float2 q = fract(p);
  float2 u = q * q * (3.0 - 2.0 * q);
  return mix(mix(dot(hash(i), q), dot(hash(i + float2(1.0, 0.0)), q - float2(1.0, 0.0)), u.x),
             mix(dot(hash(i + float2(0.0, 1.0)), q - float2(0.0, 1.0)), dot(hash(i + float2(1.0, 1.0)), q - float2(1.0, 1.0)), u.x), u.y);
}

// A layer's lobes, first on top (CSS backgrounds): colour at the centre, transparent at fade x radius.
float4 lobe(float4 acc, float2 p, float2 c, float2 r, float3 col, float alpha, float fade, float soft) {
  float x = 1.0 - edist(p, c, r) / fade;
  float k = soft / (fade * max(1.0, min(r.x, r.y)));
  float a = x >= k ? x : (x <= -k ? 0.0 : (x + k) * (x + k) / max(4.0 * k, 0.0001));
  a = alpha * min(1.0, a);
  return over(float4(col * a, a), acc);
}

float4 ridge(float4 acc, float dv, float sl, float inv, float ox, float oy, float3 col, float a, float th) {
  float d = (dv + sl * ox - oy) * inv;
  float4 r = acc;
  float c = a * 0.16 * cover(d, max(0.6, th) * 0.5, BAND_SIGMA); r = over(float4(col * c, c), r);
  c = a * 0.2 * cover(d, max(0.6, th * 0.72) * 0.5, BAND_SIGMA); r = over(float4(col * c, c), r);
  c = a * 0.26 * cover(d, max(0.6, th * 0.46) * 0.5, BAND_SIGMA); r = over(float4(col * c, c), r);
  c = a * 0.34 * cover(d, max(0.6, th * 0.22) * 0.5, BAND_SIGMA); r = over(float4(col * c, c), r);
  return r;
}

// The canvas is drawn at a fraction of the screen's pixels and scaled up (the glow is all soft light):
// \`pos\` is in canvas units, \`p\` in the host's.
half4 main(float2 pos) {
  float2 p = pos * uScale;
  if (p.y < uTop) return half4(0.0);
  float W = uSize.x;
  float H = uSize.y;
  float r = min(uR, min(W, H) * 0.5);
  float sdf = rrect(p, uSize * 0.5, r);
  float clip = 1.0 - smoothstep(-0.5, 0.5, sdf);
  if (clip <= 0.0) return half4(0.0);

  // The band line: the warp lives under it, the epicentre wash too.
  float y0 = bandY(p.x);
  float dv = p.y - y0;
  float2 pw = p;
  if (dv > 0.0 && uWarp.x > 0.0) {
    float2 q = (p - uWarp.yz) * float2(${f(0.012 * 1.6)}, ${f(0.05 * 1.6)});
    pw.x += uWarp.x * 0.5 * (gnoise(q) + 0.5 * gnoise(q * 2.0));
  }

  float4 col = float4(0.0);

  // z1 · inner light: soft light along the edges, an inset shadow, masked to the edge ellipse.
  float mI = maskA(edist(p, uMI.xy, uMI.zw), 0.45, 0.3);
  if (mI > 0.0 && uOp.x > 0.0) {
    float v = max(max(0.0, 1.0 - p.y / CORNER_FADE), max(0.0, 1.0 - (H - p.y) / CORNER_FADE));
    float h = max(max(0.0, 1.0 - p.x / CORNER_FADE), max(0.0, 1.0 - (W - p.x) / CORNER_FADE));
    float geom = v + h * (1.0 - v);
    if (geom > 0.0) {
      float4 l = float4(0.0);
      for (int i = 6; i >= 0; i--) l = lobe(l, pw, float2(uA[i].x, H + uA[i].y), uA[i].zw, uC[i].rgb, 0.46, FADE_I, 0.0);
      float s = SHADOW_A * (1.0 - smoothstep(1.0 - INSET_BLUR, 1.0 + INSET_BLUR, -sdf));
      l = over(float4(uShadowC * s, s), l);
      col = l * (geom * mI * uOp.x);
    }
  }

  // z2 · stroke: the colours in the 1px edge ring, the hot core at the centre of the edge on top.
  float inner = 1.0 - smoothstep(-0.5, 0.5, rrect(p - 1.0, uSize * 0.5 - 1.0, max(r - 1.0, 0.0)));
  float ring = max(clip - inner, 0.0);
  float mS = maskA(edist(p, uMI.xy, uMI.zw), 0.45, -1.0);
  if (ring > 0.0 && mS > 0.0 && uOp.y > 0.0) {
    float4 l = float4(0.0);
    for (int i = 6; i >= 0; i--) l = lobe(l, p, float2(uA[i].x, H + 2.0 + uA[i].y), uB[i].xy, uC[i].rgb, 1.0, FADE_I, 0.0);
    float d = edist(p, uHi.xy, uHi.zw);
    float a = d <= ${f(hi[1])} ? mix(${f(hi[0])}, ${f(hi[2])}, d / ${f(hi[1])})
      : (d < ${f(hi[3])} ? mix(${f(hi[2])}, 0.0, (d - ${f(hi[1])}) / ${f(hi[3] - hi[1])}) : 0.0);
    l = over(float4(uHiC * a, a), l);
    col = over(l * (ring * mS * uOp.y), col);
  }

  // z3 · bloom: the blurred halo (softened falloff, edges faded as a blur against nothing outside the box).
  float mB = maskA(edist(p, uMB.xy, uMB.zw), 0.35, -1.0);
  if (mB > 0.0 && uOp.z > 0.0) {
    float4 l = float4(0.0);
    for (int i = 6; i >= 0; i--) l = lobe(l, pw, float2(uA[i].x, H + uA[i].y), uB[i].zw, uC[i].rgb, ${f(dark ? 0.9 : 0.7)}, FADE_B, BLOOM_SIGMA);
    float e = phi(p.x / BLOOM_SIGMA) * phi((W - p.x) / BLOOM_SIGMA) * phi((H - p.y) / BLOOM_SIGMA);
    col = over(l * (e * mB * uOp.z), col);
  }

  // z4 · band: the halo, then red above, faint green, blue below and the white core, each a blurred ramp.
  if (uRidge.x > 0.002 && abs(dv) < 125.0) {
    float x0 = uBand2.y;
    float x1 = uBand2.z;
    float u = (p.x - x0) / max(1.0, x1 - x0);
    float ends = u <= 0.0 || u >= 1.0 ? 0.0 : min(1.0, min(u, 1.0 - u) / END_FADE);
    if (ends > 0.0) {
      float sl = (bandY(p.x + 2.0) - y0) * 0.5;
      float inv = inversesqrt(1.0 + sl * sl);
      float a = uRidge.x * ends;
      float th = uRidge.y;
      float c = a * 0.3 * cover(dv * inv, th * 1.1, BAND_SIGMA * 3.0);
      float4 b = float4(uK0 * c, c);
      if (abs(dv) < 80.0) { // the ridges reach ~60 px; past that only the halo shows
        b = ridge(b, dv, sl, inv, uRidge.z, -uRidge.w, uK1, a, th);
        b = ridge(b, dv, sl, inv, uRidge.z * 0.35, -uRidge.w * 0.35, uK2, a * 0.55, th);
        b = ridge(b, dv, sl, inv, -uRidge.z, uRidge.w, uK3, a, th);
        b = ridge(b, dv, sl, inv, 0.0, 0.0, uK0, a * 0.9, th);
      }
      col = over(b, col);
    }
  }

  // z4 · epicentre (light theme): a soft white wash at the source, under the band line.
  if (uCore.z > 0.0) {
    float d = edist(p, float2(uMI.x, uMI.y), uCore.xy);
    float a = d <= 0.36 ? 1.0 : (d <= 0.6 ? mix(1.0, 0.83, (d - 0.36) / 0.24) : (d < 0.832 ? mix(0.83, 0.0, (d - 0.6) / 0.232) : 0.0));
    a *= uCore.z * phi(dv / CORE_SIGMA);
    col = over(float4(a, a, a, a), col);
  }

  return half4(col * clip);
}
`
}

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
function cornerLift(x: number, cw: number, radius: number, influence: number) {
  'worklet'
  if (radius <= 0) return 0
  const d = Math.min(x, cw - x) - influence
  if (d >= radius) return 0
  if (d <= 0) return radius
  const dx = radius - d
  return radius - Math.sqrt(Math.max(0, radius * radius - dx * dx))
}

/** CSS `hue-rotate(h) brightness(b) saturate(s)`, step by step (each clamped, as filter primitives are). */
function filtered(c: number[], hueDeg: number, b: number, s: number) {
  'worklet'
  const a = (hueDeg * Math.PI) / 180
  const cs = Math.cos(a)
  const sn = Math.sin(a)
  const r0 = c[0]
  const g0 = c[1]
  const b0 = c[2]
  let r = clamp01((0.213 + cs * 0.787 - sn * 0.213) * r0 + (0.715 - cs * 0.715 - sn * 0.715) * g0 + (0.072 - cs * 0.072 + sn * 0.928) * b0)
  let g = clamp01((0.213 - cs * 0.213 + sn * 0.143) * r0 + (0.715 + cs * 0.285 + sn * 0.14) * g0 + (0.072 - cs * 0.072 - sn * 0.283) * b0)
  let bl = clamp01((0.213 - cs * 0.213 - sn * 0.787) * r0 + (0.715 - cs * 0.715 + sn * 0.715) * g0 + (0.072 + cs * 0.928 + sn * 0.072) * b0)
  r = clamp01(r * b); g = clamp01(g * b); bl = clamp01(bl * b)
  return [
    clamp01((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * bl),
    clamp01((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * bl),
    clamp01((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * bl),
  ]
}

export interface State {
  level: number; b0: number; b1: number; b2: number; phase: number; scanA: number; scanT: number
  t: number; last: number; warp: number; opacity: number
}

export type Uniforms = Record<string, number | number[]>

/** One frame: the driver step, then the numbers the shader needs. */
export function step(s: State, k: Config, mode: number, input: number[], W: number, H: number, R: number, ts: number, still: boolean, scale = 1): Uniforms {
  'worklet'
  const dt = s.last ? Math.min(0.05, (ts - s.last) / 1000) : 1 / 60
  s.last = ts
  s.t += dt
  const tSec = s.t
  s.opacity = Math.min(1, s.opacity + dt / 0.6)
  const fadeIn = s.opacity * s.opacity * (3 - 2 * s.opacity)

  // Raw level and bands: the analyser's while a voice is heard; without a spectrum, out-of-phase wobbles.
  const voice = mode === 1 || mode === 3
  const raw = voice ? input[0] : 0
  const spectrum = input.length >= 4
  const bands = !voice ? [0, 0, 0] : spectrum ? [input[1], input[2], input[3]]
    : [raw, raw * (0.72 + 0.28 * Math.sin(tSec * 9.1)), raw * (0.6 + 0.4 * Math.sin(tSec * 13.7 + 2))]
  s.level = follow(s.level, shape(raw, k.threshold), dt, k.attack, k.release)
  s.b0 = follow(s.b0, shape(bands[0], k.threshold * 0.6), dt, k.attack, k.release * 1.15)
  s.b1 = follow(s.b1, shape(bands[1], k.threshold * 0.6), dt, k.attack, k.release * 1.15)
  s.b2 = follow(s.b2, shape(bands[2], k.threshold * 0.6), dt, k.attack, k.release * 1.15)
  const sb = [s.b0, s.b1, s.b2]

  // Motion: processing gathers the lobes into one beam that sweeps the edge and wraps the corners.
  const processing = mode === 2
  const span = 36 * LOBES.length * k.lobeSpacing
  if (processing && s.scanA < 0.001 && s.scanT === 0) s.scanT = k.processingDuration / 2
  s.scanA = follow(s.scanA, processing ? 1 : 0, dt, k.processingEase * 0.9, k.processingEase * 0.8)
  if (processing) s.scanT += dt
  else if (s.scanA < 0.001) s.scanT = 0
  const morph = s.scanA * s.scanA * (3 - 2 * s.scanA)
  const passes = s.scanT / k.processingDuration
  const passIndex = Math.floor(passes)
  const u = passes - passIndex
  const eased = u < 0.5 ? 0.5 * Math.pow(2 * u, k.processingCurve) : 1 - 0.5 * Math.pow(2 - 2 * u, k.processingCurve)
  const pass = passIndex % 2 === 0 ? 2 * eased - 1 : 1 - 2 * eased
  const cx = still ? 0 : morph * (span / 2) * pass
  const gather = 1 - morph * 0.6
  const maskWidth = 1 - morph * 0.45
  const passWidth = 1 + morph * 0.3 * (1 - pass * pass)

  // Idle breathing folded under the voice.
  const breathe = still ? 0.5 : 0.5 + 0.5 * Math.sin((Math.PI * 2 * tSec) / k.breathe)
  const voiced = s.level + (1 - s.level) * k.idle * breathe
  const heldT = Math.max(0, Math.min(1, (morph - 0.25) / 0.75))
  const held = heldT * heldT * (3 - 2 * heldT)
  const eff = Math.max(voiced, k.processingLevel * held)
  const glow = 0.15 + 0.85 * eff
  const h = 0.5 + k.reach * eff
  const w = (0.85 + k.spread * eff) * passWidth
  if (!still) s.phase = (((s.phase + k.flow * eff * dt) % span) + span) % span
  const lift = k.bend * eff
  const bendA = k.bend > 0 ? Math.min(1, lift / k.bend) : 0

  // Colours: the hue drift, then each through the layers' filter chain.
  const hue = still ? 0 : -k.hueRange + 2 * k.hueRange * ((1 - Math.cos((Math.PI * 2 * tSec) / k.hueDuration)) / 2)
  const deg = k.hueBase + hue
  const tint = (c: number[]) => filtered(c, deg, k.brightness, k.saturation)

  // Lobes: where each sits on the flow, how tall the voice band makes it, and its lift along a corner arc.
  const arcR = Math.max(0, Math.min(R, W / 2, H / 2))
  const beamX = W / 2 + cx * w
  const reachX = 30 * k.scale * w
  const cy = -cornerLift(beamX, W, arcR, reachX * 1.4) * morph
  const A: number[] = []
  const B: number[] = []
  const C: number[] = []
  for (let i = 0; i < LOBES.length; i++) {
    const lx = wrapX(LOBES[i].x * k.lobeSpacing + s.phase, span)
    const l = (0.6 + 0.7 * sb[LOBES[i].band]) * edgeEnvelope(lx, span)
    const x = W / 2 + (cx + lx * gather) * w
    const y = -cornerLift(x, W, arcR, reachX) * morph
    A.push(x, y, k.rx[0][i] * w, k.ry[0][i] * h * l)
    B.push(k.rx[1][i] * w, k.ry[1][i] * h * l, k.rx[2][i] * w, k.ry[2][i] * h * l)
    C.push(...tint(k.colors[i]), 1)
  }

  // The band line (bandPoints) and its strokes (drawBand).
  const half = 170 * k.rangeWidth * w * maskWidth
  const apex = Math.min(H * 0.82, (64 * k.rangeHeight * h + lift) * k.bandPosition)
  const base = H - k.bandOffset
  const tailT = Math.min(1, morph * 4)
  const tail = k.bandTail * (1 - tailT * tailT * (3 - 2 * tailT))
  const withTail = tail > 0.001
  const x0 = withTail ? -27.5 : beamX - half
  const x1 = withTail ? W + 27.5 : beamX + half
  const bandA = Math.min(1, 0.6 * k.bandStrength * bendA)
  const split = k.bandAberration * (0.35 + 0.65 * s.level)
  const ridgeBase = bandA < 0.005 ? 0 : (k.dark ? 0.42 : 0.4) * bandA * fadeIn
  const thickness = 14 * k.bandWidth * (1 + 0.35 * s.level)

  // The warp under the band line: follows the voice, drops while gathered.
  s.warp = follow(s.warp, morph > 0.02 ? 0 : 1, dt, 0.35, 0.06)
  const amount = still || s.warp < 0.03 ? 0 : k.distortion * 120 * k.scale * (0.15 + 0.85 * eff) * s.warp

  const op = (layer: number) => clamp01(fadeIn * glow * layer)
  const maskI = [beamX, H + cy, 170 * k.rangeWidth * w * maskWidth, 64 * k.rangeHeight * h + Math.max(0, lift)]
  const maskB = [beamX, H + cy, 200 * k.rangeWidth * w * maskWidth, 130 * k.rangeHeight * h + Math.max(0, lift)]
  const grow = 1.24
  return {
    uSize: [W, H],
    uScale: scale,
    uR: R,
    uTop: Math.max(0, Math.min(H - maskB[3], base - apex * 1.7 - arcR - 180) - 8),
    uA: A, uB: B, uC: C,
    uMI: maskI,
    uMB: maskB,
    uHi: [beamX, H + 2 + cy, (k.dark ? 30 : 40) * k.coreSize * w, 30 * k.coreSize * h],
    uHiC: tint(k.dark ? [1, 1, 1] : [0, 0, 0]),
    uShadowC: tint(k.shadow),
    uOp: [op(k.innerOpacity), op(k.strokeOpacity), op(k.bloomOpacity)],
    uBand: [beamX, half, apex, base],
    uBand2: [tail, x0, x1, morph],
    uRidge: [ridgeBase, thickness, 4 * split * k.scale, (4 + 12 * split) * k.scale],
    uK0: tint(k.band[0]), uK1: tint(k.band[1]), uK2: tint(k.band[2]), uK3: tint(k.band[3]),
    uWarp: [amount, 8 * k.scale * Math.sin(tSec * 0.9), 4 * k.scale * Math.sin(tSec * 0.6 + 1.3), 0],
    uCore: k.dark ? [0, 0, 0, 0] : [120 * grow * k.scale * w, 70 * grow * k.scale * h + Math.max(0, lift), fadeIn * Math.min(1, glow * 2.72), 0],
  }
}

