import assert from "node:assert/strict";
import { resolveConnectTarget, scanMessage, scannedAddress } from "../ui/js/core/session.js";

// The connect flow resolves an address and never falls back to scanning.
assert.equal(resolveConnectTarget("", ""), null);
assert.equal(resolveConnectTarget("   ", ""), null);
assert.equal(resolveConnectTarget(undefined, null), null);
assert.deepEqual(resolveConnectTarget(" http://192.168.2.83 ", ""), {
  url: "http://192.168.2.83",
  source: "input",
});
assert.deepEqual(resolveConnectTarget("", " http://192.168.2.84 "), {
  url: "http://192.168.2.84",
  source: "scan",
});
assert.deepEqual(resolveConnectTarget("http://192.168.2.83", "http://192.168.2.84"), {
  url: "http://192.168.2.83",
  source: "input",
});

// The scan flow only reports results / prefills the address for one hit.
assert.equal(scanMessage([]), "未发现设备");
assert.equal(scanMessage(null), "未发现设备");
assert.equal(scanMessage([{}]), "发现 1 台");
assert.equal(scanMessage([{}, {}]), "发现 2 台");
assert.equal(scannedAddress([]), "");
assert.equal(scannedAddress([{ url: " http://192.168.2.83 " }]), "http://192.168.2.83");
assert.equal(scannedAddress([{ url: "http://192.168.2.83" }, { url: "http://192.168.2.84" }]), "");
assert.equal(scannedAddress([{}]), "");

console.log("session flow tests: PASS");
