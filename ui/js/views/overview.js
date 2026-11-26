import {
  currentHttpBase,
  currentMode,
  currentSerial,
  getStatus,
  getCan,
  getFirmware,
  getFirmwareDrivers,
  isSerial,
} from "../core/transport.js";
import { asText, driverRows, pick, stateParts } from "../core/parsers.js";
import { patch, state, subscribe } from "../core/store.js";
import { driverMetaMap } from "../core/drivers.js";
import { renderCanView } from "./can.js";
import { firmwareDriverRows, parseBoardInfo } from "../core/firmwareinfo.js";

const $ = (id) => document.getElementById(id);

function kv(el, rows) {
  if (!el) return;
  el.innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join("");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function renderDrivers(can) {
  const table = $("driverTable");
  if (!table) return;
  // Axis roles and protocols come from config.yaml; the same table works for
  // PD42S1, ZDT and CANopen.  Fields a protocol does not report stay "--".
  const rows = driverRows(can, driverMetaMap(state.driverLayout));
  if (!rows.length) {
    table.innerHTML = '<tr><td colspan="10" class="muted">未读到驱动器，检查 CAN 日志/总线</td></tr>';
    return;
  }
  table.innerHTML = rows
    .map(
      (d) => `<tr>
        <td class="mono">${esc(d.addr)}</td><td>${esc(d.role || "--")}</td><td>${esc(d.protocolLabel || "--")}</td>
        <td class="mono">${esc(d.pos || "--")}</td><td class="mono">${esc(d.err || "--")}</td>
        <td class="mono">${esc(d.speed || "--")}</td><td>${esc(d.status || "--")}</td>
        <td class="${d.stall === "yes" ? "badtxt" : "oktxt"}">${esc(d.stall || "--")}</td>
        <td class="${d.enabled === "yes" ? "oktxt" : "warntxt"}">${esc(d.enabled || "--")}</td>
        <td>${esc(d.inpos || "--")}</td></tr>`,
    )
    .join("");
}

// FluidNC reports version strings in several forms, e.g.
// "[VER:can-0.2 FluidNC can-v0.2.13 (esp32s3-wifi) :]" or "FluidNC v3.7.0".
function firmwareVersion(build) {
  const fluidnc = pick(build, /FluidNC\s+(can-v[\d][\w.-]*)/i);
  if (fluidnc !== "--") return fluidnc;
  return pick(build, /FluidNC\s+v([^\s]+)/i);
}

function renderBoardFirmware(build) {
  const info = parseBoardInfo(build);
  const details = $("fwDetailBox");
  if (details) {
    details.innerHTML = [
      ["版本", info.version || "--"],
      ["MCU", info.mcu || "--"],
      ["硬件变体", info.hardware || "--"],
      ["选项", info.options || "--"],
      ["机器", info.machine || "--"],
    ].map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
  }
  const raw = $("fwRaw");
  if (raw) raw.textContent = info.raw || "--";
  renderDriverFirmware();
}

function renderDriverFirmware(driversText = "", error = "") {
  const table = $("fwDriverTable");
  if (!table) return;
  if (state.connected && !driversText && !error) {
    table.innerHTML = '<tr><td colspan="6" class="muted">固件信息读取中…</td></tr>';
    return;
  }
  const rows = firmwareDriverRows(state.driverLayout, driversText, error);
  if (!rows.length) {
    table.innerHTML = state.driverLayout
      ? '<tr><td colspan="6" class="muted">固件信息读取中…</td></tr>'
      : '<tr><td colspan="6" class="muted">等待 config.yaml</td></tr>';
    return;
  }
  table.innerHTML = rows
    .map(
      (d) => `<tr>
        <td class="mono">${esc(d.address)}</td><td>${esc(d.role)}</td><td>${esc(d.protocol)}</td>
        <td>${esc(d.configuredFirmware)}</td><td class="${d.firmware === "无响应" || d.firmware === "读取失败" ? "warntxt" : d.firmware === "未上报" ? "muted" : "oktxt"}">${esc(d.firmware)}</td>
        <td>${esc(d.hardware)}</td></tr>`,
    )
    .join("");
}

function currentLinkKey() {
  return `${currentMode()}|${currentMode() === "serial" ? currentSerial() : currentHttpBase()}`;
}

function firmwareKey() {
  return currentLinkKey();
}

// $CANDriverInfo is a separate, potentially slow CAN report.  Never put it on
// the connect/status path; render the board banner immediately and fill the
// per-driver actual firmware from the background request.  The key prevents an
// in-flight response for device A from repainting device B after a reconnect.
let firmwareRefreshPromise = null;
let firmwareRefreshKey = "";

export async function refreshFirmwareData(key = firmwareKey()) {
  renderBoardFirmware(state.build || "");
  if (!state.connected || !key.endsWith("|")) {
    return { skipped: true };
  }
  try {
    // The connect/status path already has the board build.  Only fetch it here
    // when the panel is opened before status has populated it.
    let build = state.build;
    if (!build) {
      const report = await getFirmware();
      if (firmwareKey() !== key) return { skipped: true };
      if (typeof report.build === "string" && report.build) {
        build = report.build;
        patch({ build });
        renderBoardFirmware(build);
      }
    }

    const report = await getFirmwareDrivers();
    if (firmwareKey() !== key) return { skipped: true };
    const rawDrivers = report.drivers;
    let drivers = "";
    let error = "";
    if (typeof rawDrivers === "string") {
      drivers = rawDrivers;
    } else if (rawDrivers && typeof rawDrivers === "object" && rawDrivers.error) {
      error = String(rawDrivers.error);
    }
    patch({ firmwareDrivers: drivers, firmwareError: error });
    renderDriverFirmware(drivers, error);
    return report;
  } catch (e) {
    if (firmwareKey() === key) {
      patch({ firmwareError: String(e) });
      renderDriverFirmware("", String(e));
    }
    return { error: String(e) };
  }
}

export function refreshFirmwareInBackground() {
  const key = firmwareKey();
  if (!state.connected || key.endsWith("|")) return Promise.resolve({ skipped: true });
  if (firmwareRefreshPromise && firmwareRefreshKey === key) return firmwareRefreshPromise;
  firmwareRefreshKey = key;
  renderDriverFirmware(state.firmwareDrivers || "", state.firmwareError || "");
  firmwareRefreshPromise = refreshFirmwareData(key).finally(() => {
    if (firmwareRefreshKey === key) {
      firmwareRefreshPromise = null;
      firmwareRefreshKey = "";
    }
  });
  return firmwareRefreshPromise;
}

// config.yaml arrives asynchronously after connect; re-render the firmware
// table once roles/addresses are available without refetching the CAN report.
subscribe(() => {
  if (state.driverLayout) renderDriverFirmware(state.firmwareDrivers || "", state.firmwareError || "");
});

// Fast path: firmware version + machine state (two device commands).  The
// connect flow only waits for this, so "连接" resolves in a few hundred ms
// even when the CAN bus is slow.
export function resetOverviewPanels() {
  kv($("fwBox"), [["状态", "等待连接"]]);
  kv($("stateBox"), [["状态", "等待连接"]]);
  const details = $("fwDetailBox");
  if (details) details.innerHTML = '<span class="muted">连接后读取</span>';
  const raw = $("fwRaw");
  if (raw) raw.textContent = "--";
  const drivers = $("driverTable");
  if (drivers) drivers.innerHTML = '<tr><td colspan="10" class="muted">等待连接</td></tr>';
  const fwDrivers = $("fwDriverTable");
  if (fwDrivers) fwDrivers.innerHTML = '<tr><td colspan="6" class="muted">等待连接</td></tr>';
  kv($("canBox"), [["状态", "等待连接"]]);
  kv($("drvBox"), [["状态", "等待连接"]]);
  const stamp = $("lastUpdate");
  if (stamp) {
    stamp.textContent = "--";
    stamp.className = "pill";
  }
}
export async function refreshStatus() {
  const started = Date.now();
  const linkKey = currentLinkKey();
  const status = await getStatus();
  // A reconnect while the status request was in flight must not repaint the
  // new device with the old device's state.  Compare the CURRENT link key, not
  // the response base: the backend captured its base before the switch.
  if (currentLinkKey() !== linkKey) return { stale: true };
  const build = asText(status.build);
  const state = asText(status.state);
  const errors = [];
  if (status.build && typeof status.build === "object" && status.build.error) errors.push(status.build.error);
  if (status.state && typeof status.state === "object" && status.state.error) errors.push(status.state.error);
  // A 200 response can still carry per-command errors; do not report a synced
  // connection when the device did not answer.
  if (!build && !state) {
    if (currentLinkKey() !== linkKey) return { stale: true };
    const reason = errors[0] || "设备无响应";
    kv($("fwBox"), [
      ["状态", "读取失败"],
      ["原因", reason],
    ]);
    kv($("stateBox"), [["状态", "读取失败"]]);
    patch({ connected: false, lastUpdate: new Date().toLocaleTimeString() });
    throw new Error(reason);
  }
  const parts = stateParts(status.state);
  kv($("fwBox"), [
    ["版本", firmwareVersion(build)],
    ["MCU", pick(build, /(esp32[\w-]*)/i)],
    ["链路", isSerial() ? "串口" : "WiFi"],
    ["设备", status.base || "--"],
  ]);
  renderBoardFirmware(build);
  kv($("stateBox"), [
    ["状态", parts.name],
    ["MPos", parts.mpos],
    ["更新时间", new Date().toLocaleTimeString()],
  ]);
  patch({
    build,
    buildSource: status.base || "",
    status: asText(status.state),
    base: status.base || "",
    connected: true,
    lastUpdate: new Date().toLocaleTimeString(),
  });
  return { status, elapsedMs: Date.now() - started };
}

// Slow path: CAN driver data.  Some CAN report commands can block for tens of
// seconds when a driver is unpowered, so callers always run this in the
// background instead of blocking connect or status refreshes.  The light
// snapshot (default) skips $CANDriverInfo because the overview never renders
// it; the CAN view requests the full snapshot.  Commands that a driver reports
// as unimplemented (for example ZDT faults/config) simply yield no rows.
export async function refreshCanData(light = true) {
  const stamp = $("lastUpdate");
  if (stamp) {
    stamp.textContent = "CAN 读取中…";
    stamp.className = "pill warn2";
  }
  const started = Date.now();
  const linkKey = currentLinkKey();
  try {
    const can = await getCan(light);
    if (currentLinkKey() !== linkKey) return { stale: true };
    renderCanView(can, { raw: !light });
    renderDrivers(can);
    const failed = ["status", "faults", "positions", "drivers"].filter((key) => {
      const value = can?.[key];
      return value && typeof value === "object" && value.error;
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (stamp) {
      if (failed.length) {
        stamp.textContent = `CAN 部分失败 ${failed.length} 项 · ${seconds}s`;
        stamp.className = "pill bad";
      } else {
        stamp.textContent = `更新 ${new Date().toLocaleTimeString()} · CAN ${seconds}s`;
        stamp.className = "pill";
      }
    }
    patch({ can, lastUpdate: new Date().toLocaleTimeString() });
    if (failed.length) throw new Error(`CAN 命令失败: ${failed.join(", ")}`);
    return { can, elapsedMs: Date.now() - started };
  } catch (e) {
    // Never leave the pill stuck at "CAN 读取中…" after a failed request.
    if (stamp && stamp.textContent === "CAN 读取中…") {
      stamp.textContent = "CAN 读取失败";
      stamp.className = "pill bad";
    }
    throw e;
  }
}
