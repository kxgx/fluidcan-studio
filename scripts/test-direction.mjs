import assert from "node:assert/strict";
import {
  clampFeed,
  directionLabel,
  directionToJog,
  gamepadButtonDirection,
  gamepadStickDirection,
  isTypingTarget,
  keyboardDirection,
  makeDirectionStabilizer,
  normalizePlane,
  stickDirection,
} from "../ui/js/core/direction.js";

assert.equal(normalizePlane("xy"), "XY");
assert.equal(normalizePlane(" xz "), "XZ");
assert.equal(normalizePlane("bogus"), "XY");
assert.equal(clampFeed(500, 3000), 500);
assert.equal(clampFeed(4000, 3000), 3000);
assert.equal(clampFeed(4000, 1000), 1000);
assert.equal(clampFeed(50, 3000), 100);
assert.equal(clampFeed("bad", 3000), 500);

assert.equal(directionToJog("XY", "left", 1, 500), "$J=G21G91X-1F500");
assert.equal(directionToJog("XY", "right", 2, 600), "$J=G21G91X2F600");
assert.equal(directionToJog("XY", "up", 0.5, 300), "$J=G21G91Y0.5F300");
assert.equal(directionToJog("XY", "down", 1, 500), "$J=G21G91Y-1F500");
assert.equal(directionToJog("XZ", "up", 1, 500), "$J=G21G91Z1F500");
assert.equal(directionToJog("YZ", "left", 1, 500), "$J=G21G91Y-1F500");
assert.equal(directionToJog("XY", "sideways", 1, 500), "");
assert.equal(directionToJog("XY", "left", 0, 500), "");
assert.equal(directionToJog("XY", "left", 1, 0), "");
assert.equal(directionLabel("XZ", "down"), "Z-");
assert.equal(directionLabel("XY", "up"), "Y+");

assert.equal(keyboardDirection("ArrowLeft"), "left");
assert.equal(keyboardDirection("ArrowRight"), "right");
assert.equal(keyboardDirection("ArrowUp"), "up");
assert.equal(keyboardDirection("ArrowDown"), "down");
assert.equal(keyboardDirection("w"), null);
assert.equal(keyboardDirection("w", { wasd: true }), "up");
assert.equal(keyboardDirection("a", { wasd: true }), "left");
assert.equal(keyboardDirection("d", { wasd: true }), "right");
assert.equal(keyboardDirection("s", { wasd: true }), "down");

assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
assert.equal(isTypingTarget({ tagName: "textarea" }), true);
assert.equal(isTypingTarget({ tagName: "SELECT" }), true);
assert.equal(isTypingTarget({ tagName: "DIV", isContentEditable: true }), true);
assert.equal(isTypingTarget({ tagName: "DIV" }), false);

const stable = makeDirectionStabilizer(2);
assert.equal(stable("left"), null);
assert.equal(stable("left"), "left");
assert.equal(stable("left"), null);
assert.equal(stable(null), null);
assert.equal(stable("right"), null);
assert.equal(stable("right"), "right");
const jitter = makeDirectionStabilizer(2);
for (const v of ["left", "right", "left", "right", "left", "right"]) jitter(v);
assert.equal(jitter("left"), null);
assert.equal(jitter("left"), "left"); // now stable for two samples
assert.equal(isTypingTarget(null), false);

function pad(buttons = {}, axes = [0, 0]) {
  return {
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: Boolean(buttons[i]) })),
    axes,
  };
}
assert.equal(gamepadButtonDirection(pad({ 14: true })), "left");
assert.equal(gamepadStickDirection(pad({}, [-1, 0])), "left");
assert.equal(gamepadStickDirection(pad({}, [0, -1])), "up");
assert.equal(gamepadStickDirection(pad({}, [0, 0])), null);
assert.equal(gamepadButtonDirection(null), null);

assert.equal(stickDirection(-1, 0), "left");
assert.equal(stickDirection(0, -1), "up");
assert.equal(stickDirection(0.1, 0.1), null);
assert.equal(stickDirection(0, 0), null);

console.log("direction tests: PASS");
