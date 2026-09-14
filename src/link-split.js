/* 链接文件分片
   —— 导入系统限定单个链接文件最多 50 行数据（表头不计入），超出必须切分成多个文件。
   本模块只做纯数据变换，不触碰 DOM 与 Tauri，便于 scripts/test-link-split.mjs 直接回归。 */

/** 单个链接文件允许的最大数据行数（不含表头两行） */
export const LINK_MAX_ROWS = 50;

/** 链接表字段名：链入与链出各 4 列，合计 8 列 */
export const LINK_FIELDS = ["项目名称", "模块名称", "模块路径", "ID"];

/** 分组表头跨列合并：链入 A1:D1、链出 E1:H1 */
export const LINK_MERGES = [
  { s: { r: 0, c: 0 }, e: { r: 0, c: 3 } },
  { s: { r: 0, c: 4 }, e: { r: 0, c: 7 } },
];

/** 列宽（字符单位） */
export const LINK_COL_WIDTHS = [22, 20, 34, 12, 22, 20, 34, 12];

/** 需要加粗的表头单元格（分组行 2 个 + 字段行 8 个） */
export const LINK_HEADER_CELLS = [
  "A1", "E1",
  "A2", "B2", "C2", "D2", "E2", "F2", "G2", "H2",
];

/**
 * 链入 ID 取值：只保留数值部分，去掉前缀。
 *
 * 规则：按 `_` 切分，取最后一个非空分段。
 * `DEMO_LL_R_123` 只是低层需求前缀的一种可能形态，故不硬编码任何前缀、
 * 也不假定尾部必须是数字——只依赖「最后一个 `_` 之后是数值部分」这一约定。
 *
 * - 字符串原样输出（不转数值类型），避免前导零丢失与超长 ID 精度问题；
 * - 不含 `_` 时整串即最后一段，原样返回（如 `N/A`、`6094`）；
 * - 尾部多余下划线被忽略（`R_007_` → `007`）；全是下划线时原样返回；
 * - 空值返回空串。
 * @param {*} id 原始需求 ID
 * @returns {string} 去掉前缀后的 ID
 */
export function stripIdPrefix(id) {
  const s = String(id == null ? "" : id).trim();
  if (!s) return "";
  const segs = s.split("_").filter((x) => x !== "");
  return segs.length ? segs[segs.length - 1] : s;
}

/**
 * 按 size 行切分数据行。严格按行数切：同一符号关联多条需求时，
 * 其各行允许落在相邻两片（分片后每行仍是独立链接记录，语义不变）。
 * @param {Array} rows 链接行 { outId, inId }
 * @param {number} size 每片最大数据行数
 * @returns {Array<Array>} 片数组；rows 为空时返回空数组
 */
export function splitLinkRows(rows, size = LINK_MAX_ROWS) {
  const n = Math.floor(size) > 0 ? Math.floor(size) : LINK_MAX_ROWS;
  const out = [];
  for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n));
  return out;
}

/**
 * 分片文件名：单片沿用原名；多片追加 _1.._N。
 * 按总片数的位数补零，保证目录内按名称排序与片序一致（如 _01.._12）。
 */
export function partFileNames(base, total) {
  if (total <= 0) return [];
  if (total === 1) return [`${base}.xlsx`];
  const width = String(total).length;
  return Array.from(
    { length: total },
    (_, i) => `${base}_${String(i + 1).padStart(width, "0")}.xlsx`
  );
}

/** 单片数据矩阵：两行表头（分组行 + 字段行）+ 该片数据行 */
export function buildLinkAoa(part, cfg) {
  return [
    ["链入", "", "", "", "链出", "", "", ""],
    LINK_FIELDS.concat(LINK_FIELDS),
    ...part.map((r) => [
      cfg.inProject, cfg.inModule, cfg.inPath, r.inId,
      cfg.outProject, cfg.outModule, cfg.outPath, r.outId,
    ]),
  ];
}

/**
 * 把一片链接数据装配为 xlsx 字节。
 * XLSX 库由调用方注入（界面传 xlsx-js-style，回归脚本传同一份依赖），
 * 保证「界面导出」与「回归校验」用的是同一份装配逻辑，不会两处漂移。
 * @param {Array} part 该片链接行
 * @param {object} cfg 链入/链出 6 项元信息
 * @param {object} XLSX SheetJS 兼容库（需支持 utils.aoa_to_sheet / utils.book_new / write）
 * @returns {Uint8Array} xlsx 字节
 */
export function encodeLinkSheet(part, cfg, XLSX) {
  const ws = XLSX.utils.aoa_to_sheet(buildLinkAoa(part, cfg));
  // 合并与列宽按片重建，避免多个 sheet 共享同一份对象
  ws["!merges"] = LINK_MERGES.map((m) => ({ s: { ...m.s }, e: { ...m.e } }));
  ws["!cols"] = LINK_COL_WIDTHS.map((wch) => ({ wch }));
  for (const addr of LINK_HEADER_CELLS) {
    const cell = ws[addr];
    if (cell) cell.s = { font: { bold: true } };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "链接文件");
  const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
