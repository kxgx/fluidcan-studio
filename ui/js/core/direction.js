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
export function clampFeed(value, max = Infinity) {
  // The ceiling comes from config.yaml via the caller.  If it is unknown,
  // do not invent a fixed speed cap; only enforce a positive rate.
  const requested = Number(max);
  const ceiling = Number.isFinite(requested) && requested > 0 ? Math.max(1, requested) : Infinity;
  const feed = Number(value);
  if (!Number.isFinite(feed) || feed <= 0) return 500;
  return Math.min(ceiling, Math.max(1, feed));
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


// ---------------------------------------------------------------------------
// NC-style multi-axis jog helpers.
//
// Arrow keys/D-pad are X/Y; PageUp/PageDown are Z.  A held input set is a
// signed axis vector, so X/Y/Z may be combined in one $J command.

export function zeroVector() {
  return { X: 0, Y: 0, Z: 0 };
}

export function mergeVector(target, part) {
  const out = target || zeroVector();
  if (part && part.X) out.X = part.X;
  if (part && part.Y) out.Y = part.Y;
  if (part && part.Z) out.Z = part.Z;
  return out;
}

export function vectorIsZero(vector) {
  return !vector || (!vector.X && !vector.Y && !vector.Z);
}

export function keyboardVector(key, { wasd = false } = {}) {
  const text = String(key ?? "");
  switch (text) {
    case "ArrowLeft":
      return { X: -1 };
    case "ArrowRight":
      return { X: 1 };
    case "ArrowUp":
      return { Y: 1 };
    case "ArrowDown":
      return { Y: -1 };
    case "PageUp":
      return { Z: 1 };
    case "PageDown":
      return { Z: -1 };
    default:
      break;
  }
  if (!wasd) return null;
  switch (text.toLowerCase()) {
    case "a":
      return { X: -1 };
    case "d":
      return { X: 1 };
    case "w":
      return { Y: 1 };
    case "s":
      return { Y: -1 };
    default:
      return null;
  }
}

// Gamepad digital mapping: D-pad X/Y, LB/RB Z.  Triggers are not used so a
// half-pressed trigger cannot leave an axis running.
export function gamepadDigitalVector(gamepad) {
  if (!gamepad || !Array.isArray(gamepad.buttons)) return null;
  if (gamepad.mapping != null && gamepad.mapping !== "standard") return null;
  const pressed = (index) => Boolean(gamepad.buttons[index] && gamepad.buttons[index].pressed);
  const vector = zeroVector();
  if (pressed(14)) vector.X = -1;
  if (pressed(15)) vector.X = 1;
  if (pressed(12)) vector.Y = 1;
  if (pressed(13)) vector.Y = -1;
  if (pressed(4)) vector.Z = 1;   // LB
  if (pressed(5)) vector.Z = -1;  // RB
  return vectorIsZero(vector) ? null : vector;
}

export function gamepadStickVector(gamepad, deadzone = 0.35) {
  if (!gamepad || !Array.isArray(gamepad.axes)) return null;
  if (gamepad.mapping != null && gamepad.mapping !== "standard") return null;
  const x = Number(gamepad.axes[0] || 0);
  const y = Number(gamepad.axes[1] || 0);
  const vector = zeroVector();
  if (Math.abs(x) >= deadzone) vector.X = x < 0 ? -1 : 1;
  if (Math.abs(y) >= deadzone) vector.Y = y < 0 ? 1 : -1;
  return vectorIsZero(vector) ? null : vector;
}

export function stickVector(dx, dy, deadzone = 0.35) {
  const x = Number(dx || 0);
  const y = Number(dy || 0);
  const vector = zeroVector();
  if (Math.abs(x) >= deadzone) vector.X = x < 0 ? -1 : 1;
  if (Math.abs(y) >= deadzone) vector.Y = y < 0 ? 1 : -1;
  return vectorIsZero(vector) ? null : vector;
}

// Merge digital and stick input.  A D-pad/button axis wins over the stick on
// the same axis; independent axes remain combinable.
export function mergeGamepadVector(digital, analog) {
  const out = zeroVector();
  if (digital) Object.assign(out, digital);
  if (analog) {
    if (!out.X && analog.X) out.X = analog.X;
    if (!out.Y && analog.Y) out.Y = analog.Y;
    if (!out.Z && analog.Z) out.Z = analog.Z;
  }
  return vectorIsZero(out) ? null : out;
}

export function vectorToJog(vector, distance = 100, feed = 500) {
  if (vectorIsZero(vector)) return "";
  const d = Number(distance);
  const f = Number(feed);
  if (!Number.isFinite(d) || d <= 0 || !Number.isFinite(f) || f <= 0) return "";
  let axes = "";
  for (const axis of ["X", "Y", "Z"]) {
    const sign = Number(vector[axis] || 0);
    if (sign) axes += `${axis}${sign > 0 ? d : -d}`;
  }
  return axes ? `$J=G21G91${axes}F${f}` : "";
}

export function vectorLabel(vector) {
  if (vectorIsZero(vector)) return "--";
  return ["X", "Y", "Z"]
    .filter((axis) => vector[axis])
    .map((axis) => `${axis}${vector[axis] > 0 ? "+" : "-"}`)
    .join(" ");
}

export function directionLabel(plane, direction) {
  const config = DPAD_PLANES[normalizePlane(plane)];
  const vector = VECTORS[String(direction ?? "").trim().toLowerCase()];
  if (!config || !vector) return "--";
  const axis = vector.first !== 0 ? config.first : config.second;
  const sign = vector.first !== 0 ? vector.first : vector.second;
  return `${axis}${sign > 0 ? "+" : "-"}`;
}
