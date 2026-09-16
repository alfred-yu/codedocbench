use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 预启动常驻 daemon（失败不阻断，首次调用时会懒启动）
            let _ = ensure_daemon(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_dir, parse_file, save_file, read_file, file_mtime
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app, event| {
        // 应用退出时回收 daemon 子进程，避免残留
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit { .. }
        ) {
            if let Some(cell) = DAEMON.get() {
                if let Ok(mut g) = cell.lock() {
                    if let Some(mut st) = g.take() {
                        let _ = st.child.kill();
                    }
                }
            }
        }
    });
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

/// 常驻 daemon 状态：连接地址、握手令牌、子进程句柄。
struct DaemonState {
    addr: String,
    token: String,
    child: std::process::Child,
}

/// 全局 daemon 状态（懒启动、跨命令线程共享）。
static DAEMON: OnceLock<Mutex<Option<DaemonState>>> = OnceLock::new();

/// 解析入口：优先走常驻 daemon（最快、内存可控），失败再 fallback 到单次子进程调用。
///
/// 任一环节失败都会返回 `{"type":"error","message":...}`，保证前端可读且不 panic。
fn run_backend(mode: &str, path: &str, app: &tauri::AppHandle) -> serde_json::Value {
    // 1) 优先常驻 daemon：一次进程启动，N 个文件复用，彻底消除进程风暴
    if let Some((addr, token)) = ensure_daemon(app) {
        if let Ok(v) = call_daemon(&addr, &token, mode, path) {
            return v;
        }
        // daemon 调用失败（崩溃/端口失效）则回退，保证可用性
    }
    // 2) fallback：单次子进程调用（原有逻辑，作为 daemon 不可用时的兜底）
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

/// 懒启动并获取 daemon 的 (地址, 令牌)。
/// 已启动且存活则直接复用；否则 spawn 新 daemon 并读取握手端口。
fn ensure_daemon(app: &tauri::AppHandle) -> Option<(String, String)> {
    let cell = DAEMON.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().ok()?;
    // 已存在且子进程仍存活
    if let Some(st) = guard.as_mut() {
        if st.child.try_wait().ok().flatten().is_none() {
            return Some((st.addr.clone(), st.token.clone()));
        }
        // 已死，清理后重建
        *guard = None;
    }
    match spawn_daemon(app) {
        Ok(st) => {
            let addr = st.addr.clone();
            let token = st.token.clone();
            *guard = Some(st);
            Some((addr, token))
        }
        Err(_) => None,
    }
}

/// 启动常驻 daemon 子进程，读取握手端口与令牌。
fn spawn_daemon(app: &tauri::AppHandle) -> Result<DaemonState, String> {
    let target = resolve_backend(app)?;
    let (program, args): (std::ffi::OsString, Vec<std::ffi::OsString>) = match &target {
        BackendTarget::Binary(exe) => (exe.as_os_str().to_os_string(), vec!["daemon".into()]),
        BackendTarget::Source(script) => {
            let python = find_python();
            (python.into(), vec![script.as_os_str().to_os_string(), "daemon".into()])
        }
    };

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut cmd = Command::new(program);
    cmd.env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdout(Stdio::piped()) // 首行握手：{"ready":true,"port":P,"token":T}
        .stderr(Stdio::null()); // daemon 日志不污染前端；解析错误经协议返回
    for a in &args {
        cmd.arg(a);
    }
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动解析后端 daemon 失败: {e}"))?;
    let stdout = child.stdout.take().ok_or("无法获取 daemon 标准输出")?;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("读取 daemon 握手失败: {e}"))?;
    let v: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("解析 daemon 握手失败: {e}"))?;
    if v.get("ready").and_then(|x| x.as_bool()) != Some(true) {
        let _ = child.kill();
        return Err(format!(
            "daemon 启动未就绪: {}",
            v.get("error")
                .and_then(|x| x.as_str())
                .unwrap_or("未知错误")
        ));
    }
    let port = v
        .get("port")
        .and_then(|x| x.as_u64())
        .ok_or("daemon 握手缺少 port")? as u16;
    let token = v
        .get("token")
        .and_then(|x| x.as_str())
        .ok_or("daemon 握手缺少 token")?
        .to_string();
    Ok(DaemonState {
        addr: format!("127.0.0.1:{port}"),
        token,
        child,
    })
}

/// 经 TCP 调用 daemon：发送令牌 + 请求，读取结果 JSON。
fn call_daemon(
    addr: &str,
    token: &str,
    mode: &str,
    path: &str,
) -> Result<serde_json::Value, String> {
    let mut stream = TcpStream::connect(addr).map_err(|e| format!("连接 daemon 失败: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(30)))
        .ok();
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .ok();
    // 1) 令牌校验行
    let tok_line = serde_json::json!({ "token": token }).to_string() + "\n";
    stream
        .write_all(tok_line.as_bytes())
        .map_err(|e| format!("发送令牌失败: {e}"))?;
    // 2) 请求行
    let req = serde_json::json!({ "mode": mode, "path": path }).to_string() + "\n";
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送请求失败: {e}"))?;
    stream.flush().ok();
    // 3) 读取响应行
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("读取 daemon 响应失败: {e}"))?;
    if line.trim().is_empty() {
        return Err("daemon 返回空响应（可能已崩溃）".to_string());
    }
    let v: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("解析 daemon 响应失败: {e}"))?;
    if let Some(err) = v.get("error") {
        return Err(err.as_str().unwrap_or("daemon error").to_string());
    }
    Ok(v
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
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
    // 候选「基目录」：exe 同级 backend_bin、exe 同级 resources/backend_bin、
    // Tauri 资源目录下的 backend_bin。每个基目录下优先匹配 onedir 布局
    // （backend_bin/backend/backend[.exe]，启动无需解压、最快），回退单文件
    // onefile（backend_bin/backend[.exe]，启动需解压、较慢）。
    let mut bases: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    {
        bases.push(dir.join("backend_bin"));
        bases.push(dir.join("resources").join("backend_bin"));
    }
    if let Ok(res) = app.path().resource_dir() {
        bases.push(res.join("backend_bin"));
    }
    for base in &bases {
        candidates.push(base.join("backend").join(bin_name)); // onedir：目录式，启动最快
        candidates.push(base.join(bin_name)); // onefile 兜底：需解压，较慢
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
