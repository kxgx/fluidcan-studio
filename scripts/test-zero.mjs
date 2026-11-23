import assert from "node:assert/strict";
import { zeroCommand, zeroAllCommand } from "../ui/js/views/control.js";
import { parseConfigMap } from "../ui/js/core/yconfig.js";
import { parseDriverLayout } from "../ui/js/core/drivers.js";

// Axis names/order come from config.yaml, not a hard-coded X/Y/Z set.
const layout = parseDriverLayout(
  parseConfigMap(`axes:
  x:
    motor0:
      pd42s1:
        address: 1
  y:
    motor0:
      pd42s1:
        address: 2
    motor1:
      pd42s1:
        address: 3
  z:
    motor0:
      pd42s1:
        address: 4
`),
);

assert.equal(zeroCommand("X", layout), "G10 L20 P1 X0");
assert.equal(zeroCommand("y", layout), "G10 L20 P1 Y0");
assert.equal(zeroCommand(" Z ", layout), "G10 L20 P1 Z0");
assert.equal(zeroAllCommand(layout), "G10 L20 P1 X0 Y0 Z0");
assert.throws(() => zeroCommand("A", layout), /不支持的清零轴/);
assert.throws(() => zeroCommand("", layout), /不支持的清零轴/);
// Without a parsed config the commands must fail instead of using defaults.
assert.throws(() => zeroCommand("X", null), /config\.yaml/);
assert.throws(() => zeroAllCommand(null), /config\.yaml/);

console.log("zero-axis tests: PASS");
