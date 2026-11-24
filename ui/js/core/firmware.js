// Firmware hardware/radio detection shared by the installer UI and tests.
//
// New firmware reports `esp32s3-<wifi|noradio>-<flash>-<psram>` in $I.
// The user only chooses the radio; the hardware suffix selects the image.
export const HARDWARE_SUFFIXES = [
  "8mb-quad",
  "8mb-octal",
  "16mb-octal",
  "4mb-quad",
  "4mb-octal",
  "4mb-nopsram",
];

const NEW_RE = /esp32s3-(wifi|noradio)-(\d+mb-(?:quad|octal|nopsram))/i;
const LEGACY_RE = /esp32s3-(wifi|noradio)\b/i;

export function parseFirmwareHardware(build) {
  const text = String(build || "");
  const m = text.match(NEW_RE);
  if (m) {
    return {
      radio: m[1].toLowerCase() === "noradio" ? "nowifi" : "wifi",
      hw: m[2].toLowerCase(),
      legacy: false,
    };
  }
  const legacy = text.match(LEGACY_RE);
  if (legacy) {
    // can-v0.2.25 and older did not report flash/PSRAM.  The production
    // N16R8 board is the only migration fallback; a marker is required for
    // every later release.
    return {
      radio: legacy[1].toLowerCase() === "noradio" ? "nowifi" : "wifi",
      hw: "16mb-octal",
      legacy: true,
    };
  }
  return null;
}

export function firmwareVariant(radio, hardware) {
  const r = radio === "nowifi" ? "nowifi" : "wifi";
  return HARDWARE_SUFFIXES.includes(hardware) ? `${r}-${hardware}` : "";
}

export function isFourMbHardware(hardware) {
  return String(hardware || "").startsWith("4mb-");
}
