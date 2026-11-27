import { exec } from "../core/transport.js";
import { state } from "../core/store.js";
import { addressesForAxis, allDriverAddresses, configAxisNames, maxFeedForAxes } from "../core/drivers.js";

const $ = (id) => document.getElementById(id);
export const logLines = [];

export function log(message, cls = "") {
  const el = $("consoleLog");
  if (!el) return;
  const delay = document.createElement("div");
  delay.className = cls;
  delay.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  el.appendChild(delay);
  el.scrollTop = el.scrollHeight;
  logLines.push(String(message));
}

async function send(command, outputId) {
  const text = await exec(command);
  if (outputId && $(outputId)) $(outputId).textContent = `> ${command}\n${text}`;
  log(`> ${command}`);
  log(text || "(无输出)");
  return text;
}

export async function sendCommand(command) {
  return send(command, "ctrlOut");
}

export async function sendQuick() {
  const value = $("quickCmd").value.trim();
  if (value) await sendCommand(value);
}

function requireLayout() {
  const layout = state.driverLayout;
  if (!layout || !layout.count) {
    throw new Error("尚未从 config.yaml 读取到驱动器配置，请先连接设备");
  }
  return layout;
}

// G10 L20 P1 sets the work-coordinate position for the selected axis.  It
// changes offsets only; it never commands motion.  Axis names come from
// config.yaml instead of a hard-coded X/Y/Z list.
export function zeroCommand(axis, layout = state.driverLayout) {
  const name = String(axis || "").trim().toUpperCase();
  const axes = configAxisNames(layout);
  if (!name) throw new Error(`不支持的清零轴: ${axis}`);
  if (!axes.length) throw new Error("尚未从 config.yaml 读取轴配置");
  if (!axes.includes(name)) throw new Error(`不支持的清零轴: ${axis}`);
  return `G10 L20 P1 ${name}0`;
}

export function zeroAllCommand(layout = state.driverLayout) {
  const axes = configAxisNames(layout);
  if (!axes.length) throw new Error("尚未从 config.yaml 读取轴配置");
  return "G10 L20 P1 " + axes.map((axis) => `${axis}0`).join(" ");
}

// Driver zero addresses come from the generic config.yaml motor blocks: an
// axis may own several motors (dual Y), and the CAN bus supports up to 16
// addresses.  No address mapping is hard-coded anymore.
export function driverZeroCommand(axis, layout = state.driverLayout) {
  const name = String(axis || "").trim().toUpperCase();
  const addresses = addressesForAxis(layout, name);
  if (!addresses.length) throw new Error(`不支持的驱动零位轴: ${axis}`);
  return `$CANZero=${addresses.join(",")}`;
}

export function driverZeroAllCommand(layout = state.driverLayout) {
  const addresses = allDriverAddresses(layout);
  if (!addresses.length) throw new Error("尚未从 config.yaml 读取到 CAN 驱动器地址");
  return `$CANZero=${addresses.join(",")}`;
}

async function zeroDriverAndCoordinate(axis, layout) {
  await sendCommand(driverZeroCommand(axis, layout));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await sendCommand(zeroCommand(axis, layout));
}

export async function zeroDriverAxis(axis) {
  const layout = requireLayout();
  const name = String(axis || "").trim().toUpperCase();
  const addresses = addressesForAxis(layout, name);
  if (!addresses.length) throw new Error(`不支持的驱动零位轴: ${axis}`);
  if (!confirm(`确定清零 ${name} 驱动器位置基准？\n地址: ${addresses.join(",")}\n此操作会改变绝对位置基准。`)) return;
  return zeroDriverAndCoordinate(name, layout);
}

export async function zeroDriverAll() {
  const layout = requireLayout();
  const addresses = allDriverAddresses(layout);
  const axes = configAxisNames(layout).join("/");
  if (!confirm(`确定清零 ${axes} 全部驱动器位置基准？\n地址: ${addresses.join(",")}\n此操作会改变绝对位置基准。`)) return;
  await sendCommand(driverZeroAllCommand(layout));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await sendCommand(zeroAllCommand(layout));
}

export async function zeroAxis(axis) {
  return sendCommand(zeroCommand(axis, requireLayout()));
}

export async function zeroAll() {
  const layout = requireLayout();
  return sendCommand(zeroAllCommand(layout));
}

export async function jog(direction) {
  const axis = $("jogAxis").value;
  const distance = parseFloat($("jogDist").value) || 1;
  const input = $("jogFeed");
  const cap = maxFeedForAxes(state.driverLayout, [axis]);
  const requested = parseFloat(input?.value) || 500;
  const feed = cap ? Math.min(requested, cap) : requested;
  if (input) input.max = cap ? String(cap) : "";
  if (feed !== requested) log(`点动进给 ${requested} 超过配置上限 ${cap}，已按 ${feed} 发送`, "warn2");
  await sendCommand(`$J=G91${axis}${direction * distance}F${feed}`);
}

export async function sendConsole() {
  const value = $("consoleCmd").value.trim();
  if (!value) return;
  await send(value);
}

export function clearLog() {
  const el = $("consoleLog");
  if (el) el.innerHTML = "";
  logLines.length = 0;
}
