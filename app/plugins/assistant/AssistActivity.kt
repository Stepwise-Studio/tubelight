package studio.stepwise.tubelight

import android.animation.ValueAnimator
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import expo.modules.ReactActivityDelegateWrapper

/** The assistant panel: a see-through window over whatever is on screen (even the lock screen), rendering the JS
 *  component "assistant" (src/assistant/root.tsx). Opened by AssistSession or an ACTION_ASSIST intent.
 *  Android 12+ blurs what's behind it (easing in as it opens); the JS side dims it, deepening toward the bottom.
 *  With blur turned off by the phone (battery saver), the dim alone carries it. */
class AssistActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
    if (Build.VERSION.SDK_INT >= 31) {
      window.addFlags(WindowManager.LayoutParams.FLAG_BLUR_BEHIND)
      ValueAnimator.ofInt(0, BLUR).apply {
        duration = 350
        interpolator = DecelerateInterpolator(2f)
        addUpdateListener { a -> window.attributes = window.attributes.apply { blurBehindRadius = a.animatedValue as Int } }
        start()
      }
    }
  }

  private companion object { const val BLUR = 28 }

  override fun getMainComponentName(): String = "assistant"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
    ReactActivityDelegateWrapper(this, BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
      object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {})
}
