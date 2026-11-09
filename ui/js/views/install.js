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
      warn.textContent = "当前选择为 8 MB 版本：支持网络 OTA。";
      warn.className = "sub";
    }
  }
}

export async function refreshRemote() {
  $("remoteMsg").textContent = "读取 GitHub...";
  const j = await httpGet("/updates");
  const releases = j.releases || [];
  const select = $("remoteRelease");
  const installed = currentTag();
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

  select.innerHTML = options.length ? options.join("") : '<option value="">没有可用版本</option>';
  if (installed && releases.some((r) => r.tag === installed)) select.value = installed;

  releasesLoaded = releases.length > 0;
  $("remoteMsg").textContent = releasesLoaded ? `${releases.length} 个版本` : "没有可用版本";
  $("remoteOut").textContent = JSON.stringify(
    { current: installed, variant: variant(), releases },
    null,
    2,
  );
  updateVariantState();
  return releases;
}

export async function remoteOta() {
  if (!releasesLoaded) throw new Error("先获取版本列表");
  if (!hasVariant()) throw new Error("先选择固件分类");
  if (isFourMb()) throw new Error("4 MB 版本不能网络 OTA，请使用串口烧录");
  const tag = $("remoteRelease").value;
  if (!tag) throw new Error("先获取并选择版本");
  $("remoteMsg").textContent = "下载并 OTA...";
  const j = await httpPost("/ota/remote", { tag, variant: variant() });
  $("remoteOut").textContent = JSON.stringify(j, null, 2);
  $("remoteMsg").textContent = "OTA 已提交";
  return j;
}

export async function otaUpload() {
  const file = $("otaFile").files[0];
  if (!file) throw new Error("选择 .bin 固件");
  const form = new FormData();
  form.append("firmware", file);
  $("otaOut").textContent = "上传中...";
  const r = await fetch("/api/install/ota", { method: "POST", body: form });
  const j = await r.json();
  $("otaOut").textContent = JSON.stringify(j, null, 2);
  return j;
}

export async function flashSerial() {
  const port = ($("flashPort").value || $("serialPorts").value || "").trim();
  const baud = parseInt($("flashBaud").value, 10) || 460800;
  if (!port) throw new Error("输入 COM 口");
  $("flashOut").textContent = "烧录中...";
  const j = await httpPost("/install/flash", { port, baud });
  $("flashOut").textContent = JSON.stringify(j, null, 2);
  return j;
}

export async function loadToolchain() {
  const j = await httpGet("/toolchain");
  const box = $("toolchainBox");
  if (!box) return j;
  const rows = [
    ["官方 esptool", j.esptool || "--"],
    ["官方 ESP-IDF", j.esp_idf || "--"],
    ["esptool 版本", (j.esptool_versions || []).join(", ") || "--"],
    ["ESP-IDF 版本", (j.esp_idf_versions || []).join(", ") || "--"],
    ["来源", j.source || "--"],
  ];
  box.innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join("");
  return j;
}

export async function loadFirmware() {
  const j = await httpGet("/firmware");
  $("fwFiles").textContent = JSON.stringify(j, null, 2);
  return j;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

document.addEventListener("DOMContentLoaded", () => {
  $("firmwareVariant")?.addEventListener("change", updateVariantState);
  updateVariantState();
  loadToolchain().catch(() => {});
});
