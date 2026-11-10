import assert from "node:assert/strict";
import { parseCanConfig, parseConfigMap, formatBool, formatNumber, driverRole } from "../ui/js/core/yconfig.js";

const sample = `
name: test
can:
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
assert.deepEqual(missingY1.warnings, ["Y motor1 不存在：当前没有独立 Y1 控制配置"]);
assert.equal(missingY1.y.motor0.address, 2);
assert.equal(missingY1.y.motor0.block, true);
assert.equal(missingY1.y.motor0.counts, 64);
assert.equal(missingY1.y.motor1, null);

const grouped = parseCanConfig(sample.replace("  baud: 500000", "  baud: 500000\n  group_member_address: 3\n  group_member_group: 2"));
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
assert.equal(withY1.warnings.length, 0);

const map = parseConfigMap(sample);
assert.equal(map.axes.y.steps_per_mm, 80);
assert.equal(map.axes.x.motor0.pd42s1.address, 1);
assert.equal(formatBool(true), "是");
assert.equal(formatBool(false), "否");
assert.equal(formatNumber(64), "64");
assert.equal(driverRole(2), "Y0");
assert.equal(driverRole(99), "");

console.log("yconfig tests: PASS");
