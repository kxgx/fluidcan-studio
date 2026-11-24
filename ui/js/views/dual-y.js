import { httpGet, isSerial } from "../core/transport.js";
import { formatBool, formatNumber, parseCanConfig } from "../core/yconfig.js";

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function row(label, value, cls = "") {
  return `<div class="kv"><span>${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`;
}

function detailFor(motor) {
  if (!motor) return "--";
  if (motor.protocol === "pd42s1") {
    const sync = motor.sync == null ? "--" : motor.sync;
    const block = formatBool(motor.block);
    const torque = motor.torque == null ? "--" : `${motor.torque}mA`;
    const pid = motor.pid ? motor.pid.map((v) => formatNumber(v, 0)).join("/") : "--";
    return `sync=${sync} block=${block} torque=${torque} PID=${pid}`;
  }
  if (motor.protocol === "zdt") {
    const cpr = motor.counts_per_rev == null ? "--" : motor.counts_per_rev;
    return `fw=${motor.firmware || "--"} cks=${motor.checksum || "--"} cpr=${cpr} mode=${motor.mode || "position_stream"} speed=${motor.speed_source || "fixed"}`;
  }
  if (motor.protocol === "canopen") {
    return `node=${motor.node_id == null ? "--" : motor.node_id}`;
  }
  return "--";
}

function motorRows(axis) {
  if (!axis || !axis.motors || !axis.motors.length) {
    return `<tr><td>${esc(axis?.name || "--")}</td><td colspan="10" class="muted">未配置 CAN 电机</td></tr>`;
  }
  return axis.motors
    .map(
      (motor) => `<tr>
        <td>${esc(axis.name)}</td>
        <td>${esc(motor.role)}</td>
        <td>${esc(motor.protocolLabel || motor.protocol || "--")}</td>
        <td class="mono">${esc(motor.address ?? "--")}</td>
        <td class="mono">${esc(formatNumber(axis.steps))}</td>
        <td class="mono">${esc(formatNumber(motor.counts_per_step))}</td>
        <td>${esc(formatBool(motor.invert))}</td>
        <td class="mono">${esc(motor.speed_rpm ?? "--")}</td>
        <td class="mono">${esc(motor.accel ?? "--")}</td>
        <td class="mono">${esc(motor.update_ms ?? "--")}</td>
        <td class="mono">${esc(detailFor(motor))}</td>
      </tr>`,
    )
    .join("");
}

export function renderCanConfig(cfg) {
  const box = $("dualYBox");
  if (!box || !cfg) return cfg;
  const can = cfg.can || {};
  const axes = Array.isArray(cfg.axes) ? cfg.axes : [];
  const drivers = Array.isArray(cfg.drivers) ? cfg.drivers : [];
  const protocols = Array.isArray(cfg.protocols) ? cfg.protocols : [];
  const warnings = Array.isArray(cfg.warnings) ? cfg.warnings : [];
  const warn = warnings.length
    ? `<div class="warnbox">${warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>`
    : '<div class="oktxt">配置检查通过</div>';

  box.innerHTML = `
    <div class="dual-grid">
      <div>
        <h3>总线</h3>
        <div class="kvbox">
          ${row("can.driver", can.driverLabel || can.driver || "未设置")}
          ${row("CAN 波特率", can.baud == null ? "--" : `${can.baud} bps`)}
          ${row("TX / RX", `${can.tx || "--"} / ${can.rx || "--"}`)}
          ${row("轴数 / 驱动数", `${axes.length} / ${drivers.length}`)}
          ${row("协议", protocols.length ? protocols.join(" / ") : "--")}
        </div>
      </div>
      <div>
        <h3>能力提示</h3>
        <div class="kvbox">
          ${row("位置回读", can.driver === "zdt" ? "36 / $CANPos" : "--")}
          ${row("故障/使能回读", can.driver === "zdt" ? "ZDT 未实现" : "按驱动能力")}
          ${row("驱动零位", can.driver === "zdt" ? "$CANZero (0A)" : "$CANZero")}
          ${row("说明", "字段来自 config.yaml；只读，不修改配置")}
        </div>
      </div>
    </div>
    ${warn}
    <table style="margin-top:10px">
      <thead><tr><th>轴</th><th>电机</th><th>协议</th><th>地址</th><th>steps/mm</th><th>counts/step</th><th>反向</th><th>速度 RPM</th><th>加速度</th><th>更新 ms</th><th>协议字段</th></tr></thead>
      <tbody>
        ${axes.map((axis) => motorRows(axis)).join("")}
      </tbody>
    </table>`;
  return cfg;
}

export async function loadCanConfig() {
  const msg = $("dualYMsg");
  const box = $("dualYBox");
  if (!box) return;
  if (isSerial()) {
    if (msg) msg.textContent = "串口模式下请先在配置页查看原文";
    if (box) box.innerHTML = '<span class="muted">串口模式不能读取 /api/config</span>';
    return;
  }
  if (msg) msg.textContent = "读取中...";
  try {
    const j = await httpGet("/config");
    const cfg = parseCanConfig(j.yaml || "");
    renderCanConfig(cfg);
    if (msg) msg.textContent = cfg.warnings.length ? `发现 ${cfg.warnings.length} 个问题` : "读取完成";
    return cfg;
  } catch (e) {
    if (msg) msg.textContent = "读取失败";
    if (box) box.innerHTML = `<div class="muted">${esc(String(e))}</div>`;
    throw e;
  }
}

export function openConfigEditor() {
  if (typeof window !== "undefined" && typeof window.showView === "function") {
    window.showView("config");
    if (typeof window.loadConfig === "function") window.loadConfig();
  }
}
