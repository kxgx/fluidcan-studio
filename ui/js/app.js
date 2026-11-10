import * as transport from "./core/transport.js";
import { patch, state } from "./core/store.js";
import { refreshOverview } from "./views/overview.js";
import { refreshCanView, runCanCommand } from "./views/can.js";
import { clearLog, jog, log, sendCommand, sendConsole, sendQuick, zeroAll, zeroAxis, zeroDriverAll, zeroDriverAxis } from "./views/control.js";
import { loadConfig, saveConfig } from "./views/config.js";
import * as install from "./views/install.js";
import { loadCanConfig, openConfigEditor } from "./views/dual-y.js";

const $ = (id) => document.getElementById(id);

function setConn(ok, text) {
  const pill = $("connPill");
  if (!pill) return;
  pill.textContent = text || (ok ? "已连接" : "未连接");
  pill.className = "pill " + (ok ? "ok" : "bad");
  patch({ connected: ok });
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const view = $("view-" + name);
  if (view) view.classList.add("active");
}

async function scanDevices() {
  const select = $("scanResults");
  const msg = $("scanMsg");
  if (!select || !msg) return;
  msg.textContent = "扫描中...";
  select.innerHTML = "<option>扫描中...</option>";
  try {
    const j = await transport.scan();
    const devices = j.devices || [];
    select.innerHTML = devices.length
      ? devices
          .map((d) => `<option value="${esc(d.url)}">${esc(d.version || "FluidNC")} · ${esc(d.ip)}</option>`)
          .join("")
      : '<option value="">未发现设备</option>';
    msg.textContent = devices.length ? `发现 ${devices.length} 台` : "未发现";
    log(`扫描 ${j.subnet || ""}: ${devices.length} 台`, devices.length ? "ok" : "err");
  } catch (e) {
    select.innerHTML = '<option value="">扫描失败</option>';
    msg.textContent = "扫描失败";
    log(String(e), "err");
  }
}

async function connectDevice() {
  const url = $("deviceUrl").value.trim();
  if (!url) {
    await scanDevices();
    return;
  }
  try {
    log("连接 " + url);
    const j = await transport.connectHttp(url);
    setConn(j.connected, j.connected ? "已连接 " + j.base : "连接失败");
    log(JSON.stringify(j), j.connected ? "ok" : "err");
    if (j.connected) await refreshOverview();
  } catch (e) {
    setConn(false, "连接失败");
    log(String(e), "err");
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

async function openSerial() {
  const port = $("serialPorts").value;
  if (!port) {
    log("先选择串口", "err");
    return;
  }
  try {
    const j = await transport.openSerial(port);
    setConn(true, "串口 " + port);
    log("串口已打开 " + JSON.stringify(j), "ok");
    startSerialPoll();
    await refreshOverview();
  } catch (e) {
    log(String(e), "err");
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
  log("FluidCAN Studio 已启动：自动扫描设备和串口，连接/打开串口由用户手动操作。");
  setTimeout(scanDevices, 600);
  refreshPorts();
  $("serialPorts")?.addEventListener("change", () => {
    if ($("serialPorts").value) $("flashPort").value = $("serialPorts").value;
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
