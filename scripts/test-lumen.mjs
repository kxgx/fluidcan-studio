import assert from "node:assert/strict";
import { LUMEN_OUTPUTS, g28Command, ledCommand, motionCommand, outputCommand, parseVacuum, supportsLumenG28, vacuumCommands } from "../ui/js/views/lumen.js";

assert.equal(LUMEN_OUTPUTS.length, 4);
assert.deepEqual(vacuumCommands(1), [
  "M260 A112 B1 S1",
  "M260 A109",
  "M260 B48",
  "M260 B10",
  "M260 S1",
  "M260 A109 B6 S1",
  "M261 A109 B1 S2",
]);
assert.equal(vacuumCommands(2)[0], "M260 A112 B2 S1");
assert.throws(() => vacuumCommands(3), /1 或 2/);
assert.equal(parseVacuum("data:220\nok"), 220);
assert.equal(parseVacuum("data: 0"), 0);
assert.equal(parseVacuum("ok"), null);
assert.equal(outputCommand(0, true), "M106 P0 S255");
assert.equal(outputCommand(3, false), "M107 P3");
assert.throws(() => outputCommand(4, true), /0\.\.3/);
assert.equal(ledCommand("off"), "M150 P0");
assert.equal(ledCommand("white"), "M150 P255 R255 U255 B255");
assert.throws(() => ledCommand("unknown"), /未知灯光/);
assert.equal(supportsLumenG28("can-v0.2.36 (esp32s3-wifi-16mb-octal)"), true);
assert.equal(supportsLumenG28("can-v0.2.35"), false);
assert.equal(supportsLumenG28("can-v0.2.34"), false);
assert.equal(supportsLumenG28("can-v0.3.0"), true);
assert.equal(supportsLumenG28(""), false);
assert.equal(g28Command(""), "G28");
assert.equal(g28Command("X"), "G28 X");
assert.equal(g28Command("xy"), "G28 XY");
assert.throws(() => g28Command("XA"), /X\/Y\/Z/);
assert.equal(motionCommand("?"), "?");
assert.equal(motionCommand("m114"), "M114");
assert.equal(motionCommand("$x"), "$X");
assert.throws(() => motionCommand("G0 X10"), /不支持/);
console.log("lumen tests: PASS");
