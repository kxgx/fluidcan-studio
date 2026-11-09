// Single UI state store. Views read from here and subscribe to changes.
export const state = {
  mode: "none",
  connected: false,
  base: "",
  build: "",
  status: "",
  can: { status: "", faults: "", positions: "", drivers: "" },
  drivers: [],
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

export function setConnection(connected, text, mode = state.mode) {
  patch({ connected, mode, base: text || state.base });
}

export function setSnapshot({ build, status, can, base }) {
  patch({
    build: build ?? state.build,
    status: status ?? state.status,
    can: can ?? state.can,
    base: base ?? state.base,
    connected: true,
    lastUpdate: new Date().toLocaleTimeString(),
  });
}
