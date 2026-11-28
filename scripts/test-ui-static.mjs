import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "ui/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "ui/js/app.js"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const css = fs.readFileSync(path.join(root, "ui/css/app.css"), "utf8");
const view = fs.readFileSync(path.join(root, "ui/js/views/dual-y.js"), "utf8");

const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) {
  assert.equal(ids.filter((x) => x === id).length, 1, `duplicate id ${id}`);
}
for (const id of ["dualYBox", "dualYMsg", "driverTable", "fwDetailBox", "fwDriverTable", "fwRaw", "view-can", "dpadEnable", "dpadWasd", "dpadZ", "dpadFeed", "dpadFeedValue", "dpadMaxFeed", "dpadFieldset", "dpadPad", "virtualStick", "stickKnob", "dpadStatus", "gamepadStatus", "appVersion"]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}

const driverHead = html.match(/<tbody id="driverTable"><tr><td colspan="(\d+)"/);
assert.ok(driverHead, "driver table empty row missing");
// There are several tables now; use the header immediately preceding the
// driverTable body rather than the first <thead> in the document.
const driverBodyAt = html.indexOf('<tbody id="driverTable"');
const driverHeadAt = html.lastIndexOf('<thead>', driverBodyAt);
const driverHeaders = (html.slice(driverHeadAt, driverBodyAt).match(/<th>/g) || []).length;
if (driverHeaders) {
  const count = driverHeaders;
  assert.equal(Number(driverHead[1]), count, "driver table colspan mismatch");
}

for (const name of ["loadCanConfig", "openConfigEditor"]) {
  assert.ok(html.includes(`onclick="${name}()`), `missing onclick ${name}`);
  assert.ok(app.includes(`${name}:`) || app.includes(`${name},`), `missing window binding ${name}`);
}
for (const name of ["zeroAxis", "zeroAll"]) {
  assert.ok(html.includes(`onclick="${name}(`), `missing zero button ${name}`);
  assert.ok(app.includes(`${name},`) || app.includes(`${name}:`), `missing zero binding ${name}`);
}
assert.ok(html.includes("X 清零") && html.includes("Y 清零") && html.includes("Z 清零"), "zero axis buttons missing");
for (const name of ["zeroDriverAxis", "zeroDriverAll"]) {
  assert.ok(html.includes(`onclick="${name}(`), `missing driver-zero button ${name}`);
  assert.ok(app.includes(`${name},`) || app.includes(`${name}:`), `missing driver-zero binding ${name}`);
}
assert.ok(html.includes("X 驱动零位") && html.includes("Y 驱动零位") && html.includes("Z 驱动零位"), "driver zero buttons missing");
assert.ok(view.includes("parseCanConfig"), "view must use the pure parser");
assert.ok(view.includes("isSerial"), "serial fallback missing");

// ---- Connect / scan / serial flows must stay independent -------------------
for (const id of ["connectBtn", "scanBtn", "openSerialBtn", "deviceUrl", "scanResults", "scanMsg", "connPill"]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `missing body ${name}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unterminated function ${name}`);
}

const connectBody = functionBody(app, "connectDevice");
const scanBody = functionBody(app, "scanDevices");
const serialBody = functionBody(app, "openSerial");
const bootBody = functionBody(app, "boot");

// 连接按钮：只连接输入框/扫描结果中的地址，地址为空时提示，绝不回退成扫描。
assert.ok(!connectBody.includes("scanDevices"), "connectDevice must not trigger a scan");
assert.ok(connectBody.includes("resolveConnectTarget"), "connectDevice must resolve the typed/scan address");
assert.ok(connectBody.includes("transport.connectHttp"), "connectDevice must use the HTTP connect call");
// 扫描按钮：只发现设备，绝不自动连接。
assert.ok(!scanBody.includes("connectDevice") && !scanBody.includes("connectHttp"), "scanDevices must not connect");
assert.ok(scanBody.includes("transport.scan"), "scanDevices must use the scan call");
assert.ok(scanBody.includes("scannedAddress"), "scanDevices must prefill a single scanned address");
// 串口按钮：独立链路，不触发扫描或 WiFi 连接。
assert.ok(!serialBody.includes("scanDevices") && !serialBody.includes("connectHttp"), "openSerial must not scan or HTTP-connect");
assert.ok(serialBody.includes("transport.openSerial"), "openSerial must use the serial open call");
// 启动时最多自动扫描一次，不得自动连接。
assert.ok(bootBody.includes("setTimeout(scanDevices"), "startup should auto-scan once");
assert.ok(!bootBody.includes("connectDevice("), "startup must not auto-connect");
assert.ok(app.includes('"scanResults")?.addEventListener'), "scan result picker change handler missing");
assert.ok(app.includes("扫描进行中"), "scan button must guard re-entrant scans");

// ---- Latency: fast status path, slow CAN path runs in the background -------
const overview = fs.readFileSync(path.join(root, "ui/js/views/overview.js"), "utf8");
assert.ok(overview.includes("export async function refreshStatus"), "fast status refresh missing");
assert.ok(overview.includes("export async function refreshCanData"), "background CAN refresh missing");
assert.ok(!/Promise\.all\(\[getStatus\(\), getCan\(\)\]\)/.test(overview), "status and slow CAN must not block each other");
// 连接/串口只等待快速状态刷新，慢 CAN 读取放到后台。
assert.ok(connectBody.includes("refreshStatus"), "connectDevice must refresh fast status");
assert.ok(!connectBody.includes("refreshOverview"), "connectDevice must not await the slow overview refresh");
assert.ok(connectBody.includes("refreshCanInBackground"), "connectDevice must trigger the CAN refresh in background");
assert.ok(serialBody.includes("refreshStatus"), "openSerial must refresh fast status");
assert.ok(serialBody.includes("refreshCanInBackground"), "openSerial must trigger the CAN refresh in background");
assert.ok(app.includes("canRefreshPromise"), "CAN background refresh must be single-flight");
assert.ok(app.includes("fluidcan.lastDevice"), "boot must prefill the last connected device");
assert.ok(app.includes("状态已同步"), "connect flow must report when the fast status refresh completes");

// ---- Error-path regressions found by functional testing --------------------
// /api/status may return 200 with {error} fields; the UI must not claim synced.
assert.ok(overview.includes("读取失败"), "status failure must be surfaced");
assert.ok(overview.includes("connected: false"), "status failure must not keep connected=true");
// CAN failures must not leave the pill stuck at "CAN 读取中…".
assert.ok(overview.includes("CAN 部分失败"), "partial CAN failure must be surfaced");
assert.ok(overview.includes("CAN 读取失败"), "CAN request failure must reset the pill");
// A stale last-session prefill must be replaceable by a single scan result.
assert.ok(app.includes("autoPrefilledDevice"), "stale prefill tracking missing");
assert.ok(scanBody.includes("autoPrefilledDevice"), "scan must replace an unedited stale prefill");
assert.ok(app.includes('addEventListener("input"'), "manual edit must invalidate the prefill");
// CAN page commands must not fire a slow background sweep after each command.
const canCmdBody = functionBody(app, "canCmd");
assert.ok(!canCmdBody.includes("refreshCanInBackground"), "canCmd must not auto-trigger the slow CAN refresh");

// ---- Additional functional-bug regressions (B08-B13) ----------------------
const configView = fs.readFileSync(path.join(root, "ui/js/views/config.js"), "utf8");
// B08: control actions must be wrapped so backend errors are logged, not unhandled.
assert.ok(app.includes("jog: (...args) => run("), "jog must be wrapped in run()");
assert.ok(app.includes("zeroDriverAll: () => run("), "driver-zero must be wrapped in run()");
assert.ok(app.includes("sendConsole: () => run("), "console send must be wrapped in run()");
// B09: never write/upload a malformed config payload.
assert.ok(configView.includes("typeof j.yaml === \"string\""), "config load must validate yaml type");
assert.ok(configView.includes("已拒绝上传"), "config save must refuse an empty/garbage editor");
// B09R: the editor starts empty with a placeholder; upload requires a successful read.
assert.ok(configView.includes("configLoaded"), "config save must require a successful read first");
assert.ok(configView.includes("请先在当前设备读取配置"), "config save must reject without a successful read");
assert.ok(configView.includes("configLoadedFor"), "config save must be bound to the link that read it");
assert.ok(app.includes("resetConfigState"), "link switch must clear the config editor");
assert.ok(html.includes("closeSerial"), "UI must expose a serial close button");
assert.ok(app.includes("closeSerial"), "UI must close serial before switching links");
assert.ok(app.includes('replace(/^Error:\\s*/, "")'), "run() must strip the Error: prefix from user-facing messages");
const runBody = functionBody(app, "run");
assert.ok(runBody.includes('log(message, "err")'), "run() must log the prefix-free message");
assert.ok(!runBody.includes('log(String(e)'), "run() must not log the raw Error string");
assert.ok(html.includes('placeholder="点击“读取配置”'), "config textarea must use a placeholder");
assert.ok(!html.includes(">点击“读取配置”</textarea>"), "config textarea must not start with baked-in text");
// B10: version display must handle the real "FluidNC can-vX.Y.Z" banner.
assert.ok(overview.includes("can-v[\\d]"), "firmware version regex must match can-v banners");
// B12: destructive CAN commands require confirmation.
assert.ok(app.includes("canConfirm"), "canConfirm helper missing");
for (const command of ["$CANScan", "$CANAutoConfig", "$CANReset"]) {
  assert.ok(html.includes(`canConfirm('${command}'`), `missing confirmation for ${command}`);
}
// B13: a recovered refresh must repaint the connection pill.
assert.ok(app.includes("setLinkPillFromTransport"), "link pill recovery helper missing");
assert.ok(functionBody(app, "refreshAll").includes("setLinkPillFromTransport"), "refreshAll must repaint the pill");

// ---- Config-driven driver layout (config.yaml is the source of truth) ------
const driversCore = fs.readFileSync(path.join(root, "ui/js/core/drivers.js"), "utf8");
const controlView = fs.readFileSync(path.join(root, "ui/js/views/control.js"), "utf8");
const canView = fs.readFileSync(path.join(root, "ui/js/views/can.js"), "utf8");
const parsersView = fs.readFileSync(path.join(root, "ui/js/core/parsers.js"), "utf8");
const yconfigView = fs.readFileSync(path.join(root, "ui/js/core/yconfig.js"), "utf8");
assert.ok(driversCore.includes("CAN_ADDRESS_LIMIT = 16"), "CAN bus address limit constant missing");
assert.ok(driversCore.includes("export function parseDriverLayout"), "config.yaml driver layout parser missing");
assert.ok(driversCore.includes("export function addressesForAxis"), "per-axis address helper missing");
assert.ok(
  driversCore.includes("pd42s1") && driversCore.includes("zdt") && driversCore.includes("canopen"),
  "generic CAN protocol registry missing",
);
assert.ok(driversCore.includes("driverMetaMap"), "driver protocol metadata map missing");
assert.ok(parsersView.includes("ZDT CAN:") && parsersView.includes("ready:"), "generic/ZDT CAN parsers missing");
assert.ok(view.includes("protocolLabel") && view.includes("cfg.axes"), "CAN config view is not generic");
assert.ok(!controlView.includes("DRIVER_ZERO_ADDRESS"), "driver zero addresses must not be hard-coded");
assert.ok(!controlView.includes('"$CANZero=1,2,3,4"'), "driver zero all command must be config-driven");
assert.ok(controlView.includes("addressesForAxis"), "driver zero must derive addresses from config");
assert.ok(!parsersView.includes("AXIS_ROLES"), "parsers must not hard-code axis roles");
assert.ok(!yconfigView.includes("AXIS_ROLES"), "yconfig must not hard-code axis roles");
assert.ok(overview.includes("driverMetaMap"), "overview must map roles/protocols from config");
assert.ok(canView.includes("CAN_ADDRESS_LIMIT"), "CAN view must show the CAN address limit");
assert.ok(connectBody.includes("loadDriverLayout"), "connectDevice must load the config.yaml driver layout");
assert.ok(serialBody.includes("loadDriverLayout"), "openSerial must load the config.yaml driver layout");
assert.ok(app.includes("parseDriverLayout") && app.includes("loadDriverLayout"), "app must parse the driver layout from config.yaml");
assert.ok(app.includes("initDirectionControls"), "direction controls must be initialized");
assert.ok(html.includes('id="firmwareVariant"') && html.includes('value="wifi"') && html.includes('value="nowifi"'), "firmware UI must expose only WiFi/NoWiFi");
assert.ok(!html.includes("quad-oled-usb") && !html.includes("nopsram-oled-usb-4mb"), "old USB/OLED variant labels must not be exposed");
const dpadView = fs.readFileSync(path.join(root, "ui/js/views/dpad.js"), "utf8");
assert.ok(
  dpadView.includes("keyboardDirection") && (dpadView.includes("gamepadButtonDirection") && dpadView.includes("gamepadStickDirection")) && dpadView.includes("stickDirection"),
  "direction input sources missing",
);
assert.ok(dpadView.includes("$J") || dpadView.includes("directionToJog"), "direction controls must build jog commands");
assert.ok(dpadView.includes("jogStart") && dpadView.includes("jogStop"), "continuous jog must use start/stop endpoints");
assert.ok(app.includes("stopDirectionJog"), "leaving the control view must cancel continuous jog");
const libJog = fs.readFileSync(path.join(root, "src/lib.rs"), "utf8");
assert.ok(libJog.includes('route("/jog/start"') && libJog.includes('route("/jog/stop"'), "backend jog endpoints missing");
assert.ok(libJog.includes("0x85"), "backend must send JogCancel 0x85");
assert.ok(dpadView.includes("keydown") && dpadView.includes("keyup"), "keyboard press/release handlers missing");
assert.ok(dpadView.includes("pointerup") && dpadView.includes("pointercancel"), "pointer stop handlers missing");
assert.ok(dpadView.includes('addEventListener("blur"'), "blur stop handler missing");
assert.ok(dpadView.includes("visibilitychange") && dpadView.includes("pagehide"), "visibility/pagehide stop handlers missing");
assert.ok(dpadView.includes("document.hasFocus") && dpadView.includes("resetGamepadHold"), "gamepad focus guard missing");
assert.ok(dpadView.includes("rearmTimer") && dpadView.includes("stopPending"), "rearm/stop retry state missing");
assert.ok(html.includes('id="dpadFieldset" class="dpad-fieldset" disabled'), "direction controls must start disabled");
assert.ok(app.includes("config.yaml："), "driver layout load must be logged");
assert.ok(app.includes("applyAxisOptions"), "jog axis options must come from config.yaml");
assert.ok(!html.includes("地址2/3"), "motion view must not hard-code Y driver addresses");
// Wi-Fi reads /api/config; the serial link reads the same YAML via $CD.
const transportView = fs.readFileSync(path.join(root, "ui/js/core/transport.js"), "utf8");
assert.ok(transportView.includes("getDeviceConfig"), "device config abstraction missing");
assert.ok(transportView.includes("$CD"), "serial config read must use $CD");
assert.ok(app.includes("getDeviceConfig"), "driver layout must use the transport config abstraction");
assert.ok(fs.readFileSync(path.join(root, "ui/js/views/overview.js"), "utf8").includes("getFirmwareDrivers"),
  "firmware view must fetch the slow driver report separately");
assert.ok(!overview.includes('!key.endsWith("|")'),
  "firmware-data gate must not skip every connected device (inverted condition)");
assert.ok(overview.includes('key.endsWith("|")'),
  "firmware-data gate must only skip when the link key is empty");
assert.ok(configView.includes("串口模式不支持上传配置"), "config upload over serial must be refused");

// ---- In-app Web Serial flasher (local packages; no bundled firmware) ------
assert.ok(html.includes("esp-web-install-button"), "in-app Web Serial install button missing");
assert.ok(html.includes("/js/vendor/esp-web-tools.js"), "esp-web-tools bundle not loaded");
assert.ok(fs.existsSync(path.join(root, "ui/js/vendor/esp-web-tools.js")), "esp-web-tools bundle missing");
assert.ok(fs.existsSync(path.join(root, "ui/js/vendor/esp-web-tools.LICENSE")), "esp-web-tools license missing");
for (const id of [
  "webFlashSource",
  "webFlashRelease",
  "webFlashVariant",
  "webFlashFile",
  "webFlashButton",
  "webFlashMsg",
  "webFlashOut",
  "webFlashParts",
  "flashFile",
]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}
const installView = fs.readFileSync(path.join(root, "ui/js/views/install.js"), "utf8");
assert.ok(installView.includes("parseFirmwareHardware") && installView.includes("firmwareVariant"), "installer must auto-detect hardware and radio");
assert.ok(installView.includes("NoWiFi 无网络栈"), "NoWiFi must block network OTA");
assert.ok(!installView.includes('$("webFlashVariant").value;'), "web flash must not use the radio-only selector as a full variant");
const libSource = fs.readFileSync(path.join(root, "src/lib.rs"), "utf8");
assert.ok(app.includes("prepareWebFlash"), "prepareWebFlash binding missing");
assert.ok(installView.includes("export async function prepareWebFlash"), "prepareWebFlash missing");
assert.ok(installView.includes("/api/install/web/manifest"), "web manifest endpoint missing");
assert.ok(installView.includes("/api/install/web/upload"), "local firmware upload endpoint missing");
assert.ok(installView.includes("/api/install/flash-local"), "local esptool flash endpoint missing");
assert.ok(installView.includes("validateWebFlashManifest"), "manifest structure validation missing");
assert.ok(installView.includes("烧录清单无效"), "invalid manifest must be rejected");
assert.ok(installView.includes("webFlashParts"), "partition selection UI missing");
assert.ok(installView.includes("selectedWebFlashParts"), "partition selection logic missing");
assert.ok(installView.includes("OTA/firmware.bin"), "OTA zip extraction hint missing");
assert.ok(html.includes('accept=".bin,.zip"'), "OTA file input must accept zip packages");
assert.ok(libSource.includes("extract_ota_image"), "backend OTA zip extraction missing");
assert.ok(libSource.includes("extract_usb_factory"), "backend factory zip extraction missing");
assert.ok(libSource.includes("release_zip_name"), "backend structured release zip naming missing");
assert.ok(readme.includes("OTA/firmware.bin"), "README OTA package format missing");

// Sidebar must not scroll away with the content: fixed app shell, only <main>
// scrolls, nav is its own flex column (or horizontal bar on narrow screens).
assert.ok(css.includes("height:100dvh"), "app shell must fill the viewport");
assert.ok(/body\{[^}]*overflow:hidden/.test(css), "page body must not scroll");
assert.ok(/\.layout\{[^}]*flex:1 1 auto;min-height:0/.test(css), "layout must fill remaining height");
assert.ok(/nav\{[^}]*overflow-y:auto/.test(css), "sidebar must scroll independently");
assert.ok(/main\{[^}]*overflow-y:auto/.test(css), "main content must be the scroll container");
assert.ok(css.includes(".layout{display:flex;flex-direction:column;min-height:0}"), "narrow layout must stack with scrollable main");
assert.ok(installView.includes("firmware.factory.bin") && libSource.includes("bootloader.bin"), "standard firmware names missing");
assert.ok(!html.includes('value="embedded"'), "embedded firmware source must be removed");
assert.ok(!html.includes("内置固件"), "embedded firmware hint must be removed");
assert.ok(libSource.includes("/install/flash-local"), "backend local esptool route missing");
assert.ok(libSource.includes("WEB_FLASH_STANDARD_NAMES"), "backend standard-name table missing");
assert.ok(!libSource.includes("FirmwareAssets"), "embedded firmware assets must be removed");
assert.ok(!fs.existsSync(path.join(root, "firmware")), "embedded firmware directory must be removed");
assert.ok(!app.includes("loadFirmware"), "old fluid-installer loadFirmware binding must be removed");
assert.ok(!html.includes("/installer/") && !app.includes("/installer/"), "standalone installer route must be gone");
assert.ok(!fs.existsSync(path.join(root, "installer-dist")), "installer-dist must be removed");
assert.ok(!fs.existsSync(path.join(root, "installer-src")), "installer-src must be removed");

// ---- Read-only limit switch test ------------------------------------------
for (const id of ["limitTestBtn", "limitMsg", "limitTable", "limitOut"]) {
  assert.ok(ids.includes(id), `missing id ${id}`);
}
assert.ok(html.includes('onclick="toggleLimitTest()"') && html.includes('onclick="readLimitsOnce()"'), "limit test buttons missing");
assert.ok(app.includes("toggleLimitTest") && app.includes("readLimitsOnce"), "limit test bindings missing");
const limitsView = fs.readFileSync(path.join(root, "ui/js/views/limits.js"), "utf8");
assert.ok(limitsView.includes('exec("?")'), "limit test must poll the ? status");
assert.ok(limitsView.includes("parsePinString"), "limit test must parse the Pn field");
assert.ok(!limitsView.includes("$J") && !limitsView.includes("sendCommand"), "limit test must not send motion commands");
assert.ok(limitsView.includes("stopLimitTest") && limitsView.includes("clearInterval"), "limit test polling must be stoppable");

console.log("static UI tests: PASS");

// Mobile landscape layout must stay wired.
{
  const manifest = fs.readFileSync(path.join(root, "gen/android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.ok(manifest.includes('android:screenOrientation="sensorLandscape"'), "Android must lock landscape");
  const css = fs.readFileSync(path.join(root, "ui/css/app.css"), "utf8");
  assert.ok(css.includes("@media (orientation: landscape) and (max-height: 600px)"), "landscape CSS missing");
  const html = fs.readFileSync(path.join(root, "ui/index.html"), "utf8");
  assert.ok(html.includes("control-main") && html.includes("control-dpad"), "control cards need mobile classes");
}

// Lumen compatibility view must stay wired.
{
  const html = fs.readFileSync(path.join(root, "ui/index.html"), "utf8");
  assert.ok(html.includes('id="view-lumen"'), "Lumen view missing");
  assert.ok(html.includes('data-view="lumen"'), "Lumen nav missing");
  for (const id of ["lumenTestRows", "lumenVac1", "lumenVac2", "lumenOut", "lumenJogAxis"]) {
    assert.ok(html.includes(`id="${id}"`), `Lumen element ${id} missing`);
  }
  const app = fs.readFileSync(path.join(root, "ui/js/app.js"), "utf8");
  assert.ok(app.includes("runLumenReadOnlyTests"), "Lumen app wiring missing");
  const transport = fs.readFileSync(path.join(root, "ui/js/core/transport.js"), "utf8");
  assert.ok(transport.includes("execChecked"), "checked command transport missing");
}
