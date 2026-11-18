import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "ui/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "ui/js/app.js"), "utf8");
const view = fs.readFileSync(path.join(root, "ui/js/views/dual-y.js"), "utf8");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) {
  assert.equal(ids.filter((x) => x === id).length, 1, `duplicate id ${id}`);
}
for (const id of ["dualYBox", "dualYMsg", "driverTable", "view-can"]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}

const driverHead = html.match(/<tbody id="driverTable"><tr><td colspan="(\d+)"/);
assert.ok(driverHead, "driver table empty row missing");
const driverHeaders = (html.match(/<thead><tr>(.*?)<\/tr><\/thead><tbody id="driverTable"/s) || [])[1];
if (driverHeaders) {
  const count = (driverHeaders.match(/<th>/g) || []).length;
  assert.equal(Number(driverHead[1]), count, "driver table colspan mismatch");
}

for (const name of ["loadCanConfig", "openConfigEditor"]) {
  assert.ok(html.includes(`onclick="${name}()`), `missing onclick ${name}`);
  assert.ok(app.includes(`${name}:`) || app.includes(`${name},`), `missing window binding ${name}`);
}
for (const name of ["zeroAxis", "zeroAll"]) {
  assert.ok(html.includes(`onclick="${name}(`), `missing zero button ${name}`);
  assert.ok(app.includes(`${name},`) || app.includes(`${name}:`), `missing zero binding ${name}`);
}
assert.ok(html.includes("X 清零") && html.includes("Y 清零") && html.includes("Z 清零"), "zero axis buttons missing");
for (const name of ["zeroDriverAxis", "zeroDriverAll"]) {
  assert.ok(html.includes(`onclick="${name}(`), `missing driver-zero button ${name}`);
  assert.ok(app.includes(`${name},`) || app.includes(`${name}:`), `missing driver-zero binding ${name}`);
}
assert.ok(html.includes("X 驱动零位") && html.includes("Y 驱动零位") && html.includes("Z 驱动零位"), "driver zero buttons missing");
assert.ok(view.includes("parseCanConfig"), "view must use the pure parser");
assert.ok(view.includes("isSerial"), "serial fallback missing");

// ---- Connect / scan / serial flows must stay independent -------------------
for (const id of ["connectBtn", "scanBtn", "openSerialBtn", "deviceUrl", "scanResults", "scanMsg", "connPill"]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `missing body ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

const connectBody = functionBody(app, "connectDevice");
const scanBody = functionBody(app, "scanDevices");
const serialBody = functionBody(app, "openSerial");
const bootBody = functionBody(app, "boot");

// 连接按钮：只连接输入框/扫描结果中的地址，地址为空时提示，绝不回退成扫描。
assert.ok(!connectBody.includes("scanDevices"), "connectDevice must not trigger a scan");
assert.ok(connectBody.includes("resolveConnectTarget"), "connectDevice must resolve the typed/scan address");
assert.ok(connectBody.includes("transport.connectHttp"), "connectDevice must use the HTTP connect call");
// 扫描按钮：只发现设备，绝不自动连接。
assert.ok(!scanBody.includes("connectDevice") && !scanBody.includes("connectHttp"), "scanDevices must not connect");
assert.ok(scanBody.includes("transport.scan"), "scanDevices must use the scan call");
assert.ok(scanBody.includes("scannedAddress"), "scanDevices must prefill a single scanned address");
// 串口按钮：独立链路，不触发扫描或 WiFi 连接。
assert.ok(!serialBody.includes("scanDevices") && !serialBody.includes("connectHttp"), "openSerial must not scan or HTTP-connect");
assert.ok(serialBody.includes("transport.openSerial"), "openSerial must use the serial open call");
// 启动时最多自动扫描一次，不得自动连接。
assert.ok(bootBody.includes("setTimeout(scanDevices"), "startup should auto-scan once");
assert.ok(!bootBody.includes("connectDevice("), "startup must not auto-connect");
assert.ok(app.includes('"scanResults")?.addEventListener'), "scan result picker change handler missing");
assert.ok(app.includes("本次扫描结束"), "scan button must guard re-entrant scans");

console.log("static UI tests: PASS");
