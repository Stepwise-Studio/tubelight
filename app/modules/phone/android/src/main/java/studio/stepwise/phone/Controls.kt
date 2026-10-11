package studio.stepwise.phone

import android.Manifest
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.session.MediaSessionManager
import android.os.SystemClock
import android.provider.CalendarContract
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import android.view.KeyEvent
import expo.modules.kotlin.exception.CodedException

/**
 * What the phone teammate can switch and read directly (Gemini's "utilities"), within what Android lets an ordinary
 * app do: the flashlight, volume, Do Not Disturb (with policy access), brightness (with "modify system settings"),
 * media keys; contacts looked up on the phone (names never leave it); and, for its status, the calendar's next day and
 * a half, recent calls and what's playing. Wi-Fi, Bluetooth, mobile data, airplane mode and battery saver can't be
 * switched by apps since Android 10: their settings panels open instead.
 */
object Controls {
  fun granted(c: Context, p: String) = c.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

  fun flashlight(c: Context, on: Boolean): String {
    val cm = c.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
      ?: throw CodedException("This phone has no flashlight.")
    cm.setTorchMode(id, on)
    return if (on) "Flashlight on" else "Flashlight off"
  }

  private val STREAMS = mapOf("media" to AudioManager.STREAM_MUSIC, "music" to AudioManager.STREAM_MUSIC, "ring" to AudioManager.STREAM_RING,
    "ringtone" to AudioManager.STREAM_RING, "alarm" to AudioManager.STREAM_ALARM, "notification" to AudioManager.STREAM_NOTIFICATION,
    "call" to AudioManager.STREAM_VOICE_CALL)

  /** `level` 0–100 of the stream's range. Ring or notification at 0 means silent, which needs Do Not Disturb access. */
  fun volume(c: Context, which: String, level: Int): String {
    val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val name = STREAMS.keys.firstOrNull { which.lowercase().contains(it) } ?: "media"
    val stream = STREAMS.getValue(name)
    val max = am.getStreamMaxVolume(stream)
    try {
      am.setStreamVolume(stream, Math.round(max * level.coerceIn(0, 100) / 100f), AudioManager.FLAG_SHOW_UI)
    } catch (_: SecurityException) {
      throw CodedException("Silencing the ringer needs Do Not Disturb access: Profile → Phone assistant.")
    }
    return "${name.replaceFirstChar { it.uppercase() }} volume ${level.coerceIn(0, 100)}%"
  }

  fun canDnd(c: Context) = (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).isNotificationPolicyAccessGranted

  fun dnd(c: Context, on: Boolean): String {
    val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (!nm.isNotificationPolicyAccessGranted) throw CodedException("Allow Do Not Disturb access first: Profile → Phone assistant.")
    nm.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
    return if (on) "Do Not Disturb on" else "Do Not Disturb off"
  }

  fun brightness(c: Context, level: Int): String {
    if (!Settings.System.canWrite(c)) throw CodedException("Allow Tubelight to change brightness first: Profile → Phone assistant.")
    Settings.System.putInt(c.contentResolver, Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL)
    Settings.System.putInt(c.contentResolver, Settings.System.SCREEN_BRIGHTNESS, Math.round(255 * level.coerceIn(1, 100) / 100f))
    return "Brightness ${level.coerceIn(1, 100)}%"
  }

  /**
   * Play, pause, skip. With notification access it tells the player itself (the app that last had music up, even if
   * nothing has played since the phone started, when media keys go nowhere); otherwise it sends the media keys.
   */
  fun media(c: Context, what: String): String {
    val session = try {
      (c.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager)
        .getActiveSessions(ComponentName(c, NotificationsService::class.java)).firstOrNull()
    } catch (_: SecurityException) { null }
    if (session != null) {
      val t = session.transportControls
      val app = try { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(session.packageName, 0)).toString() } catch (_: Exception) { session.packageName }
      return when {
        "next" in what || "skip" in what -> { t.skipToNext(); "Next track in $app" }
        "prev" in what || "back" in what -> { t.skipToPrevious(); "Previous track in $app" }
        "pause" in what -> { t.pause(); "Paused $app" }
        "stop" in what -> { t.stop(); "Stopped $app" }
        "play" in what || "resume" in what -> { t.play(); "Playing in $app" }
        else -> if (session.playbackState?.state == android.media.session.PlaybackState.STATE_PLAYING) { t.pause(); "Paused $app" } else { t.play(); "Playing in $app" }
      }
    }
    val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val (code, said) = when {
      "next" in what || "skip" in what -> KeyEvent.KEYCODE_MEDIA_NEXT to "Next track"
      "prev" in what || "back" in what -> KeyEvent.KEYCODE_MEDIA_PREVIOUS to "Previous track"
      "pause" in what -> KeyEvent.KEYCODE_MEDIA_PAUSE to "Paused"
      "stop" in what -> KeyEvent.KEYCODE_MEDIA_STOP to "Stopped"
      "play" in what || "resume" in what -> KeyEvent.KEYCODE_MEDIA_PLAY to "Playing"
      else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "Play/pause"
    }
    val t = SystemClock.uptimeMillis()
    am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
    am.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
    return said
  }

  /** A contact by name, looked up on the phone: exact name, then starting with it, then containing it; starred and
   *  default numbers first. Null when nobody matches. */
  fun contact(c: Context, name: String): Pair<String, String>? {
    if (!granted(c, Manifest.permission.READ_CONTACTS)) throw CodedException("Allow contacts first: Profile → Phone assistant.")
    val want = name.trim().lowercase()
    val rows = mutableListOf<Triple<String, String, Int>>()
    c.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER,
        ContactsContract.CommonDataKinds.Phone.STARRED, ContactsContract.CommonDataKinds.Phone.IS_SUPER_PRIMARY),
      "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?", arrayOf("%$want%"), null)?.use { cur ->
      while (cur.moveToNext()) {
        val n = cur.getString(0) ?: continue
        val num = cur.getString(1) ?: continue
        val l = n.lowercase()
        val score = (if (l == want) 100 else if (l.startsWith(want)) 50 else 10) + cur.getInt(2) * 5 + cur.getInt(3) * 2
        rows.add(Triple(n, num, score))
      }
    }
    return rows.maxByOrNull { it.third }?.let { it.first to it.second }
  }

  /** Events from now to the end of tomorrow (with calendar access). */
  fun calendar(c: Context): List<Map<String, Any?>>? {
    if (!granted(c, Manifest.permission.READ_CALENDAR)) return null
    val now = System.currentTimeMillis()
    val cal = java.util.Calendar.getInstance().apply {
      add(java.util.Calendar.DAY_OF_YEAR, 2); set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
    }
    val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
      android.content.ContentUris.appendId(it, now - 3600_000); android.content.ContentUris.appendId(it, cal.timeInMillis)
    }.build()
    val out = mutableListOf<Map<String, Any?>>()
    c.contentResolver.query(uri, arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END,
      CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.EVENT_LOCATION), null, null, "${CalendarContract.Instances.BEGIN} ASC")?.use { cur ->
      while (cur.moveToNext() && out.size < 25) {
        out.add(mapOf("title" to cur.getString(0), "start" to cur.getLong(1).toDouble(), "end" to cur.getLong(2).toDouble(),
          "all_day" to (cur.getInt(3) == 1), "place" to cur.getString(4)))
      }
    }
    return out
  }

  /** The last calls (with call-log access): who, in or out or missed, when. */
  fun calls(c: Context): List<Map<String, Any?>>? {
    if (!granted(c, Manifest.permission.READ_CALL_LOG)) return null
    val out = mutableListOf<Map<String, Any?>>()
    c.contentResolver.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls.CACHED_NAME, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
      CallLog.Calls.DATE, CallLog.Calls.DURATION), null, null, "${CallLog.Calls.DATE} DESC")?.use { cur ->
      while (cur.moveToNext() && out.size < 12) {
        val type = when (cur.getInt(2)) { CallLog.Calls.INCOMING_TYPE -> "in"; CallLog.Calls.OUTGOING_TYPE -> "out"; CallLog.Calls.MISSED_TYPE -> "missed"; else -> "other" }
        out.add(mapOf("name" to cur.getString(0), "number" to cur.getString(1), "type" to type, "at" to cur.getLong(3).toDouble(), "seconds" to cur.getLong(4).toDouble()))
      }
    }
    return out
  }

  /** What's playing (needs notification access, which lets Tubelight see media sessions). */
  fun nowPlaying(c: Context): Map<String, Any?>? = try {
    val msm = c.getSystemService(Context.MEDIA_SESSION_SERVICE) as MediaSessionManager
    msm.getActiveSessions(ComponentName(c, NotificationsService::class.java)).firstOrNull()?.let { s ->
      val md = s.metadata
      mapOf("app" to (try { c.packageManager.getApplicationLabel(c.packageManager.getApplicationInfo(s.packageName, 0)).toString() } catch (_: Exception) { s.packageName }),
        "title" to md?.getString(android.media.MediaMetadata.METADATA_KEY_TITLE),
        "artist" to md?.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST),
        "playing" to (s.playbackState?.state == android.media.session.PlaybackState.STATE_PLAYING))
    }
  } catch (_: SecurityException) { null }
}
