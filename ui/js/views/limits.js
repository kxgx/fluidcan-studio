// Read-only limit switch test panel.
//
// FluidNC reports currently triggered limit inputs in the realtime status
// `Pn:` field, e.g. "<Idle|MPos:...|FS:0,0|Pn:XY>".  This view polls `?` and
// shows the configured pins from config.yaml plus live triggered state.  It
// never sends motion or state-changing commands; the user triggers the switch
// by hand while watching the panel.
import { exec } from "../core/transport.js";
import { state } from "../core/store.js";
import { parsePinString } from "../core/parsers.js";
import { log } from "./control.js";

const $ = (id) => document.getElementById(id);
const POLL_MS = 800;

let timer = null;
let polling = false;
let lastAxes = new Map();
let last = { text: "", pins: "", probe: false, toolsetter: false, axes: [] };

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function configuredLimits() {
  return state.driverLayout && Array.isArray(state.driverLayout.limits) ? state.driverLayout.limits : [];
}

function pinText(pins) {
  const parts = [];
  if (pins.all.length) parts.push(`all ${pins.all.join(", ")}`);
  if (pins.neg.length) parts.push(`neg ${pins.neg.join(", ")}`);
  if (pins.pos.length) parts.push(`pos ${pins.pos.join(", ")}`);
  return parts.length ? parts.join("；") : "--";
}

function renderRows() {
  const box = $("limitTable");
  if (!box) return;
  const limits = configuredLimits();
  if (!limits.length) {
    box.innerHTML = '<span class="muted">尚未读取 config.yaml 的限位配置（请先连接设备）</span>';
    return;
  }
  const active = new Set(last.axes.map((axis) => axis.toUpperCase()));
  const rows = limits
    .map((entry) => {
      const triggered = active.has(entry.axis);
      return `<tr>
        <td class="mono">${esc(entry.axis)}</td>
        <td class="mono">${esc(pinText(entry.pins))}</td>
        <td class="${triggered ? "badtxt" : "oktxt"}">${triggered ? "触发" : "未触发"}</td>
      </tr>`;
    })
    .join("");
  const probe = last.probe ? "触发" : "未触发";
  const toolsetter = last.toolsetter ? "触发" : "未触发";
  box.innerHTML = `<table><thead><tr><th>轴</th><th>限位配置（config.yaml）</th><th>当前状态</th></tr></thead>
    <tbody>${rows}
      <tr><td class="mono">P</td><td class="mono">Probe</td><td class="${last.probe ? "badtxt" : "oktxt"}">${probe}</td></tr>
      <tr><td class="mono">T</td><td class="mono">Toolsetter</td><td class="${last.toolsetter ? "badtxt" : "oktxt"}">${toolsetter}</td></tr>
    </tbody></table>
    <div class="sub" style="margin-top:8px">Pn 原始值：${esc(last.pins || "（无触发）")} · 只读检测，不会移动电机；手动按动限位开关观察状态变化。</div>`;
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const status = await exec("?");
    last = { text: String(status || ""), ...parsePinString(status) };
    const active = new Set(last.axes.map((axis) => axis.toUpperCase()));
    for (const entry of configuredLimits()) {
      const was = lastAxes.get(entry.axis) === true;
      const now = active.has(entry.axis);
      if (now && !was) log(`限位触发：${entry.axis}`, "err");
      if (!now && was) log(`限位释放：${entry.axis}`, "ok");
      lastAxes.set(entry.axis, now);
    }
    const out = $("limitOut");
    if (out) out.textContent = last.text || "(无输出)";
    const msg = $("limitMsg");
    if (msg) {
      msg.textContent = `检测中 · ${new Date().toLocaleTimeString()}${last.pins ? " · " + last.pins : ""}`;
      msg.className = "pill warn2";
    }
    renderRows();
  } finally {
    polling = false;
  }
}

export async function readLimitsOnce() {
  await pollOnce();
  log(`限位状态：${last.pins || "无触发"}（Pn 为空）`, last.pins ? "err" : "ok");
}

export function stopLimitTest() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const button = $("limitTestBtn");
  if (button) button.textContent = "开始检测";
  const msg = $("limitMsg");
  if (msg) {
    msg.textContent = "已停止";
    msg.className = "pill";
  }
}

export function startLimitTest() {
  if (timer) return;
  if (!configuredLimits().length) {
    log("未读取 config.yaml 限位配置：请先连接设备", "err");
    const msg = $("limitMsg");
    if (msg) {
      msg.textContent = "缺少 config.yaml 限位配置";
      msg.className = "pill bad";
    }
    return;
  }
  lastAxes = new Map(configuredLimits().map((entry) => [entry.axis, false]));
  const button = $("limitTestBtn");
  if (button) button.textContent = "停止检测";
  const msg = $("limitMsg");
  if (msg) {
    msg.textContent = "检测中";
    msg.className = "pill warn2";
  }
  pollOnce().catch((e) => log("限位检测失败: " + e, "err"));
  timer = setInterval(() => {
    pollOnce().catch((e) => log("限位检测失败: " + e, "err"));
  }, POLL_MS);
}

export function toggleLimitTest() {
  if (timer) stopLimitTest();
  else startLimitTest();
}
