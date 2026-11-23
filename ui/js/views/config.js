import { currentMode, getDeviceConfig, httpPut } from "../core/transport.js";

const $ = (id) => document.getElementById(id);

// Only allow uploading a config that was actually read from the device in this
// session.  Without this guard the HTML placeholder text could be uploaded as
// YAML (serde_yaml accepts a bare scalar) and overwrite config.yaml.
let configLoaded = false;

export async function loadConfig() {
  $("cfgMsg").textContent = "读取中...";
  configLoaded = false;
  try {
    const j = await getDeviceConfig();
    const yaml = j && typeof j.yaml === "string" ? j.yaml : "";
    if (!yaml) throw new Error("设备返回的配置不是 YAML 文本");
    $("configText").value = yaml;
    configLoaded = true;
    $("cfgMsg").textContent = `已读取 ${yaml.length} 字节`;
    return j;
  } catch (e) {
    $("cfgMsg").textContent = "读取失败";
    throw e;
  }
}

export async function saveConfig() {
  if (!configLoaded) {
    $("cfgMsg").textContent = "请先“读取配置”，确认内容后再上传";
    throw new Error("请先“读取配置”，确认内容后再上传");
  }
  if (currentMode() !== "http") {
    $("cfgMsg").textContent = "串口模式不支持上传配置，请用 WiFi 连接";
    throw new Error("串口模式不支持上传配置，请用 WiFi 连接");
  }
  const yaml = $("configText").value;
  // Refuse to upload an empty/garbage editor state (e.g. "undefined" left by a
  // malformed read) so a bad response can never overwrite the device config.
  if (typeof yaml !== "string" || !yaml.trim() || yaml.trim() === "undefined") {
    $("cfgMsg").textContent = "未读取到有效配置，已拒绝上传";
    throw new Error("未读取到有效配置，已拒绝上传");
  }
  $("cfgMsg").textContent = "上传中...";
  try {
    const j = await httpPut("/config", { yaml });
    $("cfgMsg").textContent = "上传成功，请重启";
    return j;
  } catch (e) {
    $("cfgMsg").textContent = "上传失败";
    throw e;
  }
}
