use std::process::Command;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
        scan_dir, parse_file, save_file, read_file, file_mtime
    ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 将字节数据写入指定路径（用于导出 Excel 等文件）。
#[tauri::command]
fn save_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, data).map_err(|e| format!("写入文件失败: {e}"))
}

/// 读取指定文件的字节内容（用于解析低层需求 Excel 等）。
#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读取文件失败: {e}"))
}

/// 扫描目录，返回嵌套目录树 JSON。
#[tauri::command]
fn scan_dir(path: String) -> serde_json::Value {
    run_backend("scan_dir", &path)
}

/// 解析单个 C/C++ 源码文件，返回符号 JSON。
#[tauri::command]
fn parse_file(path: String) -> serde_json::Value {
    run_backend("parse_file", &path)
}

/// 返回文件最后修改时间（毫秒时间戳），用于前端解析缓存失效判断。
#[tauri::command]
fn file_mtime(path: String) -> Result<u128, String> {
    std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("获取文件时间失败: {e}"))
        .and_then(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .map_err(|e| format!("时间转换失败: {e}"))
        })
}

/// 以子进程方式调用 Python 后端并解析其 stdout JSON。
/// 任一环节失败都会返回 `{"type":"error","message":...}`，保证前端可读且不 panic。
fn run_backend(mode: &str, path: &str) -> serde_json::Value {
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let script = project_root.join("python").join("backend.py");

    let output = match run_python(&script.to_string_lossy(), &[mode, path]) {
        Ok(out) => out,
        Err(msg) => return err_json(&msg),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return err_json(&format!(
            "Python 后端执行失败 ({})，请确认已安装 Python: {}",
            output.status,
            stderr.trim()
        ));
    }
    match serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        Ok(v) => v,
        Err(e) => err_json(&format!("解析 Python 输出失败: {e}")),
    }
}

#[cfg(target_os = "windows")]
fn run_python(script: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("python")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(script)
        .args(args)
        .output()
        .map_err(|e| format!("无法启动 python: {e}"))
}

#[cfg(not(target_os = "windows"))]
fn run_python(script: &str, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("python3")
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .arg(script)
        .args(args)
        .output()
        .map_err(|e| format!("无法启动 python3: {e}"))
}

fn err_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "type": "error", "message": msg })
}