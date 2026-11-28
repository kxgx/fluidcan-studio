package com.fluidcan.studio

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private lateinit var gamepadBridge: GamepadBridge

  override fun onCreate(savedInstanceState: Bundle?) {
    // Tauri may create the WebView during super.onCreate(); initialize the
    // bridge first so onWebViewCreate() can attach it immediately.
    gamepadBridge = GamepadBridge(this)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // HyperOS / Android 15 edge-to-edge: keep the web UI below the status bar
    // and above the navigation bar, in addition to CSS safe-area handling.
    if (Build.VERSION.SDK_INT >= 37 &&
        checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), 1001)
    }

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    gamepadBridge.attachWebView(webView)
  }

  override fun dispatchKeyEvent(event: KeyEvent): Boolean =
    gamepadBridge.onKeyEvent(event) || super.dispatchKeyEvent(event)

  override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean =
    gamepadBridge.onMotionEvent(event) || super.dispatchGenericMotionEvent(event)

  override fun onDestroy() {
    gamepadBridge.close()
    super.onDestroy()
  }
}
