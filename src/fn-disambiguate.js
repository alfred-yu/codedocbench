/* 函数名重名消歧（同名函数跨文件归属判定）
   —— 纯数据变换模块，不触碰 DOM 与 Tauri，便于 scripts/test-fn-disambiguate.mjs 直接回归。

   问题背景
   低层需求（LLR）里函数名可以重名：典型是各模块都用 `static` 定义了同名私有函数
   （如每个文件都有一个 `A`）。原实现以「纯函数名」为键建索引
   （Map<函数名, 需求ID[]>），同名函数只会保留一份需求块，
   于是所有同名函数行被填上同一份 Parent ID —— 不是"缺失"，而是"错误填了他人的需求"，
   在 DO-178C 追溯场景下比空值危险得多。

   消歧规则（余工提出，已实测可行）
   每个函数需求块在 LLR 中都带章节号（Section 列），形如 `4.2.4.1.1.1`。
   把章节号去掉最后一段得到其「同目录级别」的兄弟函数：
   同一父章节下、章节号不同的其他函数块，即为兄弟函数。
   若某个兄弟函数名出现在当前源码文件里，则该需求块属于当前文件。
   demo 数据实测：12 个 .c 文件、60 个函数块，按此规则全部唯一命中。

   边界处理原则：**判定不了就明确判定不了，绝不随便挑一个**
   - 兄弟集合为空（该块同目录没有别的函数）→ 无法判定
   - 多个块都被判为候选（含兄弟也重名的情况）→ 仍歧义
   两种情况一律返回 null，由调用方给出告警并留空，绝不静默填错。 */

/**
 * 计算某需求块的同目录级别兄弟函数名集合。
 *
 * @param {{section: string, name: string}} block 函数需求块
 * @param {Map<string, Set<string>>} sec2names 章节号 -> 该章节上的函数名集合
 * @returns {Set<string>} 兄弟函数名集合（已排除自身）
 */
export function siblingNames(block, sec2names) {
  const section = String(block.section || "").trim();
  if (!section) return new Set();
  const dot = section.lastIndexOf(".");
  // 无点号的章节号（如顶层 "4"）无从判断层级，视为无兄弟
  if (dot < 0) return new Set();
  const parent = section.slice(0, dot);
  const out = new Set();
  for (const [sec, names] of sec2names) {
    if (sec !== section && sec.startsWith(parent + ".")) {
      for (const n of names) out.add(n);
    }
  }
  out.delete(block.name);
  return out;
}

/**
 * 汇总所有函数需求块，建立消歧所需的索引结构。
 *
 * @param {Array<{name:string, section:string, ids:string[]}>} blocks 函数名行块
 * @returns {{byName: Map<string, Array>, sec2names: Map<string, Set<string>>}}
 */
export function buildDisambiguateIndex(blocks) {
  const byName = new Map();
  const sec2names = new Map();
  for (const b of blocks) {
    if (!b.name) continue;
    if (!byName.has(b.name)) byName.set(b.name, []);
    byName.get(b.name).push(b);
    const sec = String(b.section || "").trim();
    if (sec) {
      if (!sec2names.has(sec)) sec2names.set(sec, new Set());
      sec2names.get(sec).add(b.name);
    }
  }
  return { byName, sec2names };
}

/** 消歧结论 */
export const MATCH_UNIQUE = "unique"; // 候选块只有一个，无需消歧
export const MATCH_BY_SIBLING = "sibling"; // 靠兄弟函数判定出唯一归属
export const MATCH_UNRESOLVED = "unresolved"; // 判定不了（无兄弟 / 多候选）
export const MATCH_NONE = "none"; // 该函数名在 LLR 中根本没有块

/**
 * 判定某个函数名在指定源码文件下应关联到哪个需求块。
 *
 * @param {string} name 函数名
 * @param {Set<string>} fileFunctions 当前文件里的全部函数名（用于兄弟函数命中判断）
 * @param {{byName: Map, sec2names: Map}} index buildDisambiguateIndex 的产物
 * @returns {{block: object|null, how: string}} block 为 null 表示未能唯一判定
 */
export function resolveFunctionBlock(name, fileFunctions, index) {
  const cands = index.byName.get(name) || [];
  if (!cands.length) return { block: null, how: MATCH_NONE };
  if (cands.length === 1) return { block: cands[0], how: MATCH_UNIQUE };
  // 重名：靠同目录级别的兄弟函数是否出现在当前文件里来定位
  const hits = cands.filter((b) => {
    const sib = siblingNames(b, index.sec2names);
    for (const s of sib) if (fileFunctions.has(s)) return true;
    return false;
  });
  if (hits.length === 1) return { block: hits[0], how: MATCH_BY_SIBLING };
  return { block: null, how: MATCH_UNRESOLVED };
}