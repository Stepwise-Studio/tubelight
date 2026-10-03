package studio.stepwise.tubelight

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer

/** What makes Tubelight choosable as the phone's digital assistant (Settings → Default apps → Digital assistant):
 *  the system binds this service, and a long press on the side key (or the assistant gesture) starts a session. */
class AssistService : VoiceInteractionService()

class AssistSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession = AssistSession(this)
}

/** No UI of its own: it opens the assistant panel (a normal React Native activity) and gets out of the way. */
class AssistSession(context: Context) : VoiceInteractionSession(context) {
  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args, showFlags)
    startAssistantActivity(Intent(context, AssistActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    hide()
  }
}

/** Android requires an assistant to ship a speech recognizer; Tubelight listens through Gemini Live instead. */
class AssistRecognitionService : RecognitionService() {
  override fun onStartListening(intent: Intent?, listener: Callback?) {
    listener?.error(SpeechRecognizer.ERROR_CLIENT)
  }

  override fun onCancel(listener: Callback?) {}

  override fun onStopListening(listener: Callback?) {}
}
