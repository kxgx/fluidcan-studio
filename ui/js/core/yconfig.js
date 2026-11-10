// Pure helpers for reading the CAN motor section of FluidNC config.yaml.
// Kept dependency-free so they can be exercised from Node.

export const AXIS_ROLES = Object.freeze({
  1: "X",
  2: "Y0",
  3: "Y1",
  4: "Z",
});

export function driverRole(address) {
  return AXIS_ROLES[Number(address)] || "";
}

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

function motorSummary(motor, fallbackAddress) {
  if (!motor || typeof motor !== "object") {
    return {
      address: fallbackAddress,
      counts: null,
      invert: null,
      block: null,
      sync: null,
      torque: null,
      pid: null,
    };
  }
  const pd = motor.pd42s1 && typeof motor.pd42s1 === "object" ? motor.pd42s1 : {};
  return {
    address: pd.address ?? fallbackAddress,
    counts: pd.counts_per_step ?? null,
    invert: pd.invert_direction ?? null,
    block: pd.block_targets ?? null,
    sync: pd.sync_group ?? 0,
    torque: pd.max_torque_ma ?? null,
    pid:
      pd.position_pid_p == null && pd.position_pid_i == null && pd.position_pid_d == null
        ? null
        : [pd.position_pid_p, pd.position_pid_i, pd.position_pid_d],
  };
}

/**
 * Extract the dual-Y/CAN settings that matter to this machine and flag
 * configurations that the current single-axis-per-motor firmware should not
 * silently accept.
 */
export function parseCanConfig(yaml) {
  const doc = parseConfigMap(yaml);
  const axes = doc.axes && typeof doc.axes === "object" ? doc.axes : {};
  const x = axes.x && typeof axes.x === "object" ? axes.x : {};
  const y = axes.y && typeof axes.y === "object" ? axes.y : {};
  const z = axes.z && typeof axes.z === "object" ? axes.z : {};
  const can = doc.can && typeof doc.can === "object" ? doc.can : {};

  const y0 = motorSummary(y.motor0, 2);
  const y1 = motorSummary(y.motor1, 3);
  const warnings = [];

  if (!y.motor1) warnings.push("Y motor1 不存在：当前没有独立 Y1 控制配置");
  if (Number(y0.address) !== 2) warnings.push(`Y0 地址是 ${y0.address ?? "未设置"}，预期 2`);
  if (y.motor1 && Number(y1.address) !== 3) warnings.push(`Y1 地址是 ${y1.address ?? "未设置"}，预期 3`);
  if (y0.invert != null && y1.invert != null && y0.invert !== y1.invert) {
    warnings.push("Y0/Y1 invert_direction 不一致");
  }
  if (can.group_member_address || can.group_member_group) {
    warnings.push("检测到 group_member_address/group_member_group：当前固件不应再使用自动分组");
  }
  if (y.motor1 && y0.sync !== y1.sync) warnings.push("Y0/Y1 sync_group 不一致");

  return {
    x: {
      steps: x.steps_per_mm ?? null,
      motor: motorSummary(x.motor0, 1),
    },
    y: {
      steps: y.steps_per_mm ?? null,
      motor0: y0,
      motor1: y.motor1 ? y1 : null,
    },
    z: {
      steps: z.steps_per_mm ?? null,
      motor: motorSummary(z.motor0, 4),
    },
    can: {
      baud: can.baud ?? null,
      tx: can.tx_pin ?? null,
      rx: can.rx_pin ?? null,
      groupMemberAddress: can.group_member_address ?? 0,
      groupMemberGroup: can.group_member_group ?? 0,
    },
    warnings,
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
