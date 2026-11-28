// LumenPnP compatibility / actuator view.
//
// Read-only checks and vacuum reads are safe to run on their own.  Every
// output, LED and motion action goes through an explicit confirmation and is
// never triggered automatically by loading this view.
import { exec, execChecked } from "../core/transport.js";
import { state, subscribe } from "../core/store.js";
import { configAxisNames, maxFeedForAxes } from "../core/drivers.js";

const $ = (id) => document.getElementById(id);

// The four switched outputs on the Lumen motherboard.  These names follow
// LumenCompat::pumpCommand: P0=Left_V, P1=Left_P, P2=Right_V, P3=Right_P.
export const LUMEN_OUTPUTS = [
  { p: 0, name: "VAC1 阀", side: "VAC1", role: "阀" },
  { p: 1, name: "VAC1 泵", side: "VAC1", role: "泵" },
  { p: 2, name: "VAC2 阀", side: "VAC2", role: "阀" },
  { p: 3, name: "VAC2 泵", side: "VAC2", role: "泵" },
];

// Original LumenPnP machine.xml sequence.  It selects one side of the
// PCA9545A mux, selects the sensor MSB register and reads one decimal byte.
const VACUUM_MUX = { 1: 1, 2: 2 };

export function vacuumCommands(side) {
  const mux = VACUUM_MUX[Number(side)];
  if (!mux) throw new Error("真空通道必须是 1 或 2");
  return [
    `M260 A112 B${mux} S1`,
    "M260 A109",
    "M260 B48",
    "M260 B10",
    "M260 S1",
    "M260 A109 B6 S1",
    "M261 A109 B1 S2",
  ];
}

export function parseVacuum(text) {
  const match = String(text || "").match(/data:\s*(-?\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

export function outputCommand(p, on) {
  const index = Number(p);
  if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error("输出 P 必须是 0..3");
  return on ? `M106 P${index} S255` : `M107 P${index}`;
}

export function ledCommand(name) {
  const presets = {
    off: "M150 P0",
    white: "M150 P255 R255 U255 B255",
    red: "M150 P255 R255 U0 B0",
    green: "M150 P255 R0 U255 B0",
    blue: "M150 P255 R0 U0 B255",
  };
  const command = presets[String(name || "").toLowerCase()];
  if (!command) throw new Error("未知灯光预设");
  return command;
}

function requireConnected() {
  if (!state.connected) throw new Error("设备未连接");
}

function buildVersion(build) {
  const match = String(build || "").match(/can-v(\d+)\.(\d+)\.(\d+)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function supportsLumenG28(build) {
  const version = buildVersion(build);
  if (!version) return false;
  const [major, minor, patch] = version;
  return major > 0 || (major === 0 && (minor > 2 || (minor === 2 && patch >= 36)));
}

async function requireG28Firmware() {
  // Read $I live instead of trusting state.build: an in-app OTA can downgrade
  // the controller without reconnecting the UI.
  const build = await exec("$I");
  const version = buildVersion(build);
  if (!supportsLumenG28(build)) {
    const shown = version ? version.join(".") : (String(build || "").trim() || "未知");
    throw new Error(`G28 回零需要 can-v0.2.36+ 固件（当前 ${shown}）；旧固件 G28 是 FluidNC 原生移动，不是 Marlin 回零`);
  }
  if (!state.lumenConfigured) {
    throw new Error("当前 config.yaml 不含 lumen: 段；G28 会走 FluidNC 原生预置点移动，已拒绝");
  }
}

async function ensureHomingAllowed() {
  const status = String(await exec("?")).trim();
  if (!/^<(Idle|Alarm)/.test(status)) {
    throw new Error(`当前状态不允许回零: ${status || "未知"}`);
  }
}

let lumenCompat = null;
let lastLumenBuild = "";
let actionBusy = false;
let vacuumBusy = false;

async function requireLumen() {
  requireConnected();
  if (lumenCompat === true) return;
  const text = await exec("M115");
  if (!/LumenPnP\s+COMPATIBLE/i.test(text)) {
    throw new Error("固件未报告 LumenPnP 兼容层（M115），已拒绝执行");
  }
  lumenCompat = true;
}

function busyMessage() {
  setStatus("上一个 Lumen 动作尚未完成", "warn2");
}

async function withActionBusy(fn) {
  if (actionBusy) {
    busyMessage();
    return;
  }
  actionBusy = true;
  try {
    return await fn();
  } finally {
    actionBusy = false;
  }
}

async function ensureMotionReady(axis) {
  const layout = state.driverLayout;
  const axes = Array.isArray(layout?.axes) ? layout.axes.map((a) => String(a).toUpperCase()) : [];
  if (!axes.length) throw new Error("尚未读取 config.yaml 轴配置");
  if (!axes.includes(String(axis).toUpperCase())) throw new Error(`config 中没有 ${axis} 轴`);
  const status = await exec("?");
  if (!/^<Idle/m.test(String(status).trim())) throw new Error(`机器不在 Idle，拒绝点动: ${String(status).trim()}`);
}

function setStatus(text, kind = "") {
  const el = $("lumenStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "pill" + (kind ? ` ${kind}` : "");
}

function append(text) {
  const out = $("lumenOut");
  if (!out) return;
  const stamp = new Date().toLocaleTimeString();
  out.textContent += `[${stamp}] ${text}\n`;
  out.scrollTop = out.scrollHeight;
}

async function send(command) {
  requireConnected();
  append(`> ${command}`);
  try {
    const text = await execChecked(command);
    append(text.trim() || "(无输出)");
    return text;
  } catch (e) {
    append(`错误: ${String(e)}`);
    throw e;
  }
}

export function clearLumenOut() {
  const out = $("lumenOut");
  if (out) out.textContent = "";
}

const READ_ONLY_TESTS = [
  { name: "$I 固件版本", cmd: "$I", ok: (t) => /\[VER:/.test(t) },
  { name: "? 状态", cmd: "?", ok: (t) => t.includes("<") },
  { name: "M114 位置", cmd: "M114", ok: (t) => /[XYZAB]:/.test(t) },
  { name: "M115 固件信息", cmd: "M115", ok: (t) => t.trim().length > 0 },
  { name: "$CANStatus", cmd: "$CANStatus", ok: (t) => t.trim().length > 0 },
  { name: "$CANPos", cmd: "$CANPos", ok: (t) => t.trim().length > 0 },
];

let readOnlyToken = 0;

function testRow(name, command, status = "等待", result = "") {
  const body = $("lumenTestRows");
  if (!body) return null;
  let row = [...body.querySelectorAll("tr")].find((tr) => tr.dataset.command === command);
  if (!row) {
    row = document.createElement("tr");
    row.dataset.command = command;
    row.innerHTML = `<td>${name}</td><td class="mono">${command}</td><td></td><td class="lumen-result"></td>`;
    body.appendChild(row);
  }
  row.children[2].innerHTML = `<span class="pill ${status === "通过" ? "ok" : status === "失败" ? "bad" : "warn2"}">${status}</span>`;
  row.children[3].textContent = result;
  return row;
}

export async function runLumenReadOnlyTests() {
  const token = ++readOnlyToken;
  const body = $("lumenTestRows");
  if (body) body.innerHTML = "";
  const button = $("lumenTestBtn");
  if (button) button.disabled = true;
  setStatus("只读测试中…", "warn2");
  let failed = 0;
  try {
    requireConnected();
    for (const test of READ_ONLY_TESTS) {
      if (token !== readOnlyToken) return;
      testRow(test.name, test.cmd, "运行中");
      const started = performance.now();
      try {
        const text = await exec(test.cmd);
        if (token !== readOnlyToken) return;
        const passed = test.ok(text);
        const elapsed = Math.round(performance.now() - started);
        testRow(test.name, test.cmd, passed ? "通过" : "失败", `${elapsed}ms · ${String(text).replace(/\s+/g, " ").slice(0, 80)}`);
        if (!passed) failed++;
        append(`> ${test.cmd}\n${String(text).trim() || "(无输出)"}`);
      } catch (e) {
        if (token !== readOnlyToken) return;
        failed++;
        testRow(test.name, test.cmd, "失败", String(e));
        append(`> ${test.cmd}\n错误: ${String(e)}`);
      }
    }
    setStatus(failed ? `${failed} 项失败` : "只读测试通过", failed ? "bad" : "ok");
  } catch (e) {
    setStatus(String(e), "bad");
    append(`只读测试未执行: ${String(e)}`);
  } finally {
    if (button && token === readOnlyToken) button.disabled = false;
  }
}

export async function readVacuum(side) {
  const which = Number(side);
  if (which !== 1 && which !== 2) throw new Error("真空通道必须是 1 或 2");
  if (vacuumBusy) {
    busyMessage();
    return;
  }
  vacuumBusy = true;
  const button1 = $("lumenVac1Btn");
  const button2 = $("lumenVac2Btn");
  if (button1) button1.disabled = true;
  if (button2) button2.disabled = true;
  setStatus(`读取 VAC${which}…`, "warn2");
  const valueEl = $(`lumenVac${which}`);
  if (valueEl) valueEl.textContent = "--";
  try {
    await requireLumen();
    let last = "";
    for (const command of vacuumCommands(which)) last = await send(command);
    const value = parseVacuum(last);
    const el = $(`lumenVac${which}`);
    if (el) el.textContent = value == null ? (last.trim() || "无数据") : String(value);
    setStatus(value == null ? `VAC${which} 无数据` : `VAC${which} ${value}`, value == null ? "bad" : "ok");
    return value;
  } catch (e) {
    setStatus(String(e), "bad");
    throw e;
  } finally {
    vacuumBusy = false;
    if (button1) button1.disabled = false;
    if (button2) button2.disabled = false;
  }
}

export async function setLumenOutput(p, on) {
  return withActionBusy(async () => {
    const item = LUMEN_OUTPUTS.find((entry) => entry.p === Number(p));
    const command = outputCommand(p, on);
    const label = item ? item.name : `P${p}`;
    if (!confirm(`${on ? "打开" : "关闭"} ${label}？\n命令: ${command}\n\n这会切换真实执行机构输出。`)) return;
    setStatus(`${on ? "打开" : "关闭"} ${label}…`, "warn2");
    try {
      await requireLumen();
      await send(command);
      setStatus(`${label} ${on ? "已开" : "已关"}`, "ok");
    } catch (e) {
      setStatus(String(e), "bad");
      throw e;
    }
  });
}

export async function setLumenLed(preset) {
  return withActionBusy(async () => {
    const command = ledCommand(preset);
    if (!confirm(`发送灯光命令？\n${command}`)) return;
    setStatus("灯光命令…", "warn2");
    try {
      await requireLumen();
      await send(command);
      setStatus(`灯光 ${preset}`, "ok");
    } catch (e) {
      setStatus(String(e), "bad");
      throw e;
    }
  });
}

function lumenJogConfig() {
  const axis = String($("lumenJogAxis")?.value || "Z").toUpperCase();
  const amount = Number($("lumenJogAmount")?.value);
  const requestedFeed = Number($("lumenJogFeed")?.value);
  const cap = maxFeedForAxes(state.driverLayout, [axis]);
  const limit = Number.isFinite(cap) && cap > 0 ? cap : 1000;
  const feed = Number.isFinite(requestedFeed) && requestedFeed > 0 ? Math.min(requestedFeed, limit) : Math.min(1000, limit);
  return { axis, amount, feed, limit };
}

const MOTION_COMMANDS = new Set(["?", "M114", "$X", "$ME", "$MD"]);

export function motionCommand(command) {
  const value = String(command || "").trim().toUpperCase();
  if (!MOTION_COMMANDS.has(value)) throw new Error("不支持的运动测试命令");
  return value;
}

export async function lumenMotion(command) {
  return withActionBusy(async () => {
    const cmd = motionCommand(command);
    const readOnly = cmd === "?" || cmd === "M114";
    if (!readOnly && !confirm(`发送运动测试命令 ${cmd}？\n\n这会改变电机/报警状态，请确认运动范围和急停方式。`)) return;
    setStatus(`${cmd} 发送中…`, "warn2");
    try {
      // $X is FluidNC's native alarm unlock; M115 is rejected while in Alarm,
      // so the unlock path must not depend on the Lumen gcode gate.
      if (!readOnly && cmd !== "$X") await requireLumen();
      const text = await send(cmd);
      setStatus(`${cmd} ${readOnly ? "读取完成" : "完成"}`, "ok");
      append(`${cmd} 返回: ${String(text).trim() || "ok"}`);
    } catch (e) {
      setStatus(String(e), "bad");
      throw e;
    }
  });
}

export function g28Command(axes = "") {
  const suffix = String(axes || "").trim().toUpperCase();
  if (!suffix) return "G28";
  if (!/^[XYZ]+$/.test(suffix) || new Set(suffix).size !== suffix.length) {
    throw new Error("G28 轴只允许不重复的 X/Y/Z");
  }
  return `G28 ${suffix}`;
}

export async function lumenG28(axes = "") {
  return withActionBusy(async () => {
    const command = g28Command(axes);
    const suffix = String(axes || "").trim().toUpperCase();
    if (!confirm(`执行 ${command} 回零？\n\n这会移动 ${suffix || "全部 X/Y/Z"} 轴；\n请确认运动范围无人和障碍物，异常时立即停止/断电。`)) return;
    setStatus(`${command} 回零中…`, "warn2");
    try {
      // G28's Marlin semantics are version-gated; M115 itself is rejected in
      // Alarm, and Alarm is exactly when the user may legitimately need G28.
      await requireG28Firmware();
      if (suffix) {
        const layout = state.driverLayout;
        const names = Array.isArray(layout?.axes) ? layout.axes.map((a) => String(a).toUpperCase()) : [];
        for (const axis of suffix) {
          if (!names.includes(axis)) throw new Error(`config 中没有 ${axis} 轴`);
        }
      }
      await ensureHomingAllowed();
      const text = await send(command);
      append(`G28 返回: ${String(text).trim() || "ok"}`);
      setStatus(`${command} 完成`, "ok");
    } catch (e) {
      const message = String(e);
      if (e?.timeout || /超时|timeout|timed out/i.test(message)) {
        append("G28 超时：固件可能仍在回零。请等待状态变为 Idle，异常时急停/断电；不要立即重复发送。");
        setStatus("G28 超时，请检查状态后再操作", "bad");
      } else {
        setStatus(message, "bad");
      }
      throw e;
    }
  });
}

export async function lumenJog(sign) {
  return withActionBusy(async () => {
    const { axis, amount, feed } = lumenJogConfig();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("距离/角度必须大于 0");
    const unit = axis === "A" || axis === "B" ? "°" : "mm";
    const command = `$J=G91${axis}${sign > 0 ? amount : -amount}F${feed}`;
    if (!confirm(`${axis} 轴${sign > 0 ? "正向" : "反向"} ${amount}${unit}？\n命令: ${command}\n\n请确认运动范围内无人和障碍物。`)) return;
    setStatus(`${axis} 点动…`, "warn2");
    try {
      await requireLumen();
      await ensureMotionReady(axis);
      await send(command);
      setStatus(`${axis} 命令已发送`, "ok");
    } catch (e) {
      setStatus(String(e), "bad");
      throw e;
    }
  });
}

export function initLumen() {
  const axis = $("lumenJogAxis");
  const amount = $("lumenJogAmount");
  const feed = $("lumenJogFeed");
  if (!axis || !amount || !feed || axis.dataset.ready === "1") return;
  axis.dataset.ready = "1";

  const syncAxes = () => {
    const configured = configAxisNames(state.driverLayout).map((a) => String(a).toUpperCase());
    const defaults = ["X", "Y", "Z", "A", "B"];
    const options = configured.length ? configured : defaults;
    const previous = String(axis.value || "").toUpperCase();
    if ([...axis.options].map((o) => o.value).join(",") !== options.join(",")) {
      axis.replaceChildren(...options.map((a) => {
        const option = document.createElement("option");
        option.value = a;
        option.textContent = a;
        return option;
      }));
    }
    const preferred = options.includes(previous) ? previous : options.includes("Z") ? "Z" : options[0];
    axis.value = preferred;
  };

  const sync = () => {
    syncAxes();
    const a = String(axis.value || "Z").toUpperCase();
    const rotary = a === "A" || a === "B";
    amount.title = rotary ? "角度（°）" : "距离（mm）";
    amount.value = "1";
    const cap = maxFeedForAxes(state.driverLayout, [a]);
    const limit = Number.isFinite(cap) && cap > 0 ? cap : 1000;
    feed.max = String(limit);
    if (!Number.isFinite(Number(feed.value)) || Number(feed.value) <= 0 || Number(feed.value) > limit) feed.value = String(Math.min(limit, 1000));
  };
  axis.addEventListener("change", sync);
  let lastLayout = null;
  subscribe(() => {
    if (!state.connected || state.build !== lastLumenBuild) {
      lumenCompat = null;
      lastLumenBuild = state.build;
    }
    if (state.driverLayout !== lastLayout) {
      lastLayout = state.driverLayout;
      sync();
    }
  });
  sync();
}
