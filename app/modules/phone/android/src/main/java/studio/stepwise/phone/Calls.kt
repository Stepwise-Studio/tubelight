package studio.stepwise.phone

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import android.service.notification.StatusBarNotification
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import expo.modules.kotlin.exception.CodedException

/**
 * The call stand-in's phone side: when a call rings (seen through notification access, so no extra role), Tubelight
 * posts "<name> is calling: let my assistant answer". Tapping it opens the assistant panel, which answers, puts the call
 * on speaker and lets Gemini Live talk to the caller (src/components/voice/call-stand-in.tsx).
 *
 * Hearing a call needs Tubelight's accessibility service (Android's rule for ordinary apps), and UPI apps refuse to run
 * while it's on. So it's switched on only for the call and off after: that needs WRITE_SECURE_SETTINGS, granted once
 * over USB (`adb shell pm grant studio.stepwise.tubelight android.permission.WRITE_SECURE_SETTINGS`).
 */
object Calls {
  private const val CHANNEL = "tl-standin"
  private const val ID = 4712
  private val DIALERS = setOf("com.samsung.android.incallui", "com.android.incallui", "com.google.android.dialer", "com.android.dialer")
  private const val SERVICE = "studio.stepwise.phone.AppsService"

  fun on(c: Context) = c.getSharedPreferences("tubelight.standin", Context.MODE_PRIVATE).getBoolean("on", false)
  fun set(c: Context, value: Boolean) { c.getSharedPreferences("tubelight.standin", Context.MODE_PRIVATE).edit().putBoolean("on", value).apply() }

  fun canAnswer(c: Context) = Controls.granted(c, Manifest.permission.ANSWER_PHONE_CALLS)
  fun canSwitchAccess(c: Context) = Controls.granted(c, "android.permission.WRITE_SECURE_SETTINGS")

  /** A ringing call's notification (from the phone app): offer the stand-in. */
  fun seen(c: Context, sbn: StatusBarNotification) {
    val n = sbn.notification
    if (!on(c) || sbn.packageName !in DIALERS || n.category != Notification.CATEGORY_CALL) return
    if (state(c) != "ringing") return
    val ex = n.extras
    val caller = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty().ifBlank { "Someone" }
    val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Answer calls for me", NotificationManager.IMPORTANCE_HIGH)
      .apply { description = "When a call rings: let your assistant answer it" })
    val open = Intent().setClassName(c.packageName, "${c.packageName}.AssistActivity")
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      .putExtra("tl_call", "1").putExtra("tl_caller", caller)
    val pi = PendingIntent.getActivity(c, ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val icon = c.resources.getIdentifier("notification_icon", "drawable", c.packageName).takeIf { it != 0 } ?: c.applicationInfo.icon
    nm.notify(ID, Notification.Builder(c, CHANNEL).setSmallIcon(icon).setContentTitle("$caller is calling")
      .setContentText("Let your assistant answer").setCategory(Notification.CATEGORY_CALL).setContentIntent(pi)
      .addAction(Notification.Action.Builder(null, "Let my assistant answer", pi).build())
      .setAutoCancel(true).setTimeoutAfter(45_000).build())
  }

  fun clear(c: Context) = (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(ID)

  @Suppress("DEPRECATION")
  fun state(c: Context): String = when ((c.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager).callState) {
    TelephonyManager.CALL_STATE_RINGING -> "ringing"
    TelephonyManager.CALL_STATE_OFFHOOK -> "active"
    else -> "idle"
  }

  @Suppress("MissingPermission")
  fun answer(c: Context) {
    if (!canAnswer(c)) throw CodedException("Allow Tubelight to answer calls: Profile → Phone assistant.")
    (c.getSystemService(Context.TELECOM_SERVICE) as TelecomManager).acceptRingingCall()
  }

  @Suppress("MissingPermission", "DEPRECATION")
  fun hangUp(c: Context) {
    if (!canAnswer(c)) throw CodedException("Allow Tubelight to answer calls: Profile → Phone assistant.")
    (c.getSystemService(Context.TELECOM_SERVICE) as TelecomManager).endCall()
  }

  private var volumeBefore = -1

  /** The call on the speaker, loud (or back to the earpiece at the volume it had); true when it took. */
  @Suppress("DEPRECATION")
  fun speaker(c: Context, on: Boolean): Boolean {
    val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val stream = AudioManager.STREAM_VOICE_CALL
    if (on && volumeBefore < 0) volumeBefore = am.getStreamVolume(stream)
    if (Build.VERSION.SDK_INT >= 31) {
      if (on) am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }?.let { am.setCommunicationDevice(it) }
      else am.clearCommunicationDevice()
    }
    am.isSpeakerphoneOn = on
    if (on) am.setStreamVolume(stream, am.getStreamMaxVolume(stream), 0)
    else if (volumeBefore >= 0) { am.setStreamVolume(stream, volumeBefore, 0); volumeBefore = -1 }
    return am.isSpeakerphoneOn == on
  }

  /** Tubelight's accessibility service on for the call, off after (UPI apps refuse to run while it's on). */
  fun access(c: Context, on: Boolean): Boolean {
    if (!canSwitchAccess(c)) return Apps.on(c)
    val me = "${c.packageName}/$SERVICE"
    val cur = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
      .split(':').filter { it.isNotBlank() && it != me }
    Settings.Secure.putString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, (if (on) cur + me else cur).joinToString(":"))
    if (on) Settings.Secure.putInt(c.contentResolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
    return on
  }
}
