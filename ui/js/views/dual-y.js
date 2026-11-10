import { httpGet, isSerial } from "../core/transport.js";
import { formatBool, formatNumber, parseCanConfig } from "../core/yconfig.js";

const $ = (id) => document.getElementById(id);

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function row(label, value, cls = "") {
  return `<div class="kv"><span>${esc(label)}</span><b class="${cls}">${esc(value)}</b></div>`;
}

function motorRows(name, motor) {
  if (!motor) return `<tr><td>${esc(name)}</td><td colspan="7" class="muted">未配置</td></tr>`;
  const pid = motor.pid ? motor.pid.map((v) => formatNumber(v, 0)).join(" / ") : "--";
  return `<tr>
    <td>${esc(name)}</td>
    <td class="mono">${esc(motor.address)}</td>
    <td class="mono">${esc(formatNumber(motor.counts))}</td>
    <td>${esc(formatBool(motor.invert))}</td>
    <td>${esc(formatBool(motor.block))}</td>
    <td class="mono">${esc(motor.sync ?? 0)}</td>
    <td class="mono">${esc(motor.torque == null ? "--" : `${motor.torque}mA`)}</td>
    <td class="mono">${esc(pid)}</td>
  </tr>`;
}

export function renderCanConfig(cfg) {
  const box = $("dualYBox");
  if (!box) return cfg;
  const y0 = cfg.y.motor0;
  const y1 = cfg.y.motor1;
  const warn = cfg.warnings.length
    ? `<div class="warnbox">${cfg.warnings.map((w) => `<div>⚠ ${esc(w)}</div>`).join("")}</div>`
    : '<div class="oktxt">配置检查通过</div>';

  box.innerHTML = `
    <div class="dual-grid">
      <div>
        <h3>Y 轴</h3>
        <div class="kvbox">
          ${row("steps_per_mm", formatNumber(cfg.y.steps))}
          ${row("Y0 地址", y0.address)}
          ${row("Y1 地址", y1 ? y1.address : "未配置")}
          ${row("Y0 方向反转", formatBool(y0.invert))}
          ${row("Y1 方向反转", y1 ? formatBool(y1.invert) : "--")}
          ${row("Y block target", `${formatBool(y0.block)} / ${y1 ? formatBool(y1.block) : "--"}`)}
          ${row("sync_group", `${y0.sync ?? 0} / ${y1 ? y1.sync ?? 0 : "--"}`)}
        </div>
      </div>
      <div>
        <h3>X / Z</h3>
        <div class="kvbox">
          ${row("X 地址", cfg.x.motor.address)}
          ${row("X block target", formatBool(cfg.x.motor.block))}
          ${row("Z 地址", cfg.z.motor.address)}
          ${row("Z block target", formatBool(cfg.z.motor.block))}
          ${row("CAN 波特率", cfg.can.baud ? `${cfg.can.baud} bps` : "--")}
        </div>
      </div>
    </div>
    ${warn}
    <table style="margin-top:10px">
      <thead><tr><th>电机</th><th>地址</th><th>counts/step</th><th>反向</th><th>block</th><th>sync</th><th>力矩</th><th>PID P/I/D</th></tr></thead>
      <tbody>
        ${motorRows("Y0", y0)}
        ${motorRows("Y1", y1)}
        ${motorRows("X", cfg.x.motor)}
        ${motorRows("Z", cfg.z.motor)}
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
