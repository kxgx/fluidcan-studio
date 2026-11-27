// Native desktop gamepad source.
//
// The Rust backend normalizes XInput/DirectInput (Windows), evdev (Linux) and
// IOKit (macOS) into the Web Gamepad "standard" layout.  The browser Gamepad
// API remains the fallback for web mode and Android.

let supported = false;
let snapshot = null;
let started = false;
let timer = null;

export function startNativeGamepadSource() {
  if (started || typeof window === "undefined" || typeof fetch !== "function") return;
  started = true;
  void poll();
}

async function poll() {
  try {
    const response = await fetch("/api/gamepad", { cache: "no-store" });
    if (response.ok) {
      const next = await response.json();
      supported = Boolean(next && next.available);
      snapshot = next;
    }
  } catch {
    // The local server is not reachable (for example during shutdown); the
    // browser Gamepad API remains available as a fallback.
  }
  timer = setTimeout(poll, 50);
}

// Returns null when the native backend is not available (web/Android), an
// empty array when it is available but no gamepad is connected, or one
// standard-layout gamepad object.
export function nativeGamepads() {
  if (!supported) return null;
  if (!snapshot || !snapshot.connected) return [];
  return [toGamepad(snapshot)];
}

export function nativeGamepadActive() {
  return supported;
}

export function toGamepad(state) {
  const buttons = Array.from({ length: 17 }, (_, index) => {
    const pressed = Boolean(state.buttons && state.buttons[index]);
    return { pressed, value: pressed ? 1 : 0 };
  });
  const axes = Array.from({ length: 4 }, (_, index) =>
    Number(state.axes && state.axes[index]) || 0,
  );
  return {
    id: state.id ? `Native ${state.id}` : "Native gamepad",
    mapping: "standard",
    axes,
    buttons,
  };
}

export function stopNativeGamepadSource() {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}
