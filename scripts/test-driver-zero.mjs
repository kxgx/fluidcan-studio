import assert from "node:assert/strict";
import { driverZeroCommand, driverZeroAllCommand, zeroCommand } from "../ui/js/views/control.js";
import { parseConfigMap } from "../ui/js/core/yconfig.js";
import { parseDriverLayout } from "../ui/js/core/drivers.js";

// Driver zero addresses come from config.yaml (X=1, Y=2,3, Z=4).
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

assert.equal(driverZeroCommand("X", layout), "$CANZero=1");
assert.equal(driverZeroCommand("y", layout), "$CANZero=2,3");
assert.equal(driverZeroCommand(" Z ", layout), "$CANZero=4");
assert.equal(driverZeroAllCommand(layout), "$CANZero=1,2,3,4");
assert.equal(zeroCommand("Y", layout), "G10 L20 P1 Y0");
assert.throws(() => driverZeroCommand("A", layout), /不支持的驱动零位轴/);
assert.throws(() => driverZeroCommand("", layout), /不支持的驱动零位轴/);
// No config => refuse to send $CANZero with guessed addresses.
assert.throws(() => driverZeroCommand("X", null), /不支持的驱动零位轴/);
assert.throws(() => driverZeroAllCommand(null), /config\.yaml/);

// A different config must produce different addresses (no hard-coded 1..4).
const other = parseDriverLayout(
  parseConfigMap(`axes:
  a:
    motor0:
      pd42s1:
        address: 5
  b:
    motor0:
      pd42s1:
        address: 6
`),
);
assert.equal(driverZeroCommand("A", other), "$CANZero=5");
assert.equal(driverZeroAllCommand(other), "$CANZero=5,6");

console.log("driver-zero tests: PASS");
