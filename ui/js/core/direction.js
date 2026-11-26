// Pure direction-pad helpers shared by the keyboard, gamepad and on-screen
// controls.  They only build the existing one-shot $J jog command; no motion
// is started unless the caller explicitly invokes them.

export const DPAD_PLANES = {
  XY: { first: "X", second: "Y" },
  XZ: { first: "X", second: "Z" },
  YZ: { first: "Y", second: "Z" },
};

const VECTORS = {
  left: { first: -1, second: 0 },
  right: { first: 1, second: 0 },
  up: { first: 0, second: 1 },
  down: { first: 0, second: -1 },
};

export function normalizePlane(value) {
  const key = String(value ?? "").trim().toUpperCase();
  return DPAD_PLANES[key] ? key : "XY";
}

// UI-side safety cap.  The firmware axis max_rate remains the hard limit; this
// only prevents a stored/typed jog value from exceeding the operator's chosen
// software ceiling.
export function clampFeed(value, max = 3000) {
  const ceiling = Number.isFinite(Number(max)) ? Math.min(3000, Math.max(100, Number(max))) : 3000;
  const feed = Number(value);
  if (!Number.isFinite(feed) || feed <= 0) return 500;
  return Math.min(ceiling, Math.max(100, feed));
}

export function directionToJog(plane, direction, distance = 1, feed = 500) {
  const config = DPAD_PLANES[normalizePlane(plane)];
  const vector = VECTORS[String(direction ?? "").trim().toLowerCase()];
  if (!config || !vector) return "";
  const distanceValue = Number(distance);
  const feedValue = Number(feed);
  if (!Number.isFinite(distanceValue) || distanceValue === 0) return "";
  if (!Number.isFinite(feedValue) || feedValue <= 0) return "";
  const axis = vector.first !== 0 ? config.first : config.second;
  const sign = vector.first !== 0 ? vector.first : vector.second;
  // G21 keeps the jog in millimetres even if the controller modal state is
  // currently G20 (inches); direction steps are always expressed in mm here.
  return `$J=G21G91${axis}${sign * Math.abs(distanceValue)}F${feedValue}`;
}

export function planeAxes(plane) {
  const config = DPAD_PLANES[normalizePlane(plane)];
  return config ? [config.first, config.second] : [];
}

// Keyboard mapping.  Arrow keys are the primary scheme; WASD is accepted only
// when the explicit option is enabled, so typing in a text field is unaffected.
export function keyboardDirection(key, { wasd = false } = {}) {
  const text = String(key ?? "");
  switch (text) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      break;
  }
  if (!wasd) return null;
  switch (text.toLowerCase()) {
    case "a":
      return "left";
    case "d":
      return "right";
    case "w":
      return "up";
    case "s":
      return "down";
    default:
      return null;
  }
}

export function isTypingTarget(target) {
  if (!target || typeof target !== "object") return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.isContentEditable);
}

// Standard Gamepad API mapping: D-pad buttons 12..15 and left stick axes 0/1.
// Digital D-pad presses must not go through the analog stabilizer, otherwise a
// short press can be lost between two 80 ms polls.
export function gamepadButtonDirection(gamepad) {
  if (!gamepad || !Array.isArray(gamepad.buttons)) return null;
  if (gamepad.mapping != null && gamepad.mapping !== "standard") return null;
  const pressed = (index) => Boolean(gamepad.buttons[index] && gamepad.buttons[index].pressed);
  if (pressed(14)) return "left";
  if (pressed(15)) return "right";
  if (pressed(12)) return "up";
  if (pressed(13)) return "down";
  return null;
}

export function gamepadStickDirection(gamepad, deadzone = 0.35) {
  if (!gamepad || !Array.isArray(gamepad.axes)) return null;
  if (gamepad.mapping != null && gamepad.mapping !== "standard") return null;
  const x = Number(gamepad.axes[0] || 0);
  const y = Number(gamepad.axes[1] || 0);
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) return null;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

// Virtual analog stick vector -> one of four cardinal directions.
export function stickDirection(dx, dy, deadzone = 0.35) {
  const x = Number(dx || 0);
  const y = Number(dy || 0);
  if (Math.abs(x) < deadzone && Math.abs(y) < deadzone) return null;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

// A small state machine for analog sources.  A candidate must be seen
// `required` times before it is emitted once; diagonal/deadzone jitter that
// alternates between two directions therefore cannot produce a burst of jog
// commands.  The emitted direction is latched until the source returns to
// neutral, so holding a stick does not repeatedly step.
export function makeDirectionStabilizer(required = 2) {
  const need = Math.max(1, Number(required) || 1);
  let candidate = null;
  let count = 0;
  let emitted = null;
  return (value) => {
    if (!value) {
      candidate = null;
      count = 0;
      emitted = null;
      return null;
    }
    if (value === candidate) {
      count += 1;
    } else {
      candidate = value;
      count = 1;
    }
    if (count < need) return null;
    if (emitted === candidate) return null;
    emitted = candidate;
    return candidate;
  };
}

export function directionLabel(plane, direction) {
  const config = DPAD_PLANES[normalizePlane(plane)];
  const vector = VECTORS[String(direction ?? "").trim().toLowerCase()];
  if (!config || !vector) return "--";
  const axis = vector.first !== 0 ? config.first : config.second;
  const sign = vector.first !== 0 ? vector.first : vector.second;
  return `${axis}${sign > 0 ? "+" : "-"}`;
}
