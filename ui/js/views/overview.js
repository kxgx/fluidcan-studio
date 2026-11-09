import { getStatus, getCan, isSerial } from "../core/transport.js";
import { asText, canBusRows, driverRows, pick, stateParts, enabledCount } from "../core/parsers.js";
import { patch, state } from "../core/store.js";

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
  const rows = driverRows(can);
  if (!rows.length) {
    table.innerHTML = '<tr><td colspan="9" class="muted">未读到驱动器，检查 CAN 日志/总线</td></tr>';
    return;
  }
  table.innerHTML = rows
    .map(
      (d) => `<tr>
        <td class="mono">${esc(d.addr)}</td><td>${esc(d.fw || "--")}</td>
        <td class="mono">${esc(d.pos || "--")}</td><td class="mono">${esc(d.err || "--")}</td>
        <td class="mono">${esc(d.speed || "--")}</td><td>${esc(d.status || "--")}</td>
        <td class="${d.stall === "yes" ? "badtxt" : "oktxt"}">${esc(d.stall || "--")}</td>
        <td class="${d.enabled === "yes" ? "oktxt" : "warntxt"}">${esc(d.enabled || "--")}</td>
        <td>${esc(d.inpos || "--")}</td></tr>`,
    )
    .join("");
}

export async function refreshOverview() {
  const [status, can] = await Promise.all([getStatus(), getCan()]);
  const build = asText(status.build);
  const parts = stateParts(status.state);
  kv($("fwBox"), [
    ["版本", pick(build, /FluidNC v([^\s]+)/)],
    ["MCU", pick(build, /(esp32[\w-]*)/i)],
    ["链路", isSerial() ? "串口" : "WiFi"],
    ["设备", status.base || "--"],
  ]);
  kv($("stateBox"), [
    ["状态", parts.name],
    ["MPos", parts.mpos],
    ["更新时间", new Date().toLocaleTimeString()],
  ]);
  kv($("canBox"), canBusRows(can));
  kv($("drvBox"), [
    ["在线", `${driverRows(can).length}/4`],
    ["使能", `${enabledCount(can)}/4`],
  ]);
  renderDrivers(can);
  const stamp = $("lastUpdate");
  if (stamp) stamp.textContent = "更新 " + new Date().toLocaleTimeString();
  patch({
    build,
    status: asText(status.state),
    can,
    base: status.base || "",
    connected: true,
    lastUpdate: new Date().toLocaleTimeString(),
  });
  return state;
}
