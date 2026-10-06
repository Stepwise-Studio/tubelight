package studio.stepwise.liveaudio

import kotlin.math.PI
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * What voice-glow's web driver reads from an AnalyserNode, so the glow reacts the same here: RMS of the latest
 * samples, and a Blackman-windowed FFT smoothed over time (0.5) on the −100…−30 dB byte scale, averaged over three
 * voice bands (fundamentals and chest, vowels and presence, sibilance). One per audio thread.
 */
internal class Spectrum(rate: Int, private val size: Int = 1024) {
  private val ring = FloatArray(size)
  private var pos = 0
  private val window = DoubleArray(size) { n -> val x = 2 * PI * n / size; 0.42 - 0.5 * cos(x) + 0.08 * cos(2 * x) }
  private val re = DoubleArray(size)
  private val im = DoubleArray(size)
  private val smoothed = DoubleArray(size / 2)
  private val ranges = listOf(80.0 to 300.0, 300.0 to 2000.0, 2000.0 to 6000.0).map { (lo, hi) ->
    val bin = rate.toDouble() / size
    maxOf(1, floor(lo / bin).toInt()) to minOf(size / 2 - 1, ceil(hi / bin).toInt())
  }

  /** Adds PCM16 little-endian samples. */
  fun push(buf: ByteArray, off: Int, len: Int) {
    var i = off
    while (i + 1 < off + len) {
      ring[pos] = ((buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)).toShort() / 32768f
      pos = (pos + 1) % size
      i += 2
    }
  }

  fun clear() {
    ring.fill(0f)
    smoothed.fill(0.0)
  }

  /** RMS of the last [last] samples, and the three bands (0–1). */
  fun read(last: Int): Pair<Double, List<Double>> {
    var sum = 0.0
    for (k in 0 until last) {
      val s = ring[(pos - 1 - k + size) % size]
      sum += s * s
    }
    for (n in 0 until size) {
      re[n] = ring[(pos + n) % size] * window[n]
      im[n] = 0.0
    }
    fft()
    val bands = ranges.map { (from, to) ->
      var acc = 0.0
      for (k in from..to) {
        smoothed[k] = 0.5 * smoothed[k] + 0.5 * sqrt(re[k] * re[k] + im[k] * im[k]) / size
        acc += ((20 * log10(maxOf(smoothed[k], 1e-12)) + 100) / 70).coerceIn(0.0, 1.0)
      }
      acc / (to - from + 1)
    }
    return sqrt(sum / last) to bands
  }

  /** In-place radix-2 FFT of re/im. */
  private fun fft() {
    var j = 0
    for (i in 1 until size) {
      var bit = size shr 1
      while (j and bit != 0) {
        j = j xor bit
        bit = bit shr 1
      }
      j = j xor bit
      if (i < j) {
        var t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    var len = 2
    while (len <= size) {
      val half = len / 2
      val wr = cos(-2 * PI / len)
      val wi = sin(-2 * PI / len)
      var i = 0
      while (i < size) {
        var cr = 1.0
        var ci = 0.0
        for (k in 0 until half) {
          val a = i + k
          val b = a + half
          val vr = re[b] * cr - im[b] * ci
          val vi = re[b] * ci + im[b] * cr
          re[b] = re[a] - vr; im[b] = im[a] - vi
          re[a] += vr; im[a] += vi
          val nr = cr * wr - ci * wi
          ci = cr * wi + ci * wr
          cr = nr
        }
        i += len
      }
      len = len shl 1
    }
  }
}
