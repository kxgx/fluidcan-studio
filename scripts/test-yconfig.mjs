import assert from "node:assert/strict";
import { parseCanConfig, parseConfigMap, formatBool, formatNumber } from "../ui/js/core/yconfig.js";

const sample = `
name: test
can:
  driver: pd42s1
  tx_pin: gpio.6
  rx_pin: gpio.5
  baud: 500000
axes:
  x:
    steps_per_mm: 80
    motor0:
      pd42s1:
        address: 1
        counts_per_step: 64
        invert_direction: false
        block_targets: true
  y:
    steps_per_mm: 80
    motor0:
      pd42s1:
        address: 2
        sync_group: 1
        counts_per_step: 64
        invert_direction: true
        block_targets: true
        max_torque_ma: 3000
  z:
    steps_per_mm: 80
    motor0:
      pd42s1:
        address: 4
        counts_per_step: 8
        invert_direction: true
        block_targets: false
`;

const missingY1 = parseCanConfig(sample);
assert.deepEqual(missingY1.warnings, []);
assert.equal(missingY1.can.driver, "pd42s1");
assert.equal(missingY1.can.driverLabel, "PD42S1");
assert.equal(missingY1.can.baud, 500000);
assert.equal(missingY1.axes.length, 3);
assert.deepEqual(missingY1.axes.map((a) => a.name), ["X", "Y", "Z"]);
assert.equal(missingY1.y.motor0.address, 2);
assert.equal(missingY1.y.motor0.block, true);
assert.equal(missingY1.y.motor0.counts, 64);
assert.equal(missingY1.y.motor1, null);
assert.equal(missingY1.drivers.length, 3);

const grouped = parseCanConfig(
  sample.replace("  baud: 500000", "  baud: 500000\n  group_member_address: 3\n  group_member_group: 2"),
);
assert.ok(grouped.warnings.some((w) => w.includes("自动分组")));

const withY1 = parseCanConfig(
  sample.replace(
    "        max_torque_ma: 3000",
    "        max_torque_ma: 3000\n    motor1:\n      pd42s1:\n        address: 3\n        sync_group: 1\n        counts_per_step: 64\n        invert_direction: true\n        block_targets: true",
  ),
);
assert.ok(withY1.y.motor1);
assert.equal(withY1.y.motor1.address, 3);
assert.equal(withY1.y.motor1.block, true);
assert.deepEqual(withY1.warnings, []);
assert.deepEqual(withY1.axes.find((a) => a.name === "Y").motors.map((m) => m.role), ["Y0", "Y1"]);

// ZDT drives expose their own configuration fields, not PD42 PID/torque.
const zdt = parseCanConfig(`
can:
  driver: zdt
  baud: 500000
axes:
  x:
    steps_per_mm: 80
    motor0:
      zdt:
        address: 1
        firmware: Emm
        checksum: 6B
        counts_per_rev: 3200
        counts_per_step: 1
        speed_rpm: 20
        accel: 50
        update_ms: 20
        mode: position_stream
        position_mode: relative_previous
        speed_source: fixed
`);
assert.equal(zdt.can.driverLabel, "ZDT");
assert.equal(zdt.drivers[0].protocol, "zdt");
assert.equal(zdt.x.motor0.firmware, "Emm");
assert.equal(zdt.x.motor0.checksum, "6B");
assert.equal(zdt.x.motor0.counts_per_rev, 3200);
assert.equal(zdt.x.motor0.mode, "position_stream");
assert.equal(zdt.x.motor0.position_mode, "relative_previous");
assert.equal(zdt.x.motor0.speed_source, "fixed");
assert.equal(zdt.x.motor0.sync, null);
assert.deepEqual(zdt.warnings, []);

// Mixed protocols and driver mismatch are configuration errors.
const mixed = parseCanConfig(`
can:
  driver: zdt
axes:
  x:
    motor0:
      zdt:
        address: 1
  y:
    motor0:
      pd42s1:
        address: 2
`);
assert.ok(mixed.warnings.some((w) => w.includes("多种 CAN 协议")));
const mismatch = parseCanConfig(`
can:
  driver: pd42s1
axes:
  x:
    motor0:
      zdt:
        address: 1
`);
assert.ok(mismatch.warnings.some((w) => w.includes("不一致")));

const map = parseConfigMap(sample);
assert.equal(map.axes.y.steps_per_mm, 80);
assert.equal(map.axes.x.motor0.pd42s1.address, 1);
assert.equal(formatBool(true), "是");
assert.equal(formatBool(false), "否");
assert.equal(formatNumber(64), "64");

console.log("yconfig tests: PASS");
