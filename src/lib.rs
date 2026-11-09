
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, UdpSocket},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{Multipart, Path as AxPath, Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower_http::trace::TraceLayer;

#[derive(rust_embed::RustEmbed)]
#[folder = "installer-dist/"]
struct InstallerAssets;

#[derive(rust_embed::RustEmbed)]
#[folder = "firmware/"]
struct FirmwareAssets;

#[derive(rust_embed::RustEmbed)]
#[folder = "ui/"]
struct UiAssets;

include!(concat!(env!("OUT_DIR"), "/toolchain_versions.rs"));

const DEFAULT_DEVICE: &str = "";
const DEFAULT_PORT: u16 = 8088;
const RELEASE_NAME: &str = "fluidcan-pcb5";
const GITHUB_REPO: &str = "kxgx/FluidNC";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    base: Arc<tokio::sync::RwLock<String>>,
    serial: Arc<Mutex<SerialState>>,
    serial_log: Arc<Mutex<Vec<String>>>,
    serial_exec_lock: Arc<tokio::sync::Mutex<()>>,
    web_token: Option<String>,
}

#[derive(Default)]
struct SerialState {
    port: Option<Box<dyn serialport::SerialPort>>,
    name: String,
}

#[derive(Deserialize)]
struct ConnectReq {
    url: Option<String>,
}

#[derive(Deserialize)]
struct CommandReq {
    command: String,
}

#[derive(Deserialize)]
struct ConfigReq {
    yaml: String,
}

#[derive(Deserialize)]
struct SerialOpenReq {
    port: String,
    baud: Option<u32>,
}

#[derive(Deserialize)]
struct SerialSendReq {
    command: String,
}

#[derive(Deserialize)]
struct FlashReq {
    port: String,
    baud: Option<u32>,
    firmware: Option<String>,
}

#[derive(Deserialize)]
struct RemoteOtaReq {
    tag: String,
    variant: Option<String>,
}

#[derive(Serialize)]
struct RemoteAsset {
    name: String,
    size: u64,
    url: String,
}

#[derive(Serialize)]
struct RemoteRelease {
    tag: String,
    version: String,
    name: String,
    published_at: String,
    prerelease: bool,
    body: String,
    assets: Vec<RemoteAsset>,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

fn err<T: Into<String>>(msg: T) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError { error: msg.into() }))
}

fn normalize_base(url: &str) -> String {
    let mut s = url.trim().to_string();
    if s.is_empty() {
        return String::new();
    }
    if !s.starts_with("http://") && !s.starts_with("https://") {
        s = format!("http://{s}");
    }
    s.trim_end_matches('/').to_string()
}

async fn device_command(
    client: &reqwest::Client,
    base: &str,
    command: &str,
) -> Result<String, String> {
    let resp = client
        .get(format!("{base}/command"))
        .query(&[("plain", command)])
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("设备请求失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("设备返回 HTTP {status}: {text}"));
    }
    Ok(text)
}

async fn current_base(state: &AppState) -> String {
    state.base.read().await.clone()
}

async fn toolchain_info() -> Json<Value> {
    Json(json!({
        "esptool": BUILD_ESPTOOL_VERSION,
        "esp_idf": BUILD_ESP_IDF_VERSION,
        "platform": BUILD_ESPTOOL_PLATFORM,
        "esptool_asset": BUILD_ESPTOOL_ASSET,
        "esptool_platform_url": BUILD_ESPTOOL_PLATFORM_URL,
        "esptool_supported": BUILD_ESPTOOL_SUPPORTED,
        "esptool_versions": BUILD_ESPTOOL_VERSIONS,
        "esp_idf_versions": BUILD_ESP_IDF_VERSIONS,
        "source": "official Espressif release metadata (build time)",
    }))
}

async fn health(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "app": "FluidCAN Studio",
        "version": env!("CARGO_PKG_VERSION"),
        "default_device": current_base(&st).await,
        "mode": "gui",
        "embedded_installer": true,
        "embedded_firmware": true,
    }))
}

async fn connect(State(st): State<Arc<AppState>>, Json(req): Json<ConnectReq>) -> Json<Value> {
    let base = normalize_base(req.url.as_deref().unwrap_or(DEFAULT_DEVICE));
    *st.base.write().await = base.clone();
    let probe = device_command(&st.client, &base, "$I").await;
    Json(json!({
        "base": base,
        "connected": probe.is_ok(),
        "probe": probe.unwrap_or_else(|e| e),
    }))
}

async fn get_status(State(st): State<Arc<AppState>>) -> Response {
    let base = current_base(&st).await;
    let mut out = json!({ "base": base });
    for (key, cmd) in [
        ("build", "$I"),
        ("state", "?"),
        ("settings", "$$"),
        ("startup", "$SS"),
    ] {
        out[key] = match device_command(&st.client, &base, cmd).await {
            Ok(v) => json!(v),
            Err(e) => json!({"error": e}),
        };
    }
    Json(out).into_response()
}

async fn get_can(State(st): State<Arc<AppState>>) -> Response {
    let base = current_base(&st).await;
    let mut out = json!({ "base": base });
    for (key, cmd) in [
        ("status", "$CANStatus"),
        ("faults", "$CANFaults"),
        ("positions", "$CANPos"),
        ("drivers", "$CANDriverInfo"),
    ] {
        out[key] = match device_command(&st.client, &base, cmd).await {
            Ok(v) => json!(v),
            Err(e) => json!({"error": e}),
        };
    }
    Json(out).into_response()
}

async fn run_command(
    State(st): State<Arc<AppState>>,
    Json(req): Json<CommandReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let base = current_base(&st).await;
    let command = req.command.trim().to_string();
    if command.is_empty() {
        return Err(err("命令不能为空"));
    }
    match device_command(&st.client, &base, &command).await {
        Ok(text) => Ok(Json(json!({ "command": command, "output": text }))),
        Err(e) => Err((StatusCode::BAD_GATEWAY, Json(ApiError { error: e }))),
    }
}

async fn get_config(
    State(st): State<Arc<AppState>>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let base = current_base(&st).await;
    let resp = st
        .client
        .get(format!("{base}/config.yaml"))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| err(format!("读取配置失败: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err(format!("读取配置失败 HTTP {status}: {text}")));
    }
    Ok(Json(json!({ "yaml": text, "base": base })))
}

async fn put_config(
    State(st): State<Arc<AppState>>,
    Json(req): Json<ConfigReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if let Err(e) = serde_yaml::from_str::<serde_yaml::Value>(&req.yaml) {
        return Err(err(format!("YAML 语法错误，未上传: {e}")));
    }
    let base = current_base(&st).await;
    let resp = st
        .client
        .put(format!("{base}/flash/config.yaml"))
        .body(req.yaml)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| err(format!("上传配置失败: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(err(format!("上传配置失败 HTTP {status}: {text}")));
    }
    Ok(Json(json!({ "ok": true, "status": status.as_u16(), "output": text })))
}

async fn list_ports() -> Json<Value> {
    let ports = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            json!({
                "name": p.port_name,
                "type": format!("{:?}", p.port_type),
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "ports": ports }))
}

async fn serial_open(
    State(st): State<Arc<AppState>>,
    Json(req): Json<SerialOpenReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let baud = req.baud.unwrap_or(115200);
    // Drop any previous port first so Windows does not keep the COM handle
    // locked when the user re-opens the same port.
    {
        let mut s = st.serial.lock().unwrap();
        s.port = None;
    }
    let port = serialport::new(&req.port, baud)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| err(format!("打开串口失败: {e}")))?;
    let mut reader = port
        .try_clone()
        .map_err(|e| err(format!("复制串口句柄失败: {e}")))?;
    {
        let mut s = st.serial.lock().unwrap();
        s.port = Some(port);
        s.name = req.port.clone();
    }
    st.serial_log
        .lock()
        .unwrap()
        .push(format!("[serial] open {} @{}", req.port, baud));
    let log = st.serial_log.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        let mut line = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !line.is_empty() {
                                let s = String::from_utf8_lossy(&line).trim().to_string();
                                if !s.is_empty() {
                                    log.lock().unwrap().push(format!("< {s}"));
                                }
                                line.clear();
                            }
                        } else {
                            line.push(b);
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
        }
        log.lock().unwrap().push("[serial] closed".to_string());
    });
    Ok(Json(json!({"ok": true, "port": req.port, "baud": baud})))
}

async fn serial_send(
    State(st): State<Arc<AppState>>,
    Json(req): Json<SerialSendReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let mut s = st.serial.lock().unwrap();
    let port = s.port.as_mut().ok_or_else(|| err("串口未打开"))?;
    let line = format!("{}\n", req.command.trim());
    port.write_all(line.as_bytes())
        .map_err(|e| err(format!("串口写入失败: {e}")))?;
    port.flush().ok();
    st.serial_log
        .lock()
        .unwrap()
        .push(format!("> {}", req.command.trim()));
    Ok(Json(json!({"ok": true, "sent": req.command})))
}

async fn serial_exec(
    State(st): State<Arc<AppState>>,
    Json(req): Json<SerialSendReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let _guard = st.serial_exec_lock.lock().await;
    let start = { st.serial_log.lock().unwrap().len() };
    {
        let mut s = st.serial.lock().unwrap();
        let port = s.port.as_mut().ok_or_else(|| err("串口未打开"))?;
        let line = format!("{}
", req.command.trim());
        port.write_all(line.as_bytes())
            .map_err(|e| err(format!("串口写入失败: {e}")))?;
        port.flush().ok();
    }
    st.serial_log
        .lock()
        .unwrap()
        .push(format!("> {}", req.command.trim()));

    let deadline = std::time::Instant::now() + Duration::from_millis(1600);
    loop {
        let lines = {
            let log = st.serial_log.lock().unwrap();
            log.iter().skip(start).cloned().collect::<Vec<_>>()
        };
        let mut text = Vec::new();
        let mut done = false;
        for line in &lines {
            if let Some(rest) = line.strip_prefix("< ") {
                text.push(rest.to_string());
                if rest.trim() == "ok" || rest.contains("error:") || rest.starts_with("ALARM:") {
                    done = true;
                }
            }
        }
        if done || std::time::Instant::now() >= deadline {
            return Ok(Json(json!({
                "text": text.join("\n"),
                "ok": done,
            })));
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn serial_log(State(st): State<Arc<AppState>>) -> Json<Value> {
    let log = st.serial_log.lock().unwrap().clone();
    Json(json!({"log": log}))
}

async fn firmware_info(State(_st): State<Arc<AppState>>) -> Json<Value> {
    let mut files = Vec::new();
    for name in [
        "firmware.bin",
        "firmware.factory.bin",
        "bootloader.bin",
        "partitions.bin",
    ] {
        if let Some(f) = FirmwareAssets::get(name) {
            files.push(json!({
                "name": name,
                "size": f.data.len(),
                "source": "embedded"
            }));
        }
    }
    Json(json!({"source": "embedded", "files": files}))
}

async fn upload_firmware(st: &AppState, data: Vec<u8>, name: String) -> Result<Value, String> {
    let base = current_base(st).await;
    let part = reqwest::multipart::Part::bytes(data)
        .file_name(name)
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new().part("firmware", part);
    let resp = st
        .client
        .post(format!("{base}/updatefw"))
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| format!("OTA 上传失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    Ok(json!({"http": status.as_u16(), "response": text}))
}

async fn ota_update(
    State(st): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let mut data: Option<Vec<u8>> = None;
    let mut name = "firmware.bin".to_string();
    while let Ok(Some(field)) = multipart.next_field().await {
        let fname = field.file_name().unwrap_or("firmware.bin").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| err(format!("读取上传文件失败: {e}")))?;
        name = fname;
        data = Some(bytes.to_vec());
    }
    let data = data.ok_or_else(|| err("没有收到固件文件"))?;
    let result = upload_firmware(&st, data, name)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    Ok(Json(result))
}


fn scan_local_ipv4s() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if let IpAddr::V4(ip) = addr.ip() {
                    if !ip.is_loopback() {
                        out.push(ip);
                    }
                }
            }
        }
    }
    for s in local_ips() {
        if let Ok(ip) = s.parse::<Ipv4Addr>() {
            if !ip.is_loopback() && !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    // Prefer normal home/office LANs over VPN / virtual adapters.
    out.sort_by_key(|ip| {
        let o = ip.octets();
        if o[0] == 192 && o[1] == 168 { 0 }
        else if o[0] == 10 { 1 }
        else if o[0] == 172 && (16..=31).contains(&o[1]) { 2 }
        else { 3 }
    });
    out
}

async fn probe_fluidnc(ip: Ipv4Addr) -> Option<Value> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(900))
        .build()
        .ok()?;
    let url = format!("http://{ip}/command?plain=%24I");
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    if !text.contains("[VER:") && !text.contains("FluidNC") {
        return None;
    }
    let version = text
        .split("[VER:")
        .nth(1)
        .and_then(|v| v.split(']').next())
        .unwrap_or("FluidNC")
        .to_string();
    Some(json!({
        "ip": ip.to_string(),
        "url": format!("http://{ip}"),
        "version": version,
    }))
}

async fn scan_subnet(local: Ipv4Addr) -> Vec<Value> {
    let octets = local.octets();
    let sem = Arc::new(tokio::sync::Semaphore::new(32));
    let mut set = tokio::task::JoinSet::new();
    for host in 1u8..=254 {
        if host == octets[3] {
            continue;
        }
        let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], host);
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            probe_fluidnc(ip).await
        });
    }
    let mut devices = Vec::new();
    while let Some(item) = set.join_next().await {
        if let Ok(Some(device)) = item {
            devices.push(device);
        }
    }
    devices.sort_by(|a, b| {
        a.get("ip")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("ip").and_then(Value::as_str).unwrap_or(""))
    });
    devices
}

async fn scan_devices() -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let candidates = scan_local_ipv4s();
    if candidates.is_empty() {
        return Err(err("无法确定本机局域网地址，请手动输入设备地址"));
    }
    let mut scanned = Vec::new();
    let mut devices = Vec::new();
    for local in &candidates {
        scanned.push(format!(
            "{}.{}.{}.0/24",
            local.octets()[0],
            local.octets()[1],
            local.octets()[2]
        ));
        devices = scan_subnet(*local).await;
        if !devices.is_empty() {
            break;
        }
    }
    Ok(Json(json!({
        "subnets": scanned,
        "local_ip": candidates[0].to_string(),
        "devices": devices,
    })))
}

async fn remote_releases(State(_st): State<Arc<AppState>>) -> Response {
    match fetch_remote_releases().await {
        Ok(rel) => Json(json!({"repo": GITHUB_REPO, "releases": rel})).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })).into_response(),
    }
}

fn is_version_tag(tag: &str) -> bool {
    let Some(v) = tag.strip_prefix("can-v") else {
        return false;
    };
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

async fn fetch_remote_releases_api() -> Result<Vec<RemoteRelease>, String> {
    let mut req = reqwest::Client::new()
        .get(format!(
            "{GITHUB_API}/repos/{GITHUB_REPO}/releases?per_page=30"
        ))
        .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .timeout(Duration::from_secs(30));
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.is_empty() {
            req = req.bearer_auth(token);
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("访问 GitHub 失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("GitHub 返回 HTTP {status}: {text}"));
    }
    let arr: Value = serde_json::from_str(&text).map_err(|e| format!("解析 GitHub 响应失败: {e}"))?;
    let mut out = Vec::new();
    for r in arr.as_array().cloned().unwrap_or_default() {
        if r.get("draft").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let tag = r.get("tag_name").and_then(Value::as_str).unwrap_or("");
        if !is_version_tag(tag) {
            continue;
        }
        let assets = r
            .get("assets")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| {
                Some(RemoteAsset {
                    name: a.get("name")?.as_str()?.to_string(),
                    size: a.get("size").and_then(Value::as_u64).unwrap_or(0),
                    url: a.get("browser_download_url")?.as_str()?.to_string(),
                })
            })
            .collect();
        out.push(RemoteRelease {
            tag: tag.to_string(),
            version: tag.trim_start_matches("can-v").to_string(),
            name: r
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(tag)
                .to_string(),
            published_at: r
                .get("published_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            prerelease: r.get("prerelease").and_then(Value::as_bool).unwrap_or(false),
            body: r.get("body").and_then(Value::as_str).unwrap_or("").to_string(),
            assets,
        });
    }
    Ok(out)
}

async fn fetch_remote_releases_atom() -> Result<Vec<RemoteRelease>, String> {
    let url = format!("https://github.com/{GITHUB_REPO}/releases.atom");
    let text = reqwest::Client::new()
        .get(&url)
        .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("访问 GitHub releases.atom 失败: {e}"))?
        .text()
        .await
        .map_err(|e| format!("读取 releases.atom 失败: {e}"))?;

    fn between<'a>(s: &'a str, a: &str, b: &str) -> Option<&'a str> {
        let start = s.find(a)? + a.len();
        let end = s[start..].find(b)? + start;
        Some(&s[start..end])
    }

    let mut out = Vec::new();
    for chunk in text.split("<entry>").skip(1) {
        let Some(link) = between(chunk, "href=\"", "\"") else { continue };
        let Some(tag) = link.rsplit('/').next() else { continue };
        if !is_version_tag(tag) {
            continue;
        }
        let title = between(chunk, "<title>", "</title>").unwrap_or(tag);
        let updated = between(chunk, "<updated>", "</updated>").unwrap_or("");
        let fw_url = format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/firmware.bin");
        out.push(RemoteRelease {
            tag: tag.to_string(),
            version: tag.trim_start_matches("can-v").to_string(),
            name: title.to_string(),
            published_at: updated.to_string(),
            prerelease: false,
            body: String::new(),
            assets: vec![RemoteAsset {
                name: "firmware.bin".to_string(),
                size: 0,
                url: fw_url,
            }],
        });
    }
    Ok(out)
}

async fn fetch_remote_releases() -> Result<Vec<RemoteRelease>, String> {
    match fetch_remote_releases_api().await {
        Ok(v) if !v.is_empty() => Ok(v),
        Ok(_) => fetch_remote_releases_atom().await,
        Err(api_err) => match fetch_remote_releases_atom().await {
            Ok(v) => Ok(v),
            Err(atom_err) => Err(format!("{api_err}; {atom_err}")),
        },
    }
}

fn ota_asset_name(variant: &str) -> String {
    if variant.is_empty() || variant == "default" {
        "firmware.bin".to_string()
    } else {
        format!("{variant}-firmware.bin")
    }
}

fn variant_is_4mb(variant: &str) -> bool {
    let v = variant.to_ascii_lowercase();
    v.contains("4mb") || v.contains("nopsram")
}

async fn remote_ota(
    State(st): State<Arc<AppState>>,
    Json(req): Json<RemoteOtaReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let releases = fetch_remote_releases()
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    let release = releases
        .into_iter()
        .find(|r| r.tag == req.tag)
        .ok_or_else(|| err(format!("找不到版本 {}", req.tag)))?;
    let variant = req.variant.unwrap_or_else(|| "default".to_string());
    if variant_is_4mb(&variant) {
        return Err(err(format!(
            "{} 是 4 MB 单 app 分区版本，不能网络 OTA；请使用串口烧录",
            variant
        )));
    }
    let asset_name = ota_asset_name(&variant);
    let asset_url = release
        .assets
        .iter()
        .find(|a| a.name == asset_name)
        .map(|a| a.url.clone())
        .unwrap_or_else(|| {
            // The releases.atom fallback has no asset list; construct the
            // variant URL and let the download verify that it exists.
            format!(
                "https://github.com/{GITHUB_REPO}/releases/download/{}/{}",
                release.tag, asset_name
            )
        });
    let resp = reqwest::Client::new()
        .get(&asset_url)
        .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .map_err(|e| err(format!("下载固件失败: {e}")))?;
    let status = resp.status();
    let data = resp
        .bytes()
        .await
        .map_err(|e| err(format!("读取固件失败: {e}")))?
        .to_vec();
    if !status.is_success() || data.is_empty() {
        return Err(err(format!(
            "下载固件失败 HTTP {status}, {} bytes",
            data.len()
        )));
    }
    let result = upload_firmware(&st, data, "firmware.bin".to_string())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    Ok(Json(json!({
        "version": release.version,
        "tag": release.tag,
        "asset": asset_name,
        "variant": variant,
        "ota": result,
    })))
}

async fn flash_serial(
    State(_st): State<Arc<AppState>>,
    Json(req): Json<FlashReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let firmware = if let Some(path) = req.firmware {
        let p = PathBuf::from(path);
        if !p.exists() {
            return Err(err(format!("固件不存在: {}", p.display())));
        }
        p
    } else {
        let data = FirmwareAssets::get("firmware.factory.bin")
            .ok_or_else(|| err("内置固件中找不到 firmware.factory.bin"))?;
        let p = std::env::temp_dir().join(format!("fluidcan-flash-{}.bin", std::process::id()));
        std::fs::write(&p, data.data).map_err(|e| err(format!("写入临时固件失败: {e}")))?;
        p
    };
    let baud = req.baud.unwrap_or(460800);
    let py = std::env::var("FLUIDCAN_PYTHON").unwrap_or_else(|_| "python".to_string());
    let mut cmd = std::process::Command::new(py);
    cmd.args([
        "-m",
        "esptool",
        "--chip",
        "esp32s3",
        "--port",
        &req.port,
        "--baud",
        &baud.to_string(),
        "--before",
        "default_reset",
        "--after",
        "hard_reset",
        "write_flash",
        "--flash_mode",
        "keep",
        "--flash_freq",
        "keep",
        "--flash_size",
        "keep",
        "0x0",
    ]);
    cmd.arg(&firmware);
    let out = cmd
        .output()
        .map_err(|e| err(format!("启动 esptool 失败: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Ok(Json(json!({
        "ok": out.status.success(),
        "code": out.status.code(),
        "stdout": stdout,
        "stderr": stderr,
        "firmware": firmware,
    })))
}

fn firmware_factory_bytes() -> Result<Vec<u8>, String> {
    FirmwareAssets::get("firmware.factory.bin")
        .map(|f| f.data.into_owned())
        .ok_or_else(|| "内置固件中找不到 firmware.factory.bin".to_string())
}

async fn installer_releases() -> Json<Value> {
    Json(json!([{
        "id": 1,
        "name": RELEASE_NAME,
        "body": "FluidCAN Studio custom ESP32-S3 CAN firmware",
        "url": "",
        "draft": false,
        "prerelease": false,
        "created_at": "2026-10-30T00:00:00Z",
        "published_at": "2026-10-30T00:00:00Z"
    }]))
}


async fn installer_manifest(
    State(_st): State<Arc<AppState>>,
    AxPath(release): AxPath<String>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if release != RELEASE_NAME {
        return Err(err("未知的安装包"));
    }
    let data = firmware_factory_bytes().map_err(err)?;
    let mut h = Sha256::new();
    h.update(&data);
    let sha = hex::encode(h.finalize());
    let size = data.len() as u64;
    Ok(Json(json!({
        "name": "FluidCAN",
        "version": "can-motor-driver / PCB5",
        "source_url": "",
        "release_url": "",
        "images": {
            "fluidcan-factory": {
                "size": size,
                "offset": "0x0",
                "path": "firmware.factory.bin",
                "signature": {"algorithm": "SHA2-256", "value": sha}
            }
        },
        "installable": {
            "name": "installable",
            "description": "FluidCAN firmware",
            "choice-name": "Processor type",
            "choices": [{
                "name": "esp32s3",
                "description": "ESP32-S3-WROOM-1",
                "choice-name": "安装方式",
                "choices": [{
                    "name": "can-full",
                    "description": "完整写入 CAN 固件（factory image @ 0x0）",
                    "erase": true,
                    "images": ["fluidcan-factory"]
                }]
            }]
        }
    })))
}

async fn installer_firmware(
    State(_st): State<Arc<AppState>>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let data = firmware_factory_bytes().map_err(err)?;
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
        data,
    )
        .into_response())
}

async fn installer_asset(AxPath(path): AxPath<String>) -> Response {
    let path = if path.is_empty() { "index.html".to_string() } else { path };
    let Some(asset) = InstallerAssets::get(&path) else {
        return (StatusCode::NOT_FOUND, "installer asset not found").into_response();
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    (
        [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
        asset.data.into_owned(),
    )
        .into_response()
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../ui/index.html"))
}

async fn ui_asset_named(path: String) -> Response {
    let Some(asset) = UiAssets::get(&path) else {
        return (StatusCode::NOT_FOUND, "ui asset not found").into_response();
    };
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    ([(header::CONTENT_TYPE, mime.as_ref())], asset.data.into_owned()).into_response()
}

async fn ui_js(AxPath(path): AxPath<String>) -> Response {
    ui_asset_named(format!("js/{path}")).await
}

async fn ui_css(AxPath(path): AxPath<String>) -> Response {
    ui_asset_named(format!("css/{path}")).await
}

fn build_state(web_token: Option<String>) -> Arc<AppState> {
    Arc::new(AppState {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(25))
            .build()
            .expect("build http client"),
        base: Arc::new(tokio::sync::RwLock::new(normalize_base(
            &std::env::var("FLUIDCAN_DEVICE").unwrap_or_else(|_| DEFAULT_DEVICE.to_string()),
        ))),
        serial: Arc::new(Mutex::new(SerialState::default())),
        serial_log: Arc::new(Mutex::new(Vec::new())),
        serial_exec_lock: Arc::new(tokio::sync::Mutex::new(())),
        web_token,
    })
}

async fn web_auth(State(st): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let Some(token) = st.web_token.as_deref() else {
        return next.run(req).await;
    };
    let query = req.uri().query().unwrap_or("");
    let query_ok = query
        .split('&')
        .any(|p| p == format!("token={token}"));
    let cookie = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let cookie_ok = cookie
        .split(';')
        .any(|p| p.trim() == format!("fluidcan_token={token}"));
    if !query_ok && !cookie_ok {
        return (StatusCode::UNAUTHORIZED, "token required").into_response();
    }
    let mut resp = next.run(req).await;
    if query_ok {
        if let Ok(v) = format!("fluidcan_token={token}; Path=/; HttpOnly; SameSite=Lax").parse() {
            resp.headers_mut().insert(header::SET_COOKIE, v);
        }
    }
    resp
}

fn build_router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/toolchain", get(toolchain_info))
        .route("/connect", post(connect))
        .route("/status", get(get_status))
        .route("/can", get(get_can))
        .route("/command", post(run_command))
        .route("/config", get(get_config).put(put_config))
        .route("/ports", get(list_ports))
        .route("/serial/open", post(serial_open))
        .route("/serial/send", post(serial_send))
        .route("/serial/exec", post(serial_exec))
        .route("/serial/log", get(serial_log))
        .route("/firmware", get(firmware_info))
        .route("/install/ota", post(ota_update))
        .route("/install/flash", post(flash_serial))
        .route("/scan", get(scan_devices))
        .route("/updates", get(remote_releases))
        .route("/ota/remote", post(remote_ota));

    let installer_api = Router::new()
        .route("/installer-api/releases", get(installer_releases))
        .route(
            "/installer-api/resources/{release}/manifest.json",
            get(installer_manifest),
        )
        .route(
            "/installer-api/resources/{release}/firmware.factory.bin",
            get(installer_firmware),
        );

    Router::new()
        .nest("/api", api)
        .merge(installer_api)
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/js/{*path}", get(ui_js))
        .route("/css/{*path}", get(ui_css))
        .route(
            "/installer",
            get(|| async { installer_asset(AxPath("index.html".to_string())).await }),
        )
        .route(
            "/installer/",
            get(|| async { installer_asset(AxPath("index.html".to_string())).await }),
        )
        .route("/installer/{*path}", get(installer_asset))
        .layer(middleware::from_fn_with_state(state.clone(), web_auth))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn start_server(bind: &str, token: Option<String>) -> anyhow::Result<u16> {
    let listener = std::net::TcpListener::bind(bind)?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let state = build_state(token);
    let app = build_router(state);
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("tokio listener");
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("server error: {e}");
            }
        });
    });
    Ok(port)
}

fn runtime_log(msg: &str) {
    println!("{msg}");
    let path = std::env::temp_dir().join("fluidcan-studio.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::io::Write as _;
        let _ = writeln!(f, "{msg}");
    }
}
fn local_ips() -> Vec<String> {
    use std::net::ToSocketAddrs;
    let hostname = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".to_string());
    let mut out = Vec::new();
    if let Ok(addrs) = (hostname.as_str(), 0).to_socket_addrs() {
        for a in addrs {
            if let std::net::IpAddr::V4(v4) = a.ip() {
                if !v4.is_loopback() && !v4.is_link_local() {
                    let s = v4.to_string();
                    if !out.contains(&s) {
                        out.push(s);
                    }
                }
            }
        }
    }
    out
}

fn has_desktop() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("DISPLAY").is_some() || std::env::var_os("WAYLAND_DISPLAY").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

fn make_token() -> String {
    let mut h = Sha256::new();
    h.update(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    hex::encode(h.finalize())[..20].to_string()
}

pub fn run_desktop() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let args: Vec<String> = std::env::args().collect();
    let force_web = args.iter().any(|a| a == "--web")
        || std::env::var("FLUIDCAN_MODE").map(|v| v == "web").unwrap_or(false);

    if force_web || !has_desktop() {
        let host = std::env::var("FLUIDCAN_WEB_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = std::env::var("FLUIDCAN_WEB_PORT")
            .or_else(|_| std::env::var("FLUIDCAN_STUDIO_PORT"))
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(DEFAULT_PORT);
        let token = std::env::var("FLUIDCAN_WEB_TOKEN")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(make_token);
        let bind = format!("{host}:{port}");
        let actual_port = start_server(&bind, Some(token.clone()))?;
        let url_host = if host == "0.0.0.0" { "127.0.0.1" } else { &host };
        let url = format!("http://{url_host}:{actual_port}/?token={token}");
        runtime_log(&format!("FluidCAN Studio web mode: {url}"));
        let ips = local_ips();
        if ips.is_empty() {
            runtime_log(&format!("Remote access: http://<this-machine-ip>:{actual_port}/?token={token}"));
        } else {
            for ip in ips {
                runtime_log(&format!("Remote access: http://{ip}:{actual_port}/?token={token}"));
            }
        }
        if has_desktop() {
            let _ = open::that(&url);
        }
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    // Native GUI: start the embedded web backend on a loopback port, then
    // point a Tauri webview window at it.  The UI is exactly the same web UI.
    let port = start_server("127.0.0.1:0", None)?;
    let url = format!("http://127.0.0.1:{port}/");
    runtime_log(&format!("FluidCAN Studio GUI: {url}"));
    let url_for_window = url.clone();
    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url_for_window.parse()?),
            )
            .title("FluidCAN Studio")
            .inner_size(1500.0, 980.0)
            .min_inner_size(1000.0, 700.0)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .map_err(|e| anyhow::anyhow!("Tauri error: {e}"))?;
    Ok(())
}




#[cfg(target_os = "android")]
#[tauri::mobile_entry_point]
pub fn run_android() {
    let port = start_server("127.0.0.1:0", None).expect("start embedded server");
    let url = format!("http://127.0.0.1:{port}/");
    runtime_log(&format!("FluidCAN Studio Android: {url}"));
    let url_for_window = url.clone();
    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(url_for_window.parse()?),
            )
            .title("FluidCAN Studio")
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run Android Tauri app");
}


