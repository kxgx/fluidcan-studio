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

// Address -> role metadata comes from config.yaml (core/drivers.js).  The
// metadata may be a plain role string (legacy) or { role, protocol,
// protocolLabel } (generic driverMetaMap).
function metaFor(meta, address) {
  if (!meta) return {};
  const value = meta instanceof Map ? meta.get(Number(address)) : meta[Number(address)];
  if (value == null) return {};
  if (typeof value === "string") return { role: value };
  return value;
}

const PROTOCOL_LABELS = {
  pd42s1: "PD42S1",
  zdt: "ZDT",
  canopen: "CANopen",
};

function protocolLabel(protocol) {
  return PROTOCOL_LABELS[protocol] || protocol || "";
}

export function driverRows(can, meta = null) {
  const pos = asText(can && can.positions);
  const faults = asText(can && can.faults);
  const rows = new Map();

  function addRow(address, protocol) {
    const info = metaFor(meta, address);
    const existing = rows.get(String(address));
    if (existing) {
      if (!existing.protocol && protocol) existing.protocol = protocol;
      return existing;
    }
    const row = {
      addr: String(address),
      role: info.role || "",
      protocol: info.protocol || protocol || "",
      protocolLabel: info.protocolLabel || protocolLabel(info.protocol || protocol),
    };
    rows.set(String(address), row);
    return row;
  }

  // PD42S1 position report:
  //   address 1: fw V1.6 pos=269071 error=0 speed=0RPM in-position=yes
  for (const line of pos.split("\n")) {
    const m = line.match(
      /address\s+(\d+):.*pos=(-?\d+).*error=(-?\d+).*speed=(-?\d+)RPM.*in-position=(\w+)/,
    );
    if (m) {
      Object.assign(addRow(m[1], "pd42s1"), {
        pos: m[2],
        err: m[3],
        speed: m[4],
        inpos: m[5],
      });
    }
  }

  // ZDT position report:
  //   ZDT CAN: address 1 position 0
  for (const line of pos.split("\n")) {
    const m = line.match(/ZDT CAN:\s*address\s+(\d+)\s+position\s+(-?\d+)/);
    if (m) {
      Object.assign(addRow(m[1], "zdt"), { pos: m[2] });
    }
  }

  // PD42S1 fault/status report:
  //   address 1: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes
  for (const line of faults.split("\n")) {
    const m = line.match(
      /address\s+(\d+):.*fw V([\d.]+).*status=(\w+).*stall=(\w+).*enabled=(\w+).*in-position=(\w+)/,
    );
    if (m) {
      Object.assign(addRow(m[1], "pd42s1"), {
        fw: m[2],
        status: m[3],
        stall: m[4],
        enabled: m[5],
        inpos: m[6],
      });
    }
  }

  return [...rows.values()].sort((a, b) => Number(a.addr) - Number(b.addr));
}

export function onlineCount(can, meta = null) {
  return driverRows(can, meta).length;
}

export function enabledCount(can, meta = null) {
  return driverRows(can, meta).filter((d) => d.enabled === "yes").length;
}

export function hasEnabledTelemetry(can, meta = null) {
  return driverRows(can, meta).some((d) => d.enabled != null);
}

export function canBusRows(can) {
  const text = asText(can && can.status);
  const rows = [];
  const zdt = text.match(/ready:(\w+).*control:(\w+).*clients:(\d+)/i);
  if (zdt) {
    rows.push(["驱动就绪", zdt[1]]);
    rows.push(["控制就绪", zdt[2]]);
    rows.push(["CAN 客户端", zdt[3]]);
    return rows;
  }
  const pd42 = text.match(/state=(\w+)/i);
  if (pd42) {
    rows.push(["状态", pd42[1]]);
    rows.push(["TX错误", pick(text, /tx_err=(\d+)/)]);
    rows.push(["RX错误", pick(text, /rx_err=(\d+)/)]);
    rows.push(["BUS错误", pick(text, /bus_errors=(\d+)/)]);
    return rows;
  }
  if (text.trim()) {
    rows.push(["原始状态", text.trim().split("\n")[0]]);
  }
  return rows;
}

// Parse the FluidNC realtime status `Pn:` field, e.g.
//   <Idle|MPos:0,0,0|FS:0,0|Pn:PXT>
// FluidNC appends "P" for probe, "T" for toolsetter and the axis names whose
// limit inputs are currently triggered.  Read-only helper for the limit test.
export function parsePinString(status) {
  const text = asText(status);
  const match = text.match(/\|Pn:([^|>\s]+)/);
  const pins = match ? match[1] : "";
  const letters = pins.replace(/[PT]/g, "");
  return {
    pins,
    probe: pins.includes("P"),
    toolsetter: pins.includes("T"),
    axes: [...new Set(letters.split(""))].filter((letter) => /[A-Za-z]/.test(letter)),
  };
}
