// Shared by live voice and dictation: Gemini Live's WebSocket (single-use tokens from our server) and its frames.

export const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'

/** Gemini Live sends JSON in binary frames: UTF-8 decode them (TextDecoder when the runtime has it). */
export function frameText(data: unknown): string {
  if (typeof data === 'string') return data
  const bytes = new Uint8Array(data as ArrayBuffer)
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder
  if (TD) return new TD().decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++]
    const cp = b < 0x80 ? b
      : b < 0xe0 ? ((b & 0x1f) << 6) | (bytes[i++] & 0x3f)
      : b < 0xf0 ? ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
      : ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)
    out += String.fromCodePoint(cp)
  }
  return out
}
