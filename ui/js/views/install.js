import { httpGet, httpPost } from "../core/transport.js";

const $ = (id) => document.getElementById(id);

export async function refreshRemote() {
  $("remoteMsg").textContent = "读取 GitHub...";
  const j = await httpGet("/updates");
  const releases = j.releases || [];
  const select = $("remoteRelease");
  select.innerHTML = releases.length
    ? releases
        .map(
          (r) =>
            `<option value="${esc(r.tag)}">${esc(r.version)} · ${esc(r.name)} · ${esc(String(r.published_at).slice(0, 10))}</option>`,
        )
        .join("")
    : '<option value="">没有可用版本</option>';
  $("remoteMsg").textContent = `${releases.length} 个版本`;
  $("remoteOut").textContent = JSON.stringify(releases, null, 2);
  return releases;
}

export async function remoteOta() {
  const tag = $("remoteRelease").value;
  if (!tag) throw new Error("先获取并选择版本");
  $("remoteMsg").textContent = "下载并 OTA...";
  const j = await httpPost("/ota/remote", { tag });
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
  const port = $("flashPort").value.trim();
  const baud = parseInt($("flashBaud").value, 10) || 460800;
  if (!port) throw new Error("输入 COM 口");
  $("flashOut").textContent = "烧录中...";
  const j = await httpPost("/install/flash", { port, baud });
  $("flashOut").textContent = JSON.stringify(j, null, 2);
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
