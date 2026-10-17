package studio.stepwise.phone

import android.animation.ValueAnimator
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
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
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

  /** `minutes`: picked on the ringing screen (hold Snooze); else 5 for an alarm, 10 for a reminder. */
  fun snooze(c: Context, id: String, minutes: Int = 0) {
    val o = item(c, id) ?: return
    val min = minutes.takeIf { it > 0 } ?: if (o.optString("kind") == "alarm") ALARM_SNOOZE_MIN else REMINDER_SNOOZE_MIN
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
      Clock.SNOOZE -> { Clock.snooze(this, id, intent.getIntExtra("minutes", 0)); finish(); return START_NOT_STICKY }
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
    val full = PendingIntent.getActivity(this, 7, AlarmActivity.intent(this, o, false)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val n = Notification.Builder(this, Clock.ALARM_CHANNEL)
      .setSmallIcon(Clock.icon(this)).setContentTitle(o.optString("title").ifBlank { "Alarm" }).setContentText(time)
      .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC).setOngoing(true)
      .setFullScreenIntent(full, true).setContentIntent(full)
      .addAction(Notification.Action.Builder(null, "Snooze", stopper(Clock.SNOOZE, id)).build())
      .addAction(Notification.Action.Builder(null, "Stop", stopper(Clock.STOP, id)).build())
      .build()
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) else startForeground(NOTE, n)
    ring(o.optString("sound"))
    quiet.removeCallbacksAndMessages(null)
    quiet.postDelayed({ finish() }, 10 * 60_000L)
    return START_NOT_STICKY
  }

  private fun stopper(act: String, id: String) = PendingIntent.getService(this, act.hashCode(),
    Intent(this, AlarmService::class.java).setAction(act).putExtra("id", id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  /** The alarm's own tone, else the phone's alarm sound (also if its tone was removed from the phone). */
  private fun ring(sound: String) {
    player?.release()
    val fallback = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
    fun play(uri: Uri) = MediaPlayer().apply {
      setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
      setDataSource(this@AlarmService, uri); isLooping = true; prepare(); start()
    }
    player = runCatching { play(if (sound.isNotBlank()) Uri.parse(sound) else fallback) }.recoverCatching { play(fallback) }.getOrNull()
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

/** The ringing alarm, full screen over the lock screen (also its preview from the alarm editor, which only closes).
 *  A living background: deep blue into black with three soft lights (blue, indigo, cyan) drifting slowly on their own
 *  paths, and a glow breathing behind the time. In the middle, the alarm's name (if it has one), the time big in Inter
 *  Display with AM/PM beside it, the date. At the bottom a frosted Snooze (hold it for 5 / 10 / 15 / 30 minutes) and a
 *  slide-to-stop track that fills as the thumb moves. Only transforms and alpha animate: two animators drive it all. */
class AlarmActivity : Activity() {
  private val animators = mutableListOf<ValueAnimator>()

  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    current = this
    if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
    else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS)
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT
    val id = intent.getStringExtra("id") ?: ""
    val preview = intent.getBooleanExtra("preview", false)
    val title = intent.getStringExtra("title")?.ifBlank { null }
    val d = resources.displayMetrics.density
    fun dp(v: Int) = (v * d).toInt()
    fun font(name: String, fallback: String) = runCatching { Typeface.createFromAsset(assets, "fonts/$name.ttf") }.getOrElse { Typeface.create(fallback, Typeface.NORMAL) }
    val regular = font("InterDisplay-Regular", "sans-serif")
    val medium = font("InterDisplay-Medium", "sans-serif-medium")
    fun white(a: Int) = Color.argb(a, 255, 255, 255)
    fun text(s: String, size: Float, alpha: Int, face: Typeface, spacing: Float = 0f) = TextView(this).apply {
      this.text = s; textSize = size; setTextColor(white(alpha)); typeface = face; gravity = Gravity.CENTER
      letterSpacing = spacing; includeFontPadding = false
    }
    fun frosted(radius: Int) = GradientDrawable().apply { cornerRadius = radius.toFloat(); setColor(white(30)); setStroke(dp(1), white(40)) }
    fun snooze(min: Int) {
      if (!preview) startService(Intent(this, AlarmService::class.java).setAction(Clock.SNOOZE).putExtra("id", id).putExtra("minutes", min))
      finish()
    }
    fun stop() {
      if (!preview) startService(Intent(this, AlarmService::class.java).setAction(Clock.STOP).putExtra("id", id))
      finish()
    }

    val root = FrameLayout(this).apply {
      background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
        intArrayOf(Color.parseColor("#1a3591"), Color.parseColor("#0c1a4a"), Color.parseColor("#05070f"), Color.parseColor("#030406"), Color.parseColor("#030406")))
    }
    // The lights: big soft radial blobs drifting on slow, different loops (one animator moves all three).
    fun blob(r: Int, g: Int, b: Int, a: Int, size: Int) = android.view.View(this).apply {
      background = GradientDrawable().apply {
        gradientType = GradientDrawable.RADIAL_GRADIENT; gradientRadius = size / 2f
        colors = intArrayOf(Color.argb(a, r, g, b), Color.argb(0, r, g, b))
      }
    }
    val w = resources.displayMetrics.widthPixels
    // Each light fades out within its own square (radius = half its side), so no edge ever shows.
    // They stay in the upper part, so the lower half is near black (as in the reference).
    val lights = listOf(blob(59, 130, 246, 110, dp(500)) to floatArrayOf(-0.25f, -0.35f, 0.18f, 0.08f, 1f),
      blob(99, 102, 241, 95, dp(500)) to floatArrayOf(0.35f, -0.20f, 0.22f, 0.08f, 1.6f),
      blob(34, 211, 238, 55, dp(500)) to floatArrayOf(0.05f, 0.05f, 0.20f, 0.06f, 0.7f))
    for ((v, _) in lights) root.addView(v, FrameLayout.LayoutParams(dp(500), dp(500)))
    animators += ValueAnimator.ofFloat(0f, (2 * Math.PI).toFloat()).apply {
      duration = 22_000; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
      addUpdateListener { a ->
        val t = a.animatedValue as Float
        for ((v, p) in lights) { // p: x, y (fractions of the width), swing x, swing y, speed
          v.translationX = w * (p[0] + p[2] * kotlin.math.sin(t * p[4])) - dp(250) + w / 2f
          v.translationY = w * (p[1] + p[3] * kotlin.math.cos(t * p[4] * 0.8f)) + dp(40)
        }
      }
      start()
    }

    val now = Date()
    val h24 = android.text.format.DateFormat.is24HourFormat(this)
    // The glow behind the time, breathing.
    val halo = blob(147, 197, 253, 70, dp(360))
    val clock = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
      if (title != null) addView(text(title, 22f, 235, medium).apply { maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END },
        LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(6) })
      addView(LinearLayout(this@AlarmActivity).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM
        addView(text(java.text.SimpleDateFormat(if (h24) "HH:mm" else "h:mm", java.util.Locale.getDefault()).format(now), 104f, 255, regular, -0.04f)
          .apply { isSingleLine = true })
        if (!h24) addView(text(java.text.SimpleDateFormat("a", java.util.Locale.getDefault()).format(now).uppercase(), 24f, 190, medium),
          LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { leftMargin = dp(8); bottomMargin = dp(18) })
      }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
      addView(text(java.text.SimpleDateFormat("EEEE, d MMMM", java.util.Locale.getDefault()).format(now), 17f, 160, regular),
        LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(2) })
    }
    val middle = FrameLayout(this).apply {
      clipChildren = false
      addView(halo, FrameLayout.LayoutParams(dp(360), dp(360)).apply { gravity = Gravity.CENTER })
      addView(clock, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { gravity = Gravity.CENTER })
    }
    animators += ValueAnimator.ofFloat(0.45f, 1f).apply {
      duration = 2600; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE
      interpolator = android.view.animation.AccelerateDecelerateInterpolator()
      addUpdateListener { halo.alpha = it.animatedValue as Float; halo.scaleX = 0.9f + 0.1f * halo.alpha; halo.scaleY = halo.scaleX }
      start()
    }

    // Hold Snooze: how long, as a row of frosted chips that rises above it.
    val choices = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL; visibility = android.view.View.GONE; alpha = 0f
      for ((i, m) in listOf(5, 10, 15, 30).withIndex()) addView(text("$m min", 16f, 240, medium).apply {
        background = frosted(dp(24)); setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); snooze(m) }
      }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { if (i > 0) leftMargin = dp(8) })
    }
    val snoozeButton = text("Snooze  ·  5 min", 17f, 240, medium).apply {
      background = frosted(dp(30))
      setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); snooze(5) }
      setOnLongClickListener {
        performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
        choices.visibility = android.view.View.VISIBLE; choices.translationY = dp(8).toFloat()
        choices.animate().alpha(1f).translationY(0f).setDuration(220).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start()
        text = "Snooze for…"
        true
      }
    }
    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL; clipChildren = false; clipToPadding = false
      setPadding(dp(24), dp(56), dp(24), dp(40))
      addView(middle, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
      addView(choices, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = dp(12) })
      addView(snoozeButton, LinearLayout.LayoutParams(MATCH_PARENT, dp(60)))
      addView(slider(dp(72), ::dp, medium) { stop() }, LinearLayout.LayoutParams(MATCH_PARENT, dp(72)).apply { topMargin = dp(14) })
    }
    root.addView(column, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    setContentView(root)
    // In: the content rises a little and fades up.
    column.alpha = 0f; column.translationY = dp(16).toFloat()
    column.animate().alpha(1f).translationY(0f).setDuration(420).setInterpolator(android.view.animation.DecelerateInterpolator(2f)).start()
  }

  /** "Slide to stop": a frosted track that fills behind the white thumb as it moves; past three quarters it stops,
   *  else it springs back. */
  private fun slider(h: Int, dp: (Int) -> Int, face: Typeface, onStop: () -> Unit): FrameLayout {
    val pad = dp(6)
    val size = h - pad * 2
    val track = FrameLayout(this).apply {
      background = GradientDrawable().apply { cornerRadius = h / 2f; setColor(Color.argb(22, 255, 255, 255)); setStroke(dp(1), Color.argb(36, 255, 255, 255)) }
      clipToOutline = true
    }
    // The fill: the whole track's shape, light, revealed from the left edge up to the thumb's centre (clip bounds:
    // nothing lays out while sliding). The hint is drawn twice, white and dark; the dark copy shows only over the fill.
    val fill = android.view.View(this).apply {
      background = GradientDrawable().apply { cornerRadius = h / 2f; setColor(Color.argb(235, 219, 234, 254)) }
    }
    track.addView(fill, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    fun hintView(color: Int) = TextView(this).apply {
      text = "Slide to stop"; textSize = 17f; typeface = face; setTextColor(color); gravity = Gravity.CENTER
    }
    val hint = hintView(Color.argb(170, 255, 255, 255))
    val hintDark = hintView(Color.parseColor("#0c1a4a"))
    track.addView(hint, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    track.addView(hintDark, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
    val thumb = FrameLayout(this).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
      elevation = dp(4).toFloat()
      addView(android.view.View(this@AlarmActivity).apply {
        background = GradientDrawable().apply { cornerRadius = dp(4).toFloat(); setColor(Color.parseColor("#102466")) }
      }, FrameLayout.LayoutParams(dp(18), dp(18)).apply { gravity = Gravity.CENTER })
    }
    track.addView(thumb, FrameLayout.LayoutParams(size, size).apply { leftMargin = pad; topMargin = pad })
    val clip = android.graphics.Rect()
    fun follow(x: Float) {
      val edge = if (x <= 0f) 0 else (pad + x + size / 2f).toInt() // at rest: nothing filled
      clip.set(0, 0, edge, track.height)
      fill.clipBounds = clip
      hintDark.clipBounds = clip
    }
    track.post { follow(0f) }
    var downX = 0f
    var done = false
    thumb.setOnTouchListener { v, e ->
      val max = (track.width - size - pad * 2).toFloat()
      when (e.actionMasked) {
        android.view.MotionEvent.ACTION_DOWN -> { downX = e.rawX - v.translationX; v.animate().cancel(); true }
        android.view.MotionEvent.ACTION_MOVE -> {
          v.translationX = (e.rawX - downX).coerceIn(0f, max)
          follow(v.translationX)
          true
        }
        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
          if (!done && v.translationX > max * 0.75f) {
            done = true
            v.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
            v.animate().translationX(max).setDuration(120).setUpdateListener { follow(v.translationX) }.withEndAction(onStop).start()
          } else {
            v.animate().translationX(0f).setDuration(320).setInterpolator(android.view.animation.OvershootInterpolator(1.2f))
              .setUpdateListener { follow(v.translationX) }.start()
          }
          true
        }
        else -> false
      }
    }
    return track
  }

  // Back doesn't stop the alarm by accident (a preview just closes).
  @Deprecated("Back does nothing while ringing")
  override fun onBackPressed() { if (intent.getBooleanExtra("preview", false)) finish() }

  override fun onDestroy() {
    animators.forEach { it.cancel() }
    if (current === this) current = null
    super.onDestroy()
  }

  companion object {
    var current: AlarmActivity? = null

    /** An alarm item ({id, title}) on its screen; `preview` from the editor. */
    fun intent(c: Context, o: JSONObject, preview: Boolean): Intent =
      Intent(c, AlarmActivity::class.java).putExtra("id", o.optString("id")).putExtra("title", o.optString("title")).putExtra("preview", preview)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
  }
}

/** The phone's alarm tones for the alarm editor, and a short preview of one (on the alarm stream). */
object Tones {
  private var playing: android.media.Ringtone? = null
  private val stopper = Handler(Looper.getMainLooper())

  /** The phone's alarm tones, then its ringtones (some phones ship only two alarm tones). */
  fun list(c: Context): List<Map<String, String>> {
    val out = mutableListOf<Map<String, String>>()
    for ((type, kind) in listOf(RingtoneManager.TYPE_ALARM to "alarm", RingtoneManager.TYPE_RINGTONE to "ringtone")) {
      val rm = RingtoneManager(c).apply { setType(type) }
      runCatching {
        rm.cursor.use { cur -> while (cur.moveToNext()) out.add(mapOf("title" to cur.getString(RingtoneManager.TITLE_COLUMN_INDEX), "uri" to rm.getRingtoneUri(cur.position).toString(), "kind" to kind)) }
      }
    }
    return out.distinctBy { it["uri"] }
  }

  fun preview(c: Context, uri: String) {
    stop()
    val u = if (uri.isBlank()) RingtoneManager.getActualDefaultRingtoneUri(c, RingtoneManager.TYPE_ALARM) ?: return else Uri.parse(uri)
    playing = RingtoneManager.getRingtone(c, u)?.apply {
      audioAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build(); play()
    }
    stopper.postDelayed({ stop() }, 6000)
  }

  fun stop() {
    stopper.removeCallbacksAndMessages(null)
    playing?.stop()
    playing = null
  }
}
