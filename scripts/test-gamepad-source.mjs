import assert from "node:assert/strict";
import { toGamepad } from "../ui/js/core/gamepad-source.js";

const state = {
  available: true,
  connected: true,
  id: "Xbox Wireless Controller",
  axes: [-0.5, 0.25, 0.0, -1.0],
  buttons: [true, false, false, false, true, false, false, false, false, true, false, false, false, false, true, false, false],
};

const pad = toGamepad(state);
assert.equal(pad.mapping, "standard");
assert.equal(pad.id, "Native Xbox Wireless Controller");
assert.deepEqual(pad.axes, [-0.5, 0.25, 0, -1]);
assert.equal(pad.buttons.length, 17);
assert.equal(pad.buttons[0].pressed, true);
assert.equal(pad.buttons[1].pressed, false);
assert.equal(pad.buttons[4].pressed, true);
assert.equal(pad.buttons[9].pressed, true);
assert.equal(pad.buttons[14].pressed, true);
assert.equal(pad.buttons[6].value, 0);

const empty = toGamepad({ available: true, connected: false, id: "", axes: [], buttons: [] });
assert.equal(empty.buttons.length, 17);
assert.deepEqual(empty.axes, [0, 0, 0, 0]);

console.log("native gamepad source tests: PASS");
