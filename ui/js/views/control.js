import { exec } from "../core/transport.js";

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

const ZERO_AXES = new Set(["X", "Y", "Z"]);

// G10 L20 P1 sets the work-coordinate position for the selected axis.  It
// changes offsets only; it never commands motion.
export function zeroCommand(axis) {
  const name = String(axis || "").trim().toUpperCase();
  if (!ZERO_AXES.has(name)) throw new Error(`不支持的清零轴: ${axis}`);
  return `G10 L20 P1 ${name}0`;
}

export function zeroAllCommand() {
  return "G10 L20 P1 X0 Y0 Z0";
}

const DRIVER_ZERO_ADDRESS = Object.freeze({ X: "1", Y: "2,3", Z: "4" });

export function driverZeroCommand(axis) {
  const name = String(axis || "").trim().toUpperCase();
  const address = DRIVER_ZERO_ADDRESS[name];
  if (!address) throw new Error(`不支持的驱动零位轴: ${axis}`);
  return `$CANZero=${address}`;
}

export function driverZeroAllCommand() {
  return "$CANZero=1,2,3,4";
}

async function zeroDriverAndCoordinate(axis) {
  await sendCommand(driverZeroCommand(axis));
  await new Promise((resolve) => setTimeout(resolve, 400));
  await sendCommand(zeroCommand(axis));
}

export async function zeroDriverAxis(axis) {
  const name = String(axis || "").trim().toUpperCase();
  const address = DRIVER_ZERO_ADDRESS[name];
  if (!address) throw new Error(`不支持的驱动零位轴: ${axis}`);
  if (!confirm(`确定清零 ${name} 驱动器编码器位置？\n地址: ${address}\n此操作会改变绝对位置基准。`)) return;
  return zeroDriverAndCoordinate(name);
}

export async function zeroDriverAll() {
  if (!confirm("确定清零 X/Y/Z 全部驱动器编码器位置？\n地址: 1,2,3,4\n此操作会改变绝对位置基准。")) return;
  await sendCommand(driverZeroAllCommand());
  await new Promise((resolve) => setTimeout(resolve, 400));
  await sendCommand(zeroAllCommand());
}

export async function zeroAxis(axis) {
  return sendCommand(zeroCommand(axis));
}

export async function zeroAll() {
  return sendCommand(zeroAllCommand());
}

export async function jog(direction) {
  const axis = $("jogAxis").value;
  const distance = parseFloat($("jogDist").value) || 1;
  const feed = parseFloat($("jogFeed").value) || 500;
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
