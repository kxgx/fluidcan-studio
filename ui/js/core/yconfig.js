// Pure helpers for reading the CAN motor section of FluidNC config.yaml.
// Kept dependency-free so they can be exercised from Node.
//
// The firmware is protocol-neutral: can.driver selects the bus protocol and
// each motor carries a protocol-specific block (pd42s1 / zdt / canopen).
// This parser keeps the common fields normalized and preserves the
// protocol-specific fields the UI needs to display.

import { motorDriverEntry, normalizeProtocol, protocolLabel } from "./drivers.js";

function scalar(value) {
  const text = value.trim();
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  return text.replace(/^["']|["']$/g, "");
}

/**
 * Parse the small map-only subset used by config.yaml.  The firmware config
 * has no flow sequences in the sections this tool displays, so a path-based
 * indentation parser is enough and avoids shipping a full YAML dependency.
 */
export function parseConfigMap(yaml) {
  const root = {};
  const stack = [];
  for (const raw of String(yaml || "").split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw) || /^\s*---/.test(raw)) continue;
    const match = raw.match(/^(\s*)([^:#]+):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    if (!key) continue;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack.length ? stack[stack.length - 1].node : root;
    const tail = match[3] == null ? "" : match[3].trim();
    if (tail === "") {
      const node = {};
      parent[key] = node;
      stack.push({ indent, node });
    } else {
      parent[key] = scalar(tail);
    }
  }
  return root;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function motorSummary(motor, fallbackAddress = null) {
  const entry = motor && typeof motor === "object" ? motorDriverEntry(motor) : null;
  if (!entry) {
    return {
      present: Boolean(motor && typeof motor === "object"),
      protocol: "",
      protocolLabel: "",
      address: fallbackAddress,
      counts: null,
      counts_per_step: null,
      counts_per_rev: null,
      invert: null,
      block: null,
      sync: null,
      torque: null,
      pid: null,
      firmware: null,
      checksum: null,
      node_id: null,
      speed_rpm: null,
      accel: null,
      update_ms: null,
    };
  }
  const p = entry.config || {};
  return {
    present: true,
    protocol: entry.protocol,
    protocolLabel: protocolLabel(entry.protocol),
    address: p.address ?? fallbackAddress,
    counts: p.counts_per_step ?? null,
    counts_per_step: p.counts_per_step ?? null,
    counts_per_rev: p.counts_per_rev ?? null,
    invert: p.invert_direction ?? null,
    block: p.block_targets ?? null,
    sync: p.sync_group ?? null,
    torque: p.max_torque_ma ?? null,
    pid:
      p.position_pid_p == null && p.position_pid_i == null && p.position_pid_d == null
        ? null
        : [p.position_pid_p, p.position_pid_i, p.position_pid_d],
    firmware: p.firmware ?? null,
    checksum: p.checksum ?? null,
    node_id: p.node_id ?? null,
    speed_rpm: p.speed_rpm ?? null,
    accel: p.accel ?? null,
    update_ms: p.update_ms ?? null,
  };
}

function axisMotors(axisNode) {
  if (!axisNode || typeof axisNode !== "object") return [];
  const motors = [];
  for (let index = 0; index < 16; index += 1) {
    const motor = axisNode[`motor${index}`];
    if (!motor || typeof motor !== "object") continue;
    const entry = motorDriverEntry(motor);
    if (!entry) continue;
    motors.push({ index, motor: motorSummary(motor) });
  }
  return motors;
}

/**
 * Extract the generic CAN settings and per-axis motor details from config.yaml.
 * Returns:
 *   can:    { driver, driverLabel, baud, tx, rx }
 *   axes:   [{ name, steps, motors: [{ role, ...summary }] }]
 *   drivers:flat list (same shape as parseDriverLayout)
 *   warnings
 * plus x/y/z convenience objects for older views.
 */
export function parseCanConfig(yaml) {
  const doc = parseConfigMap(yaml);
  const axesNode = doc.axes && typeof doc.axes === "object" ? doc.axes : {};
  const canNode = doc.can && typeof doc.can === "object" ? doc.can : {};
  const canDriver = normalizeProtocol(canNode.driver);
  const axes = [];
  const drivers = [];
  const protocols = [];
  const addressOwners = new Map();
  const warnings = [];

  for (const [axisKey, axisNode] of Object.entries(axesNode)) {
    if (!axisNode || typeof axisNode !== "object") continue;
    const name = String(axisKey).trim().toUpperCase();
    if (!name) continue;
    const motors = axisMotors(axisNode);
    if (!motors.length) continue;
    axes.push({
      name,
      steps: axisNode.steps_per_mm ?? null,
      motors: motors.map((entry, index) => ({
        role: motors.length > 1 ? `${name}${index}` : name,
        ...entry.motor,
      })),
    });
    motors.forEach((entry, index) => {
      const summary = entry.motor;
      const role = motors.length > 1 ? `${name}${index}` : name;
      if (!protocols.includes(summary.protocol)) protocols.push(summary.protocol);
      drivers.push({ axis: name, role, ...summary });
      if (summary.address != null) {
        if (addressOwners.has(summary.address)) {
          warnings.push(`地址 ${summary.address} 被 ${addressOwners.get(summary.address)} 和 ${role} 重复使用`);
        } else {
          addressOwners.set(summary.address, role);
        }
      }
    });
    const configured = motors.map((entry) => entry.motor);
    const inverts = configured.map((m) => m.invert).filter((v) => v != null);
    if (inverts.length > 1 && new Set(inverts).size > 1) {
      warnings.push(`${name} 轴多个电机的 invert_direction 不一致`);
    }
    const syncs = configured.map((m) => m.sync).filter((v) => v != null);
    if (syncs.length > 1 && new Set(syncs).size > 1) {
      warnings.push(`${name} 轴多个电机的 sync_group 不一致`);
    }
  }

  if (protocols.length > 1) {
    warnings.push(
      `配置了多种 CAN 协议（${protocols.map(protocolLabel).join(" / ")}），固件 can.driver 只能选择一种；混合总线不会同时工作`,
    );
  }
  if (canDriver && protocols.length === 1 && protocols[0] !== canDriver) {
    warnings.push(`can.driver=${protocolLabel(canDriver)} 与电机配置协议 ${protocolLabel(protocols[0])} 不一致`);
  }
  if (!canDriver && drivers.length) {
    warnings.push("can.driver 未设置；固件将使用默认驱动，请显式配置");
  }
  if (canNode.group_member_address || canNode.group_member_group) {
    warnings.push("检测到 group_member_address/group_member_group：当前固件不应再使用自动分组");
  }

  const byName = {};
  for (const axis of axes) byName[axis.name] = axis;
  const axisCompat = (name) => {
    const axis = byName[name] || { steps: null, motors: [] };
    return {
      steps: axis.steps,
      motor0: axis.motors[0] || null,
      motor1: axis.motors[1] || null,
      motors: axis.motors,
    };
  };

  return {
    can: {
      driver: canDriver,
      driverLabel: canDriver ? protocolLabel(canDriver) : "",
      baud: canNode.baud ?? null,
      tx: canNode.tx_pin ?? null,
      rx: canNode.rx_pin ?? null,
      groupMemberAddress: canNode.group_member_address ?? 0,
      groupMemberGroup: canNode.group_member_group ?? 0,
    },
    axes,
    drivers,
    protocols,
    warnings,
    // Backwards-compatible convenience views.
    x: axisCompat("X"),
    y: axisCompat("Y"),
    z: axisCompat("Z"),
  };
}

export function formatBool(value) {
  if (value == null) return "--";
  return value ? "是" : "否";
}

export function formatNumber(value, digits = 2) {
  if (value == null || value === "") return "--";
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(digits))) : String(value);
}

export { numberOrNull };
