/* 一致性校验：代码文档 ↔ 低层需求的双向追溯核对
   —— 纯逻辑模块，不依赖 DOM / Tauri / xlsx，可脱离界面回归（与 src/link-split.js 同款做法）

   两个校验方向（对应生成文档页的两个疑问）：
   ① 代码侧：Object Type = "Source Code" 的行，Parent ID 是否为空。
      注意 Parent ID 设计上只在 Function Definition 章填充，其余数据章节恒空，
      故结果按「数据章节」分组给出，避免结构性空值淹没函数章的真实缺口。
   ② 需求侧：低层需求中 Object Type = "Requirement" 的行，其 ID 是否全部被代码文档的
      Parent ID 引用（反向覆盖核对，现有导出前自检完全没有这个方向）。

   附带核对（同源数据，零额外成本）：
   - 悬空引用：Parent ID 指向的需求 ID 不在低层需求 ID 列中
   - 重复追溯：同一条需求被多个符号引用（一个需求应只由一个符号承载）
   - 口径差异：出现在 Parent ID 中、却不是 Requirement 的需求 ID */

export const TRACE_SAMPLE_LIMIT = 200; // 每组明细最多列出的行数（超出只给计数，避免超大文档把 DOM 撑爆）

function norm(v) {
  return String(v == null ? "" : v).trim();
}

/* 占比计算放在纯模块里（渲染层只负责格式化成百分比文案），
   这样分母写错能在回归脚本里被断言抓住 —— 界面层只有在分子非 0 时才有区分度。
   分母为 0（不可计算）时返回 null，由渲染层显示为 "—"。 */
function ratio(part, whole) {
  return whole ? part / whole : null;
}

function isComment(v) {
  return norm(v).toLowerCase() === "comment";
}

function isRequirement(v) {
  return norm(v).toLowerCase() === "requirement";
}

/* 需求块扫描：块边界规则与 src/main.js 的 buildLlrFunctionIndex / scanLlrBlocks 保持一致
   —— 章节列非空，或需求内容恰为文档树中的函数名，即为块边界。
   返回 [{ title, known, ids }]，known 表示该块标题命中文档树中的函数。 */
export function scanRequirementBlocks(llrRows, colMap, nameSet) {
  const blocks = [];
  const idCol = colMap.id;
  const typeCol = colMap.type;
  const contentCol = colMap.content;
  const chapterCol = colMap.chapter;
  let cur = null;
  for (const r of llrRows) {
    const content = norm(r[contentCol]);
    const chapter = chapterCol ? norm(r[chapterCol]) : "";
    if ((chapterCol && chapter) || nameSet.has(content)) {
      cur = { title: `${chapter} ${content}`.trim(), known: nameSet.has(content), ids: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    // 重读态：Object Type = Comment 的行不计入需求（与生成侧同一排除规则）
    if (typeCol && isComment(r[typeCol])) continue;
    const id = norm(r[idCol]);
    if (id) cur.ids.push(id);
  }
  return blocks;
}

/* 主入口：一次遍历产出完整核对报告
   - rows    生成文档页的行数据（collectDocRows 输出；Source Code 行需带 sectionKey/sectionTitle）
   - llrRows 低层需求数据行
   - colMap  { id, content, type, chapter } —— 取自步骤 3 的列映射，空串表示未映射
   - nameSet 文档树中的函数名集合（用于标注孤儿需求所属的函数块），可选
   - unresolvedNames 同名函数消歧未决的函数名集合（见 src/fn-disambiguate.js），可选。

     为什么要有这个维度：同名函数（典型是各模块的 static 私有函数）在低层需求里
     有多个同名需求块，若无法判定归属，软件会**故意留空**而不是随便挑一个填上。
     这个空值语义是「填不出来」，不是「该函数没有需求」——
     若混进遗漏/孤儿统计，用户会把工具的局限误判成数据缺陷。
     故这些行与这些需求单列为「未决」，不计入 emptyParent、不计入 orphaned。 */
export function auditTrace({ rows, llrRows, colMap, nameSet, unresolvedNames }) {
  const safeRows = rows || [];
  const safeLlr = llrRows || [];
  const cols = {
    id: colMap.id || "",
    content: colMap.content || "",
    type: colMap.type || "",
    chapter: colMap.chapter || "",
  };
  const names = nameSet || new Set();
  const pendingNames = new Set(unresolvedNames || []);
  // Object Type 列未映射时无法识别 Requirement，退化为「所有带 ID 的行」并在报告中标注
  const typeMapped = !!cols.type;

  /* ---------- ① 代码侧：Source Code 行的 Parent ID 空值，按数据章节分组 ---------- */
  const sectionMap = new Map();
  const sourceRows = []; // 全量 Source Code 行明细（报告「代码侧」sheet 用，按文档顺序）
  const refsByReq = new Map(); // 需求 ID -> 引用它的 Source Code 行明细（反向核对 sheet 用）
  const pendingCodeRows = []; // 空 Parent ID 但属于「未决同名函数」的行（不算遗漏）
  let sourceTotal = 0;
  let emptyParent = 0;
  let curSectionNum = ""; // 最近的章节标题行编号（数据行 num 为空，章节号从所属章节标题行取）
  safeRows.forEach((row, i) => {
    if (!norm(row.objectType) && norm(row.num)) curSectionNum = norm(row.num);
    if (row.objectType !== "Source Code") return;
    sourceTotal += 1;
    const key = row.sectionKey || "(未分章)";
    if (!sectionMap.has(key)) {
      sectionMap.set(key, { key, title: row.sectionTitle || key, total: 0, empty: 0, pending: 0, details: [] });
    }
    const g = sectionMap.get(key);
    const parent = norm(row.parent);
    // 全量明细：序号与生成文档页「序号」列、链接文件「链出 ID」同一坐标系，便于回表定位。
    sourceRows.push({ index: i + 1, sectionNum: curSectionNum, title: row.title, parent });
    g.total += 1;
    // Parent ID 支持多 ID（换行分隔）：逐个登记反向引用，供需求侧 sheet 展开成「一需求一引用一行」
    for (const id of parent.split("\n").map(norm).filter(Boolean)) {
      if (!refsByReq.has(id)) refsByReq.set(id, []);
      refsByReq.get(id).push({ index: i + 1, sectionNum: curSectionNum, title: row.title });
    }
    if (parent) return;
    // 未决同名函数：空值是「归属填不出来」，不等于「没有需求」→ 单列，不计遗漏
    if (pendingNames.has(norm(row.title))) {
      g.pending += 1;
      pendingCodeRows.push({ index: i + 1, sectionNum: curSectionNum, title: row.title });
      return;
    }
    g.empty += 1;
    emptyParent += 1;
    g.details.push({ index: i + 1, title: row.title });
  });

  /* ---------- 代码文档的 Parent ID 全集（需求侧反向核对的数据源） ---------- */
  const referenced = new Set();
  const owners = new Map(); // 需求 ID -> 引用它的符号名集合
  const refPairs = [];
  for (const row of safeRows) {
    for (const id of norm(row.parent).split("\n").map(norm).filter(Boolean)) {
      referenced.add(id);
      if (!owners.has(id)) owners.set(id, new Set());
      owners.get(id).add(row.title);
      refPairs.push({ id, title: row.title });
    }
  }

  const knownIds = new Set(safeLlr.map((r) => norm(r[cols.id])).filter(Boolean));

  /* ---------- ② 需求侧：Requirement 行的引用覆盖 ---------- */
  const reqRows = [];
  safeLlr.forEach((r, i) => {
    const id = norm(r[cols.id]);
    if (!id) return;
    if (typeMapped && !isRequirement(r[cols.type])) return;
    reqRows.push({
      id,
      chapter: cols.chapter ? norm(r[cols.chapter]) : "",
      content: norm(r[cols.content]),
      line: i + 1,
    });
  });

  const blocks = scanRequirementBlocks(safeLlr, cols, names);
  const idToBlock = new Map();
  const pendingReqIds = new Set(); // 属于未决同名函数的需求 ID：算「未决」，不算孤儿
  for (const b of blocks) {
    // 只认「由未决函数名行开启」的块。
    // 注意不能只按块标题末段取词判断 —— 块边界由章节列触发后，其后的无章节行都会并入
    // 上一个块，排在未决块之后的其他需求会被连带误判成「未决」。
    // known 标记块标题是否命中文档树函数名；未决函数必然在文档树中，故要求两者同时成立。
    const parts = b.title.split(/\s+/);
    const fnName = parts[parts.length - 1] || "";
    const isPending = b.known && pendingNames.has(fnName);
    for (const id of b.ids) {
      if (!idToBlock.has(id)) idToBlock.set(id, b.title);
      if (isPending) pendingReqIds.add(id);
    }
  }

  const orphans = [];
  const pendingReqs = [];
  for (const r of reqRows) {
    if (referenced.has(r.id)) continue;
    if (pendingReqIds.has(r.id)) {
      // 未决：需求本身存在，只是填不进Parent ID（归属判不出来）→ 单列
      pendingReqs.push({ ...r, block: idToBlock.get(r.id) || "" });
      continue;
    }
    orphans.push({ ...r, block: idToBlock.get(r.id) || "" });
  }

  /* ---------- 附带核对 ---------- */
  const dangling = [];
  const seenDangling = new Set();
  for (const { id, title } of refPairs) {
    if (knownIds.has(id) || seenDangling.has(id)) continue;
    seenDangling.add(id);
    dangling.push({ id, title });
  }

  const duplicated = [];
  for (const [id, set] of owners) {
    if (set.size > 1) duplicated.push({ id, count: set.size, owners: [...set].sort() });
  }
  duplicated.sort((a, b) => b.count - a.count);

  // 生成侧口径（排除 Comment）比校验侧口径（仅 Requirement）更宽，多引用出来的 ID 在此暴露
  const reqIdSet = new Set(reqRows.map((r) => r.id));
  const nonRequirementRefs = [...referenced].filter((id) => knownIds.has(id) && !reqIdSet.has(id));

  return {
    typeMapped,
    colMissing: {
      id: !cols.id,
      content: !cols.content,
      type: !cols.type,
      chapter: !cols.chapter,
    },
    code: {
      sourceTotal,
      emptyParent,
      // 未决行不计filled：它的 Parent ID 是空的，语义上并未「关联」，
      // 若计入会让环形图「已关联」数虚高、三个分段加起来也对不上 sourceTotal。
      pendingRows: pendingCodeRows.length,
      filledParent: sourceTotal - emptyParent - pendingCodeRows.length,
      // 占比分母 = Source Code 行数
      emptyRatio: ratio(emptyParent, sourceTotal),
      sourceRows,
      sections: [...sectionMap.values()].map((s) => ({
        ...s,
        emptyRatio: ratio(s.empty, s.total),
      })),
    },
    requirement: {
      total: reqRows.length,
      referenced: reqRows.length - orphans.length - pendingReqs.length,
      orphaned: orphans.length,
      // 占比分母 = Requirement 条数（未决单列，不进孤儿）
      orphanRatio: ratio(orphans.length, reqRows.length),
      orphans,
      // 反向核对明细：每条 Requirement 及其被引用情况（refs 按文档顺序；孤儿 refs 为空数组）
      detail: reqRows.map((r) => ({ ...r, refs: refsByReq.get(r.id) || [] })),
    },
    /* 未决同名函数：空值语义是「归属填不出来」而非「没有需求」，
       必须在报告里单列，否则用户会把工具局限误判成数据缺陷。
       代码侧与需求侧成对出现 —— 同一批函数名导致的「填不出」与「引用不上」。 */
    pending: {
      names: [...pendingNames],
      codeRows: pendingCodeRows,
      reqs: pendingReqs,
      // 该函数名下的需求条数（可能是多个需求块，故与代码侧行数不必相等）
      reqCount: pendingReqs.length,
    },
    extra: { dangling, duplicated, nonRequirementRefs },
  };
}

/* ---------- 报告导出：把核对结果编成 Excel 工作簿 ----------
   三个 sheet：校验汇总（两视角统计 + 占比 + 附带核对 + 结论）/
   代码侧-SourceCode明细（全量 Source Code 行：文档序号 · 章节号 · 需求内容 · Parent ID，空值行 exceljs 侧着色）/
   需求侧-一致性明细（反向核对：全量 Requirement 行，低层需求 ID · 内容 + 引用它的 Code 文档行 序号/章节号/内容，
   未被引用的行 exceljs 侧着色）。
   明细全量列出 —— 报告是导出文件，不是 DOM，不设条数上限。 */

function pct(r) {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

/* 纯数据：返回 [{ name, aoa, cols }]，不碰 XLSX，可直接断言 */
export function buildTraceReportSheets(report, meta = {}) {
  const { code, requirement, extra, typeMapped, colMissing, pending } = report;

  const notes = [];
  if (colMissing.id) notes.push("未映射「ID 列」，无法生成 Parent ID");
  if (colMissing.content) notes.push("未映射「需求内容列」，无法定位需求行");
  if (!typeMapped) notes.push("未映射「Object Type 列」，需求侧校验退化为「所有带 ID 的行」");
  else if (colMissing.chapter) notes.push("未映射「章节列」，需求块边界可能不准确");
  const hasPending = !!(pending && pending.names && pending.names.length);
  if (hasPending)
    notes.push(
      `有 ${pending.names.length} 个同名函数无法判定归属（${pending.names.join("、")}），` +
        "其 Parent ID 已留空并单列为「未决」，不计入遗漏与孤儿"
    );

  const fn = code.sections.find((s) => s.key === "functions");
  const conclusion =
    `视角一空值 ${code.emptyParent} 行（Function 章 ${fn ? fn.empty : 0} 行）；` +
    `视角二遗漏 ${requirement.orphaned} 条；` +
    (hasPending
      ? `同名未决 ${pending.codeRows.length} 行 / ${pending.reqCount} 条需求；`
      : "") +
    `附带核对 ${
      extra.dangling.length + extra.duplicated.length + extra.nonRequirementRefs.length
    } 项`;

  const summary = [
    ["一致性检查报告", ""],
    ["生成时间", meta.generatedAt || ""],
    [],
    ["视角一 · 代码文档", "Object Type = Source Code 的行中，Parent ID 为空的情况（占比分母 = Source Code 行数）"],
    ["Source Code 总行数", code.sourceTotal],
    ["Parent ID 为空", code.emptyParent],
    ["空值占比", pct(code.emptyRatio)],
    [],
    ["按数据章节", ""],
    ["数据章节", "总行数", "空值数", "空值占比"],
    ...code.sections.map((s) => [`${s.title} 章`, s.total, s.empty, pct(s.emptyRatio)]),
    [],
    ["视角二 · 低层需求", "Object Type = Requirement 的需求中，ID 未被代码文档 Parent ID 引用的情况（占比分母 = Requirement 条数）"],
    ["Requirement 总条数", requirement.total],
    ["未被引用", requirement.orphaned],
    ["遗漏占比", pct(requirement.orphanRatio)],
    [],
    // 未决维度单列成节：空值语义是「归属填不出来」，与「没有需求」是两回事
    ...(hasPending
      ? [
          [],
          ["同名函数未决（不计入遗漏/孤儿）", "同名函数（各模块的 static 私有函数等）在低层需求中有多个同名需求块，" +
            "软件无法判定归属时**故意留空**而非随便挑一个填上。以下为空值语义＝「填不出来」的行与需求，"],
          ["未决函数名", pending.names.join("、")],
          ["代码侧未决行数", pending.codeRows.length],
          ["需求侧未决条数", pending.reqCount],
          ["处理建议", "核对低层需求中这些函数是否分属不同章节；补齐可区分它们的同目录兄弟函数后重新导出"],
        ]
      : []),
    [],
    ["附带核对", ""],
    ["悬空引用（Parent ID 指向不存在的需求 ID）", extra.dangling.length],
    ["重复追溯（同一条需求被多个符号引用）", extra.duplicated.length],
    ["口径差异（Parent ID 引用了非 Requirement 行）", extra.nonRequirementRefs.length],
    [],
    ["列映射提示", notes.join("；") || "（无）"],
    ["结论", conclusion],
  ];

  /* 代码侧 sheet：全量 Source Code 行（不只空值行），四列 ——
     文档序号（与链接文件「链出 ID」同一坐标系）/ 章节号（取自所属章节标题行）/
     需求内容（符号名）/ Parent ID 原值。
     空 Parent ID 行由 exceljs 侧按第 4 列着色；未决同名函数行在第 4 列写明原因，
     不与真·遗漏混为一谈（着色规则见 src/trace-report-exceljs.js）。 */
  const pendingCodeIdx = new Set((pending ? pending.codeRows : []).map((r) => r.index));
  const codeDetail = [["文档序号", "章节号", "需求内容", "Parent ID"]];
  for (const r of code.sourceRows) {
    const isPending = pendingCodeIdx.has(r.index) && !r.parent;
    codeDetail.push([
      r.index,
      r.sectionNum,
      r.title,
      isPending ? "（同名函数无法判定归属）" : r.parent,
    ]);
  }
  if (codeDetail.length === 1) codeDetail.push(["（无 Source Code 行）", "", "", ""]);

  /* 需求侧 sheet：反向核对视角 —— 全量 Requirement 行（不只孤儿），列出被 Code 文档引用的情况：
     低层需求 ID / 低层需求内容 / 引用文档序号（对齐链出 ID 坐标系）/ 引用章节号 / 引用需求内容（符号名）。
     一条需求被多行引用时逐引用展开（一引用一行）；未被引用的行第 3 列给「（未被引用）」标记，
     exceljs 侧据此整行着色；未决同名函数对应的需求标记为「（归属未决）」，语义与真·孤儿不同。 */
  const pendingReqIdSet = new Set((pending ? pending.reqs : []).map((r) => r.id));
  const reqDetail = [["低层需求 ID", "低层需求内容", "引用文档序号", "引用章节号", "引用需求内容"]];
  for (const r of requirement.detail) {
    const content = r.content || "（需求内容为空）";
    if (!r.refs.length) {
      if (pendingReqIdSet.has(r.id)) reqDetail.push([r.id, content, "（归属未决）", "", ""]);
      else reqDetail.push([r.id, content, "（未被引用）", "", ""]);
      continue;
    }
    for (const ref of r.refs) reqDetail.push([r.id, content, ref.index, ref.sectionNum, ref.title]);
  }
  if (reqDetail.length === 1) reqDetail.push(["（无 Requirement 行）", "", "", "", ""]);

  return [
    { name: "校验汇总", aoa: summary, cols: [{ wch: 46 }, { wch: 18 }, { wch: 12 }, { wch: 12 }] },
    { name: "代码侧-SourceCode明细", aoa: codeDetail, cols: [{ wch: 10 }, { wch: 12 }, { wch: 44 }, { wch: 24 }] },
    { name: "需求侧-一致性明细", aoa: reqDetail, cols: [{ wch: 24 }, { wch: 64 }, { wch: 14 }, { wch: 12 }, { wch: 44 }] },
  ];
}

/* ---------- 图表描述（纯数据，不依赖任何 xlsx / 渲染库） ----------
   把「校验汇总」页里适合可视化的汇总数字抽成图表语义：4 张图——
   ① 视角一环形图：已关联 / 空 Parent ID
   ② 按数据章节柱状图：各章空 Parent ID 数
   ③ 视角二环形图：已引用 / 未被引用
   ④ 附带核对柱状图：悬空引用 / 重复追溯 / 口径差异 项数
   返回 [{ id, kind, title, categories, values, anchor, size }]。
   - kind：'doughnut' | 'bar'，供浏览器侧选择 Canvas 画法
   - categories / values：纯数字与标签，便于回归断言（与界面两视角同一坐标系）
   - anchor：图表在「校验汇总」sheet 中的左上角单元格（列 F 起，避免与 A~D 表格重叠）
   - size：{ cols, rows } 图表占据的单元格跨度（exceljs.addImage 锚点用）
   浏览器侧（src/trace-report-exceljs.js）据此用 Canvas 现画 PNG 并嵌入工作簿，
   因此本函数保持零依赖，Node 回归可直接断言。 */
export function buildTraceChartSpecs(report) {
  const { code, requirement, extra, pending } = report;
  const sections = code.sections || [];
  const hasPending = !!(pending && pending.names && pending.names.length);
  /* 布局：图表不与表格并排（右侧 F 列起会压住表格右侧数据列），
     而是「上文字、下图片」——排在「校验汇总」表格末尾下方竖排。
     起始行按汇总表实际行数动态计算（空 1 行起），图与图之间空 1 行，避免以后表格变长被盖。 */
  const sumRows = buildTraceReportSheets(report).find((s) => s.name === "校验汇总").aoa.length;
  let row = sumRows + 2;
  const anchorAt = () => {
    const a = `A${row}`;
    return a;
  };
  const advance = (spec) => {
    /* rows 只作布局估算（图片实际高 240px ≈ 12 行 @20px/行）；+2 行余量防不同软件
       行高差异（WPS 默认行高更矮，步进不足会贴叠上一张图） */
    row += spec.size.rows + 2;
  };
  /* 未决单列为第三段：环形图里必须能把「填不出来」与「没有需求」分开看，
     否则用户看到的"空 Parent ID"数量会被误当成数据缺陷。 */
  const codeOverview = {
    id: "codeOverview",
    kind: "doughnut",
    title: "视角一 · 代码文档：Parent ID 关联覆盖",
    categories: hasPending
      ? ["已关联 Parent ID", "空 Parent ID（未决同名）", "空 Parent ID"]
      : ["已关联 Parent ID", "空 Parent ID"],
    values: hasPending
      ? [code.filledParent, pending.codeRows.length, code.emptyParent]
      : [code.filledParent, code.emptyParent],
    anchor: anchorAt(),
    size: { cols: 8, rows: 12 },
  };
  advance(codeOverview);
  const codeBySection = {
    id: "codeBySection",
    kind: "bar",
    title: "按数据章节：空 Parent ID 数",
    categories: sections.map((s) => s.title),
    values: sections.map((s) => s.empty),
    anchor: anchorAt(),
    size: { cols: 10, rows: 12 },
  };
  advance(codeBySection);
  const reqOverview = {
    id: "reqOverview",
    kind: "doughnut",
    title: "视角二 · 低层需求：引用覆盖",
    categories: hasPending
      ? ["已引用", "未被引用（归属未决）", "未被引用"]
      : ["已引用", "未被引用"],
    values: hasPending
      ? [requirement.referenced, pending.reqCount, requirement.orphaned]
      : [requirement.referenced, requirement.orphaned],
    anchor: anchorAt(),
    size: { cols: 8, rows: 12 },
  };
  advance(reqOverview);
  const extraChart = {
    id: "extra",
    kind: "bar",
    title: "附带核对：异常项数",
    categories: ["悬空引用", "重复追溯", "口径差异"],
    values: [extra.dangling.length, extra.duplicated.length, extra.nonRequirementRefs.length],
    anchor: anchorAt(),
    size: { cols: 10, rows: 11 },
  };
  advance(extraChart);
  return [codeOverview, codeBySection, reqOverview, extraChart];
}
