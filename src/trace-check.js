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

export const TRACE_SAMPLE_LIMIT = 50; // 每组明细最多列出的行数（超出只给计数）

function norm(v) {
  return String(v == null ? "" : v).trim();
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
   - nameSet 文档树中的函数名集合（用于标注孤儿需求所属的函数块），可选 */
export function auditTrace({ rows, llrRows, colMap, nameSet }) {
  const safeRows = rows || [];
  const safeLlr = llrRows || [];
  const cols = {
    id: colMap.id || "",
    content: colMap.content || "",
    type: colMap.type || "",
    chapter: colMap.chapter || "",
  };
  const names = nameSet || new Set();
  // Object Type 列未映射时无法识别 Requirement，退化为「所有带 ID 的行」并在报告中标注
  const typeMapped = !!cols.type;

  /* ---------- ① 代码侧：Source Code 行的 Parent ID 空值，按数据章节分组 ---------- */
  const sectionMap = new Map();
  let sourceTotal = 0;
  let emptyParent = 0;
  safeRows.forEach((row, i) => {
    if (row.objectType !== "Source Code") return;
    sourceTotal += 1;
    const key = row.sectionKey || "(未分章)";
    if (!sectionMap.has(key)) {
      sectionMap.set(key, { key, title: row.sectionTitle || key, total: 0, empty: 0, samples: [] });
    }
    const g = sectionMap.get(key);
    g.total += 1;
    if (norm(row.parent)) return;
    g.empty += 1;
    emptyParent += 1;
    // 序号与生成文档页「序号」列、链接文件「链出 ID」同一坐标系，便于回表定位
    if (g.samples.length < TRACE_SAMPLE_LIMIT) g.samples.push({ index: i + 1, title: row.title });
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
  for (const b of blocks) for (const id of b.ids) if (!idToBlock.has(id)) idToBlock.set(id, b.title);

  const orphans = [];
  for (const r of reqRows) {
    if (referenced.has(r.id)) continue;
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
      filledParent: sourceTotal - emptyParent,
      sections: [...sectionMap.values()],
    },
    requirement: {
      total: reqRows.length,
      referenced: reqRows.length - orphans.length,
      orphaned: orphans.length,
      orphans,
    },
    extra: { dangling, duplicated, nonRequirementRefs },
  };
}
