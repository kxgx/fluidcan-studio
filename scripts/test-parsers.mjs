import assert from "node:assert/strict";
import { canBusRows, driverRows, stateParts, parsePinString } from "../ui/js/core/parsers.js";

const can = {
  positions: [
    "[MSG:INFO:   address 1: fw V1.6 pos=269071 error=0 speed=0RPM in-position=yes]",
    "[MSG:INFO:   address 2: fw V1.6 pos=35148 error=3 speed=0RPM in-position=yes]",
    "[MSG:INFO:   address 3: fw V1.6 pos=12446 error=-2 speed=0RPM in-position=no]",
    "[MSG:INFO:   address 4: fw V1.6 pos=51029 error=0 speed=0RPM in-position=yes]",
  ].join("\n"),
  faults: [
    "[MSG:INFO:   address 1: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
    "[MSG:INFO:   address 2: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
    "[MSG:INFO:   address 3: fw V1.6 hw V1.0 status=done stall=no enabled=no in-position=no]",
    "[MSG:INFO:   address 4: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
  ].join("\n"),
};

// Axis roles are supplied from config.yaml (core/drivers.js), not hard-coded.
const roles = { 1: "X", 2: "Y0", 3: "Y1", 4: "Z" };
const rows = driverRows(can, roles);
assert.equal(rows.length, 4);
assert.deepEqual(rows.map((r) => r.role), ["X", "Y0", "Y1", "Z"]);
assert.deepEqual(driverRows(can).map((r) => r.role), ["", "", "", ""]);
assert.equal(rows[2].enabled, "no");
assert.equal(rows[2].inpos, "no");
assert.equal(rows[0].pos, "269071");
assert.deepEqual(stateParts("<Idle|MPos:1.000,2.000,0.000|FS:0,0>"), {
  state: "Idle|MPos:1.000,2.000,0.000|FS:0,0",
  name: "Idle",
  mpos: "1.000,2.000,0.000",
});

// FluidNC realtime Pn: field -> triggered axes (limit switch test, read-only).
assert.deepEqual(parsePinString("<Idle|MPos:0,0,0|FS:0,0|Pn:X>"), {
  pins: "X",
  probe: false,
  toolsetter: false,
  axes: ["X"],
});
assert.deepEqual(parsePinString("<Alarm|Pn:PXT>"), { pins: "PXT", probe: true, toolsetter: true, axes: ["X"] });
assert.deepEqual(parsePinString("<Idle|MPos:0,0,0>"), { pins: "", probe: false, toolsetter: false, axes: [] });

// Generic metadata supplies the protocol label without hard-coding an axis map.
const meta = {
  1: { role: "X", protocol: "pd42s1", protocolLabel: "PD42S1" },
  2: { role: "Y0", protocol: "pd42s1", protocolLabel: "PD42S1" },
  3: { role: "Y1", protocol: "zdt", protocolLabel: "ZDT" },
};
const metaRows = driverRows(can, meta);
assert.equal(metaRows[2].role, "Y1");
assert.equal(metaRows[2].protocol, "zdt"); // metadata wins over the generic position parser
assert.equal(metaRows[0].protocolLabel, "PD42S1");

// ZDT position format is a different protocol line; it must still yield a row.
const zdtCan = {
  positions: [
    "[MSG:INFO: ZDT CAN: address 1 position 0]",
    "[MSG:INFO: ZDT CAN: address 2 position -1]",
  ].join("\n"),
  status: "[MSG:INFO: ZDT CAN: ready:yes control:yes clients:2]",
  faults: "[MSG:INFO: ZDT CAN: fault reporting is not implemented]",
};
const zdtRows = driverRows(zdtCan, {
  1: { role: "X", protocol: "zdt", protocolLabel: "ZDT" },
  2: { role: "Y0", protocol: "zdt", protocolLabel: "ZDT" },
});
assert.equal(zdtRows.length, 2);
assert.equal(zdtRows[0].protocolLabel, "ZDT");
assert.equal(zdtRows[0].pos, "0");
assert.equal(zdtRows[1].pos, "-1");
assert.equal(zdtRows[0].enabled, undefined);
assert.deepEqual(canBusRows(zdtCan), [
  ["驱动就绪", "yes"],
  ["控制就绪", "yes"],
  ["CAN 客户端", "2"],
]);
assert.deepEqual(canBusRows({ status: "CAN status: state=running tx_err=0 rx_err=0 bus_errors=0" }), [
  ["状态", "running"],
  ["TX错误", "0"],
  ["RX错误", "0"],
  ["BUS错误", "0"],
]);

console.log("parser tests: PASS");
