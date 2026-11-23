import assert from "node:assert/strict";
import { resolveConnectTarget, scanMessage, scannedAddress } from "../ui/js/core/session.js";

// The connect flow resolves an address and never falls back to scanning.
assert.equal(resolveConnectTarget("", ""), null);
assert.equal(resolveConnectTarget("   ", ""), null);
assert.equal(resolveConnectTarget(undefined, null), null);
assert.deepEqual(resolveConnectTarget(" http://192.0.2.10 ", ""), {
  url: "http://192.0.2.10",
  source: "input",
});
assert.deepEqual(resolveConnectTarget("", " http://192.0.2.11 "), {
  url: "http://192.0.2.11",
  source: "scan",
});
assert.deepEqual(resolveConnectTarget("http://192.0.2.10", "http://192.0.2.11"), {
  url: "http://192.0.2.10",
  source: "input",
});

// The scan flow only reports results / prefills the address for one hit.
assert.equal(scanMessage([]), "未发现设备");
assert.equal(scanMessage(null), "未发现设备");
assert.equal(scanMessage([{}]), "发现 1 台");
assert.equal(scanMessage([{}, {}]), "发现 2 台");
assert.equal(scannedAddress([]), "");
assert.equal(scannedAddress([{ url: " http://192.0.2.10 " }]), "http://192.0.2.10");
assert.equal(scannedAddress([{ url: "http://192.0.2.10" }, { url: "http://192.0.2.11" }]), "");
assert.equal(scannedAddress([{}]), "");

console.log("session flow tests: PASS");
