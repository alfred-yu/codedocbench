// Web Worker：在低层需求 Excel 解析期间把 CPU 密集的 XLSX.read 移到后台线程，
// 避免 2 万行级别大文件冻结主线程（P2 修复核心）。
// 输入：{ bytes: Uint8Array | ArrayBuffer, msgId }
// 输出：{ ok: true, msgId, rows } 或 { ok: false, msgId, error }
import * as XLSX from "xlsx-js-style";

self.onmessage = (e) => {
  const { bytes, msgId } = e.data || {};
  try {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const wb = XLSX.read(data, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    self.postMessage({ ok: true, msgId, rows });
  } catch (err) {
    self.postMessage({
      ok: false,
      msgId,
      error: err && err.message ? err.message : String(err),
    });
  }
};
