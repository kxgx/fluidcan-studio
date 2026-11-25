import assert from "node:assert/strict";
import { firmwareDriverRows, parseBoardInfo, parseDriverFirmware } from "../ui/js/core/firmwareinfo.js";

const build = `[VER:can-0.2 FluidNC can-v0.2.26 (esp32s3-wifi-16mb-octal) :]
[OPT:PHS]
[MSG:Machine: ESP32-S3-custom-board]`;
const info = parseBoardInfo(build);
assert.equal(info.version, "can-v0.2.26");
assert.equal(info.hardware, "16mb-octal");
assert.equal(info.mcu, "esp32s3");
assert.equal(info.options, "PHS");
assert.equal(info.machine, "ESP32-S3-custom-board");

const report = `[MSG:INFO: CAN driver: address 1 protocol zdt firmware 2.0.7 firmware-raw 207 hardware-series 2 hardware-type 3 hardware-version 20]
[MSG:INFO: CAN driver: address 5 protocol zdt firmware 2.0.7 firmware-raw 207 hardware-series 2 hardware-type 1 hardware-version 20]`;
const parsed = parseDriverFirmware(report);
assert.equal(parsed.length, 2);
assert.deepEqual(parsed[0], {
  address: 1,
  protocol: "zdt",
  firmware: "2.0.7",
  firmwareRaw: 207,
  hardwareSeries: 2,
  hardwareType: 3,
  hardwareTypeLabel: "42",
  hardwareVersion: "20",
  hardwareVersionLabel: "2.0",
});
assert.equal(parsed[1].hardwareTypeLabel, "28");

// A non-ZDT driver with only the common fields must still be usable.
const generic = parseDriverFirmware("[MSG:INFO: CAN driver: address 9 protocol canopen firmware 1.2.3]");
assert.equal(generic.length, 1);
assert.equal(generic[0].protocol, "canopen");
assert.equal(generic[0].hardwareTypeLabel, "--");

const layout = {
  drivers: [
    { address: 1, role: "X", protocolLabel: "ZDT", config: { firmware: "Emm" } },
    { address: 5, role: "A", protocolLabel: "ZDT", config: { firmware: "Emm" } },
    { address: 6, role: "B", protocolLabel: "ZDT", config: { firmware: "Emm" } },
  ],
};
const rows = firmwareDriverRows(layout, report);
assert.equal(rows.length, 3);
assert.equal(rows[0].firmware, "2.0.7");
assert.equal(rows[0].configuredFirmware, "Emm");
assert.equal(rows[0].hardware, "42 / 系列2 / V2.0");
assert.equal(rows[2].firmware, "无响应");
assert.equal(firmwareDriverRows(layout, "[MSG:INFO: ZDT CAN: configuration report is not implemented]")[0].firmware, "未上报");
assert.equal(firmwareDriverRows(layout, "", "timeout")[0].firmware, "读取失败");
assert.equal(firmwareDriverRows(layout, report, "timeout")[0].firmware, "2.0.7");

assert.deepEqual(parseDriverFirmware(""), []);
assert.deepEqual(firmwareDriverRows(null, report), []);
console.log("firmwareinfo tests PASS");
