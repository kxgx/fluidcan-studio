// Pure helpers for the two independent device flows:
//
//   * scan    : discover FluidNC devices on the LAN, only fills the scan picker
//               and (for a single hit) the address input.  It never connects.
//   * connect : reach the address the user typed or picked from scan results.
//               It never scans.
//
// Keeping the decision logic here makes the flows unit-testable without a DOM.

// Resolve which address the "连接" (connect) button should use.  The typed
// address wins over the scan picker; when neither is present the caller must
// tell the user to pick/enter an address instead of silently starting a scan.
export function resolveConnectTarget(typedUrl, scannedUrl) {
  const typed = String(typedUrl ?? "").trim();
  if (typed) return { url: typed, source: "input" };
  const scanned = String(scannedUrl ?? "").trim();
  if (scanned) return { url: scanned, source: "scan" };
  return null;
}

export function scanMessage(devices) {
  const count = Array.isArray(devices) ? devices.length : 0;
  return count ? `发现 ${count} 台` : "未发现设备";
}

// A scan with exactly one compatible device may fill the address input.
// With several devices the user picks from the scan result dropdown instead;
// with none nothing is prefilled.
export function scannedAddress(devices) {
  const list = Array.isArray(devices) ? devices : [];
  if (list.length !== 1) return "";
  const url = list[0] && list[0].url;
  return typeof url === "string" ? url.trim() : "";
}
