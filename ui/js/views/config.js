import { httpGet, httpPost, httpPut } from "../core/transport.js";

const $ = (id) => document.getElementById(id);

export async function loadConfig() {
  $("cfgMsg").textContent = "读取中...";
  try {
    const j = await httpGet("/config");
    $("configText").value = j.yaml;
    $("cfgMsg").textContent = `已读取 ${j.yaml.length} 字节`;
  } catch (e) {
    $("cfgMsg").textContent = "读取失败";
    throw e;
  }
}

export async function saveConfig() {
  const yaml = $("configText").value;
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
