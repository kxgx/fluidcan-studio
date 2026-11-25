import { state, subscribe } from "../core/store.js";
import {
  directionLabel,
  directionToJog,
  gamepadButtonDirection,
  gamepadStickDirection,
  isTypingTarget,
  keyboardDirection,
  makeDirectionStabilizer,
  normalizePlane,
  planeAxes,
  stickDirection,
} from "../core/direction.js";
import { getStatus, jogStart, jogStop } from "../core/transport.js";

const GAMEPAD_POLL_MS = 80;

const $ = (id) => document.getElementById(id);

let initialized = false;
let enabled = false;
let active = null;
let jogToken = 0;
let rearmTimer = null;
let stopPending = false;
let stopRequested = false;
let stopRetryTimer = null;
let commandLock = Promise.resolve();

function serialized(fn) {
  const next = commandLock.then(fn, fn);
  commandLock = next.catch(() => {});
  return next;
}
let gamepadTimer = null;
let lastGamepadButton = null;
let gamepadArmed = true;
let analogGamepadDirection = null;
let analogStickDirection = null;
let virtualStickPointer = null;
let virtualDirection = null;
const heldKeys = new Map();
const gamepadStabilizer = makeDirectionStabilizer(2);
const stickStabilizer = makeDirectionStabilizer(2);

function status(text, kind = "") {
  const el = $("dpadStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "pill" + (kind ? ` ${kind}` : "");
}

function currentPlane() {
  return normalizePlane($("dpadPlane")?.value);
}

function currentFeed() {
  const value = parseFloat($("dpadFeed")?.value);
  return Number.isFinite(value) && value > 0 ? value : 500;
}

function updateFeedLabel() {
  const value = $("dpadFeedValue");
  if (value) value.textContent = `${Math.round(currentFeed())} mm/min`;
}

function layoutHasPlaneAxes(plane) {
  const layout = state.driverLayout;
  if (!layout || !Array.isArray(layout.axes) || !layout.axes.length) return true;
  return planeAxes(plane).every((axis) => layout.axes.includes(axis));
}

// A finite long jog keeps the machine inside a bounded move even if the stop
// packet is lost; normal release sends JogCancel (0x85) immediately.
function continuousStep(direction, plane, feed) {
  // Keep each accepted segment short so a missed JogCancel can only cause a
  // small extra move; the rearm timer joins segments while the input is held.
  const maxDistance = plane === "XY" ? 25 : 5;
  const distance = Math.max(0.2, Math.min(maxDistance, (feed / 60) * 0.6));
  return {
    command: directionToJog(plane, direction, Number(distance.toFixed(2)), feed),
    durationMs: Math.max(300, (distance / (feed / 60)) * 1000),
  };
}

function clearRearm() {
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
}

function scheduleStopRetry() {
  if (stopRetryTimer) return;
  stopRetryTimer = setTimeout(() => {
    stopRetryTimer = null;
    if (stopPending) void stopContinuous("重试停止");
  }, 1000);
}

function clearStopRetry() {
  if (stopRetryTimer) {
    clearTimeout(stopRetryTimer);
    stopRetryTimer = null;
  }
}

function canMove() {
  if (!enabled) {
    status("方向键未启用", "warn2");
    return false;
  }
  if (!state.connected) {
    status("设备未连接", "bad");
    return false;
  }
  return true;
}

function statusIsReady(text) {
  return /^<Idle/.test(String(text || "").trim());
}

async function machineIsReady() {
  try {
    const snapshot = await getStatus();
    return statusIsReady(snapshot.state);
  } catch {
    return false;
  }
}

async function doStartContinuous(direction, source, plane, feed, rearm = false) {
  if (!canMove() || !direction) return;
  if (!(feed > 0)) {
    status("速度必须大于 0", "bad");
    return;
  }
  if (!layoutHasPlaneAxes(plane)) {
    status(`${plane} 平面缺少轴配置`, "bad");
    return;
  }
  const step = continuousStep(direction, plane, feed);
  if (!step.command) {
    status("无效方向", "bad");
    return;
  }
  if (active) {
    const stopped = await doStopContinuous("切换方向或输入源");
    if (!stopped) return;
  }
  const token = ++jogToken;
  active = { direction, source, plane, feed, token };
  stopPending = false;
  clearRearm();
  status(`${source} ${directionLabel(plane, direction)} · ${Math.round(feed)} mm/min`, "warn2");
  try {
    // Do not queue a jog behind homing/cycle/alarm.  This also makes the
    // start/stop intent abortable while the status query is in flight.
    if (!rearm) {
      const ready = await machineIsReady();
      if (jogToken !== token || !active || active.token !== token) return;
      if (stopRequested) {
        active = null;
        status("已松开，未启动", "warn2");
        return;
      }
      if (!ready) {
        active = null;
        status("机器不在 Idle，连续点动已拒绝", "bad");
        return;
      }
    }
    if (stopRequested) {
      active = null;
      return;
    }
    await jogStart(step.command);
    if (jogToken !== token || !active || active.token !== token) {
      await jogStop().catch(() => {});
      return;
    }
    status(`${source} ${directionLabel(plane, direction)} · 持续移动中`, "ok");
    rearmTimer = setTimeout(() => {
      if (active?.token === token) {
        void startContinuous(active.direction, active.source, currentPlane(), currentFeed(), { rearm: true });
      }
    }, step.durationMs * 0.75);
  } catch (e) {
    if (active?.token === token) active = null;
    await jogStop().catch(() => {});
    status(`方向键失败: ${String(e)}`, "bad");
  }
}

async function doStopContinuous(reason = "松开", owner = null) {
  if (owner && active?.source !== owner) return true;
  if (!active && !stopPending) return true;
  const saved = active;
  active = null;
  ++jogToken;
  clearRearm();
  stopPending = true;
  try {
    await jogStop();
    stopPending = false;
    stopRequested = false;
    clearStopRetry();
    status(`${reason} · 已停止`, "ok");
    return true;
  } catch (e) {
    active = saved;
    stopPending = true;
    scheduleStopRetry();
    status(`停止失败: ${String(e)}，正在重试`, "bad");
    return false;
  }
}

function startContinuous(direction, source, plane = currentPlane(), feed = currentFeed(), options = {}) {
  stopRequested = false;
  stopPending = false;
  clearStopRetry();
  return serialized(() => doStartContinuous(direction, source, plane, feed, Boolean(options.rearm)));
}

function stopContinuous(reason = "松开", owner = null) {
  // A no-handle poll or another input source must not cancel a start that
  // belongs to the current source.
  if (!owner || active?.source === owner) stopRequested = true;
  return serialized(() => doStopContinuous(reason, owner));
}

export function stopDirectionJog() {
  heldKeys.clear();
  virtualDirection = null;
  virtualStickPointer = null;
  analogStickDirection = null;
  resetGamepadHold();
  void stopContinuous("离开控制页");
}

function setEnabled(next) {
  enabled = Boolean(next);
  const fieldset = $("dpadFieldset");
  if (fieldset) fieldset.disabled = !enabled;
  const checkbox = $("dpadEnable");
  if (checkbox) checkbox.checked = enabled;
  if (!enabled) {
    heldKeys.clear();
    lastGamepadButton = null;
    analogGamepadDirection = null;
    analogStickDirection = null;
    gamepadStabilizer(null);
    stickStabilizer(null);
    virtualStickPointer = null;
    virtualDirection = null;
    stopGamepadPoll();
    resetStickVisual();
    void stopContinuous("禁用");
    status("方向键未启用", "warn2");
  } else {
    startGamepadPoll();
    status(state.connected ? "方向键已启用（按住连续移动）" : "等待连接设备", state.connected ? "ok" : "warn2");
  }
}

function keyboardHandler(event) {
  if (!enabled || !state.connected) return;
  const view = $("view-control");
  if (!view || !view.classList.contains("active")) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;
  const wasd = Boolean($("dpadWasd")?.checked);
  const keyId = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const direction = keyboardDirection(keyId, { wasd });
  if (!direction) return;
  event.preventDefault();
  if (event.repeat || heldKeys.has(keyId)) return;
  heldKeys.set(keyId, direction);
  void startContinuous(direction, "键盘");
}

function keyboardRelease(event) {
  const keyId = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!heldKeys.has(keyId)) return;
  heldKeys.delete(keyId);
  if (!heldKeys.size) {
    void stopContinuous("键盘松开", "键盘");
    return;
  }
  // Another direction key is still held; switch to the most recent one.
  const last = [...heldKeys.values()].pop();
  if (last) {
      void startContinuous(last, "键盘");
  }
}

function virtualButtonDirection(event) {
  const button = event.target.closest("[data-dir]");
  return button ? button.dataset.dir : null;
}

function bindVirtualButtons() {
  const pad = $("dpadPad");
  if (!pad) return;
  pad.addEventListener("pointerdown", (event) => {
    if (!enabled || !state.connected) return;
    if (event.button != null && event.button !== 0) return;
    const direction = virtualButtonDirection(event);
    if (!direction) return;
    event.preventDefault();
    virtualDirection = direction;
    const button = event.target.closest("[data-dir]");
    button?.setPointerCapture?.(event.pointerId);
    void startContinuous(direction, "虚拟");
  });
  const stop = () => {
    if (!virtualDirection) return;
    virtualDirection = null;
    void stopContinuous("虚拟松开", "虚拟");
  };
  pad.addEventListener("pointerup", stop);
  pad.addEventListener("pointercancel", stop);
  pad.addEventListener("pointerleave", stop);
  pad.addEventListener("contextmenu", (event) => event.preventDefault());
}

function gamepadStatus(text, kind = "") {
  const el = $("gamepadStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "sub" + (kind ? ` ${kind}` : "");
}

function gamepads() {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

function resetGamepadHold() {
  lastGamepadButton = null;
  analogGamepadDirection = null;
  gamepadArmed = false;
  gamepadStabilizer(null);
}

function pollGamepad() {
  if (!enabled || !state.connected) return;
  if (document.hidden || !document.hasFocus()) {
    resetGamepadHold();
    void stopContinuous("窗口失焦", "手柄");
    return;
  }
  const view = $("view-control");
  if (!view || !view.classList.contains("active")) {
    void stopContinuous("离开控制页", "手柄");
    return;
  }
  const pads = gamepads();
  if (!pads.length) {
    resetGamepadHold();
    void stopContinuous("手柄断开", "手柄");
    gamepadStatus("手柄：未连接");
    return;
  }
  const pad = pads[0];
  const standard = pad.mapping == null || pad.mapping === "standard";
  if (!standard) {
    resetGamepadHold();
    void stopContinuous("手柄非标准映射", "手柄");
    gamepadStatus("手柄：非 standard 映射，已忽略");
    return;
  }
  gamepadStatus(`手柄：${pad.id || "已连接"}`, "ok");
  const button = gamepadButtonDirection(pad);
  const rawStick = gamepadStickDirection(pad);
  if (!gamepadArmed) {
    // Require a neutral sample after focus loss/reconnect so a held stick
    // cannot resume motion without a fresh user action.
    if (!button && !rawStick) gamepadArmed = true;
    return;
  }
  if (button) {
    analogGamepadDirection = null;
    gamepadStabilizer(null);
    if (button !== lastGamepadButton) {
      lastGamepadButton = button;
      void startContinuous(button, "手柄");
    }
    return;
  }
  lastGamepadButton = null;
  const raw = rawStick;
  const stable = gamepadStabilizer(raw);
  if (raw) {
    if (stable) analogGamepadDirection = stable;
  } else {
    analogGamepadDirection = null;
    gamepadStabilizer(null);
  }
  if (!analogGamepadDirection) {
    void stopContinuous("摇杆回中", "手柄");
    return;
  }
  if (analogGamepadDirection !== active?.direction || active?.source !== "手柄") {
    void startContinuous(analogGamepadDirection, "手柄");
  }
}

function startGamepadPoll() {
  if (gamepadTimer) return;
  gamepadTimer = setInterval(pollGamepad, GAMEPAD_POLL_MS);
  pollGamepad();
}

function stopGamepadPoll() {
  if (gamepadTimer) {
    clearInterval(gamepadTimer);
    gamepadTimer = null;
  }
}

function virtualStickVector(event, element) {
  const rect = element.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
  const dx = Math.max(-1, Math.min(1, (event.clientX - cx) / radius));
  const dy = Math.max(-1, Math.min(1, (event.clientY - cy) / radius));
  return { dx, dy };
}

function updateStickVisual(dx, dy) {
  const knob = $("stickKnob");
  if (!knob) return;
  knob.style.transform = `translate(${dx * 26}px, ${dy * 26}px)`;
}

function resetStickVisual() {
  updateStickVisual(0, 0);
}

function bindVirtualStick() {
  const stick = $("virtualStick");
  if (!stick) return;
  const move = (event) => {
    if (!virtualStickPointer || event.pointerId !== virtualStickPointer) return;
    event.preventDefault();
    const { dx, dy } = virtualStickVector(event, stick);
    updateStickVisual(dx, dy);
    const raw = stickDirection(dx, dy);
    const stable = stickStabilizer(raw);
    if (raw) {
      if (stable) analogStickDirection = stable;
    } else {
      analogStickDirection = null;
      stickStabilizer(null);
    }
    if (!analogStickDirection) {
      void stopContinuous("虚拟摇杆回中", "虚拟手柄");
      return;
    }
    if (analogStickDirection !== active?.direction || active?.source !== "虚拟手柄") {
      void startContinuous(analogStickDirection, "虚拟手柄");
    }
  };
  const end = (event) => {
    if (!virtualStickPointer || event.pointerId !== virtualStickPointer) return;
    virtualStickPointer = null;
    analogStickDirection = null;
    stickStabilizer(null);
    resetStickVisual();
    void stopContinuous("虚拟摇杆松开", "虚拟手柄");
    if (stick.hasPointerCapture?.(event.pointerId)) {
      try {
        stick.releasePointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    }
  };
  stick.addEventListener("pointerdown", (event) => {
    if (!enabled || !state.connected) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    virtualStickPointer = event.pointerId;
    stick.setPointerCapture?.(event.pointerId);
    const { dx, dy } = virtualStickVector(event, stick);
    updateStickVisual(dx, dy);
    const raw = stickDirection(dx, dy);
    stickStabilizer(raw);
    const stable = stickStabilizer(raw);
    if (stable) {
      analogStickDirection = stable;
      void startContinuous(stable, "虚拟手柄");
    }
  });
  stick.addEventListener("pointermove", move);
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);
  stick.addEventListener("lostpointercapture", () => {
    const had = virtualStickPointer;
    virtualStickPointer = null;
    analogStickDirection = null;
    stickStabilizer(null);
    resetStickVisual();
    if (had) void stopContinuous("虚拟摇杆失联", "虚拟手柄");
  });
}

export function initDirectionControls() {
  if (initialized) return;
  initialized = true;
  const enable = $("dpadEnable");
  if (!enable) return;
  enable.addEventListener("change", () => setEnabled(enable.checked));
  $("dpadPlane")?.addEventListener("change", () => {
    lastGamepadButton = null;
    analogGamepadDirection = null;
    analogStickDirection = null;
    gamepadStabilizer(null);
    stickStabilizer(null);
    virtualDirection = null;
    heldKeys.clear();
    void stopContinuous("切换平面");
  });
  $("dpadFeed")?.addEventListener("input", updateFeedLabel);
  $("dpadFeed")?.addEventListener("change", () => {
    updateFeedLabel();
    if (active) void startContinuous(active.direction, active.source, currentPlane(), currentFeed());
  });
  bindVirtualButtons();
  bindVirtualStick();
  window.addEventListener("keydown", keyboardHandler);
  window.addEventListener("keyup", keyboardRelease);
  window.addEventListener("blur", () => {
    heldKeys.clear();
    virtualDirection = null;
    virtualStickPointer = null;
    analogStickDirection = null;
    resetGamepadHold();
    void stopContinuous("窗口失焦");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      heldKeys.clear();
        virtualDirection = null;
      virtualStickPointer = null;
      analogStickDirection = null;
      resetGamepadHold();
      void stopContinuous("页面隐藏");
    }
  });
  window.addEventListener("pagehide", () => {
    void stopContinuous("页面关闭");
  });
  window.addEventListener("gamepadconnected", () => {
    if (enabled) gamepadStatus(`手柄：${gamepads()[0]?.id || "已连接"}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", () => {
    resetGamepadHold();
    void stopContinuous("手柄断开", "手柄");
    gamepadStatus("手柄：未连接");
  });
  subscribe(() => {
    if (!state.connected) {
      lastGamepadButton = null;
      analogGamepadDirection = null;
      analogStickDirection = null;
      void stopContinuous("设备断开");
      if (enabled) status("设备未连接", "bad");
    } else if (enabled) {
      status("方向键已启用（按住连续移动）", "ok");
    }
  });
  updateFeedLabel();
  setEnabled(false);
}
