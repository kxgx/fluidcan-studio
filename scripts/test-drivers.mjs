import assert from "node:assert/strict";
import { parseConfigMap } from "../ui/js/core/yconfig.js";
import {
  CAN_ADDRESS_LIMIT,
  addressesForAxis,
  allDriverAddresses,
  configAxisNames,
  driverMetaMap,
  parseDriverLayout,
  parseLimitSwitches,
  roleMap,
} from "../ui/js/core/drivers.js";

function axesYaml(count, protocol = "pd42s1") {
  let yaml = "can:\n  driver: " + protocol + "\naxes:\n";
  for (let i = 0; i < count; i += 1) {
    yaml += `  m${i}:\n    motor0:\n      ${protocol}:\n        address: ${i + 1}\n`;
  }
  return yaml;
}

// PD42 machine layout: X=1, Y0=2, Y1=3, Z=4 parsed from config.yaml.
const machineYaml = `
can:
  driver: pd42s1
  baud: 1000000
axes:
  x:
    motor0:
      pd42s1:
        address: 1
  y:
    motor0:
      pd42s1:
        address: 2
    motor1:
      pd42s1:
        address: 3
  z:
    motor0:
      pd42s1:
        address: 4
`;
const layout = parseDriverLayout(parseConfigMap(machineYaml));
assert.equal(CAN_ADDRESS_LIMIT, 16);
assert.equal(layout.count, 4);
assert.deepEqual(layout.addressList, [1, 2, 3, 4]);
assert.deepEqual(layout.axes, ["X", "Y", "Z"]);
assert.deepEqual(layout.protocols, ["pd42s1"]);
assert.equal(layout.can.driver, "pd42s1");
assert.equal(layout.can.driverLabel, "PD42S1");
assert.deepEqual(
  layout.drivers.map((d) => [d.address, d.role, d.protocol]),
  [
    [1, "X", "pd42s1"],
    [2, "Y0", "pd42s1"],
    [3, "Y1", "pd42s1"],
    [4, "Z", "pd42s1"],
  ],
);
assert.deepEqual(roleMap(layout), { 1: "X", 2: "Y0", 3: "Y1", 4: "Z" });
assert.deepEqual(driverMetaMap(layout)[2], { role: "Y0", axis: "Y", protocol: "pd42s1", protocolLabel: "PD42S1" });
assert.deepEqual(addressesForAxis(layout, "y"), [2, 3]);
assert.deepEqual(addressesForAxis(layout, " x "), [1]);
assert.deepEqual(allDriverAddresses(layout), [1, 2, 3, 4]);
assert.deepEqual(configAxisNames(layout), ["X", "Y", "Z"]);
assert.equal(layout.overLimit, false);
assert.deepEqual(layout.warnings, []);

// ZDT is a first-class motor block, not a special case of PD42.
const zdtLayout = parseDriverLayout(
  parseConfigMap(`can:
  driver: zdt
axes:
  x:
    motor0:
      zdt:
        address: 1
        firmware: Emm
  y:
    motor0:
      zdt:
        address: 2
    motor1:
      zdt:
        address: 3
  z:
    motor0:
      zdt:
        address: 4
`),
);
assert.equal(zdtLayout.count, 4);
assert.deepEqual(zdtLayout.protocols, ["zdt"]);
assert.equal(zdtLayout.can.driverLabel, "ZDT");
assert.equal(zdtLayout.drivers[0].protocol, "zdt");
assert.deepEqual(zdtLayout.warnings, []);

// CANopen motor block is also recognized.
const canopenLayout = parseDriverLayout(
  parseConfigMap(`can:
  driver: canopen
axes:
  x:
    motor0:
      canopen:
        address: 1
        node_id: 1
`),
);
assert.equal(canopenLayout.count, 1);
assert.deepEqual(canopenLayout.protocols, ["canopen"]);
assert.equal(canopenLayout.drivers[0].protocol, "canopen");

// Mixed protocols cannot work through the single can.driver selector.
const mixed = parseDriverLayout(
  parseConfigMap(`can:
  driver: zdt
axes:
  x:
    motor0:
      zdt:
        address: 1
  y:
    motor0:
      pd42s1:
        address: 2
`),
);
assert.equal(mixed.count, 2);
assert.equal(mixed.protocols.length, 2);
assert.ok(mixed.warnings.some((w) => w.includes("多种 CAN 协议")));

// A single protocol that disagrees with can.driver is a configuration error.
const mismatch = parseDriverLayout(
  parseConfigMap(`can:
  driver: pd42s1
axes:
  x:
    motor0:
      zdt:
        address: 1
`),
);
assert.ok(mismatch.warnings.some((w) => w.includes("不一致")));

// Up to the current MAX_CLIENTS=16 is accepted; more is flagged.
const sixteen = parseDriverLayout(parseConfigMap(axesYaml(16)));
assert.equal(sixteen.count, 16);
assert.equal(sixteen.overLimit, false);
const seventeen = parseDriverLayout(parseConfigMap(axesYaml(17)));
assert.equal(seventeen.count, 17);
assert.equal(seventeen.overLimit, true);
assert.ok(seventeen.warnings.some((w) => w.includes("上限 16")));
assert.deepEqual(seventeen.outOfRange, [17]);

// Duplicate addresses and addresses above the bus limit are reported.
const duplicate = parseDriverLayout(
  parseConfigMap(`can:
  driver: zdt
axes:
  x:
    motor0:
      zdt:
        address: 1
  y:
    motor0:
      zdt:
        address: 1
`),
);
assert.deepEqual(duplicate.duplicates, [1]);
assert.equal(duplicate.overLimit, true);
assert.ok(duplicate.warnings.some((w) => w.includes("地址重复")));

// Empty/missing sections must not crash and simply yield no drivers.
for (const empty of [null, {}, { axes: {} }, { axes: { x: {} } }, { axes: { x: { motor0: {} } } }]) {
  const parsed = parseDriverLayout(empty);
  assert.equal(parsed.count, 0);
  assert.deepEqual(parsed.axes, []);
  assert.deepEqual(parsed.addressList, []);
  assert.equal(parsed.overLimit, false);
  assert.deepEqual(parsed.limits, []);
}

// Limit switch wiring is parsed read-only from the same config.yaml.
const limitYaml = `
axes:
  x:
    motor0:
      limit_all_pin: gpio.17:pu:low
      limit_neg_pin: NO_PIN
      limit_pos_pin: NO_PIN
      pd42s1:
        address: 1
  y:
    motor0:
      limit_all_pin: gpio.18:pu:low
      pd42s1:
        address: 2
    motor1:
      limit_all_pin: NO_PIN
      pd42s1:
        address: 3
  z:
    motor0:
      limit_pos_pin: gpio.10:pu
      pd42s1:
        address: 4
`;
const limitMap = parseConfigMap(limitYaml);
const limitLayout = parseDriverLayout(limitMap);
assert.equal(limitLayout.limits.length, 3);
assert.deepEqual(limitLayout.limits[0], { axis: "X", pins: { all: ["gpio.17:pu:low"], neg: [], pos: [] } });
assert.deepEqual(limitLayout.limits[1].pins.all, ["gpio.18:pu:low"]);
assert.deepEqual(limitLayout.limits[2], { axis: "Z", pins: { all: [], neg: [], pos: ["gpio.10:pu"] } });
assert.deepEqual(parseLimitSwitches(null), []);
assert.deepEqual(parseLimitSwitches({ axes: { x: {} } }), []);

console.log("driver layout tests: PASS");
