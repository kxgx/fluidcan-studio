import { exec, getCan, isSerial } from "../core/transport.js";
import { asText, canBusRows, driverRows, hasEnabledTelemetry } from "../core/parsers.js";
import { state } from "../core/store.js";
import { CAN_ADDRESS_LIMIT, driverMetaMap } from "../core/drivers.js";

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

// Render an already-fetched CAN snapshot.  Kept separate from the fetch so the
// overview's background CAN refresh can reuse the same rendering without
// issuing a second (slow) round of CAN commands.  Works for protocol drivers
// that expose only a subset of the PD42S1 telemetry.
export function renderCanView(can, { raw = true } = {}) {
  if (raw) {
    const text =
      asText(can.status) + "\n" + asText(can.faults) + "\n" + asText(can.positions) + "\n" + asText(can.drivers);
    const out = $("canOut");
    if (out) out.textContent = text.trim() || "(无输出)";
  }
  const layout = state.driverLayout;
  const meta = driverMetaMap(layout);
  const configured = layout && layout.count ? layout.count : null;
  const total = configured == null ? "?" : String(configured);
  const rows = driverRows(can, meta);
  const busRows = canBusRows(can);
  if (layout && layout.can) {
    busRows.unshift(["驱动协议", layout.can.driverLabel || layout.can.driver || "未配置"]);
    if (layout.can.baud != null) busRows.push(["CAN 波特率", `${layout.can.baud} bps`]);
  }
  if (layout && layout.addressList && layout.addressList.length) {
    busRows.push(["配置地址", layout.addressList.join(",")]);
  }
  busRows.push(["CAN 地址上限", String(layout?.limit ?? CAN_ADDRESS_LIMIT)]);
  const protocols = layout && Array.isArray(layout.protocols) ? layout.protocols : [];
  if (protocols.length) busRows.push(["总线协议", protocols.join(" / ")]);
  kv($("canBox"), busRows);
  const capability = $("canCapability");
  if (capability) {
    const driver = layout?.can?.driver || "";
    if (driver === "zdt") {
      capability.textContent =
        "驱动能力：ZDT — $CANStatus/$CANPos/$CANScan 可用；$CANFaults/$CANDriverInfo/$CANRead 为 stub，$CANAutoConfig 无动作";
    } else if (driver === "pd42s1") {
      capability.textContent = "驱动能力：PD42S1 — 位置/故障/使能/参数诊断可用；自动配置会改写驱动器波特率";
    } else if (driver) {
      capability.textContent = `驱动能力：${layout.can.driverLabel || driver} — 以固件实际实现为准`;
    } else {
      capability.textContent = "驱动能力：未读取 config.yaml 或 can.driver 未设置";
    }
  }
  const canReadEnabled = hasEnabledTelemetry(can, meta);
  const drvRows = [
    ["配置", configured == null ? "未读取 config.yaml" : `${configured} 台`],
    ["在线", `${rows.length}/${total}`],
    ["使能", canReadEnabled ? `${rows.filter((r) => r.enabled === "yes").length}/${total}` : "当前驱动不提供使能回读"],
  ];
  if (layout && layout.warnings && layout.warnings.length) {
    drvRows.push(["配置警告", layout.warnings.join("；")]);
  }
  kv($("drvBox"), drvRows);
  return can;
}

export async function refreshCanView() {
  return renderCanView(await getCan());
}

export async function runCanCommand(command) {
  const text = await exec(command);
  const out = $("canOut");
  if (out) out.textContent = `> ${command}\n${text || "(无输出)"}`;
  return text;
}

export async function scanBus() {
  return runCanCommand(isSerial() ? "$CANScan" : "$CANScan");
}
