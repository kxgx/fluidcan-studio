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

export function setNone() {
  mode = "none";
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

// Execute one FluidNC console command through the active transport.
export async function exec(command) {
  if (mode === "serial") {
    const j = await api("/serial/exec", {
      method: "POST",
      body: JSON.stringify({ command }),
    });
    return j.text || "";
  }
  const j = await api("/command", {
    method: "POST",
    body: JSON.stringify({ command }),
  });
  return j.output || "";
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
export async function getCan() {
  if (mode === "serial") {
    return {
      base: "serial:" + serialName,
      status: await exec("$CANStatus"),
      faults: await exec("$CANFaults"),
      positions: await exec("$CANPos"),
      drivers: await exec("$CANDriverInfo"),
    };
  }
  return api("/can");
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
