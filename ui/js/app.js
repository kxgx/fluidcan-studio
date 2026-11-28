import * as transport from "./core/transport.js";
import { patch, state } from "./core/store.js";
import { refreshStatus, refreshCanData, refreshFirmwareInBackground, resetOverviewPanels } from "./views/overview.js";
import { runCanCommand } from "./views/can.js";
import { clearLog, jog, log, sendCommand, sendConsole, sendQuick, zeroAll, zeroAxis, zeroDriverAll, zeroDriverAxis } from "./views/control.js";
import { loadConfig, resetConfigState, saveConfig } from "./views/config.js";
import * as install from "./views/install.js";
import { loadCanConfig, openConfigEditor } from "./views/dual-y.js";
import { resolveConnectTarget, scanMessage, scannedAddress } from "./core/session.js";
import { parseConfigMap } from "./core/yconfig.js";
import { parseDriverLayout } from "./core/drivers.js";
import { readLimitsOnce, stopLimitTest, toggleLimitTest } from "./views/limits.js";
import { clearLumenOut, initLumen, lumenJog, readVacuum, runLumenReadOnlyTests, setLumenLed, setLumenOutput } from "./views/lumen.js";
import { initDirectionControls, stopDirectionJog } from "./views/dpad.js";

const $ = (id) => document.getElementById(id);

// The top bar has three independent flows and they must never trigger each
// other: connect reaches a typed/picked address, scan only discovers devices,
// and the serial port is its own link.
let scanBusy = false;
let connectBusy = false;
let serialBusy = false;
// Set when boot prefilled the address from the last session, so a scan can
// replace that stale value with the device it actually found.  Cleared as soon
// as the user edits the address.
let autoPrefilledDevice = "";

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

// Repaint the connection pill from the active transport.  A transient read
// failure must not leave a stale "读取失败" pill after the link recovers.
function resetDeviceState() {
  // A new link must not inherit the previous controller's build, driver
  // firmware report or CAN snapshot.  The install view uses state.build for
  // hardware auto-detection, so stale values are a safety issue, not just UI.
  canRefreshPromise = null;
  canRefreshKey = "";
  patch({
    build: "",
    buildSource: "",
    status: "",
    can: { status: "", faults: "", positions: "", drivers: "" },
    firmwareDrivers: "",
    firmwareError: "",
    driverLayout: null,
    drivers: [],
  });
  resetConfigState();
  resetOverviewPanels();
}

function setLinkPillFromTransport() {
  const mode = transport.currentMode();
  if (mode === "serial") {
    setConn(true, "串口 " + transport.currentSerial());
  } else if (mode === "http") {
    setConn(true, "已连接 " + transport.currentHttpBase());
  }
}

function setScanPill(text, kind = "") {
  const msg = $("scanMsg");
  if (!msg) return;
  msg.textContent = text;
  msg.className = "pill" + (kind ? " " + kind : "");
}

// CAN report commands can take tens of seconds when a driver is unpowered,
// so they never block connecting or status refreshes.  Only one CAN read runs
// at a time; extra requests reuse the in-flight one.
let canRefreshPromise = null;
let canRefreshKey = "";

function currentTransportKey() {
  return transport.currentMode() === "serial"
    ? "serial:" + transport.currentSerial()
    : "http:" + transport.currentHttpBase();
}

function refreshCanInBackground(reason = "") {
  const key = currentTransportKey();
  if (canRefreshPromise && canRefreshKey === key) {
    log("CAN 数据正在读取中" + (reason ? `（${reason}）` : ""));
    return canRefreshPromise;
  }
  canRefreshKey = key;
  log("CAN 数据读取中…");
  canRefreshPromise = refreshCanData()
    .then((result) => {
      if (result?.stale) return result;
      log(`CAN 数据已更新（${(result.elapsedMs / 1000).toFixed(1)}s）`, "ok");
      return result;
    })
    .catch((e) => {
      log("CAN 读取失败: " + e, "err");
      return { error: String(e) };
    })
    .finally(() => {
      if (canRefreshKey === key) {
        canRefreshPromise = null;
        canRefreshKey = "";
      }
    });
  return canRefreshPromise;
}

function applyAxisOptions(layout) {
  const select = $("jogAxis");
  if (!select) return;
  const axes = layout && Array.isArray(layout.axes) ? layout.axes : [];
  if (!axes.length) return;
  const previous = select.value;
  select.innerHTML = axes.map((axis) => `<option>${esc(axis)}</option>`).join("");
  select.value = axes.includes(previous) ? previous : axes[0];
}

// config.yaml is the single source of truth for driver addresses, axis roles
// and the expected CAN driver count.  It is loaded after connecting; on failure
// driver-zero commands are disabled instead of falling back to hard-coded
// addresses.
async function loadDriverLayout() {
  const expected = currentTransportKey();
  try {
    const j = await transport.getDeviceConfig();
    if (currentTransportKey() !== expected) return null;
    const layout = parseDriverLayout(parseConfigMap(j.yaml));
    patch({ driverLayout: layout });
    applyAxisOptions(layout);
    const addressText = layout.addressList.length ? layout.addressList.join(",") : "无";
    log(
      `config.yaml：${layout.count} 台驱动器（地址 ${addressText}）`,
      layout.warnings.length ? "err" : "ok",
    );
    for (const warning of layout.warnings) log("config.yaml 警告: " + warning, "err");
    return layout;
  } catch (e) {
    if (currentTransportKey() !== expected) return null;
    patch({ driverLayout: null });
    log("读取 config.yaml 失败: " + e, "err");
    return null;
  }
}

function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  const view = $("view-" + name);
  if (view) view.classList.add("active");
  // The limit test polls and continuous jog must stop when leaving motion.
  if (name !== "control") {
    stopLimitTest();
    stopDirectionJog();
  }
  if (name === "lumen") initLumen();
}

// Discovery flow: only fills the scan picker (and the address input when
// exactly one device is found).  It never connects to anything.
async function scanDevices() {
  const select = $("scanResults");
  if (!select) return;
  if (scanBusy) {
    log("扫描进行中", "err");
    return;
  }
  scanBusy = true;
  const started = Date.now();
  setBusyButton("scanBtn", true, "扫描设备", "扫描中...");
  select.disabled = true;
  setScanPill("扫描中...", "warn2");
  select.innerHTML = "<option>扫描中…</option>";
  try {
    const j = await transport.scan();
    const devices = j.devices || [];
    const picker = devices.length
      ? (devices.length > 1 ? '<option value="">选择设备</option>' : "") +
        devices
          .map((d) => `<option value="${esc(d.url)}">${esc(d.version || "FluidNC")} · ${esc(d.ip)}</option>`)
          .join("")
      : '<option value="">未发现设备</option>';
    select.innerHTML = picker;
    const input = $("deviceUrl");
    const current = input?.value.trim() || "";
    const stalePrefill = current !== "" && current === autoPrefilledDevice;
    // Only overwrite an empty input, or the stale last-session prefill the
    // user has not edited yet.  Never overwrite a hand-typed address.
    const single = scannedAddress(devices);
    const filled = single && input && (!current || stalePrefill) ? single : "";
    if (filled && input) {
      input.value = filled;
      autoPrefilledDevice = "";
    } else if (devices.length > 1 && stalePrefill && input) {
      // Several candidates and the input only held the stale last-session
      // address: clear it so the user picks from the scan result instead of
      // connecting to the wrong device.
      input.value = "";
      autoPrefilledDevice = "";
      log("请选择扫描结果", "err");
    }
    setScanPill(scanMessage(devices), devices.length ? "ok" : "bad");
    const subnets = (j.subnets || []).join(", ");
    log(`扫描 ${subnets}: ${devices.length} 台（${((Date.now() - started) / 1000).toFixed(1)}s）`, devices.length ? "ok" : "err");
    if (filled) log(`已填入 ${filled}，点“连接”`, "ok");
    else if (single) log(`发现 ${single}；未覆盖已输入地址`, "ok");
    else if (devices.length > 1) log("发现多台，请选择一台", "ok");
    if (!devices.length && canRefreshPromise) {
      log("CAN 读取中，稍后重扫", "err");
    }
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
  // A held direction button must not keep moving the current device while the
  // operator is switching links.
  await stopDirectionJog();
  if (connectBusy) {
    log("连接处理中", "err");
    return;
  }
  const target = resolveConnectTarget($("deviceUrl")?.value, $("scanResults")?.value);
  if (!target) {
    setConn(false, "未选择设备");
    log("连接：请先输入设备地址，或在“扫描结果”中选择一台设备；扫描请用“扫描设备”按钮", "err");
    return;
  }
  connectBusy = true;
  const started = Date.now();
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
      const active = transport.currentMode() === "http" ? transport.currentHttpBase() : "";
      if (active) {
        setConn(true, "已连接 " + active);
        log(`切换失败，仍连接 ${active}: ${reason}`, "err");
      } else {
        setConn(false, "连接失败");
        log(`连接失败 ${j.requested || target.url}: ${reason}`, "err");
      }
      if (canRefreshPromise) log("提示：CAN 数据正在后台读取，设备可能忙于响应；稍等后重试连接", "err");
      return;
    }
    const base = j.base || target.url;
    if ($("deviceUrl")) $("deviceUrl").value = base;
    autoPrefilledDevice = "";
    try {
      localStorage.setItem("fluidcan.lastDevice", base);
    } catch {
      /* localStorage may be unavailable */
    }
    setConn(true, "已连接 " + base);
    log(`WiFi 已连接 ${base}（${Date.now() - started} ms），正在同步状态…`, "ok");
    // Driver layout is parsed from the device's config.yaml; it does not block
    // the connect flow.
    resetDeviceState();
    void loadDriverLayout();
    // The probe already proved the link.  Do not keep the button in
    // "连接中..." while the separate status/CAN reports run; a slow/busy
    // controller must not make a successful connect look stuck.
    // The controller's command channel is single-threaded.  Finish the fast
    // status query before starting the slow CAN reports, otherwise a pending
    // CAN report can delay `$I`/`?` and make a healthy link look broken.
    void refreshStatus()
      .then(() => log(`状态已同步（${((Date.now() - started) / 1000).toFixed(1)}s）`, "ok"))
      .catch((e) => log("已连接，但读取状态失败: " + e, "err"))
      .finally(() => {
        refreshCanInBackground("连接后").finally(() => void refreshFirmwareInBackground());
      });
  } catch (e) {
    const active = transport.currentMode() === "http" ? transport.currentHttpBase() : "";
    if (active) {
      setConn(true, "已连接 " + active);
      log("切换失败，仍连接 " + active + ": " + e, "err");
    } else {
      setConn(false, "连接失败");
      log(String(e), "err");
    }
  } finally {
    connectBusy = false;
    setBusyButton("connectBtn", false, "连接", "连接中...");
  }
}

async function closeSerial() {
  await stopDirectionJog();
  const wasSerial = transport.currentMode() === "serial";
  try {
    await transport.closeSerial();
    log("串口已关闭", "ok");
  } catch (e) {
    log("关闭串口失败: " + e, "err");
    return;
  }
  if (!wasSerial) return;
  stopSerialPoll();
  setConn(false, "未连接");
  resetDeviceState();
}

let portsRefreshPromise = null;
function refreshPorts() {
  if (portsRefreshPromise) return portsRefreshPromise;
  portsRefreshPromise = refreshPortsOnce().finally(() => {
    portsRefreshPromise = null;
  });
  return portsRefreshPromise;
}

async function refreshPortsOnce() {
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
  await stopDirectionJog();
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
  const started = Date.now();
  setBusyButton("openSerialBtn", true, "打开串口", "打开中...");
  try {
    const j = await transport.openSerial(port);
    setConn(true, "串口 " + port);
    log("串口已打开 " + JSON.stringify(j) + "（串口链路）", "ok");
    resetDeviceState();
    void loadDriverLayout();
    startSerialPoll();
    void refreshStatus()
      .then(() => log(`状态已同步（${((Date.now() - started) / 1000).toFixed(1)}s）`, "ok"))
      .catch((e) => log("串口已打开，但读取状态失败: " + e, "err"))
      .finally(() => {
        refreshCanInBackground("串口连接后").finally(() => void refreshFirmwareInBackground());
      });
  } catch (e) {
    log(String(e), "err");
    // A failed serial open must not paint over an already working WiFi link.
    if (transport.currentMode() === "http" && transport.currentHttpBase()) {
      setConn(true, "已连接 " + transport.currentHttpBase());
    } else {
      setConn(false, "串口打开失败");
    }
  } finally {
    serialBusy = false;
    setBusyButton("openSerialBtn", false, "打开串口", "打开中...");
  }
}

let serialTimer = null;
let serialLast = 0;
function stopSerialPoll() {
  if (serialTimer) {
    clearInterval(serialTimer);
    serialTimer = null;
  }
}
function startSerialPoll() {
  stopSerialPoll();
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
    const started = Date.now();
    await refreshStatus();
    // Always reload config.yaml: soft limits and axis ranges may have been
    // changed on the device without reconnecting.
    await loadDriverLayout();
    setLinkPillFromTransport();
    log(`状态已刷新（${((Date.now() - started) / 1000).toFixed(1)}s），CAN 数据后台读取中`, "ok");
    refreshCanInBackground("刷新").finally(() => void refreshFirmwareInBackground(true));
  } catch (e) {
    log(String(e), "err");
    setConn(false, "读取失败");
  }
}

async function refreshCan() {
  const result = await refreshCanInBackground("刷新 CAN");
  if (result && result.error) log("CAN 刷新失败: " + result.error, "err");
  else log("CAN 刷新完成", "ok");
}

async function canCmd(command) {
  try {
    await runCanCommand(command);
    // No automatic CAN refresh here: the report commands are slow when the bus
    // is unpowered, and a background sweep would delay the next command.  The
    // 总览 "刷新 CAN" button explicitly refreshes the CAN summary.
  } catch (e) {
    log(String(e), "err");
  }
}

// Commands that reconfigure or restart the drivers must be confirmed, like the
// driver-zero actions in the motion view.
function canConfirm(command, text) {
  const message = text || `确定执行 ${command}？`;
  if (!window.confirm(message)) return;
  canCmd(command);
}

async function sendCmd(command) {
  try {
    await sendCommand(command);
    if (command === "?" || command.startsWith("$X") || command.startsWith("$H")) {
      try {
        await refreshStatus();
      } catch (e) {
        log(String(e), "err");
      }
      refreshCanInBackground("命令后");
    }
  } catch (e) {
    log(String(e), "err");
  }
}

async function run(kind, fn) {
  try {
    await fn();
  } catch (e) {
    // Strip the JS "Error: " prefix once so the console log and the view
    // messages show the same friendly text.
    const message = String(e).replace(/^Error:\s*/, "");
    log(message, "err");
    if (kind === "config" && $("cfgMsg")) $("cfgMsg").textContent = message;
  }
}

async function boot() {
  initDirectionControls();
  initLumen();
  $("clock").textContent = new Date().toLocaleString();
  setInterval(() => {
    $("clock").textContent = new Date().toLocaleString();
  }, 1000);
  setConn(false, "未连接");
  // Remembering the last device lets the user connect immediately without
  // waiting for the scan; it is only prefilled, never auto-connected.
  let lastDevice = "";
  try {
    lastDevice = localStorage.getItem("fluidcan.lastDevice") || "";
  } catch {
    /* localStorage may be unavailable */
  }
  // Desktop GUI serves the UI from a random loopback port on each launch, so
  // localStorage is a fresh origin and cannot remember the device.  The Rust
  // backend returns its persisted last device here instead.
  try {
    const health = await transport.httpGet("/health");
    if ($("appVersion")) $("appVersion").textContent = "Studio " + (health.version || "--");
    if (!lastDevice && health.default_device) lastDevice = String(health.default_device);
  } catch (e) {
    log("读取 Studio 信息失败: " + e, "err");
  }
  if (lastDevice && $("deviceUrl") && !$("deviceUrl").value.trim()) {
    $("deviceUrl").value = lastDevice;
    autoPrefilledDevice = lastDevice;
    log(`上次设备：${lastDevice}`);
  }
  // Any manual edit invalidates the auto-prefill, so scans no longer overwrite
  // it; this keeps user input authoritative.
  $("deviceUrl")?.addEventListener("input", () => {
    autoPrefilledDevice = "";
  });
  log("FluidCAN Studio 已启动");
  // A remembered device is already usable.  Do not launch a 254-host scan at
  // the same moment the user clicks connect: on a PC with several virtual
  // adapters that scan competes with the connect probe and is the main source
  // of the "连接中..." delay (Android usually has only one Wi-Fi subnet).
  if (lastDevice) {
    log("使用上次设备；需要新设备请点扫描");
  } else {
    setTimeout(scanDevices, 600);
  }
  // Serial enumeration can be slow on Windows (Bluetooth/virtual COM ports).
  // Populate lazily when the serial controls are first used instead of at boot.
  const lazyPorts = (id) => {
    $(id)?.addEventListener("focus", () => {
      if (($(id).options?.length || 0) <= 1) void refreshPorts();
    }, { once: true });
  };
  lazyPorts("serialPorts");
  lazyPorts("flashPort");
  $("serialPorts")?.addEventListener("change", () => {
    if ($("serialPorts").value) $("flashPort").value = $("serialPorts").value;
  });
  // Picking a discovered device only fills the address input; the user still
  // clicks "连接", so scanning never connects on its own.
  $("scanResults")?.addEventListener("change", () => {
    const url = $("scanResults").value;
    if (!url) return;
    $("deviceUrl").value = url;
    autoPrefilledDevice = "";
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
  closeSerial,
  showView,
  refreshAll,
  refreshCan,
  canCmd,
  canConfirm,
  sendCmd,
  // Motion / zero actions go through run() so a backend error is logged instead
  // of surfacing as an unhandled promise rejection.
  jog: (...args) => run("control", () => jog(...args)),
  zeroAxis: (axis) => run("control", () => zeroAxis(axis)),
  zeroAll: () => run("control", () => zeroAll()),
  zeroDriverAxis: (axis) => run("control", () => zeroDriverAxis(axis)),
  zeroDriverAll: () => run("control", () => zeroDriverAll()),
  sendQuick: () => run("control", sendQuick),
  sendConsole: () => run("control", sendConsole),
  toggleLimitTest: () => run("control", toggleLimitTest),
  readLimitsOnce: () => run("control", readLimitsOnce),
  clearLog,
  clearLumenOut,
  runLumenReadOnlyTests: () => run("lumen", runLumenReadOnlyTests),
  readVacuum: (side) => run("lumen", () => readVacuum(side)),
  setLumenOutput: (p, on) => run("lumen", () => setLumenOutput(p, on)),
  setLumenLed: (preset) => run("lumen", () => setLumenLed(preset)),
  lumenJog: (sign) => run("lumen", () => lumenJog(sign)),
  loadConfig: () => run("config", loadConfig),
  saveConfig: () => run("config", saveConfig),
  loadCanConfig: () => run("can", loadCanConfig),
  openConfigEditor,
  refreshRemote: () => run("install", install.refreshRemote),
  remoteOta: () => run("install", install.remoteOta),
  otaUpload: () => run("install", install.otaUpload),
  flashSerial: () => run("install", install.flashSerial),
  prepareWebFlash: () => run("install", install.prepareWebFlash),
  installToolchain: () => run("install", install.installToolchain),
});

boot();

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
