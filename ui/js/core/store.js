// Single UI state store. Views read from here and subscribe to changes.
export const state = {
  mode: "none",
  connected: false,
  base: "",
  build: "",
  // Which link produced `build` (http URL or serial:port).  OTA must refuse to
  // combine a serial build with a different HTTP target.
  buildSource: "",
  status: "",
  can: { status: "", faults: "", positions: "", drivers: "" },
  // Raw $CANDriverInfo text and its read error (actual firmware report).
  firmwareDrivers: "",
  firmwareError: "",
  drivers: [],
  // Parsed from config.yaml after connecting: drivers/axes/address list and the
  // CAN address capacity.  null until a successful /config read.
  driverLayout: null,
  lastUpdate: "",
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function patch(next) {
  Object.assign(state, next);
  for (const fn of listeners) fn(state);
}
