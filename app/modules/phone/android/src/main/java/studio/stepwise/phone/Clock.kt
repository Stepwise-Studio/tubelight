package studio.stepwise.phone

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/**
 * Tubelight's own alarms and reminders (the Tasks tab's clock). The app hands over the whole list (`set`); it's kept
 * here and every item is armed with AlarmManager, so they ring with Tubelight closed, after a reboot, offline.
 * An alarm rings until stopped (AlarmService: alarm sound on loop, vibration, full screen over the lock screen,
 * Snooze 5 min / Stop); a reminder is a notification with Done and Snooze 10 min. Repeats are worked out here, so the
 * next one is armed as each rings. Reminders marked Done from the notification wait for the app (`takeDone`).
 */
object Clock {
  private const val PREFS = "tl_clock"
  const val FIRE = "studio.stepwise.tubelight.CLOCK_FIRE"
  const val DONE = "studio.stepwise.tubelight.CLOCK_DONE"
  const val SNOOZE = "studio.stepwise.tubelight.CLOCK_SNOOZE"
  const val STOP = "studio.stepwise.tubelight.CLOCK_STOP"
  const val ALARM_CHANNEL = "tl-alarm"
  const val REMINDER_CHANNEL = "tl-reminder"
  private const val ALARM_SNOOZE_MIN = 5
  private const val REMINDER_SNOOZE_MIN = 10

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private fun items(c: Context) = JSONArray(prefs(c).getString("items", "[]"))
  private fun snoozes(c: Context) = JSONObject(prefs(c).getString("snoozes", "{}"))
  fun item(c: Context, id: String): JSONObject? = items(c).let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("id") == id } }

  /** The whole list from the app: [{id, kind: alarm|reminder, title, body, hour, minute, days (0 = Monday), at (ms, 0
   *  for none), repeat, enabled}]. Anything no longer in it is disarmed. */
  fun set(c: Context, json: String) {
    prefs(c).edit().putString("items", JSONArray(json).toString()).apply()
    arm(c)
  }

  fun takeDone(c: Context): List<String> {
    val p = prefs(c)
    val done = JSONArray(p.getString("done", "[]"))
    p.edit().putString("done", "[]").apply()
    return (0 until done.length()).map { done.getString(it) }
  }

  fun canExact(c: Context) = Build.VERSION.SDK_INT < 31 || (c.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms()

  /** When it rings next after `now`, or null (switched off, a one-off that's passed). */
  fun next(o: JSONObject, now: Long): Long? {
    if (!o.optBoolean("enabled", true)) return null
    val at = o.optLong("at", 0)
    val days = o.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.getInt(it) } } ?: emptyList()
    if (o.optString("kind") == "alarm" && days.isNotEmpty()) {
      val cal = Calendar.getInstance().apply {
        timeInMillis = now; set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        set(Calendar.HOUR_OF_DAY, o.optInt("hour")); set(Calendar.MINUTE, o.optInt("minute"))
      }
      for (i in 0..7) {
        if (cal.timeInMillis > now && (cal.get(Calendar.DAY_OF_WEEK) + 5) % 7 in days) return cal.timeInMillis
        cal.add(Calendar.DAY_OF_YEAR, 1)
      }
      return null
    }
    if (at <= 0) return null
    if (at > now) return at
    val step = o.optString("repeat")
    if (step.isEmpty()) return null
    val cal = Calendar.getInstance().apply { timeInMillis = at }
    while (cal.timeInMillis <= now) {
      when (step) {
        "daily" -> cal.add(Calendar.DAY_OF_YEAR, 1)
        "weekdays" -> do cal.add(Calendar.DAY_OF_YEAR, 1) while (cal.get(Calendar.DAY_OF_WEEK) == Calendar.SATURDAY || cal.get(Calendar.DAY_OF_WEEK) == Calendar.SUNDAY)
        "weekly" -> cal.add(Calendar.WEEK_OF_YEAR, 1)
        "monthly" -> cal.add(Calendar.MONTH, 1)
        "yearly" -> cal.add(Calendar.YEAR, 1)
        else -> return null
      }
    }
    return cal.timeInMillis
  }

  private fun pending(c: Context, id: String, flags: Int = PendingIntent.FLAG_UPDATE_CURRENT) =
    PendingIntent.getBroadcast(c, 0, Intent(c, ClockReceiver::class.java).setAction(FIRE).setData(Uri.parse("tlclock://$id")).putExtra("id", id),
      PendingIntent.FLAG_IMMUTABLE or flags)

  /** Disarms everything armed before, then arms each item's next time (and any snooze still to come). */
  fun arm(c: Context) {
    val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val p = prefs(c)
    val before = JSONArray(p.getString("armed", "[]"))
    for (i in 0 until before.length()) pending(c, before.getString(i), PendingIntent.FLAG_NO_CREATE)?.let { am.cancel(it); it.cancel() }
    val now = System.currentTimeMillis()
    val armed = JSONArray()
    val list = items(c)
    val sn = snoozes(c)
    for (i in 0 until list.length()) {
      val o = list.getJSONObject(i)
      val id = o.optString("id")
      val snoozed = sn.optLong(id, 0).takeIf { it > now }
      val at = listOfNotNull(next(o, now), snoozed).minOrNull() ?: continue
      val pi = pending(c, id)
      if (o.optString("kind") == "alarm") {
        val show = c.packageManager.getLaunchIntentForPackage(c.packageName)?.let {
          PendingIntent.getActivity(c, 1, it.setData(Uri.parse("tubelight://tasks?view=clock")), PendingIntent.FLAG_IMMUTABLE)
        }
        am.setAlarmClock(AlarmManager.AlarmClockInfo(at, show), pi)
      } else if (canExact(c)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
      armed.put(id)
    }
    // Snoozes that have rung (or whose item is gone) are forgotten.
    val keep = JSONObject()
    for (k in sn.keys()) if (sn.optLong(k) > now && item(c, k) != null) keep.put(k, sn.optLong(k))
    p.edit().putString("armed", armed.toString()).putString("snoozes", keep.toString()).apply()
  }

  fun snooze(c: Context, id: String) {
    val o = item(c, id) ?: return
    val min = if (o.optString("kind") == "alarm") ALARM_SNOOZE_MIN else REMINDER_SNOOZE_MIN
    prefs(c).edit().putString("snoozes", snoozes(c).put(id, System.currentTimeMillis() + min * 60_000L).toString()).apply()
    arm(c)
  }

  fun markDone(c: Context, id: String) {
    val p = prefs(c)
    p.edit().putString("done", JSONArray(p.getString("done", "[]")).put(id).toString()).apply()
  }

  fun icon(c: Context) = c.resources.getIdentifier("notification_icon", "drawable", c.packageName).takeIf { it != 0 } ?: c.applicationInfo.icon

  fun openApp(c: Context, code: Int): PendingIntent? = c.packageManager.getLaunchIntentForPackage(c.packageName)?.let {
    PendingIntent.getActivity(c, code, it.setData(Uri.parse("tubelight://tasks?view=clock")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  fun action(c: Context, act: String, id: String, code: Int): PendingIntent =
    PendingIntent.getBroadcast(c, code, Intent(c, ClockReceiver::class.java).setAction(act).setData(Uri.parse("tlclock://$act/$id")).putExtra("id", id),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  fun remind(c: Context, o: JSONObject) {
    val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(REMINDER_CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Your reminders, at their time"; enableVibration(true)
    })
    val id = o.optString("id")
    val code = id.hashCode()
    nm.notify(code, Notification.Builder(c, REMINDER_CHANNEL)
      .setSmallIcon(icon(c)).setContentTitle(o.optString("title")).setContentText(o.optString("body").ifBlank { null })
      .setCategory(Notification.CATEGORY_REMINDER).setContentIntent(openApp(c, code)).setAutoCancel(true)
      .addAction(Notification.Action.Builder(null, "Done", action(c, DONE, id, code)).build())
      .addAction(Notification.Action.Builder(null, "Snooze 10 min", action(c, SNOOZE, id, code)).build())
      .build())
  }
}

class ClockReceiver : BroadcastReceiver() {
  override fun onReceive(c: Context, intent: Intent) {
    val id = intent.getStringExtra("id") ?: ""
    when (intent.action) {
      Clock.FIRE -> {
        val o = Clock.item(c, id)
        if (o != null) {
          if (o.optString("kind") == "alarm") {
            val s = Intent(c, AlarmService::class.java).setAction(Clock.FIRE).putExtra("id", id)
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(s) else c.startService(s)
          } else Clock.remind(c, o)
        }
        Clock.arm(c) // the next one (repeats), and this one's snooze is used up
      }
      Clock.DONE -> {
        (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id.hashCode())
        if (Clock.item(c, id)?.optString("repeat").isNullOrEmpty()) Clock.markDone(c, id)
      }
      Clock.SNOOZE -> {
        (c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(id.hashCode())
        Clock.snooze(c, id)
      }
    }
  }
}

/** A reboot, an app update, a new time or zone: arm everything again. */
class ClockBoot : BroadcastReceiver() {
  override fun onReceive(c: Context, intent: Intent) = Clock.arm(c)
}

/** A ringing alarm: in the foreground, sound on loop on the alarm stream, vibrating, full screen over the lock screen,
 *  until Stop or Snooze (or ten minutes). */
class AlarmService : Service() {
  private var player: MediaPlayer? = null
  private var ringing: String? = null
  private val quiet = Handler(Looper.getMainLooper())

  override fun onBind(i: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val id = intent?.getStringExtra("id") ?: ringing ?: ""
    when (intent?.action) {
      Clock.STOP -> { finish(); return START_NOT_STICKY }
      Clock.SNOOZE -> { Clock.snooze(this, id); finish(); return START_NOT_STICKY }
    }
    val o = Clock.item(this, id)
    if (o == null) { finish(); return START_NOT_STICKY }
    ringing = id
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    nm.createNotificationChannel(NotificationChannel(Clock.ALARM_CHANNEL, "Alarms", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "Your alarms, ringing"; setSound(null, null); enableVibration(false)
      lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    })
    val time = String.format("%02d:%02d", o.optInt("hour"), o.optInt("minute"))
    val full = PendingIntent.getActivity(this, 7, Intent(this, AlarmActivity::class.java).putExtra("id", id)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val n = Notification.Builder(this, Clock.ALARM_CHANNEL)
      .setSmallIcon(Clock.icon(this)).setContentTitle(o.optString("title").ifBlank { "Alarm" }).setContentText(time)
      .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC).setOngoing(true)
      .setFullScreenIntent(full, true).setContentIntent(full)
      .addAction(Notification.Action.Builder(null, "Snooze", stopper(Clock.SNOOZE, id)).build())
      .addAction(Notification.Action.Builder(null, "Stop", stopper(Clock.STOP, id)).build())
      .build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(NOTE, n)
    ring()
    quiet.removeCallbacksAndMessages(null)
    quiet.postDelayed({ finish() }, 10 * 60_000L)
    return START_NOT_STICKY
  }

  private fun stopper(act: String, id: String) = PendingIntent.getService(this, act.hashCode(),
    Intent(this, AlarmService::class.java).setAction(act).putExtra("id", id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun ring() {
    player?.release()
    val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
    player = runCatching {
      MediaPlayer().apply {
        setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        setDataSource(this@AlarmService, uri); isLooping = true; prepare(); start()
      }
    }.getOrNull()
    val v = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    v.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 500), 0), AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build())
  }

  private fun finish() {
    quiet.removeCallbacksAndMessages(null)
    player?.runCatching { stop(); release() }
    player = null
    (getSystemService(Context.VIBRATOR_SERVICE) as Vibrator).cancel()
    ringing = null
    AlarmActivity.current?.finish()
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    player?.runCatching { release() }
    super.onDestroy()
  }

  companion object { const val NOTE = 4712 }
}

/** The ringing alarm, full screen over the lock screen: the time, its name, Snooze and Stop. */
class AlarmActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    current = this
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
    else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    val id = intent.getStringExtra("id") ?: ""
    val o = Clock.item(this, id)
    val d = resources.displayMetrics.density
    fun dp(v: Int) = (v * d).toInt()
    fun text(s: String, size: Float, color: Int, face: Typeface) = TextView(this).apply {
      this.text = s; textSize = size; setTextColor(color); typeface = face; gravity = Gravity.CENTER
    }
    fun button(s: String, solid: Boolean, act: String) = TextView(this).apply {
      text = s; textSize = 18f; gravity = Gravity.CENTER; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setTextColor(if (solid) Color.parseColor("#0b0b0c") else Color.WHITE)
      background = GradientDrawable().apply { cornerRadius = dp(32).toFloat(); setColor(if (solid) Color.WHITE else Color.parseColor("#26262a")) }
      setOnClickListener { startService(Intent(this@AlarmActivity, AlarmService::class.java).setAction(act).putExtra("id", id)); finish() }
    }
    val now = Date()
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL; setBackgroundColor(Color.parseColor("#0b0b0c"))
      setPadding(dp(28), dp(120), dp(28), dp(56))
      addView(text(o?.optString("title")?.ifBlank { null } ?: "Alarm", 20f, Color.parseColor("#a1a1aa"), Typeface.create("sans-serif", Typeface.NORMAL)))
      addView(text(DateFormat.getTimeInstance(DateFormat.SHORT).format(now), 84f, Color.WHITE, Typeface.create("sans-serif-light", Typeface.NORMAL)),
        LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(8) })
      addView(text(DateFormat.getDateInstance(DateFormat.FULL).format(now), 16f, Color.parseColor("#71717a"), Typeface.create("sans-serif", Typeface.NORMAL)))
      addView(android.view.View(this@AlarmActivity), LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
      addView(button("Snooze 5 min", false, Clock.SNOOZE), LinearLayout.LayoutParams(MATCH_PARENT, dp(64)))
      addView(button("Stop", true, Clock.STOP), LinearLayout.LayoutParams(MATCH_PARENT, dp(64)).apply { topMargin = dp(12) })
    }
    setContentView(root)
  }

  // Back doesn't stop the alarm by accident.
  @Deprecated("Back does nothing while ringing")
  override fun onBackPressed() {}

  override fun onDestroy() {
    if (current === this) current = null
    super.onDestroy()
  }

  companion object { var current: AlarmActivity? = null }
}
