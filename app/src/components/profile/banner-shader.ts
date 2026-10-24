// The Profile banner: five small scenes drawn as ordered (Bayer) dither in square blocks, two inks on near-black, like
// a dithered photo. One SkSL shader for all of them (`scene` picks); `t` is seconds, everything drifts slowly.
// Kept free of React so CanvasKit can render it off-device (see scripts in the commit that added it).

export const BANNERS = [
  { id: 'canopy', name: 'Canopy' },
  { id: 'tide', name: 'Tide' },
  { id: 'dune', name: 'Dune' },
  { id: 'aurora', name: 'Aurora' },
  { id: 'signal', name: 'Signal' },
] as const
export type BannerId = (typeof BANNERS)[number]['id']

export const BANNER_SKSL = `
uniform float2 size;
uniform float t;
uniform float scene;
uniform float cell;

float hash(float2 p) { return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453); }
float noise(float2 p) {
  float2 i = floor(p); float2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1, 0)), f.x), mix(hash(i + float2(0, 1)), hash(i + float2(1, 1)), f.x), f.y);
}
float fbm(float2 p) {
  float v = 0.0; float a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.0; a *= 0.5; }
  return v;
}
float bayer2(float2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(float2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
float bayer8(float2 a) { return bayer4(0.5 * a) * 0.25 + bayer2(a); }

// Brightness of each scene at uv (0..1, y down), aspect k = width / height.
float canopy(float2 uv, float k) {
  float2 p = float2(uv.x * k, uv.y);
  float2 c = float2(k * 0.68, 0.46);
  float2 d = p - c;
  float warp = fbm(p * 3.0 + float2(t * 0.05, -t * 0.03));
  float blob = min(min(length(d * float2(0.9, 1.3)), length((d - float2(-0.2, 0.07)) * float2(1.2, 1.5)) + 0.04),
    length((d - float2(0.22, 0.05)) * float2(1.2, 1.6)) + 0.05);
  float crown = smoothstep(0.4, 0.14, blob + (warp - 0.5) * 0.45);
  float leaves = fbm(p * 9.0 + float2(t * 0.12, t * 0.04));
  float trunk = smoothstep(0.035, 0.0, abs(p.x - c.x - (uv.y - 0.6) * 0.06)) * step(0.5, uv.y);
  float sky = 0.06 * fbm(p * 2.0 + t * 0.02);
  return max(max(crown * (0.25 + 0.85 * leaves), trunk * 0.55), sky);
}
float tide(float2 uv, float k) {
  float2 p = float2(uv.x * k, uv.y);
  float horizon = 0.6;
  float2 moon = float2(k * 0.74, 0.36);
  float disc = smoothstep(0.1, 0.085, length(p - moon));
  float halo = 0.35 * exp(-length(p - moon) * 5.0);
  float sky = disc + halo;
  float depth = (uv.y - horizon) / (1.0 - horizon);
  float waves = sin(p.x * 30.0 / (0.2 + depth) + t * 0.8 + fbm(p * 6.0) * 4.0) * 0.5 + 0.5;
  float column = exp(-abs(p.x - moon.x) * (6.0 - depth * 3.0)) * (0.4 + 0.6 * waves);
  float sea = 0.1 + 0.18 * waves * (1.0 - depth) + 0.8 * column * (0.5 + 0.5 * fbm(p * 12.0 + float2(t * 0.1, 0)));
  return uv.y < horizon ? sky : sea;
}
float dune(float2 uv, float k) {
  float2 p = float2(uv.x * k, uv.y);
  float2 sun = float2(k * 0.7, 0.52 + 0.01 * sin(t * 0.3));
  float glow = smoothstep(0.17, 0.155, length(p - sun)) + 0.55 * exp(-length(p - sun) * 3.5);
  float sky = uv.y * uv.y * 0.32 + glow;
  float ridge1 = 0.62 + 0.06 * sin(p.x * 2.2 + 1.0) + 0.03 * sin(p.x * 5.1 + t * 0.05);
  float ridge2 = 0.78 + 0.05 * sin(p.x * 3.4 + 2.5) + 0.02 * sin(p.x * 7.3 - t * 0.04);
  float sand = fbm(p * float2(3.0, 18.0) + float2(t * 0.03, 0));
  if (uv.y > ridge2) return 0.35 + 0.35 * sand * (1.0 - (uv.y - ridge2) * 1.5);
  if (uv.y > ridge1) return 0.12 + 0.25 * sand + 0.25 * smoothstep(ridge1 + 0.05, ridge1, uv.y);
  return sky;
}
float aurora(float2 uv, float k) {
  float2 p = float2(uv.x * k, uv.y);
  float v = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float y = 0.42 + fi * 0.11 + 0.14 * sin(p.x * (1.4 + fi * 0.5) + t * (0.12 + fi * 0.05) + fi * 2.0) + 0.06 * (fbm(float2(p.x * 2.0 + fi, t * 0.05)) - 0.5);
    float band = exp(-abs(uv.y - y) * (14.0 - fi * 3.0));
    float rays = 0.45 + 0.55 * fbm(float2(p.x * 22.0 + fi * 7.0, t * 0.15));
    v += band * rays * (0.9 - fi * 0.2);
  }
  float stars = step(0.985, hash(floor(p * 90.0))) * (0.5 + 0.5 * sin(t * 2.0 + hash(floor(p * 90.0)) * 40.0));
  float hills = smoothstep(0.86 + 0.04 * sin(p.x * 3.0), 0.9 + 0.04 * sin(p.x * 3.0), uv.y);
  return mix(max(v, stars * 0.8), 0.04, hills);
}
float signal(float2 uv, float k) {
  float2 p = float2(uv.x * k, uv.y);
  float f = fbm(p * 2.2 + float2(t * 0.06, t * 0.02));
  float rings = 0.5 + 0.5 * sin(length(p - float2(k * 0.72, 0.5)) * 18.0 - t * 0.6);
  return clamp(f * 1.2 - 0.25 + rings * 0.35 * f, 0.0, 1.0);
}

// Signal is ASCII: each 6x6 block is a glyph picked by brightness (space . : + x #).
float glyph(float level, float2 q) {
  float2 g = floor(q);
  float cx = step(abs(g.x - 2.0), 0.0); float cy = step(abs(g.y - 2.0), 0.0);
  if (g.x > 4.0 || g.y > 4.0) return 0.0;
  if (level < 1.0) return 0.0;
  if (level < 2.0) return cx * cy;
  if (level < 3.0) return cx * (step(abs(g.y - 1.0), 0.0) + step(abs(g.y - 3.0), 0.0));
  if (level < 4.0) return max(cx, cy) * step(abs(g.x - 2.0) + abs(g.y - 2.0), 2.0);
  if (level < 5.0) return max(step(abs(g.x - g.y), 0.0), step(abs(g.x + g.y - 4.0), 0.0));
  return max(step(abs(g.x - 1.0), 0.0) + step(abs(g.x - 3.0), 0.0), step(abs(g.y - 1.0), 0.0) + step(abs(g.y - 3.0), 0.0));
}

half4 main(float2 xy) {
  float k = size.x / size.y;
  float s = scene;
  if (s > 3.5) {
    float big = cell * 2.6;
    float2 b = floor(xy / big);
    float v = signal((b + 0.5) * big / size, k);
    float level = floor(smoothstep(0.15, 0.95, v) * 6.0);
    float on = glyph(level, fract(xy / big) * 6.0);
    float3 ink = mix(float3(0.32, 0.33, 0.36), float3(0.93, 0.94, 0.96), v);
    return half4(mix(float3(0.035, 0.035, 0.043), ink, on), 1.0);
  }
  float2 b = floor(xy / cell);
  float2 uv = (b + 0.5) * cell / size;
  float v = s < 0.5 ? canopy(uv, k) : s < 1.5 ? tide(uv, k) : s < 2.5 ? dune(uv, k) : aurora(uv, k);
  v = smoothstep(0.06, 1.0, v); // dark stays dark: no even dot grid over the empty parts
  float th = bayer8(b);
  float3 bg = float3(0.035, 0.035, 0.043);
  float3 lo; float3 hi;
  if (s < 0.5) { lo = float3(0.55, 0.22, 0.32); hi = float3(0.98, 0.72, 0.80); }
  else if (s < 1.5) { lo = float3(0.16, 0.30, 0.62); hi = float3(0.78, 0.88, 1.0); }
  else if (s < 2.5) { lo = float3(0.62, 0.30, 0.10); hi = float3(1.0, 0.82, 0.52); }
  else { lo = float3(0.10, 0.48, 0.42); hi = float3(0.70, 1.0, 0.86); }
  float3 col = bg;
  if (v > th) col = lo;
  if (v > 0.55 + th * 0.45) col = hi;
  return half4(col, 1.0);
}
`
