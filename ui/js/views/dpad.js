import { state, subscribe } from "../core/store.js";
import { stateParts } from "../core/parsers.js";
import { maxFeedForAxes } from "../core/drivers.js";
import {
  clampFeed,
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
  gamepadDigitalVector,
  gamepadStickVector,
  mergeGamepadVector,
  keyboardVector,
  mergeVector,
  stickVector,
  vectorIsZero,
  vectorLabel,
  vectorToJog,
  zeroVector,
} from "../core/direction.js";
import { getStatus, httpGet, httpPost, jogStart, jogStop } from "../core/transport.js";
import { nativeGamepads, startNativeGamepadSource } from "../core/gamepad-source.js";

const GAMEPAD_POLL_MS = 80;

const $ = (id) => document.getElementById(id);

let initialized = false;
let enabled = false;
let active = null; // { vector, source, feed, token }
let pendingStart = null; // latest input rejected while a stop was confirming
let inputRevision = 0; // increments on every requested input change
let jogToken = 0;
let rearmTimer = null;
let stopPending = false;
let stopRequested = false;
let stopRetryTimer = null;
let feedRestartTimer = null;
let commandLock = Promise.resolve();
let lastLayout = null;
let rawMaxFeed = null;

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
let virtualVector = zeroVector();
const virtualPressed = new Map();
let virtualStickPart = zeroVector();
let virtualStickPointer = null;
const heldKeys = new Map();
const gamepadStabilizer = makeDirectionStabilizer(2);
const stickStabilizer = makeDirectionStabilizer(2);

function status(text, kind = "") {
  const el = $("dpadStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "pill" + (kind ? ` ${kind}` : "");
}

function configMaxFeed() {
  // One speed slider feeds combined X/Y/Z motion; use the most restrictive of
  // the three axes.  Missing max_rate falls back to FluidNC's 1000 mm/min.
  const max = maxFeedForAxes(state.driverLayout, ["X", "Y", "Z"], 1000);
  return Number.isFinite(max) && max > 0 ? max : 3000;
}

// rawMaxFeed is the operator's saved ceiling; currentMaxFeed is what the
// current plane/config allows.  Keeping them separate means a low-cap plane
// (e.g. XZ with Z=600) does not permanently overwrite a 5000 setting when the
// user returns to XY or after a restart.
function setRawMaxFeed(value) {
  const raw = Number(value);
  if (Number.isFinite(raw) && raw > 0) rawMaxFeed = Math.min(60000, Math.max(100, raw));
}

function rawCeiling() {
  return Number.isFinite(rawMaxFeed) && rawMaxFeed > 0 ? rawMaxFeed : 3000;
}

function currentMaxFeed() {
  return clampFeed(Math.min(rawCeiling(), configMaxFeed()), configMaxFeed());
}

function syncFeedInputs() {
  const cap = configMaxFeed();
  const input = $("dpadMaxFeed");
  const slider = $("dpadFeed");
  if (input) {
    input.max = String(cap);
    input.value = String(currentMaxFeed());
  }
  if (slider) {
    slider.max = String(cap);
    slider.value = String(clampFeed(slider.value, cap));
  }
  updateFeedLabel();
}

function currentFeed() {
  return clampFeed($("dpadFeed")?.value, currentMaxFeed());
}

function updateFeedLabel() {
  const value = $("dpadFeedValue");
  if (value) value.textContent = `${Math.round(currentFeed())} mm/min`;
  const slider = $("dpadFeed");
  if (slider) slider.max = String(currentMaxFeed());
}

function applyFeedLimit() {
  const input = $("dpadMaxFeed");
  const slider = $("dpadFeed");
  if (input) setRawMaxFeed(input.value);
  const max = currentMaxFeed();
  if (input) {
    input.max = String(configMaxFeed());
    input.value = String(max);
  }
  if (slider) {
    slider.max = String(max);
    slider.value = String(clampFeed(slider.value, max));
  }
  updateFeedLabel();
  try {
    localStorage.setItem("fluidcan.jogMaxFeed", String(rawCeiling()));
  } catch {
    /* storage unavailable */
  }
  void httpPost("/settings", { jog_max_feed: rawCeiling() }).catch(() => {});
  if (canRestartForFeed()) void startContinuous(active.vector, active.source, currentFeed());
}

function layoutHasAxes(vector) {
  const layout = state.driverLayout;
  if (!layout || !Array.isArray(layout.axes) || !layout.axes.length) return true;
  return ["X", "Y", "Z"].every((axis) => !vector[axis] || layout.axes.includes(axis));
}

function mposValue(mpos, axis) {
  const index = { X: 0, Y: 1, Z: 2 }[axis];
  const parts = String(mpos || "").split(",");
  const value = Number(parts[index]);
  return Number.isFinite(value) ? value : null;
}

// Compute the remaining distance to the configured soft/travel bound.  The
// command is sized so a lost JogCancel stops at the bound instead of moving
// a fixed extra distance.  Axes already at their bound are dropped.
function continuousStep(vector, feed, mpos = "--") {
  const filtered = zeroVector();
  const distances = [];
  for (const axis of ["X", "Y", "Z"]) {
    const sign = vector[axis];
    if (!sign) continue;
    const travel = Number(state.driverLayout?.axisTravel?.[axis]);
    const soft = state.driverLayout?.axisSoft?.[axis] || {};
    const hasSoft = Number.isFinite(Number(soft.max)) && Number.isFinite(Number(soft.min));
    if (!hasSoft) {
      // No firmware soft limit to stop a lost JogCancel; use the old bounded
      // segment rather than running to the physical travel end.
      distances.push(axis === "Z" ? 5 : 25);
      filtered[axis] = sign;
      continue;
    }
    const upper = Number(soft.max);
    const lower = Number(soft.min);
    const pos = mposValue(mpos, axis);
    if (pos == null) {
      distances.push(axis === "Z" ? 5 : 25);
      filtered[axis] = sign;
      continue;
    }
    const target = sign > 0 ? upper : lower;
    const available = sign > 0 ? target - pos : pos - target;
    if (available > 0.05) {
      distances.push(available - 0.05);
      filtered[axis] = sign;
    }
  }
  if (!distances.length) return { command: "", durationMs: 0 };
  const distance = Math.min(...distances);
  const durationMs = Math.max(300, (distance / (feed / 60)) * 1000);
  return {
    command: vectorToJog(filtered, Number(distance.toFixed(3)), feed),
    durationMs,
  };
}

function clearRearm() {
  if (rearmTimer) {
    clearTimeout(rearmTimer);
    rearmTimer = null;
  }
}

function clearFeedRestart() {
  if (feedRestartTimer) {
    clearTimeout(feedRestartTimer);
    feedRestartTimer = null;
  }
}

function canRestartForFeed() {
  return Boolean(active) && !stopRequested && !stopPending;
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

async function machineSnapshot() {
  try {
    const snapshot = await getStatus();
    return { ready: statusIsReady(snapshot.state), mpos: stateParts(snapshot.state).mpos };
  } catch {
    return { ready: false, mpos: "--" };
  }
}

async function confirmIdle(timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const snapshot = await getStatus();
      if (statusIsReady(snapshot.state)) return true;
      if (Date.now() >= deadline) return false;
    } catch {
      if (Date.now() >= deadline) return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function doStartContinuous(vector, source, feed, rearm = false) {
  const revision = inputRevision;
  if (!canMove() || vectorIsZero(vector)) return;
  if (!(feed > 0)) {
    status("速度必须大于 0", "bad");
    return;
  }
  if (!layoutHasAxes(vector)) {
    status("缺少轴配置", "bad");
    return;
  }
  let step = continuousStep(vector, feed, "--");
  if (active) {
    const stopped = await doStopContinuous("切换方向或输入源");
    if (!stopped) return;
    // A newer input arrived while the switch stop was confirming; the latest
    // vector will be started/replayed, never this stale one.
    if (revision !== inputRevision) return;
  }
  const token = ++jogToken;
  active = { vector: { ...vector }, source, feed, token };
  stopPending = false;
  clearRearm();
  status(`${source} ${vectorLabel(vector)} · ${Math.round(feed)} mm/min`, "warn2");
  try {
    // Do not queue a jog behind homing/cycle/alarm.  This also makes the
    // start/stop intent abortable while the status query is in flight.
    let ready = true;
    if (!rearm) {
      const snapshot = await machineSnapshot();
      ready = snapshot.ready;
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
      step = continuousStep(vector, feed, snapshot.mpos);
      if (revision !== inputRevision) {
        active = null;
        return;
      }
    }
    if (!step.command) {
      active = null;
      status("已到软限位/行程边界", "warn2");
      return;
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
    status(`${source} ${vectorLabel(vector)} · 持续移动中`, "ok");
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
  clearFeedRestart();
  stopPending = true;
  try {
    await jogStop();
    const idle = await confirmIdle();
    if (!idle) {
      // 0x85 is write-only over the live link; do not claim a confirmed stop
      // until the controller actually reports Idle.
      stopPending = true;
      scheduleStopRetry();
      status(`${reason} · 停止已发送，状态未确认`, "warn2");
      return false;
    }
    stopPending = false;
    stopRequested = false;
    clearStopRetry();
    status(`${reason} · 已停止`, "ok");
    const pending = pendingStart;
    pendingStart = null;
    if (pending && enabled && state.connected) {
      // Replay after the lock is released, only if the same input generation
      // is still current and the window is still focused/visible.  A blur,
      // page hide, disconnect or newer input must never restart old motion.
      setTimeout(() => {
        if (pending.revision !== inputRevision) return;
        if (typeof document !== "undefined" && (document.hidden || !document.hasFocus())) return;
        void startContinuous(pending.vector, pending.source, pending.feed, pending.options);
      }, 0);
    }
    return true;
  } catch (e) {
    active = saved;
    stopPending = true;
    scheduleStopRetry();
    status(`停止失败: ${String(e)}，正在重试`, "bad");
    return false;
  }
}

function startContinuous(vector, source, feed = currentFeed(), options = {}) {
  inputRevision += 1;
  if (stopPending) {
    // Remember only the latest input.  The old vector must never be replayed
    // after the operator has already released one of the axes.
    pendingStart = { vector: { ...vector }, source, feed, options, revision: inputRevision };
    status("停止确认中，暂不启动", "warn2");
    return Promise.resolve({ skipped: true });
  }
  stopRequested = false;
  clearStopRetry();
  return serialized(() => doStartContinuous(vector, source, feed, Boolean(options.rearm)));
}

function clearPendingStart(source = null) {
  if (!pendingStart) return;
  if (!source || pendingStart.source === source) pendingStart = null;
}

function stopContinuous(reason = "松开", owner = null) {
  inputRevision += 1;
  // A no-handle poll or another input source must not cancel a start that
  // belongs to the current source.
  if (!owner || active?.source === owner) stopRequested = true;
  return serialized(() => doStopContinuous(reason, owner));
}

export async function stopDirectionJog() {
  heldKeys.clear();
  virtualPressed.clear(); virtualStickPart = zeroVector(); virtualVector = zeroVector();
  virtualStickPointer = null;
  analogStickDirection = null;
  pendingStart = null;
  resetGamepadHold();
  await stopContinuous("离开控制页");
}

function setEnabled(next) {
  enabled = Boolean(next);
  const fieldset = $("dpadFieldset");
  if (fieldset) fieldset.disabled = !enabled;
  const checkbox = $("dpadEnable");
  if (checkbox) checkbox.checked = enabled;
  if (!enabled) {
    clearFeedRestart();
    heldKeys.clear();
    lastGamepadButton = null;
    analogGamepadDirection = null;
    analogStickDirection = null;
    gamepadStabilizer(null);
    stickStabilizer(null);
    virtualStickPointer = null;
    virtualPressed.clear(); virtualStickPart = zeroVector(); virtualVector = zeroVector();
    stopGamepadPoll();
    resetStickVisual();
    pendingStart = null;
    void stopContinuous("禁用");
    status("方向键未启用", "warn2");
  } else {
    startGamepadPoll();
    status(state.connected ? "方向键已启用" : "等待连接设备", state.connected ? "ok" : "warn2");
  }
}

function heldKeyboardVector() {
  const vector = zeroVector();
  for (const part of heldKeys.values()) mergeVector(vector, part);
  return vector;
}

function keyboardHandler(event) {
  if (!enabled || !state.connected) return;
  const view = $("view-control");
  if (!view || !view.classList.contains("active")) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;
  const wasd = Boolean($("dpadWasd")?.checked);
  const keyId = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const part = keyboardVector(keyId, { wasd });
  if (!part) return;
  event.preventDefault();
  if (event.repeat || heldKeys.has(keyId)) return;
  heldKeys.set(keyId, part);
  void startContinuous(heldKeyboardVector(), "键盘");
}

function keyboardRelease(event) {
  const keyId = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (!heldKeys.has(keyId)) return;
  heldKeys.delete(keyId);
  const vector = heldKeyboardVector();
  if (vectorIsZero(vector)) {
    clearPendingStart("键盘");
    void stopContinuous("键盘松开", "键盘");
    return;
  }
  void startContinuous(vector, "键盘");
}

function virtualPart(target) {
  const dir = target.closest?.("[data-dir]")?.dataset.dir;
  if (dir === "left") return { X: -1 };
  if (dir === "right") return { X: 1 };
  if (dir === "up") return { Y: 1 };
  if (dir === "down") return { Y: -1 };
  const z = target.closest?.("[data-z]")?.dataset.z;
  if (z === "+") return { Z: 1 };
  if (z === "-") return { Z: -1 };
  return null;
}

function virtualVectorNow() {
  const vector = zeroVector();
  for (const part of virtualPressed.values()) mergeVector(vector, part);
  mergeVector(vector, virtualStickPart);
  return vector;
}

function applyVirtualPresses() {
  const vector = virtualVectorNow();
  virtualVector = vector;
  if (vectorIsZero(vector)) {
    // No owner: a start from this virtual source may still be queued in the
    // serialized command lock.  The unconditional stop sets stopRequested so
    // that queued start aborts instead of running after the finger is released.
    clearPendingStart("虚拟");
    clearPendingStart("虚拟手柄");
    void stopContinuous("虚拟松开");
    return;
  }
  const source = virtualStickPointer ? "虚拟手柄" : "虚拟";
  // The analog stick emits on every pointermove; only restart when the
  // quantized axis vector or source actually changed.
  if (active && active.source === source && vectorLabel(active.vector) === vectorLabel(vector)) return;
  void startContinuous(vector, source);
}

function bindVirtualButtons() {
  const pad = $("dpadPad");
  const zBox = $("dpadZ");
  if (!pad && !zBox) return;
  const onDown = (event) => {
    if (!enabled || !state.connected) return;
    if (event.button != null && event.button !== 0) return;
    const part = virtualPart(event.target);
    if (!part) return;
    event.preventDefault();
    virtualPressed.set(event.pointerId, part);
    event.target.setPointerCapture?.(event.pointerId);
    applyVirtualPresses();
  };
  const onUp = (event) => {
    if (!virtualPressed.has(event.pointerId)) return;
    virtualPressed.delete(event.pointerId);
    applyVirtualPresses();
  };
  for (const root of [pad, zBox].filter(Boolean)) {
    root.addEventListener("pointerdown", onDown);
    root.addEventListener("pointerup", onUp);
    root.addEventListener("pointercancel", onUp);
    root.addEventListener("pointerleave", onUp);
    root.addEventListener("contextmenu", (event) => event.preventDefault());
  }
}

function gamepadStatus(text, kind = "") {
  const el = $("gamepadStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "sub" + (kind ? ` ${kind}` : "");
}

function browserGamepads() {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  return Array.from(navigator.getGamepads()).filter(Boolean);
}

function gamepads() {
  const native = nativeGamepads();
  if (native === null) return browserGamepads();
  // Prefer the normalized native device.  If gilrs cannot see a particular
  // controller, still let the WebView Gamepad API try it.
  if (native.length) return native;
  const browser = browserGamepads();
  return browser.length ? browser : native;
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
  const digital = gamepadDigitalVector(pad);
  const stick = gamepadStickVector(pad);
  const vector = mergeGamepadVector(digital, stick);
  if (!gamepadArmed) {
    // Require a neutral sample after focus loss/reconnect so a held stick
    // cannot resume motion without a fresh user action.
    if (!vector) gamepadArmed = true;
    return;
  }
  if (!vector) {
    analogGamepadDirection = null;
    lastGamepadButton = null;
    clearPendingStart("手柄");
    if (active?.source === "手柄") void stopContinuous("摇杆回中", "手柄");
    return;
  }
  const key = vectorLabel(vector);
  if (key !== lastGamepadButton || active?.source !== "手柄") {
    lastGamepadButton = key;
    analogGamepadDirection = key;
    void startContinuous(vector, "手柄");
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
    virtualStickPart = stickVector(dx, dy) || zeroVector();
    applyVirtualPresses();
  };
  const end = (event) => {
    if (!virtualStickPointer || event.pointerId !== virtualStickPointer) return;
    virtualStickPointer = null;
    virtualStickPart = zeroVector();
    resetStickVisual();
    applyVirtualPresses();
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
    virtualStickPart = stickVector(dx, dy) || zeroVector();
    applyVirtualPresses();
  });
  stick.addEventListener("pointermove", move);
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);
  stick.addEventListener("lostpointercapture", () => {
    const had = virtualStickPointer;
    virtualStickPointer = null;
    virtualStickPart = zeroVector();
    resetStickVisual();
    if (had) applyVirtualPresses();
  });
}

export function initDirectionControls() {
  if (initialized) return;
  initialized = true;
  startNativeGamepadSource();
  const enable = $("dpadEnable");
  if (!enable) return;
  enable.addEventListener("change", () => setEnabled(enable.checked));
  $("dpadFeed")?.addEventListener("input", () => {
    updateFeedLabel();
    // Re-arm the current segment with the new F after a short quiet period.
    // This is the safe live-speed path for the existing short-segment jog.
    if (canRestartForFeed()) {
      clearTimeout(feedRestartTimer);
      feedRestartTimer = setTimeout(() => {
        feedRestartTimer = null;
        if (canRestartForFeed()) void startContinuous(active.vector, active.source, currentFeed());
      }, 140);
    }
  });
  $("dpadFeed")?.addEventListener("change", () => {
    clearFeedRestart();
    updateFeedLabel();
    if (canRestartForFeed()) void startContinuous(active.vector, active.source, currentFeed());
  });
  $("dpadMaxFeed")?.addEventListener("change", applyFeedLimit);
  $("dpadMaxFeed")?.addEventListener("input", () => {
    if (($("dpadMaxFeed")?.value || "").length >= 3) applyFeedLimit();
  });
  bindVirtualButtons();
  bindVirtualStick();
  window.addEventListener("keydown", keyboardHandler);
  window.addEventListener("keyup", keyboardRelease);
  window.addEventListener("blur", () => {
    pendingStart = null;
    heldKeys.clear();
    virtualPressed.clear(); virtualStickPart = zeroVector(); virtualVector = zeroVector();
    virtualStickPointer = null;
    analogStickDirection = null;
    resetGamepadHold();
    void stopContinuous("窗口失焦");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pendingStart = null;
      heldKeys.clear();
        virtualPressed.clear(); virtualStickPart = zeroVector(); virtualVector = zeroVector();
      virtualStickPointer = null;
      analogStickDirection = null;
      resetGamepadHold();
      void stopContinuous("页面隐藏");
    }
  });
  window.addEventListener("pagehide", () => {
    pendingStart = null;
    void stopContinuous("页面关闭");
  });
  window.addEventListener("gamepadconnected", () => {
    if (enabled) gamepadStatus(`手柄：${gamepads()[0]?.id || "已连接"}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", () => {
    pendingStart = null;
    resetGamepadHold();
    void stopContinuous("手柄断开", "手柄");
    gamepadStatus("手柄：未连接");
  });
  subscribe(() => {
    if (state.driverLayout !== lastLayout) {
      lastLayout = state.driverLayout;
      syncFeedInputs();
    }
    if (!state.connected) {
      pendingStart = null;
      lastGamepadButton = null;
      analogGamepadDirection = null;
      analogStickDirection = null;
      void stopContinuous("设备断开");
      if (enabled) status("设备未连接", "bad");
    } else if (enabled) {
      status("方向键已启用", "ok");
    }
  });
  try {
    const savedMax = Number(localStorage.getItem("fluidcan.jogMaxFeed"));
    if (Number.isFinite(savedMax) && savedMax > 0) setRawMaxFeed(savedMax);
  } catch {
    /* storage unavailable */
  }
  // Persisted backend value works in the desktop GUI too, where every launch
  // has a new random loopback origin and localStorage would be empty.
  void httpGet("/settings")
    .then((settings) => {
      const value = Number(settings.jog_max_feed);
      if (Number.isFinite(value) && value > 0) {
        setRawMaxFeed(value);
        syncFeedInputs();
      }
    })
    .catch(() => {});
  syncFeedInputs();
  setEnabled(false);
}
