// Derive the CAN driver layout (addresses, axes, protocols, roles, capacity)
// from the device's config.yaml.  Pure functions so they can be tested from
// Node and reused by the browser UI.
//
// The current firmware has a protocol-neutral CanBus: `can.driver` selects the
// protocol driver, while each motor uses a protocol-specific config block
// (`pd42s1`, `zdt` or `canopen`).  The bus keeps at most MAX_CLIENTS = 16
// addressed clients (FluidNC/src/Can/CanBus.h), so do not hard-code the old
// 8-client limit.

export const CAN_ADDRESS_LIMIT = 16;

export const CAN_PROTOCOLS = {
  pd42s1: { key: "pd42s1", label: "PD42S1", family: "vendor" },
  zdt: { key: "zdt", label: "ZDT", family: "vendor" },
  canopen: { key: "canopen", label: "CANopen", family: "standard" },
};

export const CAN_MOTOR_KEYS = Object.keys(CAN_PROTOCOLS);

export function normalizeProtocol(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return CAN_PROTOCOLS[text] ? text : "";
}

export function protocolLabel(value) {
  const key = normalizeProtocol(value);
  return key ? CAN_PROTOCOLS[key].label : value ? String(value) : "未知";
}

// Find the protocol-specific block in one `motorN` node.  Returns
// { protocol, config } or null when this motor is not a CAN motor.
export function motorDriverEntry(motor) {
  if (!motor || typeof motor !== "object") return null;
  for (const protocol of CAN_MOTOR_KEYS) {
    const config = motor[protocol];
    if (config && typeof config === "object") return { protocol, config };
  }
  return null;
}

function motorAddress(motor) {
  const entry = motorDriverEntry(motor);
  if (!entry) return null;
  const address = Number(entry.config.address);
  return Number.isInteger(address) && address > 0 ? address : null;
}

/**
 * Parse axes/motorN/<protocol>/address structures of a FluidNC config map:
 *   drivers: [{ address, axis, role, protocol, protocolLabel, config }]
 *   axes:    ["X", "Y", "Z"] (config order, for G10 zeroing)
 *   can:     { driver, baud, tx, rx }
 *   addressList / count / limit / overLimit / duplicates / outOfRange /
 *   protocols / warnings
 *
 * Role naming: a single-motor axis is just "X"; an axis with several motors is
 * "Y0"/"Y1" like the dual-Y machine.
 */
export function parseDriverLayout(configMap) {
  const root = configMap && typeof configMap === "object" ? configMap : {};
  const axesNode = root.axes && typeof root.axes === "object" ? root.axes : {};
  const canNode = root.can && typeof root.can === "object" ? root.can : {};
  const drivers = [];
  const axes = [];
  const protocols = [];
  const axisLimits = {};
  const seen = new Map();
  const duplicates = [];

  for (const [axisKey, axisNode] of Object.entries(axesNode)) {
    if (!axisNode || typeof axisNode !== "object") continue;
    const axis = String(axisKey).trim().toUpperCase();
    if (!axis) continue;
    const motors = [];
    for (let index = 0; index < CAN_ADDRESS_LIMIT; index += 1) {
      const motor = axisNode[`motor${index}`];
      const address = motorAddress(motor);
      if (address != null) {
        const entry = motorDriverEntry(motor);
        motors.push({ address, protocol: entry.protocol, config: entry.config });
      }
    }
    if (!motors.length) continue;
    const limit = axisMaxFeed(axisNode);
    if (limit != null) axisLimits[axis] = limit;
    axes.push(axis);
    motors.forEach((motor, index) => {
      const role = motors.length > 1 ? `${axis}${index}` : axis;
      if (seen.has(motor.address)) {
        duplicates.push(motor.address);
      } else {
        seen.set(motor.address, role);
      }
      if (!protocols.includes(motor.protocol)) protocols.push(motor.protocol);
      drivers.push({
        address: motor.address,
        axis,
        role,
        protocol: motor.protocol,
        protocolLabel: protocolLabel(motor.protocol),
        config: motor.config,
      });
    });
  }

  drivers.sort((a, b) => a.address - b.address);
  const addressList = drivers.map((driver) => driver.address);
  const count = drivers.length;
  const outOfRange = [...new Set(addressList.filter((address) => address > CAN_ADDRESS_LIMIT))];
  const warnings = [];

  if (duplicates.length) {
    warnings.push(`config.yaml 里地址重复：${[...new Set(duplicates)].join(", ")}`);
  }
  if (outOfRange.length) {
    warnings.push(`地址 ${outOfRange.join(", ")} 超出 CAN 总线地址上限 ${CAN_ADDRESS_LIMIT}`);
  }
  if (count > CAN_ADDRESS_LIMIT) {
    warnings.push(`配置了 ${count} 台驱动器，超过 CAN 总线上限 ${CAN_ADDRESS_LIMIT}，多出的地址不会被固件控制`);
  }
  if (protocols.length > 1) {
    warnings.push(
      `配置了多种 CAN 协议（${protocols.map(protocolLabel).join(" / ")}），固件 can.driver 只能选择一种；混合总线不会同时工作`,
    );
  }
  const configuredDriver = normalizeProtocol(canNode.driver);
  if (configuredDriver && protocols.length === 1 && protocols[0] !== configuredDriver) {
    warnings.push(
      `can.driver=${protocolLabel(configuredDriver)} 与电机配置协议 ${protocolLabel(protocols[0])} 不一致`,
    );
  }

  return {
    drivers,
    axes,
    addressList,
    count,
    limit: CAN_ADDRESS_LIMIT,
    overLimit: count > CAN_ADDRESS_LIMIT || outOfRange.length > 0 || duplicates.length > 0,
    duplicates: [...new Set(duplicates)],
    outOfRange,
    protocols,
    axisLimits,
    can: {
      driver: configuredDriver,
      driverLabel: configuredDriver ? protocolLabel(configuredDriver) : "",
      baud: canNode.baud ?? null,
      tx: canNode.tx_pin ?? null,
      rx: canNode.rx_pin ?? null,
    },
    warnings,
    // Limit switch wiring (read-only) for the limit test panel.
    limits: parseLimitSwitches(configMap),
  };
}

// Axis feed ceiling comes from config.yaml.  FluidNC accepts both the legacy
// `max_rate_mm_per_min` and the human-readable `max_speed_mm_per_min`; rotary
// axes use max_speed_deg_per_min.  Keep the value unit-neutral here: the
// direction pad only uses X/Y/Z planes in mm/min.
export function axisMaxFeed(axisNode) {
  if (!axisNode || typeof axisNode !== "object") return null;
  // Human-readable max_speed_* wins over the legacy max_rate_* aliases,
  // matching Axis::afterParse/validate precedence.
  const keys = ["max_speed_mm_per_min", "max_rate_mm_per_min", "max_speed_deg_per_min", "max_rate_deg_per_min"];
  for (const key of keys) {
    const value = Number(axisNode[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function maxFeedForAxes(layout, axes, missingAxisDefault = null) {
  const limits = [];
  let missing = false;
  for (const axis of Array.isArray(axes) ? axes : []) {
    const value = layout && layout.axisLimits ? Number(layout.axisLimits[String(axis).toUpperCase()]) : NaN;
    if (Number.isFinite(value) && value > 0) limits.push(value);
    else missing = true;
  }
  if (missing && Number.isFinite(missingAxisDefault) && missingAxisDefault > 0) limits.push(missingAxisDefault);
  return limits.length ? Math.min(...limits) : null;
}

function isConfiguredPin(value) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return text !== "" && text.toUpperCase() !== "NO_PIN";
}

/**
 * Extract the configured limit/probe pins per axis from config.yaml, e.g.
 *   axes.x.motor0.limit_all_pin: gpio.17:pu:low
 * NO_PIN entries are ignored.  Order follows config.yaml.
 */
export function parseLimitSwitches(configMap) {
  const axesNode =
    configMap && typeof configMap === "object" && configMap.axes && typeof configMap.axes === "object" ? configMap.axes : {};
  const out = [];
  const buckets = [
    ["limit_all_pin", "all"],
    ["limit_neg_pin", "neg"],
    ["limit_pos_pin", "pos"],
  ];
  for (const [axisKey, axisNode] of Object.entries(axesNode)) {
    if (!axisNode || typeof axisNode !== "object") continue;
    const pins = { all: [], neg: [], pos: [] };
    for (let index = 0; index < CAN_ADDRESS_LIMIT; index += 1) {
      const motor = axisNode[`motor${index}`];
      if (!motor || typeof motor !== "object") continue;
      for (const [key, bucket] of buckets) {
        if (isConfiguredPin(motor[key])) pins[bucket].push(motor[key].trim());
      }
    }
    if (!pins.all.length && !pins.neg.length && !pins.pos.length) continue;
    out.push({ axis: String(axisKey).trim().toUpperCase(), pins });
  }
  return out;
}

// address -> { role, axis, protocol, protocolLabel } for the generic tables.
export function driverMetaMap(layout) {
  const map = {};
  for (const driver of layout && Array.isArray(layout.drivers) ? layout.drivers : []) {
    map[driver.address] = {
      role: driver.role,
      axis: driver.axis,
      protocol: driver.protocol,
      protocolLabel: driver.protocolLabel,
    };
  }
  return map;
}

export function addressesForAxis(layout, axis) {
  const name = String(axis || "").trim().toUpperCase();
  if (!name || !layout || !Array.isArray(layout.drivers)) return [];
  return layout.drivers.filter((driver) => driver.axis === name).map((driver) => driver.address);
}

export function allDriverAddresses(layout) {
  return layout && Array.isArray(layout.addressList) ? [...layout.addressList] : [];
}

export function configAxisNames(layout) {
  return layout && Array.isArray(layout.axes) ? [...layout.axes] : [];
}
