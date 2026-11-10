import assert from "node:assert/strict";
import { driverZeroCommand, driverZeroAllCommand, zeroCommand } from "../ui/js/views/control.js";

assert.equal(driverZeroCommand("X"), "$CANZero=1");
assert.equal(driverZeroCommand("y"), "$CANZero=2,3");
assert.equal(driverZeroCommand(" Z "), "$CANZero=4");
assert.equal(driverZeroAllCommand(), "$CANZero=1,2,3,4");
assert.equal(zeroCommand("Y"), "G10 L20 P1 Y0");
assert.throws(() => driverZeroCommand("A"), /不支持的驱动零位轴/);
assert.throws(() => driverZeroCommand(""), /不支持的驱动零位轴/);

console.log("driver-zero tests: PASS");
