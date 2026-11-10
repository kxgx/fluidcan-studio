// Parsers are pure functions so they can be tested without a browser.
export function asText(value) {
  return typeof value === "string" ? value : "";
}

export function pick(text, re, fallback = "--") {
  const m = String(text ?? "").match(re);
  return m ? m[1] : fallback;
}

export function parseState(value) {
  const text = asText(value);
  if (!text) return "--";
  return text.trim().split("\n")[0].replace(/^<|>$/g, "");
}

export function stateParts(value) {
  const state = parseState(value);
  return {
    state,
    name: state.split("|")[0] || "--",
    mpos: (state.match(/MPos:([^|]+)/) || [])[1] || "--",
  };
}

const AXIS_ROLES = { 1: "X", 2: "Y0", 3: "Y1", 4: "Z" };

function roleFor(address) {
  return AXIS_ROLES[Number(address)] || "";
}

export function driverRows(can) {
  const pos = asText(can && can.positions);
  const faults = asText(can && can.faults);
  const rows = new Map();

  for (const line of pos.split("\n")) {
    const m = line.match(
      /address\s+(\d+):.*pos=(-?\d+).*error=(-?\d+).*speed=(-?\d+)RPM.*in-position=(\w+)/,
    );
    if (m) {
      rows.set(m[1], {
        addr: m[1],
        role: roleFor(m[1]),
        pos: m[2],
        err: m[3],
        speed: m[4],
        inpos: m[5],
      });
    }
  }

  for (const line of faults.split("\n")) {
    const m = line.match(
      /address\s+(\d+):.*fw V([\d.]+).*status=(\w+).*stall=(\w+).*enabled=(\w+).*in-position=(\w+)/,
    );
    if (m) {
      const row = rows.get(m[1]) || { addr: m[1], role: roleFor(m[1]) };
      Object.assign(row, {
        fw: m[2],
        status: m[3],
        stall: m[4],
        enabled: m[5],
        inpos: m[6],
      });
      rows.set(m[1], row);
    }
  }

  return [...rows.values()].sort((a, b) => Number(a.addr) - Number(b.addr));
}

export function onlineCount(can) {
  return driverRows(can).length;
}

export function enabledCount(can) {
  return driverRows(can).filter((d) => d.enabled === "yes").length;
}

export function canBusRows(can) {
  const text = asText(can && can.status);
  return [
    ["状态", pick(text, /state=(\w+)/)],
    ["TX错误", pick(text, /tx_err=(\d+)/)],
    ["RX错误", pick(text, /rx_err=(\d+)/)],
    ["BUS错误", pick(text, /bus_errors=(\d+)/)],
  ];
}
