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

console.log("static UI tests: PASS");
