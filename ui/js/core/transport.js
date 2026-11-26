// Transport abstraction: the UI never talks to HTTP or serial directly.
// Mode is one of: "http", "serial", "none".
let mode = "none";
let serialName = "";
let httpBase = "";

async function api(path, opts = {}) {
  const r = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await r.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { raw: text };
  }
  if (!r.ok) throw new Error(value.error || text);
  return value;
}

export function currentMode() {
  return mode;
}

export function isSerial() {
  return mode === "serial";
}

export function currentSerial() {
  return serialName;
}

export function currentHttpBase() {
  return httpBase;
}

export async function connectHttp(url) {
  const j = await api("/connect", { method: "POST", body: JSON.stringify({ url }) });
  if (j.connected) {
    mode = "http";
    httpBase = j.base || url;
    serialName = "";
  }
  return j;
}

export async function openSerial(port, baud = 115200) {
  const j = await api("/serial/open", {
    method: "POST",
    body: JSON.stringify({ port, baud }),
  });
  mode = "serial";
  serialName = port;
  return j;
}

export async function scan() {
  return api("/scan");
}

export async function ports() {
  return api("/ports");
}

// Continuous jog: start one long $J command, stop with the FluidNC realtime
// JogCancel byte (0x85).  The UI sends its current mode explicitly.
export async function jogStart(command) {
  return api("/jog/start", {
    method: "POST",
    body: JSON.stringify({ command, mode }),
  });
}

export async function jogStop() {
  return api("/jog/stop", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

// Execute one FluidNC console command through the active transport.
export async function execRaw(command) {
  if (mode === "serial") {
    return api("/serial/exec", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
  }
  const j = await api("/command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
  return { text: j.output || "", ok: true };
}

export async function exec(command) {
  const j = await execRaw(command);
  return j.text || "";
}

// Uniform status snapshot for the overview.
export async function getStatus() {
  if (mode === "serial") {
    const build = await exec("$I");
    const state = await exec("?");
    return { base: "serial:" + serialName, build, state };
  }
  return api("/status");
}

// Uniform CAN snapshot for the overview and CAN view.
// `light` skips $CANDriverInfo for the fast overview refresh; the raw CAN
// view still requests the full snapshot.
export async function getCan(light = false) {
  if (mode === "serial") {
    const fields = ["status", "faults", "positions"];
    if (!light) fields.push("drivers");
    const commands = { status: "$CANStatus", faults: "$CANFaults", positions: "$CANPos", drivers: "$CANDriverInfo" };
    const out = { base: "serial:" + serialName };
    for (const field of fields) out[field] = await exec(commands[field]);
    return out;
  }
  return api("/can" + (light ? "?light=1" : ""));
}

// Board build string plus the ZDT firmware/hardware report.  The HTTP backend
// reads both in parallel; serial has to issue the two console commands
// sequentially.  Callers run this in the background, never before connect.
export async function getFirmware() {
  if (mode === "serial") {
    const build = await exec("$I");
    const drivers = await execRaw("$CANDriverInfo");
    if (!drivers.ok) {
      throw new Error("串口 $CANDriverInfo 超时/被截断（驱动可能未全部上电）");
    }
    return { base: "serial:" + serialName, build, drivers: drivers.text || "" };
  }
  return api("/firmware");
}

// Device configuration (config.yaml).  WiFi reads /api/config; the serial link
// uses FluidNC's $CD (Config/Dump) report command, which prints the YAML on the
// console channel.
export async function getDeviceConfig() {
  if (mode === "serial") {
    const text = await exec("$CD");
    if (!text || !/(^|\n)\s*axes\s*:/i.test(text)) {
      throw new Error("串口返回的配置内容无效（$CD 没有输出 YAML）");
    }
    return { yaml: text, base: "serial:" + serialName };
  }
  return api("/config");
}

// Serial log is exposed by the native backend.
export async function serialLog() {
  return api("/serial/log");
}

// HTTP-only endpoints used by config/install views.
export async function httpGet(path) {
  return api(path);
}

export async function httpPost(path, body) {
  return api(path, { method: "POST", body: JSON.stringify(body) });
}

export async function httpPut(path, body) {
  return api(path, { method: "PUT", body: JSON.stringify(body) });
}
