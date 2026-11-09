use serde_json::Value;
use std::path::PathBuf;

const ESPTOOL_FALLBACK: &str = "v5.6.0";
const IDF_FALLBACK: &str = "v6.0";
const ESPTOOL_FALLBACK_VERSIONS: &[&str] =
    &["v5.6.0", "v5.4.0", "v5.3.1", "v5.2.1", "v4.13.0"];
const IDF_FALLBACK_VERSIONS: &[&str] =
    &["v6.0", "v5.5.6", "v5.4.3", "v5.3.4", "v5.2.5"];
fn platform_asset_suffix(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("windows-amd64.zip"),
        ("linux", "x86_64") => Some("linux-amd64.tar.gz"),
        ("linux", "aarch64") => Some("linux-aarch64.tar.gz"),
        ("linux", "arm") => Some("linux-armv7.tar.gz"),
        ("macos", "x86_64") => Some("macos-amd64.tar.gz"),
        ("macos", "aarch64") => Some("macos-arm64.tar.gz"),
        // Android/Tauri mobile has no standalone desktop esptool binary.
        _ => None,
    }
}

fn fetch_json(url: &str) -> Option<Value> {
    let mut request = ureq::get(url)
        .set("User-Agent", "FluidCAN-Studio-build")
        .set("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(12));
    if let Ok(token) = std::env::var("GITHUB_TOKEN") {
        if !token.is_empty() {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
    }
    let response = request.call().ok()?;
    serde_json::from_str(&response.into_string().ok()?).ok()
}

fn latest_tag(repo: &str) -> Option<String> {
    fetch_json(&format!("https://api.github.com/repos/{repo}/releases/latest"))?
        .get("tag_name")?
        .as_str()
        .map(str::to_string)
}

fn release_tags(url: &str) -> Vec<String> {
    let Some(Value::Array(items)) = fetch_json(url) else {
        return Vec::new();
    };
    items
        .into_iter()
        .filter_map(|r| r.get("tag_name")?.as_str().map(str::to_string))
        .collect()
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");

    let mut esptool_versions = release_tags(
        "https://api.github.com/repos/espressif/esptool/releases?per_page=12",
    );
    if esptool_versions.is_empty() {
        esptool_versions.extend(ESPTOOL_FALLBACK_VERSIONS.iter().map(|s| s.to_string()));
    }

    let mut idf_versions = release_tags(
        "https://api.github.com/repos/espressif/esp-idf/releases?per_page=12",
    );
    if idf_versions.is_empty() {
        idf_versions.extend(IDF_FALLBACK_VERSIONS.iter().map(|s| s.to_string()));
    }

    let esptool_latest = latest_tag("espressif/esptool")
        .or_else(|| esptool_versions.first().cloned())
        .unwrap_or_else(|| ESPTOOL_FALLBACK.to_string());
    let idf_latest = latest_tag("espressif/esp-idf")
        .or_else(|| idf_versions.first().cloned())
        .unwrap_or_else(|| IDF_FALLBACK.to_string());

    // Select the official standalone esptool build for the OS/arch being
    // compiled.  The version list itself is platform-independent.
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let platform_asset = platform_asset_suffix(&target_os, &target_arch);
    let mut esptool_platform_asset = platform_asset.unwrap_or("").to_string();
    let mut esptool_platform_digest = String::new();
    let mut esptool_platform_url = platform_asset
        .map(|suffix| {
            format!(
                "https://github.com/espressif/esptool/releases/download/{esptool_latest}/esptool-{esptool_latest}-{suffix}"
            )
        })
        .unwrap_or_default();

    let release_url = format!(
        "https://api.github.com/repos/espressif/esptool/releases/tags/{esptool_latest}"
    );
    if let Some(release) = fetch_json(&release_url) {
        if let Some(assets) = release.get("assets").and_then(Value::as_array) {
            if let Some(asset) = assets.iter().find(|a| {
                a.get("name")
                    .and_then(Value::as_str)
                    .map(|n| platform_asset.map(|suffix| n.ends_with(suffix)).unwrap_or(false))
                    .unwrap_or(false)
            }) {
                if let Some(name) = asset.get("name").and_then(Value::as_str) {
                    esptool_platform_asset = name.to_string();
                }
                if let Some(url) = asset.get("browser_download_url").and_then(Value::as_str) {
                    esptool_platform_url = url.to_string();
                }
                if let Some(digest) = asset.get("digest").and_then(Value::as_str) {
                    esptool_platform_digest = digest.trim_start_matches("sha256:").to_string();
                }
            }
        }
    }

    let vec_literal = |items: &[String]| {
        items
            .iter()
            .map(|s| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let generated = format!(
        "// Generated at build time from official Espressif release metadata.\n\
         pub const BUILD_ESPTOOL_VERSION: &str = \"{esptool_latest}\";\n\
         pub const BUILD_ESP_IDF_VERSION: &str = \"{idf_latest}\";\n\
         pub const BUILD_ESPTOOL_PLATFORM: &str = \"{target_os}/{target_arch}\";\n\
         pub const BUILD_ESPTOOL_ASSET: &str = \"{esptool_platform_asset}\";\n\
         pub const BUILD_ESPTOOL_PLATFORM_URL: &str = \"{esptool_platform_url}\";\n\
         pub const BUILD_ESPTOOL_SHA256: &str = \"{esptool_platform_digest}\";\n\
         pub const BUILD_ESPTOOL_SUPPORTED: bool = {esptool_supported};\n\
         pub const BUILD_ESPTOOL_VERSIONS: &[&str] = &[{esptool_versions}];\n\
         pub const BUILD_ESP_IDF_VERSIONS: &[&str] = &[{idf_versions}];\n",
        esptool_supported = platform_asset.is_some(),
        esptool_versions = vec_literal(&esptool_versions),
        idf_versions = vec_literal(&idf_versions)
    );

    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("toolchain_versions.rs");
    std::fs::write(&out, generated).expect("write toolchain_versions.rs");
    println!("cargo:warning=official esptool={esptool_latest} esp-idf={idf_latest} platform={target_os}/{target_arch}");

    tauri_build::build()
}
