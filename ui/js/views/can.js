import { exec, getCan, isSerial } from "../core/transport.js";
import { asText, driverRows, canBusRows } from "../core/parsers.js";

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

export async function refreshCanView() {
  const can = await getCan();
  const text =
    asText(can.status) + "\n" + asText(can.faults) + "\n" + asText(can.positions) + "\n" + asText(can.drivers);
  $("canOut").textContent = text.trim() || "(无输出)";
  kv($("canBox"), canBusRows(can));
  const rows = driverRows(can);
  kv($("drvBox"), [
    ["在线", `${rows.length}/4`],
    ["使能", `${rows.filter((r) => r.enabled === "yes").length}/4`],
  ]);
  return can;
}

export async function runCanCommand(command) {
  const text = await exec(command);
  $("canOut").textContent = `> ${command}\n${text || "(无输出)"}`;
  if (command.includes("CANStatus") || command.includes("CANFaults")) {
    await refreshCanView();
  }
  return text;
}

export async function scanBus() {
  return runCanCommand(isSerial() ? "$CANScan" : "$CANScan");
}
