
use std::{
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr, UdpSocket},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use axum::{
    extract::{DefaultBodyLimit, Multipart, Path as AxPath, Query, Request, State},
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
#[folder = "ui/"]
struct UiAssets;

include!(concat!(env!("OUT_DIR"), "/toolchain_versions.rs"));

const DEFAULT_DEVICE: &str = "";
const DEFAULT_PORT: u16 = 8088;
const GITHUB_REPO: &str = "kxgx/FluidNC";
const GITHUB_API: &str = "https://api.github.com";

// Latency budget for the interactive paths.  The device answers ordinary
// commands in <150 ms on a healthy WiFi link, so these only bound failure
// cases; a wrong address should not make the user wait 20 seconds.
const CONNECT_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STATUS_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
// CAN report commands can legitimately take tens of seconds when a driver is
// unpowered; they run in the background in the UI, so allow them to finish.
const CAN_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

// LAN discovery probes are intentionally cheap: many /24 addresses are probed
// at once and FluidNC answers in well under a second.
const SCAN_PROBE_TIMEOUT: Duration = Duration::from_millis(600);
const SCAN_CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const SCAN_CONCURRENCY: usize = 128;

// In-app Web Serial flasher (esp-web-tools).  The browser fetches a generated
// manifest + image from these endpoints, so no Python/esptool install is
// needed for a factory-image flash.
const WEB_FLASH_IMAGE_PATH: &str = "/api/install/web/image";
const MAX_WEB_FLASH_BYTES: usize = 32 * 1024 * 1024;
// Variants that ship a factory image (0.2.16+ release zips contain
// USB/firmware.factory.bin for every variant; older releases only for some).
const WEB_FLASH_VARIANTS: &[&str] = &[
    "nopsram-oled-usb-4mb",
    "quad-oled-usb-4mb",
    "octal-oled-usb-4mb",
    "quad-oled-usb",
    "octal-oled-usb",
    "quad-oled",
    "octal-oled",
    "quad",
    "octal",
];

/// Query for the browser-facing Web Serial manifest/image endpoints.
#[derive(Deserialize)]
struct WebFlashQuery {
    source: Option<String>,
    tag: Option<String>,
    variant: Option<String>,
    asset: Option<String>,
    token: Option<String>,
    /// Comma-separated local package part names to flash (defaults to all
    /// factory parts, or every part when no factory image is present).
    parts: Option<String>,
    /// Local package part name for the image endpoint.
    name: Option<String>,
}

#[derive(Clone)]
struct AppState {
    client: reqwest::Client,
    base: Arc<tokio::sync::RwLock<String>>,
    serial: Arc<Mutex<SerialState>>,
    serial_log: Arc<Mutex<Vec<String>>>,
    serial_exec_lock: Arc<tokio::sync::Mutex<()>>,
    tool_lock: Arc<tokio::sync::Mutex<()>>,
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
    device_command_timeout(client, base, command, Duration::from_secs(20)).await
}

async fn device_command_timeout(
    client: &reqwest::Client,
    base: &str,
    command: &str,
    timeout: Duration,
) -> Result<String, String> {
    let resp = client
        .get(format!("{base}/command"))
        .query(&[("plain", command)])
        .timeout(timeout)
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

async fn install_toolchain(State(st): State<Arc<AppState>>) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let tool = ensure_official_esptool(&st)
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    Ok(Json(json!({
        "ok": tool.is_some(),
        "tool": tool.map(|p| p.to_string_lossy().to_string()),
        "platform": BUILD_ESPTOOL_PLATFORM,
        "version": BUILD_ESPTOOL_VERSION,
        "asset": BUILD_ESPTOOL_ASSET,
    })))
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
        "web_serial_flash": true,
    }))
}

async fn connect(State(st): State<Arc<AppState>>, Json(req): Json<ConnectReq>) -> Json<Value> {
    let requested = normalize_base(req.url.as_deref().unwrap_or(DEFAULT_DEVICE));
    let previous = current_base(&st).await;
    if requested.is_empty() {
        return Json(json!({
            "base": previous,
            "requested": requested,
            "connected": false,
            "error": "设备地址为空",
        }));
    }
    let probe = device_command_timeout(&st.client, &requested, "$I", CONNECT_PROBE_TIMEOUT).await;
    match probe {
        Ok(text) => {
            *st.base.write().await = requested.clone();
            Json(json!({
                "base": requested,
                "requested": requested,
                "connected": true,
                "probe": text,
            }))
        }
        // A failed connect must not repoint the active device: keep using the
        // previously working base so the scan/connect flows stay recoverable.
        Err(e) => Json(json!({
            "base": previous,
            "requested": requested,
            "connected": false,
            "probe": e,
        })),
    }
}

// Only the fields the UI needs, queried in parallel.  The previous version
// also fetched `$$` and `$SS` (unused by the UI) sequentially, which doubled
// the latency of the very first refresh after connecting.
async fn get_status(State(st): State<Arc<AppState>>) -> Response {
    let base = current_base(&st).await;
    let (build, state) = tokio::join!(
        device_command_timeout(&st.client, &base, "$I", STATUS_COMMAND_TIMEOUT),
        device_command_timeout(&st.client, &base, "?", STATUS_COMMAND_TIMEOUT),
    );
    let field = |result: Result<String, String>| match result {
        Ok(v) => json!(v),
        Err(e) => json!({"error": e}),
    };
    Json(json!({
        "base": base,
        "build": field(build),
        "state": field(state),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct CanQuery {
    // light=1 skips $CANDriverInfo, which the overview never renders and which
    // is one of the slowest report commands on an unpowered bus.
    light: Option<u8>,
}

async fn get_can(State(st): State<Arc<AppState>>, Query(query): Query<CanQuery>) -> Response {
    let base = current_base(&st).await;
    let mut commands: Vec<(&str, &str)> = vec![
        ("status", "$CANStatus"),
        ("faults", "$CANFaults"),
        ("positions", "$CANPos"),
    ];
    if query.light != Some(1) {
        commands.push(("drivers", "$CANDriverInfo"));
    }
    let mut out = json!({ "base": base });
    for (key, cmd) in commands {
        out[key] = match device_command_timeout(&st.client, &base, cmd, CAN_COMMAND_TIMEOUT).await {
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

fn is_zip_upload(data: &[u8], uploaded_name: &str) -> bool {
    uploaded_name.to_ascii_lowercase().ends_with(".zip") || data.starts_with(b"PK\x03\x04")
}

fn normalized_zip_path(name: &str) -> String {
    name.replace('\\', "/").to_ascii_lowercase()
}

/// Read the first zip entry whose normalized path matches `wanted`.
fn read_zip_member(
    data: &[u8],
    wanted: impl Fn(&str) -> bool,
) -> Result<Option<(String, Vec<u8>)>, String> {
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let path = normalized_zip_path(entry.name());
        if !wanted(&path) {
            continue;
        }
        if entry.size() as usize > MAX_WEB_FLASH_BYTES {
            return Err(format!("zip 条目 {} 超过 32 MB 限制", entry.name()));
        }
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut bytes)
            .map_err(|e| format!("解压 {} 失败: {e}", entry.name()))?;
        if bytes.is_empty() || bytes.len() > MAX_WEB_FLASH_BYTES {
            return Err(format!("zip 条目 {} 大小无效", entry.name()));
        }
        return Ok(Some((entry.name().replace('\\', "/"), bytes)));
    }
    Ok(None)
}

/// A can-v0.2.16+ release .zip contains `<variant>/OTA/firmware.bin`; older
/// releases used a loose app image (firmware.bin).  Both are accepted.
fn extract_ota_image(data: &[u8], uploaded_name: &str) -> Result<(String, Vec<u8>), String> {
    if data.is_empty() {
        return Err("固件文件为空".to_string());
    }
    if data.len() > MAX_WEB_FLASH_BYTES {
        return Err("固件文件超过 32 MB 限制".to_string());
    }
    if !is_zip_upload(data, uploaded_name) {
        return Ok((uploaded_name.to_string(), data.to_vec()));
    }
    if let Some((path, bytes)) = read_zip_member(data, |path| {
        path.ends_with("/ota/firmware.bin") || path == "ota/firmware.bin"
    })? {
        return Ok((path, bytes));
    }
    // Fallback for older/ad-hoc zips: any firmware.bin outside USB/.
    if let Some((path, bytes)) = read_zip_member(data, |path| {
        (path.ends_with("/firmware.bin") || path == "firmware.bin") && !path.contains("/usb/")
    })? {
        return Ok((path, bytes));
    }
    Err("zip 中没有 OTA 应用镜像（需要 OTA/firmware.bin；这是 can-v0.2.16 起的 Release 包格式）".to_string())
}

/// Extract the full USB factory image from a release .zip.
fn extract_usb_factory(data: &[u8]) -> Result<Option<(String, Vec<u8>)>, String> {
    read_zip_member(data, |path| {
        path.ends_with("/usb/firmware.factory.bin")
            || path == "usb/firmware.factory.bin"
            || path.ends_with("/firmware.factory.bin")
            || path == "firmware.factory.bin"
    })
}

fn release_zip_variant(variant: &str) -> String {
    let variant = variant.trim();
    if variant.is_empty() || variant == "default" {
        // The default env (wifi_s3_oled) is released as quad-oled.zip.
        "quad-oled".to_string()
    } else {
        variant.to_string()
    }
}

fn release_zip_name(tag: &str, variant: &str) -> String {
    format!("fluidcan-{tag}-{}.zip", release_zip_variant(variant))
}

async fn download_release_bytes(url: &str, timeout_secs: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(url)
        .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?;
    let status = resp.status();
    let data = resp
        .bytes()
        .await
        .map_err(|e| format!("读取下载内容失败: {e}"))?
        .to_vec();
    if !status.is_success() || data.is_empty() {
        return Err(format!("下载失败 HTTP {status}"));
    }
    if data.len() > MAX_WEB_FLASH_BYTES {
        return Err("下载文件超过 32 MB 限制".to_string());
    }
    Ok(data)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
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
    let (source, image) = extract_ota_image(&data, &name).map_err(err)?;
    let size = image.len();
    let sha = sha256_hex(&image);
    let result = upload_firmware(&st, image, "firmware.bin".to_string())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    Ok(Json(json!({
        "source": source,
        "size": size,
        "sha256": sha,
        "ota": result,
    })))
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

// One shared client for the whole discovery sweep: building a reqwest Client
// per address was a large part of the old ~7 s scan time.
fn scan_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(SCAN_CONNECT_TIMEOUT)
        .timeout(SCAN_PROBE_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn probe_fluidnc(client: &reqwest::Client, ip: Ipv4Addr) -> Option<Value> {
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

async fn scan_subnet(client: reqwest::Client, local: Ipv4Addr) -> Vec<Value> {
    let octets = local.octets();
    let sem = Arc::new(tokio::sync::Semaphore::new(SCAN_CONCURRENCY));
    let mut set = tokio::task::JoinSet::new();
    for host in 1u8..=254 {
        if host == octets[3] {
            continue;
        }
        let ip = Ipv4Addr::new(octets[0], octets[1], octets[2], host);
        let sem = sem.clone();
        let client = client.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.ok()?;
            probe_fluidnc(&client, ip).await
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
    let client = scan_client();
    let mut scanned = Vec::new();
    let mut devices = Vec::new();
    for local in &candidates {
        scanned.push(format!(
            "{}.{}.{}.0/24",
            local.octets()[0],
            local.octets()[1],
            local.octets()[2]
        ));
        // Subnets are tried in priority order (default-route LAN first) and
        // the sweep stops as soon as a device is found.
        devices = scan_subnet(client.clone(), *local).await;
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
    let tag = req.tag.trim().to_string();
    if !is_version_tag(&tag) {
        return Err(err("版本 tag 格式无效"));
    }
    let variant = req.variant.unwrap_or_else(|| "default".to_string());
    if variant_is_4mb(&variant) {
        return Err(err(format!(
            "{} 是 4 MB 单 app 分区版本，不能网络 OTA；请使用串口或 Web Serial 烧录 USB factory 镜像",
            variant
        )));
    }
    let zip_name = release_zip_name(&tag, &variant);
    let zip_url = format!(
        "https://github.com/{GITHUB_REPO}/releases/download/{tag}/{zip_name}"
    );
    // can-v0.2.16+ publishes only structured per-variant zips.  Fall back to
    // the old loose app image for older tags.
    let (source, image) = match download_release_bytes(&zip_url, 180).await {
        Ok(zip) => extract_ota_image(&zip, &zip_name).map_err(err)?,
        Err(zip_err) => {
            let old_asset = ota_asset_name(&variant);
            let old_url = format!(
                "https://github.com/{GITHUB_REPO}/releases/download/{tag}/{old_asset}"
            );
            match download_release_bytes(&old_url, 180).await {
                Ok(data) => (old_asset, data),
                Err(old_err) => {
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        Json(ApiError {
                            error: format!(
                                "下载 OTA 包失败：结构化 zip（{zip_name}）: {zip_err}；旧格式（{old_asset}）: {old_err}"
                            ),
                        }),
                    ))
                }
            }
        }
    };
    let size = image.len();
    let sha = sha256_hex(&image);
    let result = upload_firmware(&st, image, "firmware.bin".to_string())
        .await
        .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?;
    Ok(Json(json!({
        "version": tag.trim_start_matches("can-v"),
        "tag": tag,
        "variant": variant,
        "asset": zip_name,
        "source": source,
        "size": size,
        "sha256": sha,
        "ota": result,
    })))
}

fn tool_base_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FLUIDCAN_TOOL_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("FluidCAN Studio").join("tools");
            }
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            return PathBuf::from(home).join(".local/share/fluidcan-studio/tools");
        }
    }
    std::env::temp_dir().join("fluidcan-studio-tools")
}

fn find_tool_binary(root: &Path) -> Option<PathBuf> {
    let wanted = if cfg!(target_os = "windows") { "esptool.exe" } else { "esptool" };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(wanted) {
                return Some(path);
            }
        }
    }
    None
}

fn extract_esptool_archive(archive: &Path, target: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(target).map_err(|e| format!("创建工具目录失败: {e}"))?;
    let name = archive.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.ends_with(".zip") {
        let file = std::fs::File::open(archive).map_err(|e| format!("打开 zip 失败: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败: {e}"))?;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| format!("读取 zip 条目失败: {e}"))?;
            let Some(rel) = entry.enclosed_name() else {
                continue;
            };
            let out = target.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败: {e}"))?;
            } else {
                if let Some(parent) = out.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
                }
                let mut f = std::fs::File::create(&out).map_err(|e| format!("写入文件失败: {e}"))?;
                std::io::copy(&mut entry, &mut f).map_err(|e| format!("解压写入失败: {e}"))?;
            }
        }
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        let file = std::fs::File::open(archive).map_err(|e| format!("打开 tar.gz 失败: {e}"))?;
        let decoder = flate2::read::GzDecoder::new(file);
        let mut tar = tar::Archive::new(decoder);
        tar.unpack(target).map_err(|e| format!("解压 tar.gz 失败: {e}"))?;
    } else {
        return Err(format!("不支持的 esptool 归档格式: {name}"));
    }
    find_tool_binary(target).ok_or_else(|| "解压后找不到 esptool 可执行文件".to_string())
}

async fn ensure_official_esptool(st: &AppState) -> Result<Option<PathBuf>, String> {
    if !BUILD_ESPTOOL_SUPPORTED || BUILD_ESPTOOL_PLATFORM_URL.is_empty() {
        return Ok(None);
    }
    let _guard = st.tool_lock.lock().await;
    let base = tool_base_dir();
    let cache = base.join(format!("esptool-{}-{}", BUILD_ESPTOOL_VERSION, BUILD_ESPTOOL_ASSET));
    if let Some(tool) = find_tool_binary(&cache) {
        return Ok(Some(tool));
    }
    std::fs::create_dir_all(&cache).map_err(|e| format!("创建工具缓存失败: {e}"))?;
    let archive = cache.join(if BUILD_ESPTOOL_ASSET.ends_with(".zip") { "esptool.zip" } else { "esptool.tar.gz" });
    let bytes = reqwest::Client::new()
        .get(BUILD_ESPTOOL_PLATFORM_URL)
        .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("下载官方 esptool 失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载官方 esptool HTTP 错误: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("读取官方 esptool 失败: {e}"))?
        .to_vec();
    if !BUILD_ESPTOOL_SHA256.is_empty() {
        let mut h = Sha256::new();
        h.update(&bytes);
        let actual = hex::encode(h.finalize());
        if actual != BUILD_ESPTOOL_SHA256 {
            return Err("官方 esptool 下载校验失败".to_string());
        }
    }
    std::fs::write(&archive, &bytes).map_err(|e| format!("保存官方 esptool 失败: {e}"))?;
    let target = cache.clone();
    let tool = tokio::task::spawn_blocking(move || extract_esptool_archive(&archive, &target))
        .await
        .map_err(|e| format!("解压任务失败: {e}"))??;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(&tool) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = std::fs::set_permissions(&tool, perms);
        }
    }
    Ok(Some(tool))
}

async fn run_esptool_flash(
    st: &AppState,
    port: &str,
    baud: u32,
    firmware: &Path,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let official = ensure_official_esptool(st).await;
    let mut official_tool = None;
    let mut cmd = match official {
        Ok(Some(tool)) => {
            official_tool = Some(tool.clone());
            std::process::Command::new(tool)
        }
        Ok(None) | Err(_) => {
            let py = std::env::var("FLUIDCAN_PYTHON").unwrap_or_else(|_| "python".to_string());
            let mut c = std::process::Command::new(py);
            c.arg("-m").arg("esptool");
            c
        }
    };
    cmd.args([
        "--chip",
        "esp32s3",
        "--port",
        port,
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
    cmd.arg(firmware);
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
        "firmware": firmware.to_string_lossy(),
        "official_esptool": official_tool.as_ref().map(|p| p.to_string_lossy().to_string()),
    })))
}

/// Extract the factory image from a local upload (.bin or .zip with a
/// standard-named factory file) for the backend esptool serial flasher.
fn factory_image_from_upload(data: &[u8], uploaded_name: &str) -> Result<(String, Vec<u8>), String> {
    if data.is_empty() {
        return Err("固件文件为空".to_string());
    }
    if data.len() > MAX_WEB_FLASH_BYTES {
        return Err("固件文件超过 32 MB 限制".to_string());
    }
    let is_zip = uploaded_name.to_ascii_lowercase().ends_with(".zip") || data.starts_with(b"PK\x03\x04");
    if !is_zip {
        let base = web_flash_base_name(uploaded_name);
        let lower = base.to_ascii_lowercase();
        if lower != "firmware.factory.bin" && lower != "factory.bin" {
            return Err(format!(
                "串口 esptool 烧录需要 factory 镜像（firmware.factory.bin / factory.bin），当前文件名: {base}"
            ));
        }
        return Ok((base, data.to_vec()));
    }
    let cursor = std::io::Cursor::new(data);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let base = web_flash_base_name(entry.name());
        let lower = base.to_ascii_lowercase();
        if lower == "firmware.factory.bin" || lower == "factory.bin" {
            if entry.size() as usize > MAX_WEB_FLASH_BYTES {
                return Err("factory 镜像超过 32 MB 限制".to_string());
            }
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes)
                .map_err(|e| format!("解压 {base} 失败: {e}"))?;
            if bytes.is_empty() || bytes.len() > MAX_WEB_FLASH_BYTES {
                return Err("factory 镜像大小无效".to_string());
            }
            return Ok((base, bytes));
        }
    }
    Err("zip 中没有 firmware.factory.bin（串口 esptool 烧录需要 factory 镜像）".to_string())
}

async fn flash_serial(
    State(st): State<Arc<AppState>>,
    Json(req): Json<FlashReq>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let Some(path) = req.firmware else {
        return Err(err("内置固件已移除：请上传本地固件，或使用 Web Serial 烧录"));
    };
    let firmware = PathBuf::from(path);
    if !firmware.is_file() {
        return Err(err(format!("固件不存在: {}", firmware.display())));
    }
    run_esptool_flash(&st, &req.port, req.baud.unwrap_or(460800), &firmware).await
}

async fn flash_local(
    State(st): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let mut data: Option<Vec<u8>> = None;
    let mut name = String::from("firmware.factory.bin");
    let mut port = String::new();
    let mut baud = 460800u32;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(format!("解析上传失败: {e}")))?
    {
        let field_name = field.name().unwrap_or("").to_string();
        if field_name == "port" {
            port = field
                .text()
                .await
                .map_err(|e| err(format!("读取串口字段失败: {e}")))?
                .trim()
                .to_string();
            continue;
        }
        if field_name == "baud" {
            if let Ok(text) = field.text().await {
                baud = text.trim().parse().unwrap_or(460800);
            }
            continue;
        }
        if let Some(file_name) = field.file_name() {
            if !file_name.is_empty() {
                name = file_name.to_string();
            }
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| err(format!("读取上传失败: {e}")))?;
        if bytes.len() > MAX_WEB_FLASH_BYTES {
            return Err(err("固件文件超过 32 MB 限制"));
        }
        data = Some(bytes.to_vec());
    }
    let data = data.ok_or_else(|| err("没有收到固件文件"))?;
    if port.trim().is_empty() {
        return Err(err("缺少串口端口"));
    }
    let (factory_name, factory) = factory_image_from_upload(&data, &name).map_err(err)?;
    let token = web_flash_token();
    let path = std::env::temp_dir().join(format!("fluidcan-flashlocal-{token}.bin"));
    std::fs::write(&path, &factory).map_err(|e| err(format!("写入临时固件失败: {e}")))?;
    let result = run_esptool_flash(&st, port.trim(), baud, &path).await;
    let _ = std::fs::remove_file(&path);
    let Json(mut value) = result?;
    value["firmware"] = json!(factory_name);
    Ok(Json(value))
}

// ---------------------------------------------------------------------------
// Local firmware packages for the in-app Web Serial flasher.
//
// Studio no longer bundles firmware.  The user supplies either a .zip archive
// containing standard-named files or a single standard-named .bin, then picks
// which partitions to flash.  Standard names / ESP32-S3 offsets:
//   firmware.factory.bin / factory.bin  -> 0x0    (whole factory image)
//   bootloader.bin                      -> 0x0
//   partitions.bin                      -> 0x8000
//   boot_app0.bin                       -> 0xE000
//   firmware.bin / app.bin              -> 0x10000
// ---------------------------------------------------------------------------

const WEB_FLASH_STANDARD_NAMES: &[(&str, &str, u32)] = &[
    ("firmware.factory.bin", "整片 factory（0x0）", 0x0),
    ("factory.bin", "整片 factory（0x0）", 0x0),
    ("bootloader.bin", "bootloader（0x0）", 0x0),
    ("partitions.bin", "分区表（0x8000）", 0x8000),
    ("boot_app0.bin", "boot_app0（0xE000）", 0xE000),
    ("firmware.bin", "应用 firmware（0x10000）", 0x10000),
    ("app.bin", "应用 firmware（0x10000）", 0x10000),
];

#[derive(Clone, Serialize, Deserialize)]
struct WebFlashPart {
    name: String,
    label: String,
    offset: u32,
    size: u64,
}

#[derive(Serialize, Deserialize)]
struct WebFlashPackage {
    kind: String,
    parts: Vec<WebFlashPart>,
    defaults: Vec<String>,
    warnings: Vec<String>,
}

fn web_flash_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut h = Sha256::new();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    h.update(nanos.to_le_bytes());
    h.update(std::process::id().to_le_bytes());
    h.update(COUNTER.fetch_add(1, Ordering::Relaxed).to_le_bytes());
    hex::encode(h.finalize())[..32].to_string()
}

fn web_flash_base_name(name: &str) -> String {
    Path::new(name)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(name)
        .to_string()
}

fn web_flash_recognize(name: &str) -> Option<(String, String, u32)> {
    let base = web_flash_base_name(name).to_ascii_lowercase();
    WEB_FLASH_STANDARD_NAMES
        .iter()
        .find(|(standard, _, _)| *standard == base)
        .map(|(standard, label, offset)| (standard.to_string(), label.to_string(), *offset))
}

fn web_flash_package_dir(token: &str) -> Result<PathBuf, String> {
    let token = token.trim();
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("本地固件令牌无效".to_string());
    }
    let dir = std::env::temp_dir().join(format!("fluidcan-webflash-local-{token}"));
    if !dir.is_dir() {
        return Err("本地固件已失效，请重新上传".to_string());
    }
    Ok(dir)
}

fn read_web_flash_package(token: &str) -> Result<WebFlashPackage, String> {
    let dir = web_flash_package_dir(token)?;
    let text = std::fs::read_to_string(dir.join("parts.json"))
        .map_err(|e| format!("读取本地固件元数据失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("解析本地固件元数据失败: {e}"))
}

fn cleanup_old_web_flash_uploads() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with("fluidcan-webflash-local-") {
            continue;
        }
        let expired = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age.as_secs() > 2 * 3600)
            .unwrap_or(true);
        if expired {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

struct CollectedWebFlash {
    kind: String,
    parts: Vec<WebFlashPart>,
    defaults: Vec<String>,
    warnings: Vec<String>,
    files: Vec<(String, Vec<u8>)>,
}

fn collect_web_flash_parts(data: &[u8], uploaded_name: &str) -> Result<CollectedWebFlash, String> {
    if data.is_empty() {
        return Err("固件文件为空".to_string());
    }
    if data.len() > MAX_WEB_FLASH_BYTES {
        return Err("固件文件超过 32 MB 限制".to_string());
    }
    let is_zip = uploaded_name.to_ascii_lowercase().ends_with(".zip") || data.starts_with(b"PK\x03\x04");
    let mut parts: Vec<WebFlashPart> = Vec::new();
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut ignored: Vec<String> = Vec::new();

    if is_zip {
        let cursor = std::io::Cursor::new(data);
        let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("读取 zip 失败: {e}"))?;
        let mut total = 0usize;
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|e| format!("读取 zip 条目失败: {e}"))?;
            if entry.is_dir() {
                continue;
            }
            let base = web_flash_base_name(entry.name());
            let Some((name, label, offset)) = web_flash_recognize(&base) else {
                ignored.push(base);
                continue;
            };
            if entry.size() as usize > MAX_WEB_FLASH_BYTES {
                return Err(format!("{name} 超过 32 MB 限制"));
            }
            let mut bytes = Vec::new();
            std::io::Read::read_to_end(&mut entry, &mut bytes)
                .map_err(|e| format!("解压 {name} 失败: {e}"))?;
            if bytes.is_empty() || bytes.len() > MAX_WEB_FLASH_BYTES {
                return Err(format!("{name} 大小无效"));
            }
            total += bytes.len();
            if total > MAX_WEB_FLASH_BYTES {
                return Err("固件包解压后超过 32 MB 限制".to_string());
            }
            if parts.iter().any(|part| part.name == name) {
                warnings.push(format!("zip 中 {name} 重复，已忽略后一个"));
                continue;
            }
            parts.push(WebFlashPart {
                name: name.clone(),
                label,
                offset,
                size: bytes.len() as u64,
            });
            files.push((name, bytes));
        }
        if parts.is_empty() {
            let hint = if ignored.is_empty() {
                String::new()
            } else {
                format!("；未识别的文件: {}", ignored.join(", "))
            };
            return Err(format!(
                "zip 中没有标准命名的固件文件（firmware.factory.bin / bootloader.bin / partitions.bin / boot_app0.bin / firmware.bin）{hint}"
            ));
        }
    } else {
        let base = web_flash_base_name(uploaded_name);
        let Some((name, label, offset)) = web_flash_recognize(&base) else {
            return Err(format!(
                "文件名 {base} 不符合标准命名（firmware.factory.bin / bootloader.bin / partitions.bin / boot_app0.bin / firmware.bin / app.bin）"
            ));
        };
        parts.push(WebFlashPart {
            name: name.clone(),
            label,
            offset,
            size: data.len() as u64,
        });
        files.push((name, data.to_vec()));
    }

    let factory_name = parts
        .iter()
        .find(|part| part.name == "firmware.factory.bin" || part.name == "factory.bin")
        .map(|part| part.name.clone());
    let defaults: Vec<String> = match factory_name {
        Some(name) => vec![name],
        None => parts.iter().map(|part| part.name.clone()).collect(),
    };
    if defaults.first().map(|name| name == "firmware.factory.bin" || name == "factory.bin") != Some(true) {
        let has_boot = parts.iter().any(|part| part.name == "bootloader.bin");
        let has_partitions = parts.iter().any(|part| part.name == "partitions.bin");
        let has_app = parts.iter().any(|part| part.name == "firmware.bin" || part.name == "app.bin");
        if !(has_boot && has_partitions && has_app) {
            warnings.push(
                "未包含 firmware.factory.bin，且分区组件不完整；只选择部分分区烧录时请确认偏移与设备匹配"
                    .to_string(),
            );
        }
    }

    Ok(CollectedWebFlash {
        kind: if is_zip { "zip".to_string() } else { "bin".to_string() },
        parts,
        defaults,
        warnings,
        files,
    })
}

async fn install_web_upload(
    State(_st): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let mut data: Option<Vec<u8>> = None;
    let mut name = String::from("firmware.factory.bin");
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| err(format!("解析上传失败: {e}")))?
    {
        if let Some(file_name) = field.file_name() {
            if !file_name.is_empty() {
                name = file_name.to_string();
            }
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| err(format!("读取上传失败: {e}")))?;
        if bytes.len() > MAX_WEB_FLASH_BYTES {
            return Err(err("固件文件超过 32 MB 限制"));
        }
        data = Some(bytes.to_vec());
        break;
    }
    let data = data.ok_or_else(|| err("没有收到固件文件"))?;
    cleanup_old_web_flash_uploads();
    let collected = collect_web_flash_parts(&data, &name).map_err(err)?;
    let token = web_flash_token();
    let dir = std::env::temp_dir().join(format!("fluidcan-webflash-local-{token}"));
    std::fs::create_dir_all(&dir).map_err(|e| err(format!("创建本地固件目录失败: {e}")))?;
    for (file_name, bytes) in &collected.files {
        std::fs::write(dir.join(file_name), bytes)
            .map_err(|e| err(format!("保存 {file_name} 失败: {e}")))?;
    }
    let package = WebFlashPackage {
        kind: collected.kind.clone(),
        parts: collected.parts.clone(),
        defaults: collected.defaults.clone(),
        warnings: collected.warnings.clone(),
    };
    std::fs::write(
        dir.join("parts.json"),
        serde_json::to_vec(&package).map_err(|e| err(format!("写入本地固件元数据失败: {e}")))?,
    )
    .map_err(|e| err(format!("写入本地固件元数据失败: {e}")))?;
    Ok(Json(json!({
        "ok": true,
        "token": token,
        "kind": collected.kind,
        "parts": collected.parts,
        "defaults": collected.defaults,
        "warnings": collected.warnings,
    })))
}

fn web_flash_manifest_parts(name: &str, version: &str, parts: Vec<Value>) -> Value {
    json!({
        "name": name,
        "version": version,
        "builds": [{
            "chipFamily": "ESP32-S3",
            "parts": parts,
        }],
    })
}

fn web_flash_asset_name(variant: &str) -> Result<String, String> {
    let variant = variant.trim();
    if variant.is_empty() || variant == "default" {
        return Ok("firmware.factory.bin".to_string());
    }
    if !WEB_FLASH_VARIANTS.contains(&variant) {
        return Err(format!(
            "Web Serial 烧录不支持变体 {variant}：该变体没有 factory 镜像，请使用网络 OTA 或选择 4 MB 变体"
        ));
    }
    Ok(format!("{variant}-firmware.factory.bin"))
}

fn web_flash_asset_allowed(asset: &str) -> bool {
    asset == "firmware.factory.bin"
        || WEB_FLASH_VARIANTS
            .iter()
            .any(|variant| asset == format!("{variant}-firmware.factory.bin"))
}

async fn web_flash_remote_factory(
    st: &AppState,
    tag: &str,
    variant: &str,
    asset: &str,
) -> Result<Vec<u8>, String> {
    let cache = std::env::temp_dir().join(format!("fluidcan-webflash-{tag}-{asset}"));
    if let Ok(meta) = std::fs::metadata(&cache) {
        if meta.is_file() && meta.len() > 0 && meta.len() as usize <= MAX_WEB_FLASH_BYTES {
            if let Ok(data) = std::fs::read(&cache) {
                return Ok(data);
            }
        }
    }
    // Releases <= 0.2.15 had loose *-firmware.factory.bin assets.
    let direct_url = format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/{asset}");
    let direct = async {
        let resp = st
            .client
            .get(&direct_url)
            .header(reqwest::header::USER_AGENT, "FluidCAN-Studio")
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("旧版直接镜像下载失败: {e}"))?;
        let status = resp.status();
        let data = resp
            .bytes()
            .await
            .map_err(|e| format!("读取旧版直接镜像失败: {e}"))?
            .to_vec();
        if !status.is_success() || data.is_empty() {
            return Err(format!("旧版直接镜像 HTTP {status}"));
        }
        Ok(data)
    }
    .await;
    match direct {
        Ok(data) => {
            if data.len() > MAX_WEB_FLASH_BYTES {
                return Err("factory 镜像超过 32 MB 限制".to_string());
            }
            let _ = std::fs::write(&cache, &data);
            Ok(data)
        }
        Err(direct_err) => {
            // can-v0.2.16+ only publishes structured per-variant zips.
            let zip_name = release_zip_name(tag, variant);
            let zip_url =
                format!("https://github.com/{GITHUB_REPO}/releases/download/{tag}/{zip_name}");
            let zip = download_release_bytes(&zip_url, 180)
                .await
                .map_err(|zip_err| format!("{direct_err}; 新版 zip 下载失败: {zip_err}"))?;
            let (_path, factory) = extract_usb_factory(&zip)?
                .ok_or_else(|| format!("{zip_name} 中没有 USB/firmware.factory.bin"))?;
            if factory.len() > MAX_WEB_FLASH_BYTES {
                return Err("factory 镜像超过 32 MB 限制".to_string());
            }
            let _ = std::fs::write(&cache, &factory);
            Ok(factory)
        }
    }
}

async fn install_web_manifest(
    State(_st): State<Arc<AppState>>,
    Query(query): Query<WebFlashQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let source = query.source.unwrap_or_else(|| "local".to_string());
    match source.as_str() {
        "remote" => {
            let tag = query.tag.ok_or_else(|| err("缺少版本 tag"))?;
            if !is_version_tag(&tag) {
                return Err(err("版本 tag 格式无效"));
            }
            let variant = query.variant.unwrap_or_else(|| "default".to_string());
            let asset = web_flash_asset_name(&variant).map_err(err)?;
            let image_path = format!(
                "{WEB_FLASH_IMAGE_PATH}?source=remote&tag={tag}&asset={asset}&variant={variant}"
            );
            Ok(Json(web_flash_manifest_parts(
                "FluidCAN",
                &format!("{tag} / {variant}"),
                vec![json!({"path": image_path, "offset": 0})],
            )))
        }
        "local" => {
            let token = query.token.unwrap_or_default();
            let package = read_web_flash_package(&token).map_err(err)?;
            let requested: Vec<String> = match query.parts.as_deref() {
                // An explicitly empty ?parts= is an error; only a missing
                // parameter falls back to the package defaults.
                Some(text) => text
                    .split(',')
                    .map(|part| part.trim().to_string())
                    .filter(|part| !part.is_empty())
                    .collect(),
                None => package.defaults.clone(),
            };
            if requested.is_empty() {
                return Err(err("没有选择要烧录的分区"));
            }
            let mut parts = Vec::new();
            for name in &requested {
                let Some(part) = package.parts.iter().find(|part| &part.name == name) else {
                    return Err(err(format!("固件包中没有分区 {name}")));
                };
                let image_path =
                    format!("{WEB_FLASH_IMAGE_PATH}?source=local&token={token}&name={name}");
                parts.push(json!({"path": image_path, "offset": part.offset}));
            }
            Ok(Json(web_flash_manifest_parts(
                "FluidCAN",
                &format!("本地固件（{}）", requested.join(", ")),
                parts,
            )))
        }
        _ => Err(err("未知的固件来源（内置固件已移除，请选择本地固件包）")),
    }
}

async fn install_web_image(
    State(st): State<Arc<AppState>>,
    Query(query): Query<WebFlashQuery>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let source = query.source.unwrap_or_else(|| "local".to_string());
    let data = match source.as_str() {
        "remote" => {
            let tag = query.tag.ok_or_else(|| err("缺少版本 tag"))?;
            if !is_version_tag(&tag) {
                return Err(err("版本 tag 格式无效"));
            }
            let asset = query.asset.ok_or_else(|| err("缺少镜像 asset"))?;
            if !web_flash_asset_allowed(&asset) {
                return Err(err("镜像 asset 不在允许列表中"));
            }
            let variant = query.variant.unwrap_or_else(|| "default".to_string());
            web_flash_remote_factory(&st, &tag, &variant, &asset)
                .await
                .map_err(|e| (StatusCode::BAD_GATEWAY, Json(ApiError { error: e })))?
        }
        "local" => {
            let token = query.token.unwrap_or_default();
            let name = query.name.ok_or_else(|| err("缺少分区文件名"))?;
            let package = read_web_flash_package(&token).map_err(err)?;
            if !package.parts.iter().any(|part| part.name == name) {
                return Err(err("固件包中没有该分区文件"));
            }
            let dir = web_flash_package_dir(&token).map_err(err)?;
            std::fs::read(dir.join(&name))
                .map_err(|e| err(format!("读取本地分区固件失败: {e}")))?
        }
        _ => return Err(err("未知的固件来源（内置固件已移除，请选择本地固件包）")),
    };
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        data,
    )
        .into_response())
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
        tool_lock: Arc::new(tokio::sync::Mutex::new(())),
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
        .route("/toolchain/install", post(install_toolchain))
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
        .route("/install/ota", post(ota_update))
        .route("/install/flash", post(flash_serial))
        .route("/install/flash-local", post(flash_local))
        .route("/install/web/manifest", get(install_web_manifest))
        .route("/install/web/image", get(install_web_image))
        .route("/install/web/upload", post(install_web_upload))
        .route("/scan", get(scan_devices))
        .route("/updates", get(remote_releases))
        .route("/ota/remote", post(remote_ota))
        // The in-app Web Serial flasher uploads a .bin for the browser to
        // download, so allow larger request bodies than the axum default.
        .layer(DefaultBodyLimit::max(MAX_WEB_FLASH_BYTES + 1024 * 1024));

    Router::new()
        .nest("/api", api)
        .route("/", get(index))
        .route("/index.html", get(index))
        .route("/js/{*path}", get(ui_js))
        .route("/css/{*path}", get(ui_css))
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


