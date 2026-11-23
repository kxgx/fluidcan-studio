import { httpGet, httpPost } from "../core/transport.js";
import { state } from "../core/store.js";

const $ = (id) => document.getElementById(id);
let releasesLoaded = false;
const FOUR_MB = new Set([
  "nopsram-oled-usb-4mb",
  "quad-oled-usb-4mb",
  "octal-oled-usb-4mb",
]);

function variant() {
  return $("firmwareVariant")?.value || "";
}

function hasVariant() {
  return variant() !== "";
}

function isFourMb() {
  return FOUR_MB.has(variant());
}

function currentTag() {
  const m = String(state.build || "").match(/FluidNC\s+(can-v\d+\.\d+\.\d+[-\w.]*)/);
  return m ? m[1].replace(/-dirty$/, "") : "";
}

export function updateVariantState() {
  const button = $("remoteOtaBtn");
  const warn = $("variantWarn");
  const variantSelect = $("firmwareVariant");
  const releaseSelect = $("remoteRelease");
  const four = isFourMb();
  if (variantSelect) variantSelect.disabled = !releasesLoaded;
  if (releaseSelect) releaseSelect.disabled = !releasesLoaded;
  if (button) button.disabled = !releasesLoaded || !hasVariant() || four;
  if (warn) {
    if (!releasesLoaded) {
      warn.textContent = "请先获取版本列表，再选择固件分类。";
      warn.className = "sub";
    } else if (!hasVariant()) {
      warn.textContent = "请选择固件分类后再进行 OTA。";
      warn.className = "sub warntxt";
    } else if (four) {
      warn.textContent = "当前选择为 4 MB 版本：没有 OTA 备用分区，不能网络 OTA，请使用串口烧录。";
      warn.className = "sub badtxt";
    } else {
      warn.textContent = "当前选择为 8 MB 版本：支持网络 OTA（0.2.16+ 自动下载 Release 结构化 zip 并提取 OTA/firmware.bin）。";
      warn.className = "sub";
    }
  }
}

function releaseOptions(releases, installed) {
  const groups = new Map();
  for (const release of releases) {
    const family = (release.tag.match(/can-v(\d+\.\d+)/) || [])[1] || "其他";
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(release);
  }
  const options = [];
  for (const [family, items] of groups) {
    options.push(`<optgroup label="can-v${esc(family)} 系列">`);
    for (const release of items) {
      const markers = [];
      if (release.tag === installed) markers.push("当前");
      if (release.prerelease) markers.push("预发布");
      const label = `${release.tag}${markers.length ? " · " + markers.join(" · ") : ""}`;
      options.push(`<option value="${esc(release.tag)}">${esc(label)}</option>`);
    }
    options.push("</optgroup>");
  }
  return options.length ? options.join("") : '<option value="">没有可用版本</option>';
}

function syncVariantOptions() {
  const source = $("firmwareVariant");
  const target = $("webFlashVariant");
  if (!source || !target) return;
  const previous = target.value;
  target.innerHTML = source.innerHTML;
  if (previous) target.value = previous;
}

export async function refreshRemote() {
  $("remoteMsg").textContent = "读取 GitHub...";
  const j = await httpGet("/updates");
  const releases = j.releases || [];
  const installed = currentTag();
  const options = releaseOptions(releases, installed);

  for (const id of ["remoteRelease", "webFlashRelease"]) {
    const select = $(id);
    if (!select) continue;
    select.innerHTML = options;
    if (installed && releases.some((r) => r.tag === installed)) select.value = installed;
  }

  releasesLoaded = releases.length > 0;
  $("remoteMsg").textContent = releasesLoaded ? `${releases.length} 个版本` : "没有可用版本";
  $("remoteOut").textContent = JSON.stringify(
    { current: installed, variant: variant(), releases },
    null,
    2,
  );
  updateVariantState();
  updateWebFlashState();
  return releases;
}

export async function remoteOta() {
  if (!releasesLoaded) throw new Error("先获取版本列表");
  if (!hasVariant()) throw new Error("先选择固件分类");
  if (isFourMb()) throw new Error("4 MB 版本不能网络 OTA，请使用串口或 Web Serial 烧录 factory 镜像");
  const tag = $("remoteRelease").value;
  if (!tag) throw new Error("先获取并选择版本");
  $("remoteMsg").textContent = "下载 Release zip 并提取 OTA/firmware.bin...";
  const j = await httpPost("/ota/remote", { tag, variant: variant() });
  $("remoteOut").textContent = JSON.stringify(j, null, 2);
  $("remoteMsg").textContent = j && j.ota && j.ota.http === 200 ? "OTA 已提交" : "OTA 已提交（检查响应）";
  return j;
}

export async function otaUpload() {
  const file = $("otaFile").files[0];
  if (!file) throw new Error("选择 .zip 固件包或 app .bin");
  const form = new FormData();
  form.append("firmware", file);
  $("otaOut").textContent = "上传中（zip 会自动提取 OTA/firmware.bin）...";
  const r = await fetch("/api/install/ota", { method: "POST", body: form });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    j = { error: text.slice(0, 500) };
  }
  $("otaOut").textContent = JSON.stringify(j, null, 2);
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function flashSerial() {
  const file = $("flashFile")?.files?.[0];
  if (!file) throw new Error("选择本地 factory 固件（.bin 或含 firmware.factory.bin 的 .zip）");
  const port = ($("flashPort").value || $("serialPorts").value || "").trim();
  const baud = parseInt($("flashBaud").value, 10) || 460800;
  if (!port) throw new Error("选择或输入 COM 口");
  const form = new FormData();
  form.append("port", port);
  form.append("baud", String(baud));
  form.append("firmware", file);
  $("flashOut").textContent = "烧录中（首次会先准备官方 esptool）...";
  const response = await fetch("/api/install/flash-local", { method: "POST", body: form });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { error: text.slice(0, 500) };
  }
  $("flashOut").textContent = JSON.stringify(value, null, 2);
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

export async function installToolchain() {
  $("toolchainMsg").textContent = "下载/解压中...";
  const j = await httpPost("/toolchain/install", {});
  $("toolchainMsg").textContent = j.ok ? "官方 esptool 已就绪" : "当前平台不支持";
  $("remoteOut").textContent = JSON.stringify(j, null, 2);
  return j;
}

export async function loadToolchain() {
  const j = await httpGet("/toolchain");
  const box = $("toolchainBox");
  if (!box) return j;
  const rows = [
    ["官方 esptool", j.esptool || "--"],
    ["官方 ESP-IDF", j.esp_idf || "--"],
    ["目标平台", j.platform || "--"],
    ["官方 esptool 包", j.esptool_asset || "当前平台无官方独立包"],
    ["esptool 版本", (j.esptool_versions || []).join(", ") || "--"],
    ["ESP-IDF 版本", (j.esp_idf_versions || []).join(", ") || "--"],
    ["独立烧录工具", j.esptool_supported ? "可用" : "不支持（Android 等移动端）"],
    ["来源", j.source || "--"],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join("");
  return j;
}

// ---- In-app Web Serial flasher (esp-web-tools) ----------------------------
// The component fetches an esp-web-tools manifest + factory image from the
// Studio backend and talks to the ESP32-S3 bootloader over Web Serial.  This is
// the basic fluid-installer flow, now part of Studio itself.

const WEB_FLASH_VARIANTS = new Set([
  "nopsram-oled-usb-4mb",
  "quad-oled-usb-4mb",
  "octal-oled-usb-4mb",
  "quad-oled-usb",
  "octal-oled-usb",
  "quad-oled",
  "octal-oled",
  "quad",
  "octal",
  "default",
]);

let webFlashUpload = null;
let webFlashUploadKey = "";

function webFlashSource() {
  return $("webFlashSource")?.value || "local";
}

function webSerialSupported() {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = { error: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
}

function resetWebFlashUpload() {
  webFlashUpload = null;
  webFlashUploadKey = "";
  const box = $("webFlashParts");
  if (box) {
    box.style.display = "none";
    box.innerHTML = '<span class="muted">选择固件包后显示可烧录分区</span>';
  }
}

function fileKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function renderWebFlashParts(upload) {
  const box = $("webFlashParts");
  if (!box) return;
  const parts = upload && Array.isArray(upload.parts) ? upload.parts : [];
  if (!parts.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  const defaults = new Set(upload.defaults || []);
  box.style.display = "";
  box.innerHTML =
    '<div class="sub" style="margin:0 0 4px">选择要烧录的分区（默认按固件包内容预选）：</div>' +
    parts
      .map((part) => {
        const checked = defaults.has(part.name) ? "checked" : "";
        return `<label style="display:flex;gap:8px;align-items:center;padding:3px 0">
          <input type="checkbox" class="webFlashPart" value="${esc(part.name)}" ${checked}>
          <span class="mono">${esc(part.name)}</span>
          <span class="sub" style="margin:0">${esc(part.label || "")} · ${Number(part.size || 0).toLocaleString()} B</span>
        </label>`;
      })
      .join("");
}

function selectedWebFlashParts() {
  return [...document.querySelectorAll("input.webFlashPart:checked")].map((element) => element.value);
}

export function updateWebFlashState() {
  const source = webFlashSource();
  const release = $("webFlashRelease");
  const variantSelect = $("webFlashVariant");
  const file = $("webFlashFile");
  const hint = $("webFlashHint");
  const button = $("webFlashButton");
  const parts = $("webFlashParts");
  const local = source === "local";
  if (release) release.disabled = !local ? !releasesLoaded : true;
  if (variantSelect) variantSelect.disabled = !local ? !releasesLoaded : true;
  if (file) file.disabled = !local;
  if (parts) parts.style.display = local && webFlashUpload ? "" : "none";
  if (button && !button.getAttribute("manifest")) button.style.display = "none";
  if (!hint) return;
  if (source === "remote") syncVariantOptions();
  if (!webSerialSupported()) {
    hint.className = "sub badtxt";
    hint.textContent =
      "当前浏览器不支持 Web Serial（需要 Chrome/Edge 且页面为 localhost/HTTPS）；可继续使用下方网络 OTA 或串口 esptool 烧录。";
    return;
  }
  hint.className = "sub";
  if (source === "remote") {
    hint.textContent =
      "远程来源会自动下载 can-v0.2.16+ 的结构化 Release zip，并提取 USB/firmware.factory.bin；旧版本回退到直接 factory 资源。仅 8 MB 分类支持网络 OTA，4 MB 分类请用 USB/Web Serial。首次烧录需从 GitHub 下载，网络慢时可能较久。";
  } else {
    hint.textContent =
      "选择本地固件包（.zip 或单个 .bin）。标准文件名：firmware.factory.bin/factory.bin→0x0（整片）、bootloader.bin→0x0、partitions.bin→0x8000、boot_app0.bin→0xE000、firmware.bin/app.bin→0x10000。上传后可只勾选需要更新的分区（例如只更新 firmware.bin）。";
  }
}

function validateWebFlashManifest(manifest) {
  const builds = manifest && Array.isArray(manifest.builds) ? manifest.builds : [];
  const valid =
    builds.length > 0 &&
    builds.every((build) => {
      const parts = build && Array.isArray(build.parts) ? build.parts : [];
      return (
        parts.length > 0 &&
        parts.every(
          (part) => typeof part?.path === "string" && part.path !== "" && Number.isFinite(Number(part.offset)),
        )
      );
    });
  if (!valid) {
    const reason =
      manifest && typeof manifest === "object" && manifest.error
        ? manifest.error
        : "返回内容不是有效的 esp-web-tools 清单（缺少 builds/parts）";
    throw new Error("烧录清单无效：" + reason);
  }
  return manifest;
}

export async function prepareWebFlash() {
  const source = webFlashSource();
  $("webFlashMsg").textContent = "准备中...";
  try {
    let manifestUrl;
    let upload = null;
    if (source === "remote") {
      if (!releasesLoaded) await refreshRemote();
      const tag = $("webFlashRelease").value;
      const selectedVariant = $("webFlashVariant").value;
      if (!tag) throw new Error("先获取并选择版本");
      if (!selectedVariant) throw new Error("先选择固件分类");
      if (!WEB_FLASH_VARIANTS.has(selectedVariant)) {
        throw new Error("该分类没有 factory 镜像，Web Serial 不支持；请改用网络 OTA 或选择 4 MB 分类");
      }
      manifestUrl =
        "/api/install/web/manifest?source=remote&tag=" +
        encodeURIComponent(tag) +
        "&variant=" +
        encodeURIComponent(selectedVariant);
    } else {
      const file = $("webFlashFile")?.files?.[0];
      if (!file) throw new Error("选择本地固件包（.zip 或标准命名的 .bin）");
      const key = fileKey(file);
      if (!webFlashUpload || webFlashUploadKey !== key) {
        const form = new FormData();
        form.append("firmware", file);
        $("webFlashOut").textContent = "上传并解析固件包...";
        webFlashUpload = await fetchJson("/api/install/web/upload", { method: "POST", body: form });
        webFlashUploadKey = key;
        renderWebFlashParts(webFlashUpload);
        for (const warning of webFlashUpload.warnings || []) {
          console.warn("固件包提示:", warning);
        }
      }
      const selected = selectedWebFlashParts();
      if (!selected.length) throw new Error("至少勾选一个要烧录的分区");
      manifestUrl =
        "/api/install/web/manifest?source=local&token=" +
        encodeURIComponent(webFlashUpload.token) +
        "&parts=" +
        encodeURIComponent(selected.join(","));
      upload = webFlashUpload;
    }

    // Validate the manifest structure before exposing the flash button; a
    // non-JSON HTTP 200 error page must not look like a ready manifest.
    const manifest = validateWebFlashManifest(await fetchJson(manifestUrl));
    const button = $("webFlashButton");
    if (button) {
      if ("manifest" in button) button.manifest = manifestUrl;
      button.setAttribute("manifest", manifestUrl);
      button.style.display = "";
    }
    $("webFlashOut").textContent = JSON.stringify({ source, manifestUrl, manifest, upload }, null, 2);
    $("webFlashMsg").textContent = "清单已就绪，点“连接串口并烧录”";
    return manifest;
  } catch (e) {
    $("webFlashMsg").textContent = "准备失败";
    updateWebFlashState();
    throw e;
  }
}

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

document.addEventListener("DOMContentLoaded", () => {
  $("firmwareVariant")?.addEventListener("change", updateVariantState);
  $("webFlashSource")?.addEventListener("change", () => {
    updateWebFlashState();
  });
  $("webFlashFile")?.addEventListener("change", () => {
    resetWebFlashUpload();
    updateWebFlashState();
  });
  syncVariantOptions();
  updateVariantState();
  updateWebFlashState();
  loadToolchain().catch(() => {});
});
