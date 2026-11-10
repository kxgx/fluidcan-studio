import assert from "node:assert/strict";
import { driverRows, onlineCount, enabledCount, stateParts } from "../ui/js/core/parsers.js";

const can = {
  positions: [
    "[MSG:INFO:   address 1: fw V1.6 pos=269071 error=0 speed=0RPM in-position=yes]",
    "[MSG:INFO:   address 2: fw V1.6 pos=35148 error=3 speed=0RPM in-position=yes]",
    "[MSG:INFO:   address 3: fw V1.6 pos=12446 error=-2 speed=0RPM in-position=no]",
    "[MSG:INFO:   address 4: fw V1.6 pos=51029 error=0 speed=0RPM in-position=yes]",
  ].join("\n"),
  faults: [
    "[MSG:INFO:   address 1: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
    "[MSG:INFO:   address 2: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
    "[MSG:INFO:   address 3: fw V1.6 hw V1.0 status=done stall=no enabled=no in-position=no]",
    "[MSG:INFO:   address 4: fw V1.6 hw V1.0 status=done stall=no enabled=yes in-position=yes]",
  ].join("\n"),
};

const rows = driverRows(can);
assert.equal(rows.length, 4);
assert.deepEqual(rows.map((r) => r.role), ["X", "Y0", "Y1", "Z"]);
assert.equal(rows[2].enabled, "no");
assert.equal(rows[2].inpos, "no");
assert.equal(rows[0].pos, "269071");
assert.equal(onlineCount(can), 4);
assert.equal(enabledCount(can), 3);
assert.deepEqual(stateParts("<Idle|MPos:1.000,2.000,0.000|FS:0,0>"), {
  state: "Idle|MPos:1.000,2.000,0.000|FS:0,0",
  name: "Idle",
  mpos: "1.000,2.000,0.000",
});

console.log("parser tests: PASS");
