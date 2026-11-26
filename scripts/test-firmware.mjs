import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  firmwareVariant,
  isFourMbHardware,
  parseFirmwareHardware,
} from "../ui/js/core/firmware.js";

assert.deepEqual(parseFirmwareHardware("[VER:can-0.2 FluidNC can-v0.2.26 (esp32s3-wifi-16mb-octal) :]"), {
  radio: "wifi",
  hw: "16mb-octal",
  legacy: false,
});
assert.deepEqual(parseFirmwareHardware("esp32s3-noradio-8mb-quad"), {
  radio: "nowifi",
  hw: "8mb-quad",
  legacy: false,
});
assert.equal(parseFirmwareHardware("esp32s3-wifi")?.hw, "16mb-octal");
assert.equal(parseFirmwareHardware("esp32s3-noradio")?.radio, "nowifi");
assert.equal(parseFirmwareHardware("esp32s3-wifi")?.legacy, true);
assert.equal(parseFirmwareHardware("something else"), null);
assert.equal(parseFirmwareHardware("esp32s3-wifi-20mb-octal")?.hw, "20mb-octal");
assert.equal(firmwareVariant("wifi", "20mb-octal"), "");

assert.equal(firmwareVariant("wifi", "16mb-octal"), "wifi-16mb-octal");
assert.equal(firmwareVariant("nowifi", "4mb-nopsram"), "nowifi-4mb-nopsram");
assert.equal(firmwareVariant("wifi", "bogus"), "");
assert.equal(firmwareVariant("bogus", "8mb-quad"), "wifi-8mb-quad");

assert.equal(isFourMbHardware("4mb-quad"), true);
assert.equal(isFourMbHardware("4mb-nopsram"), true);
assert.equal(isFourMbHardware("8mb-quad"), false);
assert.equal(isFourMbHardware("16mb-octal"), false);
assert.equal(isFourMbHardware(""), false);

const labels = [];
for (const radio of ["wifi", "nowifi"]) {
  for (const hw of ["8mb-quad", "8mb-octal", "16mb-octal", "4mb-quad", "4mb-octal", "4mb-nopsram"]) {
    labels.push(`${radio}-${hw}`);
  }
}
const root = path.join(import.meta.dirname, "..");
const rust = fs.readFileSync(path.join(root, "src/lib.rs"), "utf8");
for (const label of labels) {
  assert.ok(rust.includes(`"${label}"`), `backend WEB_FLASH_VARIANTS missing ${label}`);
}
const install = fs.readFileSync(path.join(root, "ui/js/views/install.js"), "utf8");
assert.ok(install.includes("legacyNeedsConfirm") && install.includes("legacyConfirm"), "legacy hardware confirmation missing");
assert.ok(install.includes("NoWiFi 无网络栈"), "NoWiFi network OTA guard missing");
assert.ok(rust.includes("/serial/close"), "serial close route missing");
assert.ok(install.includes("legacyNeedsConfirm() && !legacyConfirmed()"), "legacy confirmation must gate Web Serial too");
assert.ok(
  fs.readFileSync(path.join(root, "ui/index.html"), "utf8").includes("webFlashPrepareBtn"),
  "prepare button id missing",
);

console.log("firmware variant tests: PASS");
