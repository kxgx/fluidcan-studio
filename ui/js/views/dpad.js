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
import { sendCommand } from "./control.js";

const GAMEPAD_POLL_MS = 80;

const $ = (id) => document.getElementById(id);

let initialized = false;
let enabled = false;
let busy = false;
let gamepadTimer = null;
let lastGamepadButton = null;
const gamepadStabilizer = makeDirectionStabilizer(2);
const stickStabilizer = makeDirectionStabilizer(2);
let stickPointer = null;

function status(text, kind = "") {
  const el = $("dpadStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "pill" + (kind ? ` ${kind}` : "");
}

function currentPlane() {
  return normalizePlane($("dpadPlane")?.value);
}

function currentStep() {
  return {
    distance: parseFloat($("jogDist")?.value) || 1,
    feed: parseFloat($("jogFeed")?.value) || 500,
    plane: currentPlane(),
  };
}

function layoutHasPlaneAxes(plane) {
  const layout = state.driverLayout;
  if (!layout || !Array.isArray(layout.axes) || !layout.axes.length) return true;
  return planeAxes(plane).every((axis) => layout.axes.includes(axis));
}

async function step(direction, source = "direction") {
  if (!enabled) {
    status("方向键未启用", "warn2");
    return;
  }
  if (!state.connected) {
    status("设备未连接", "bad");
    return;
  }
  const { distance, feed, plane } = currentStep();
  if (!(distance > 0) || !(feed > 0)) {
    status("步距/进给必须大于 0", "bad");
    return;
  }
  if (!layoutHasPlaneAxes(plane)) {
    status(`${plane} 平面缺少轴配置`, "bad");
    return;
  }
  const command = directionToJog(plane, direction, distance, feed);
  if (!command) {
    status("无效方向或步距", "bad");
    return;
  }
  if (busy) return;
  busy = true;
  const label = directionLabel(plane, direction);
  status(`${source} ${label} · ${command}`, "warn2");
  try {
    const output = await sendCommand(command);
    if (/(^|\n)\s*(error:|ALARM:)/i.test(String(output || ""))) {
      status(`${source} ${label} 被控制器拒绝`, "bad");
    } else {
      status(`${source} ${label} 已发送`, "ok");
    }
  } catch (e) {
    status(`方向键失败: ${String(e)}`, "bad");
  } finally {
    busy = false;
  }
}

function setEnabled(next) {
  enabled = Boolean(next);
  const fieldset = $("dpadFieldset");
  if (fieldset) fieldset.disabled = !enabled;
  const checkbox = $("dpadEnable");
  if (checkbox) checkbox.checked = enabled;
  if (!enabled) {
    lastGamepadButton = null;
    gamepadStabilizer(null);
    stickStabilizer(null);
    stickPointer = null;
    stopGamepadPoll();
    resetStickVisual();
    status("方向键未启用", "warn2");
  } else {
    startGamepadPoll();
    status(state.connected ? "方向键已启用（每次一个步距）" : "等待连接设备", state.connected ? "ok" : "warn2");
  }
}

function keyboardHandler(event) {
  if (!enabled || !state.connected) return;
  const view = $("view-control");
  if (!view || !view.classList.contains("active")) return;
  if (event.ctrlKey || event.altKey || event.metaKey) return;
  if (isTypingTarget(event.target)) return;
  const wasd = Boolean($("dpadWasd")?.checked);
  const direction = keyboardDirection(event.key, { wasd });
  if (!direction) return;
  event.preventDefault();
  if (event.repeat) return; // one step per physical key press
  void step(direction, "键盘");
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
    const button = event.target.closest("[data-dir]");
    button?.setPointerCapture?.(event.pointerId);
    void step(direction, "虚拟");
  });
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

function pollGamepad() {
  if (!enabled || !state.connected) return;
  const view = $("view-control");
  if (!view || !view.classList.contains("active")) {
    lastGamepadButton = null;
    gamepadStabilizer(null);
    return;
  }
  const pads = gamepads();
  if (!pads.length) {
    lastGamepadButton = null;
    gamepadStabilizer(null);
    gamepadStatus("手柄：未连接");
    return;
  }
  const pad = pads[0];
  const standard = pad.mapping == null || pad.mapping === "standard";
  if (!standard) {
    lastGamepadButton = null;
    gamepadStabilizer(null);
    gamepadStatus("手柄：非 standard 映射，已忽略");
    return;
  }
  gamepadStatus(`手柄：${pad.id || "已连接"}`, "ok");
  // Digital D-pad is edge-triggered immediately; only the analog stick needs
  // sample stabilization to reject boundary jitter.
  const button = gamepadButtonDirection(pad);
  if (button) {
    if (button !== lastGamepadButton) void step(button, "手柄");
    lastGamepadButton = button;
    gamepadStabilizer(null);
    return;
  }
  lastGamepadButton = null;
  const direction = gamepadStabilizer(gamepadStickDirection(pad));
  if (direction) void step(direction, "手柄");
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
    if (!stickPointer || event.pointerId !== stickPointer) return;
    event.preventDefault();
    const { dx, dy } = virtualStickVector(event, stick);
    updateStickVisual(dx, dy);
    const direction = stickStabilizer(stickDirection(dx, dy));
    if (direction) void step(direction, "虚拟手柄");
  };
  const end = (event) => {
    if (!stickPointer || event.pointerId !== stickPointer) return;
    stickPointer = null;
    stickStabilizer(null);
    resetStickVisual();
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
    stickPointer = event.pointerId;
    stick.setPointerCapture?.(event.pointerId);
    const { dx, dy } = virtualStickVector(event, stick);
    updateStickVisual(dx, dy);
    // Seed two samples so a tap on the stick is immediately usable, while
    // still rejecting alternating boundary jitter.
    stickStabilizer(stickDirection(dx, dy));
    const direction = stickStabilizer(stickDirection(dx, dy));
    if (direction) void step(direction, "虚拟手柄");
  });
  stick.addEventListener("pointermove", move);
  stick.addEventListener("pointerup", end);
  stick.addEventListener("pointercancel", end);
  stick.addEventListener("lostpointercapture", () => {
    stickPointer = null;
    stickStabilizer(null);
    resetStickVisual();
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
    gamepadStabilizer(null);
    stickStabilizer(null);
  });
  bindVirtualButtons();
  bindVirtualStick();
  window.addEventListener("keydown", keyboardHandler);
  window.addEventListener("gamepadconnected", () => {
    if (enabled) gamepadStatus(`手柄：${gamepads()[0]?.id || "已连接"}`, "ok");
  });
  window.addEventListener("gamepaddisconnected", () => {
    lastGamepadButton = null;
    gamepadStabilizer(null);
    gamepadStatus("手柄：未连接");
  });
  subscribe(() => {
    if (!state.connected) {
      lastGamepadButton = null;
      gamepadStabilizer(null);
      stickStabilizer(null);
      stickPointer = null;
      resetStickVisual();
      if (enabled) status("设备未连接", "bad");
    } else if (enabled) {
      status("方向键已启用（每次一个步距）", "ok");
    }
  });
  setEnabled(false);
}
