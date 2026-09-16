use std::process::Command;
use tauri::Manager;

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
fn scan_dir(path: String, app: tauri::AppHandle) -> serde_json::Value {
    run_backend("scan_dir", &path, &app)
}

/// 解析单个 C/C++ 源码文件，返回符号 JSON。
#[tauri::command]
fn parse_file(path: String, app: tauri::AppHandle) -> serde_json::Value {
    run_backend("parse_file", &path, &app)
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

/// 解析后端运行目标。
/// 优先使用随安装包分发的冻结可执行文件（PyInstaller 单文件，自带 Python 运行时，
/// 客户机无需预装 Python）；开发期若尚未冻结则回退到源码 `backend.py`（需开发机有 Python）。
enum BackendTarget {
    /// 冻结后的可执行文件，直接运行（客户机零 Python 依赖）
    Binary(std::path::PathBuf),
    /// 源码 backend.py，需 Python 解释器（仅开发回退）
    Source(std::path::PathBuf),
}

/// 以子进程方式调用解析后端并解析其 stdout JSON。
/// 任一环节失败都会返回 `{"type":"error","message":...}`，保证前端可读且不 panic。
fn run_backend(mode: &str, path: &str, app: &tauri::AppHandle) -> serde_json::Value {
    let target = match resolve_backend(app) {
        Ok(t) => t,
        Err(msg) => return err_json(&msg),
    };

    let output = match &target {
        BackendTarget::Binary(exe) => run_binary(exe, &[mode, path]),
        BackendTarget::Source(script) => {
            let python = find_python();
            run_source(&python, script, &[mode, path])
        }
    };
    let output = match output {
        Ok(o) => o,
        Err(msg) => return err_json(&msg),
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return err_json(&format!(
            "解析后端执行失败 ({})：{}",
            output.status,
            stderr.trim()
        ));
    }
    match serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        Ok(v) => v,
        Err(e) => err_json(&format!("解析后端输出失败: {e}")),
    }
}

/// 运行时解析解析后端。
/// 优先顺序（任一命中即可，覆盖各平台发布形态）：
///   1. exe 同级 `backend_bin/backend[.exe]`（主发布路径：安装包把冻结程序放到了 exe 旁）
///   2. exe 同级 `resources/backend_bin/backend[.exe]`（Tauri 把资源落到了 <exe_dir>/resources 的情况）
///   3. `resource_dir()/backend_bin/backend[.exe]`（Tauri 官方资源目录，跨平台正确落点）
///   4. 开发回退：项目根 `python/backend.py`（需 Python，仅开发机可用，免频繁重冻）
/// 全部找不到时返回可读错误，列出全部候选路径，便于定位分发遗漏。
fn resolve_backend(app: &tauri::AppHandle) -> Result<BackendTarget, String> {
    let bin_name = if cfg!(target_os = "windows") {
        "backend.exe"
    } else {
        "backend"
    };
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        // 1) exe 同级
        candidates.push(dir.join("backend_bin").join(bin_name));
        // 2) exe 同级的 resources 子目录（部分打包形态）
        candidates.push(dir.join("resources").join("backend_bin").join(bin_name));
    }
    // 3) Tauri 官方资源目录（跨平台正确，优先级高于 dev 候选）
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("backend_bin").join(bin_name));
    }
    for c in &candidates {
        if c.is_file() {
            return Ok(BackendTarget::Binary(c.clone()));
        }
    }
    // 4) 开发期回退：源码 backend.py（开发机具备 Python 即可调试，无需先冻结）
    let project_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let dev_script = project_root.join("python").join("backend.py");
    if dev_script.is_file() {
        return Ok(BackendTarget::Source(dev_script));
    }
    Err(format!(
        "未找到解析后端。已尝试冻结程序：{}；开发回退：{}。发布前请执行 `npm run freeze:backend` 生成 backend_bin。",
        candidates
            .iter()
            .map(|c| c.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join("；"),
        dev_script.to_string_lossy()
    ))
}

/// 探测可用的 Python 解释器（仅开发回退到源码 backend.py 时使用）。
/// Windows 优先 `py`（Microsoft Store 启动器），其次 `python3`、`python`；
/// 非 Windows 优先 `python3`，其次 `python`。
fn find_python() -> String {
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &["py", "python3", "python"]
    } else {
        &["python3", "python"]
    };
    for name in candidates {
        if Command::new(name)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return name.to_string();
        }
    }
    // 全部探测失败则退回默认名，具体错误由 run_source 的 stderr 体现
    if cfg!(target_os = "windows") {
        "py".to_string()
    } else {
        "python3".to_string()
    }
}

/// 运行冻结后的单文件可执行后端（客户机零 Python 依赖）。
fn run_binary(exe: &std::path::Path, args: &[&str]) -> Result<std::process::Output, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // GUI 进程派生控制台子进程时 Windows 会新建控制台窗口，
        // CREATE_NO_WINDOW 避免解析期间反复闪过黑色控制台
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(exe.as_os_str())
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("无法启动解析后端: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(exe.as_os_str())
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .args(args)
            .output()
            .map_err(|e| format!("无法启动解析后端: {e}"))
    }
}

/// 运行源码 backend.py（仅开发回退，需 Python 解释器）。
fn run_source(
    python: &str,
    script: &std::path::Path,
    args: &[&str],
) -> Result<std::process::Output, String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        Command::new(python)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .arg(script.as_os_str())
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("无法启动 python: {e}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Command::new(python)
            .env("PYTHONUTF8", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .arg(script.as_os_str())
            .args(args)
            .output()
            .map_err(|e| format!("无法启动 python3: {e}"))
    }
}

fn err_json(msg: &str) -> serde_json::Value {
    serde_json::json!({ "type": "error", "message": msg })
}
