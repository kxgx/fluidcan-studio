// Parse the board $I banner and the protocol-neutral $CANDriverInfo firmware
// report.  Pure functions so Node tests can verify the formats without
// hardware.  The UI does not assume every CAN driver is a ZDT.

export const HARDWARE_TYPES = {
  0: "20",
  1: "28",
  2: "35",
  3: "42",
  4: "57",
  5: "86",
  6: "86",
};

export function parseBoardInfo(build) {
  const raw = String(build || "").trim();
  return {
    raw,
    version: (raw.match(/FluidNC\s+(can-v[\d][\w.-]*)/i) || [])[1] || "",
    mcu: (raw.match(/\b(esp32s3|esp32)\b/i) || [])[1] || "",
    hardware: (raw.match(/\(esp32s3-(?:wifi|noradio)-([^)\s]+)\)/i) || [])[1] || "",
    options: (raw.match(/\[OPT:([^\]]*)\]/i) || [])[1] || "",
    machine: (raw.match(/\[MSG:Machine:\s*([^\]]*)\]/i) || [])[1] || "",
  };
}

export function parseDriverFirmware(lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  const out = [];
  // Protocol-neutral contract emitted by $CANDriverInfo:
  // [MSG:INFO: CAN driver: address 1 protocol zdt firmware 2.0.7
  //  firmware-raw 207 hardware-series 2 hardware-type 3 hardware-version 20]
  const re =
    /CAN driver:\s*address\s+(\d+)\s+protocol\s+(\S+)\s+firmware\s+([\d.]+)(?:\s+firmware-raw\s+(\d+))?(?:\s+hardware-series\s+(\d+))?(?:\s+hardware-type\s+(\d+))?(?:\s+hardware-version\s+(\d+))?/gi;
  let m;
  while ((m = re.exec(text))) {
    const hardwareType = m[6] == null ? null : Number(m[6]);
    const hardwareVersion = m[7] == null ? null : Number(m[7]);
    out.push({
      address: Number(m[1]),
      protocol: m[2].toLowerCase(),
      firmware: m[3],
      firmwareRaw: m[4] == null ? null : Number(m[4]),
      hardwareSeries: m[5] == null ? null : Number(m[5]),
      hardwareType,
      hardwareTypeLabel: hardwareType == null ? "--" : HARDWARE_TYPES[hardwareType] || String(hardwareType),
      hardwareVersion: hardwareVersion == null ? null : String(hardwareVersion),
      hardwareVersionLabel:
        hardwareVersion == null ? "--" : `${Math.floor(hardwareVersion / 10)}.${hardwareVersion % 10}`,
    });
  }
  // Compatibility with the pre-generic ZDT-only report line.
  const legacy =
    /ZDT CAN:\s*address\s+(\d+)\s+firmware\s+([\d.]+)\s+raw:(\d+)\s+hardware\s+series:(\d+)\s+type:(\d+)\s+version:(\d+)/gi;
  while ((m = legacy.exec(text))) {
    const hardwareType = Number(m[5]);
    const hardwareVersion = Number(m[6]);
    out.push({
      address: Number(m[1]),
      protocol: "zdt",
      firmware: m[2],
      firmwareRaw: Number(m[3]),
      hardwareSeries: Number(m[4]),
      hardwareType,
      hardwareTypeLabel: HARDWARE_TYPES[hardwareType] || String(hardwareType),
      hardwareVersion: String(hardwareVersion),
      hardwareVersionLabel: `${Math.floor(hardwareVersion / 10)}.${hardwareVersion % 10}`,
    });
  }
  return out.sort((a, b) => a.address - b.address);
}

export function firmwareDriverRows(layout, reported, error = "") {
  const reportText = Array.isArray(reported) ? reported.join("\n") : String(reported || "");
  const parsed = parseDriverFirmware(reportText);
  const byAddress = new Map(parsed.map((item) => [item.address, item]));
  const drivers = layout && Array.isArray(layout.drivers) ? layout.drivers : [];
  const unsupported = /not implemented|not supported|unimplemented/i.test(reportText);
  const hasReport = parsed.length > 0;
  return drivers.map((driver) => {
    const found = byAddress.get(driver.address);
    const config = driver.config && typeof driver.config === "object" ? driver.config : {};
    const firmware = found ? found.firmware : error ? "读取失败" : unsupported || !hasReport ? "未上报" : "无响应";
    return {
      address: driver.address,
      role: driver.role || driver.axis || "--",
      protocol: driver.protocolLabel || driver.protocol || "--",
      firmware,
      hardware:
        found && found.hardwareType != null
          ? `${found.hardwareTypeLabel} / 系列${found.hardwareSeries} / V${found.hardwareVersionLabel}`
          : "--",
      configuredFirmware: config.firmware || "--",
    };
  });
}

