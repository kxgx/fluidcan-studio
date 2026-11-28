package com.fluidcan.studio

import android.content.Context
import android.hardware.input.InputManager
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Android native gamepad bridge.
 *
 * Android WebView does not reliably implement the Web Gamepad API, so this
 * class reads InputDevice/KeyEvent/MotionEvent directly and posts the same
 * normalized snapshot shape that the desktop gilrs backend exposes.
 */
class GamepadBridge(context: Context) : InputManager.InputDeviceListener {
    companion object {
        private const val SEND_DELAY_MS = 20L
    }

    private val inputManager =
        context.getSystemService(Context.INPUT_SERVICE) as InputManager
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()

    // Key events and motion events are kept separate: some controllers report
    // the D-pad as KEYCODE_DPAD_* while others report it as AXIS_HAT_*; using a
    // single array lets a motion event clear a key that is still held.
    private val keyButtons = BooleanArray(17)
    private val motionButtons = BooleanArray(17)
    private val axes = FloatArray(4)
    private var connected = false
    private var deviceName = ""
    private var activeDeviceId = -1
    private var webView: WebView? = null
    private var closed = false
    private var sendScheduled = false

    init {
        inputManager.registerInputDeviceListener(this, handler)
        refreshConnection()
    }

    fun attachWebView(view: WebView) {
        webView = view
    }

    fun close() {
        closed = true
        handler.removeCallbacksAndMessages(null)
        try {
            inputManager.unregisterInputDeviceListener(this)
        } catch (_: Exception) {
            // Activity may already be torn down.
        }
        executor.shutdownNow()
    }

    fun onKeyEvent(event: KeyEvent): Boolean {
        if (!isGamepad(event.device, event.source)) return false
        val index = keyIndex(event.keyCode)
        if (index < 0) return false

        markActive(event.device)
        when (event.action) {
            KeyEvent.ACTION_DOWN -> keyButtons[index] = true
            KeyEvent.ACTION_UP -> keyButtons[index] = false
            else -> return true
        }
        scheduleSend()
        return true
    }

    fun onMotionEvent(event: MotionEvent): Boolean {
        if (!isGamepad(event.device, event.source)) return false
        markActive(event.device)

        axes[0] = event.getAxisValue(MotionEvent.AXIS_X)
        axes[1] = event.getAxisValue(MotionEvent.AXIS_Y)
        axes[2] = event.getAxisValue(MotionEvent.AXIS_Z)
        axes[3] = event.getAxisValue(MotionEvent.AXIS_RZ)

        // Reset only the motion-derived buttons; key-derived states stay held.
        motionButtons[6] = false
        motionButtons[7] = false
        motionButtons[12] = false
        motionButtons[13] = false
        motionButtons[14] = false
        motionButtons[15] = false

        if (hasAxis(event, MotionEvent.AXIS_LTRIGGER)) {
            motionButtons[6] = event.getAxisValue(MotionEvent.AXIS_LTRIGGER) > 0.5f
        }
        if (hasAxis(event, MotionEvent.AXIS_RTRIGGER)) {
            motionButtons[7] = event.getAxisValue(MotionEvent.AXIS_RTRIGGER) > 0.5f
        }
        if (hasAxis(event, MotionEvent.AXIS_HAT_X)) {
            val hatX = event.getAxisValue(MotionEvent.AXIS_HAT_X)
            motionButtons[14] = hatX < -0.5f
            motionButtons[15] = hatX > 0.5f
        }
        if (hasAxis(event, MotionEvent.AXIS_HAT_Y)) {
            val hatY = event.getAxisValue(MotionEvent.AXIS_HAT_Y)
            motionButtons[12] = hatY < -0.5f
            motionButtons[13] = hatY > 0.5f
        }

        scheduleSend()
        return true
    }

    override fun onInputDeviceAdded(deviceId: Int) {
        refreshConnection()
    }

    override fun onInputDeviceChanged(deviceId: Int) {
        refreshConnection()
    }

    override fun onInputDeviceRemoved(deviceId: Int) {
        if (deviceId == activeDeviceId) {
            resetInput()
            scheduleSend()
        }
        refreshConnection()
    }

    private fun hasAxis(event: MotionEvent, axis: Int): Boolean =
        event.device?.getMotionRange(axis, event.source) != null

    private fun markActive(device: InputDevice?) {
        val id = device?.id ?: -1
        if (!connected || id != activeDeviceId) {
            resetInput()
        }
        activeDeviceId = id
        connected = true
        deviceName = device?.name ?: "Android gamepad"
    }

    private fun resetInput() {
        activeDeviceId = -1
        connected = false
        deviceName = ""
        keyButtons.fill(false)
        motionButtons.fill(false)
        axes.fill(0f)
    }

    private fun refreshConnection() {
        if (closed) return
        val gamepad = InputDevice.getDeviceIds()
            .asSequence()
            .mapNotNull { InputDevice.getDevice(it) }
            .firstOrNull { isGamepad(it, 0) }
        if (gamepad == null) {
            if (connected) {
                resetInput()
                scheduleSend()
            }
        } else if (!connected) {
            connected = true
            activeDeviceId = gamepad.id
            deviceName = gamepad.name
            scheduleSend()
        }
    }

    private fun isGamepad(device: InputDevice?, source: Int): Boolean {
        val sources = source or (device?.sources ?: 0)
        return sources and (InputDevice.SOURCE_GAMEPAD or InputDevice.SOURCE_JOYSTICK) != 0
    }

    private fun keyIndex(keyCode: Int): Int = when (keyCode) {
        KeyEvent.KEYCODE_BUTTON_A -> 0
        KeyEvent.KEYCODE_BUTTON_B -> 1
        KeyEvent.KEYCODE_BUTTON_X -> 2
        KeyEvent.KEYCODE_BUTTON_Y -> 3
        KeyEvent.KEYCODE_BUTTON_L1 -> 4
        KeyEvent.KEYCODE_BUTTON_R1 -> 5
        KeyEvent.KEYCODE_BUTTON_L2 -> 6
        KeyEvent.KEYCODE_BUTTON_R2 -> 7
        KeyEvent.KEYCODE_BUTTON_SELECT -> 8
        KeyEvent.KEYCODE_BUTTON_START -> 9
        KeyEvent.KEYCODE_BUTTON_THUMBL -> 10
        KeyEvent.KEYCODE_BUTTON_THUMBR -> 11
        KeyEvent.KEYCODE_DPAD_UP -> 12
        KeyEvent.KEYCODE_DPAD_DOWN -> 13
        KeyEvent.KEYCODE_DPAD_LEFT -> 14
        KeyEvent.KEYCODE_DPAD_RIGHT -> 15
        KeyEvent.KEYCODE_BUTTON_MODE -> 16
        else -> -1
    }

    private fun scheduleSend() {
        if (closed || sendScheduled) return
        sendScheduled = true
        handler.postDelayed({
            sendScheduled = false
            if (closed) return@postDelayed
            // WebView.url must be read on the main thread.  It carries the
            // server's actual port and per-process auth token.
            val endpoint = endpoint()
            if (endpoint == null) {
                // The WebView URL is not available yet; retry shortly.
                scheduleSend()
                return@postDelayed
            }
            val body = snapshot().toString()
            executor.execute { post(body, endpoint) }
        }, SEND_DELAY_MS)
    }

    private fun endpoint(): String? {
        val uri = Uri.parse(webView?.url ?: return null)
        if (uri.host != "127.0.0.1" || uri.port <= 0) return null
        val token = uri.getQueryParameter("token") ?: return null
        return "http://127.0.0.1:${uri.port}/api/gamepad/android?token=$token"
    }

    private fun snapshot(): JSONObject = JSONObject().apply {
        put("available", true)
        put("connected", connected)
        put("id", deviceName)
        put("axes", JSONArray(axes.toList()))
        val merged = BooleanArray(17) { keyButtons[it] || motionButtons[it] }
        put("buttons", JSONArray(merged.toList()))
    }

    private fun post(body: String, endpoint: String) {
        var connection: HttpURLConnection? = null
        try {
            connection = URL(endpoint).openConnection() as HttpURLConnection
            connection.requestMethod = "POST"
            connection.connectTimeout = 200
            connection.readTimeout = 200
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(body.toByteArray()) }
            connection.responseCode
        } catch (_: Exception) {
            // The local server may not be ready yet; the next event retries.
        } finally {
            connection?.disconnect()
        }
    }
}
