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
