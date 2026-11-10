import assert from "node:assert/strict";
import { zeroCommand, zeroAllCommand } from "../ui/js/views/control.js";

assert.equal(zeroCommand("X"), "G10 L20 P1 X0");
assert.equal(zeroCommand("y"), "G10 L20 P1 Y0");
assert.equal(zeroCommand(" Z "), "G10 L20 P1 Z0");
assert.equal(zeroAllCommand(), "G10 L20 P1 X0 Y0 Z0");
assert.throws(() => zeroCommand("A"), /不支持的清零轴/);
assert.throws(() => zeroCommand(""), /不支持的清零轴/);

console.log("zero-axis tests: PASS");
