import { getStatus, getCan, isSerial } from "../core/transport.js";
import { asText, driverRows, pick, stateParts } from "../core/parsers.js";
import { patch, state } from "../core/store.js";
import { driverMetaMap } from "../core/drivers.js";
import { renderCanView } from "./can.js";

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

// Fast path: firmware version + machine state (two device commands).  The
// connect flow only waits for this, so "连接" resolves in a few hundred ms
// even when the CAN bus is slow.
export async function refreshStatus() {
  const started = Date.now();
  const status = await getStatus();
  const build = asText(status.build);
  const state = asText(status.state);
  const errors = [];
  if (status.build && typeof status.build === "object" && status.build.error) errors.push(status.build.error);
  if (status.state && typeof status.state === "object" && status.state.error) errors.push(status.state.error);
  // A 200 response can still carry per-command errors; do not report a synced
  // connection when the device did not answer.
  if (!build && !state) {
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
  kv($("stateBox"), [
    ["状态", parts.name],
    ["MPos", parts.mpos],
    ["更新时间", new Date().toLocaleTimeString()],
  ]);
  patch({
    build,
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
  try {
    const can = await getCan(light);
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
