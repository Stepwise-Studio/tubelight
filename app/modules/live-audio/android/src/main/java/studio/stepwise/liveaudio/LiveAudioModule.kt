package studio.stepwise.liveaudio

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Full-duplex voice audio for live conversations (Gemini Live): the mic streams 16 kHz PCM with the phone's echo
 * canceller and noise suppressor (communication mode), while the model's 24 kHz PCM plays on the same voice path, so
 * the user can talk over it. `clear()` drops whatever is queued the instant the model is interrupted.
 * Audio crosses the bridge as base64 so the JS thread does no audio work.
 */
class LiveAudioModule : Module() {
  private val inRate = 16000
  private val outRate = 24000
  private val chunkBytes = 2048 // 64 ms of 16 kHz mono PCM16

  private var audioManager: AudioManager? = null
  private var focus: AudioFocusRequest? = null
  private var record: AudioRecord? = null
  private var track: AudioTrack? = null
  private var echo: AcousticEchoCanceler? = null
  private var noise: NoiseSuppressor? = null
  private val running = AtomicBoolean(false)
  private val muted = AtomicBoolean(false)
  private val queue = LinkedBlockingQueue<ByteArray>()
  private val generation = java.util.concurrent.atomic.AtomicInteger(0)
  @Volatile private var playing = false

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No React context")

  override fun definition() = ModuleDefinition {
    Name("LiveAudio")
    Events("onMic", "onInputLevel", "onOutputLevel", "onPlayback", "onInterruption")

    AsyncFunction("start") { start() }
    Function("stop") { stop() }
    Function("play") { base64: String -> if (running.get()) queue.add(Base64.decode(base64, Base64.NO_WRAP)) }
    Function("clear") { clear() }
    Function("setMuted") { value: Boolean -> muted.set(value) }

    OnDestroy { stop() }
  }

  @SuppressLint("MissingPermission")
  private fun start() {
    if (running.get()) return
    muted.set(false) // a new session always starts listening
    val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    audioManager = am
    am.mode = AudioManager.MODE_IN_COMMUNICATION
    requestFocus(am)
    routeToSpeakerOrHeadset(am)

    val session = am.generateAudioSessionId()
    val outMin = AudioTrack.getMinBufferSize(outRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
    track = AudioTrack(
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build(),
      AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(outRate)
        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build(),
      outMin * 2, AudioTrack.MODE_STREAM, session,
    ).apply { play() }

    val inMin = AudioRecord.getMinBufferSize(inRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val rec = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION, inRate, AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT, maxOf(inMin, chunkBytes * 4),
    )
    if (rec.state != AudioRecord.STATE_INITIALIZED) throw IllegalStateException("The microphone is unavailable")
    if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(rec.audioSessionId)?.apply { enabled = true }
    if (NoiseSuppressor.isAvailable()) noise = NoiseSuppressor.create(rec.audioSessionId)?.apply { enabled = true }
    record = rec
    running.set(true)
    rec.startRecording()

    thread(name = "live-audio-mic") {
      val buf = ByteArray(chunkBytes)
      val spectrum = Spectrum(inRate)
      var filled = 0
      var silent = false
      while (running.get()) {
        // 16 ms reads: the glow hears the voice ~60 times a second; Gemini still gets 64 ms chunks.
        val n = rec.read(buf, filled, minOf(512, buf.size - filled))
        if (n <= 0) continue
        if (muted.get()) {
          filled = 0
          if (!silent) sendEvent("onInputLevel", mapOf("level" to 0.0))
          silent = true
          continue
        }
        silent = false
        spectrum.push(buf, filled, n)
        val (level, bands) = spectrum.read(n / 2)
        sendEvent("onInputLevel", mapOf("level" to level, "bands" to bands))
        filled += n
        if (filled == buf.size) {
          sendEvent("onMic", mapOf("data" to Base64.encodeToString(buf, 0, filled, Base64.NO_WRAP)))
          filled = 0
        }
      }
    }
    thread(name = "live-audio-out") {
      val spectrum = Spectrum(outRate)
      while (running.get()) {
        val data = queue.poll(100, java.util.concurrent.TimeUnit.MILLISECONDS)
        if (data == null) {
          if (playing) setPlaying(false)
          spectrum.clear()
          continue
        }
        val gen = generation.get()
        if (!playing) setPlaying(true)
        // Write in 20 ms slices so a clear() lands within a slice, not after the whole chunk.
        var off = 0
        val slice = outRate / 50 * 2
        while (off < data.size && running.get() && gen == generation.get()) {
          val len = minOf(slice, data.size - off)
          track?.write(data, off, len)
          spectrum.push(data, off, len)
          val (level, bands) = spectrum.read(len / 2)
          sendEvent("onOutputLevel", mapOf("level" to level, "bands" to bands))
          off += len
        }
      }
    }
  }

  private fun setPlaying(value: Boolean) {
    playing = value
    if (!value) sendEvent("onOutputLevel", mapOf("level" to 0.0))
    sendEvent("onPlayback", mapOf("playing" to value))
  }

  /** Barge-in: drop everything queued and whatever the track still holds. */
  private fun clear() {
    generation.incrementAndGet()
    queue.clear()
    track?.let {
      try {
        it.pause(); it.flush(); it.play()
      } catch (e: Exception) {
        Log.w("LiveAudio", "flush failed", e)
      }
    }
  }

  private fun stop() {
    if (!running.getAndSet(false)) return
    queue.clear()
    try { record?.stop() } catch (_: Exception) {}
    record?.release(); record = null
    echo?.release(); echo = null
    noise?.release(); noise = null
    try { track?.stop() } catch (_: Exception) {}
    track?.release(); track = null
    playing = false
    audioManager?.let { am ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) am.clearCommunicationDevice()
      focus?.let { am.abandonAudioFocusRequest(it) }
      am.mode = AudioManager.MODE_NORMAL
    }
  }

  private fun requestFocus(am: AudioManager) {
    val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setOnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
          sendEvent("onInterruption", mapOf("reason" to "focus"))
        }
      }
      .build()
    focus = req
    am.requestAudioFocus(req)
  }

  /** Communication mode defaults to the earpiece: use the loudspeaker unless a headset or Bluetooth is connected. */
  private fun routeToSpeakerOrHeadset(am: AudioManager) {
    val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    val external = outs.firstOrNull {
      it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
        it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
        (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && it.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val target = external ?: am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
      target?.let { am.setCommunicationDevice(it) }
    } else {
      @Suppress("DEPRECATION")
      am.isSpeakerphoneOn = external == null
    }
  }
}
