import * as transport from "./core/transport.js";
import { patch, state } from "./core/store.js";
import { refreshOverview } from "./views/overview.js";
import { refreshCanView, runCanCommand } from "./views/can.js";
import { clearLog, jog, log, sendCommand, sendConsole, sendQuick, zeroAll, zeroAxis, zeroDriverAll, zeroDriverAxis } from "./views/control.js";
import { loadConfig, saveConfig } from "./views/config.js";
import * as install from "./views/install.js";
import { loadCanConfig, openConfigEditor } from "./views/dual-y.js";
import { resolveConnectTarget, scanMessage, scannedAddress } from "./core/session.js";

const $ = (id) => document.getElementById(id);

// The top bar has three independent flows and they must never trigger each
// other: connect reaches a typed/picked address, scan only discovers devices,
// and the serial port is its own link.
let scanBusy = false;
let connectBusy = false;
let serialBusy = false;

function setConn(ok, text) {
  const pill = $("connPill");
  if (!pill) return;
  pill.textContent = text || (ok ? "已连接" : "未连接");
  pill.className = "pill " + (ok ? "ok" : "bad");
  patch({ connected: ok });
}

function setBusyButton(id, busy, idleText, busyText) {
  const button = $(id);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function setScanPill(text, kind = "") {
  const msg = $("scanMsg");
  if (!msg) return;
  msg.textContent = text;
  msg.className = "pill" + (kind ? " " + kind : "");
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const view = $("view-" + name);
  if (view) view.classList.add("active");
}

// Discovery flow: only fills the scan picker (and the address input when
// exactly one device is found).  It never connects to anything.
async function scanDevices() {
  const select = $("scanResults");
  if (!select) return;
  if (scanBusy) {
    log("扫描已在进行中，请等待本次扫描结束", "err");
    return;
  }
  scanBusy = true;
  setBusyButton("scanBtn", true, "扫描设备", "扫描中...");
  select.disabled = true;
  setScanPill("扫描中...", "warn2");
  select.innerHTML = "<option>扫描中...</option>";
  try {
    const j = await transport.scan();
    const devices = j.devices || [];
    const picker = devices.length
      ? (devices.length > 1 ? '<option value="">扫描结果（选择设备）</option>' : "") +
        devices
          .map((d) => `<option value="${esc(d.url)}">${esc(d.version || "FluidNC")} · ${esc(d.ip)}</option>`)
          .join("")
      : '<option value="">未发现设备</option>';
    select.innerHTML = picker;
    const input = $("deviceUrl");
    const single = scannedAddress(devices);
    const filled = single && input && !input.value.trim() ? single : "";
    if (filled && input) input.value = filled;
    setScanPill(scanMessage(devices), devices.length ? "ok" : "bad");
    const subnets = (j.subnets || []).join(", ");
    log(`扫描 ${subnets}: ${devices.length} 台`, devices.length ? "ok" : "err");
    if (filled) log(`扫描结果已填入地址 ${filled}；点击“连接”连接该设备`, "ok");
    else if (single) log(`扫描到 1 台设备 ${single}；输入框已有地址，未覆盖（可清空后重扫或在“扫描结果”中选择）`, "ok");
    else if (devices.length > 1) log("扫描到多台设备：在“扫描结果”中选择一台，再点击“连接”", "ok");
  } catch (e) {
    select.innerHTML = '<option value="">扫描失败</option>';
    setScanPill("扫描失败", "bad");
    log(String(e), "err");
  } finally {
    scanBusy = false;
    select.disabled = false;
    setBusyButton("scanBtn", false, "扫描设备", "扫描中...");
  }
}

// Connect flow: uses the typed address first, then the scan picker selection.
// With neither it explains what to do and returns; it never falls back to a
// scan, so the two buttons stay independent.
async function connectDevice() {
  if (connectBusy) {
    log("连接正在处理中，请等待本次连接结束", "err");
    return;
  }
  const target = resolveConnectTarget($("deviceUrl")?.value, $("scanResults")?.value);
  if (!target) {
    setConn(false, "未选择设备");
    log("连接：请先输入设备地址，或在“扫描结果”中选择一台设备；扫描请用“扫描设备”按钮", "err");
    return;
  }
  connectBusy = true;
  setBusyButton("connectBtn", true, "连接", "连接中...");
  const pill = $("connPill");
  if (pill) {
    pill.textContent = "连接中...";
    pill.className = "pill warn2";
  }
  try {
    log("连接 " + target.url + (target.source === "scan" ? "（来自扫描结果）" : ""));
    const j = await transport.connectHttp(target.url);
    if (!j.connected) {
      const reason = j.probe || j.error || "设备无响应";
      setConn(false, "连接失败");
      log(`连接失败 ${j.requested || target.url}: ${reason}`, "err");
      return;
    }
    const base = j.base || target.url;
    if ($("deviceUrl")) $("deviceUrl").value = base;
    setConn(true, "已连接 " + base);
    log(`已连接 ${base}`, "ok");
    try {
      await refreshOverview();
    } catch (e) {
      log("已连接，但读取状态失败: " + e, "err");
    }
  } catch (e) {
    setConn(false, "连接失败");
    log(String(e), "err");
  } finally {
    connectBusy = false;
    setBusyButton("connectBtn", false, "连接", "连接中...");
  }
}

async function refreshPorts() {
  try {
    const j = await transport.ports();
    const ports = j.ports || [];
    const options =
      '<option value="">串口...</option>' +
      ports.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}</option>`).join("");
    const top = $("serialPorts");
    const flash = $("flashPort");
    const topValue = top.value;
    const flashValue = flash.value;
    top.innerHTML = options;
    flash.innerHTML = options;
    if (topValue) top.value = topValue;
    if (flashValue) flash.value = flashValue;
    log("串口: " + ports.map((p) => p.name).join(", "));
  } catch (e) {
    log(String(e), "err");
  }
}

// Serial flow: its own link.  It must not scan or connect over HTTP, and a
// failed open must not touch the WiFi connection state.
async function openSerial() {
  if (serialBusy) {
    log("串口正在打开中，请等待", "err");
    return;
  }
  const port = $("serialPorts").value;
  if (!port) {
    log("打开串口：请先选择串口（串口是独立于“连接/扫描”的链路）", "err");
    return;
  }
  serialBusy = true;
  setBusyButton("openSerialBtn", true, "打开串口", "打开中...");
  try {
    const j = await transport.openSerial(port);
    setConn(true, "串口 " + port);
    log("串口已打开 " + JSON.stringify(j) + "（串口链路）", "ok");
    startSerialPoll();
    try {
      await refreshOverview();
    } catch (e) {
      log("串口已打开，但读取状态失败: " + e, "err");
    }
  } catch (e) {
    setConn(false, "串口打开失败");
    log(String(e), "err");
  } finally {
    serialBusy = false;
    setBusyButton("openSerialBtn", false, "打开串口", "打开中...");
  }
}

let serialTimer = null;
let serialLast = 0;
function startSerialPoll() {
  if (serialTimer) clearInterval(serialTimer);
  serialLast = 0;
  serialTimer = setInterval(async () => {
    try {
      const j = await transport.serialLog();
      const lines = j.log || [];
      if (lines.length !== serialLast) {
        for (const line of lines.slice(serialLast)) log(line);
        serialLast = lines.length;
      }
    } catch {
      /* serial may be closed */
    }
  }, 800);
}

async function refreshAll() {
  try {
    await refreshOverview();
    log("总览刷新完成", "ok");
  } catch (e) {
    log(String(e), "err");
    setConn(false, "读取失败");
  }
}

async function refreshCan() {
  try {
    await refreshCanView();
    log("CAN 刷新完成", "ok");
  } catch (e) {
    log(String(e), "err");
  }
}

async function canCmd(command) {
  try {
    await runCanCommand(command);
  } catch (e) {
    log(String(e), "err");
  }
}

async function sendCmd(command) {
  try {
    await sendCommand(command);
    if (command === "?" || command.startsWith("$X") || command.startsWith("$H")) await refreshAll();
  } catch (e) {
    log(String(e), "err");
  }
}

async function run(kind, fn) {
  try {
    await fn();
  } catch (e) {
    log(String(e), "err");
    if (kind === "config" && $("cfgMsg")) $("cfgMsg").textContent = String(e);
    if (kind === "install" && $("remoteMsg")) $("remoteMsg").textContent = String(e);
  }
}

async function boot() {
  $("clock").textContent = new Date().toLocaleString();
  setInterval(() => {
    $("clock").textContent = new Date().toLocaleString();
  }, 1000);
  setConn(false, "未连接");
  log("FluidCAN Studio 已启动：“扫描设备”只发现设备，“连接”用地址输入框/扫描结果建立 WiFi 连接，串口是独立链路；启动只自动扫描一次，不自动连接。");
  setTimeout(scanDevices, 600);
  refreshPorts();
  $("serialPorts")?.addEventListener("change", () => {
    if ($("serialPorts").value) $("flashPort").value = $("serialPorts").value;
  });
  // Picking a discovered device only fills the address input; the user still
  // clicks "连接", so scanning never connects on its own.
  $("scanResults")?.addEventListener("change", () => {
    const url = $("scanResults").value;
    if (!url) return;
    $("deviceUrl").value = url;
    log(`已选择扫描结果 ${url}；点击“连接”连接该设备`, "ok");
  });
}

// Inline handlers in the static HTML call these names, so publish the
// well-defined app actions on window.  The implementations remain in modules.
Object.assign(window, {
  connectDevice,
  scanDevices,
  refreshPorts,
  openSerial,
  showView,
  refreshAll,
  refreshCan,
  canCmd,
  sendCmd,
  jog,
  zeroAxis,
  zeroAll,
  zeroDriverAxis,
  zeroDriverAll,
  sendQuick,
  sendConsole,
  clearLog,
  loadConfig: () => run("config", loadConfig),
  saveConfig: () => run("config", saveConfig),
  loadCanConfig: () => run("can", loadCanConfig),
  openConfigEditor,
  refreshRemote: () => run("install", install.refreshRemote),
  remoteOta: () => run("install", install.remoteOta),
  otaUpload: () => run("install", install.otaUpload),
  flashSerial: () => run("install", install.flashSerial),
  loadFirmware: () => run("install", install.loadFirmware),
  installToolchain: () => run("install", install.installToolchain),
});

boot();

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
