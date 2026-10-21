#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CodeDocBench 解析准确率评测器。

读取 bench/ground_truth.json（手标定真值）与语料，驱动 python/backend.py 的
parse_file，按类别计算 precision / recall / F1，并输出漏检(FN)/误检(FP)清单
（附 file:line 证据），再做一组结构化深度校验。

用法：
    python bench/run_accuracy.py
    python bench/run_accuracy.py --report bench/accuracy_report.md

依赖：仅 Python 标准库。backend.py 同为纯标准库。
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from backend import parse_file  # noqa: E402

CATEGORIES = ["includes", "macros", "constants", "typedefs",
              "functions", "structs", "enums", "globals"]


def load_source(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def find_line(source, name):
    """在源码里用单词边界定位名称首次出现行号，作为证据。"""
    if not name:
        return None
    for i, line in enumerate(source.split("\n"), 1):
        if re.search(r"\b" + re.escape(name) + r"\b", line):
            return i
    return None


def pred_names(result, cat):
    items = result.get(cat, []) or []
    if cat == "includes":
        return [x for x in items if isinstance(x, str)]
    return [x["name"] for x in items if isinstance(x, dict)]


def metrics(expected, predicted):
    exp = set(expected)
    pred = set(predicted)
    tp = exp & pred
    fp = pred - exp
    fn = exp - pred
    p = len(tp) / len(pred) if pred else 1.0
    r = len(tp) / len(exp) if exp else 1.0
    f1 = (2 * p * r / (p + r)) if (p + r) else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "precision": p, "recall": r, "f1": f1,
            "exp_n": len(exp), "pred_n": len(pred)}


def evaluate_group(gt_group, sources):
    """对一组文件计算每类指标 + 汇总。"""
    per_cat = {c: {"exp": set(), "pred": set(), "fn_lines": {}, "fp_lines": {}}
               for c in CATEGORIES}
    for path, gt in gt_group.items():
        src = sources[path]
        res = parse_file(os.path.join(ROOT, path))
        for c in CATEGORIES:
            exp = set(gt.get(c, []))
            pred = set(pred_names(res, c))
            per_cat[c]["exp"] |= exp
            per_cat[c]["pred"] |= pred
            # 名称级 FN/FP 证据
            for name in (exp - pred):
                per_cat[c]["fn_lines"].setdefault(name, find_line(src, name))
            # FP 行号取预测条目自带 line
            pred_items = {x["name"]: x.get("line") for x in (res.get(c) or [])
                          if isinstance(x, dict)}
            for name in (pred - exp):
                per_cat[c]["fp_lines"].setdefault(name, pred_items.get(name))
    # 汇总表
    table = {}
    micro_tp = micro_fp = micro_fn = 0
    for c in CATEGORIES:
        m = metrics(per_cat[c]["exp"], per_cat[c]["pred"])
        table[c] = m
        micro_tp += len(m["tp"])
        micro_fp += len(m["fp"])
        micro_fn += len(m["fn"])
    micro_p = micro_tp / (micro_tp + micro_fp) if (micro_tp + micro_fp) else 1.0
    micro_r = micro_tp / (micro_tp + micro_fn) if (micro_tp + micro_fn) else 1.0
    micro_f1 = (2 * micro_p * micro_r / (micro_p + micro_r)) if (micro_p + micro_r) else 0.0
    return per_cat, table, {"tp": micro_tp, "fp": micro_fp, "fn": micro_fn,
                            "precision": micro_p, "recall": micro_r, "f1": micro_f1}


def fmt_pct(x):
    return f"{x * 100:.1f}%"


def deep_checks_core(res_core, gt_core):
    """core 语料的结构化深度校验。返回 (passed, failed, notes) 三类列表。"""
    # 合并多文件（本基准 core 仅一个文件）
    res = res_core
    src = load_source(os.path.join(ROOT, "bench/corpus_core.c"))
    notes = []
    passed = []
    failed = []

    # DC1: uint32_t typedef 被丢弃（已知缺陷）
    td = {x["name"]: x for x in res.get("typedefs", [])}
    if "uint32_t" not in td:
        failed.append("DC1 uint32_t typedef 被丢弃：别名名恰好命中 _TYPE_KEYWORDS"
                      "（stdint 固定宽度类型），整条 typedef 既不入 typedefs 也不入 globals")
    else:
        passed.append("DC1 uint32_t typedef 正常识别")

    # DC2: const 限定的全局变量必须只在 constants，绝不能漏进 globals
    const_names = {x["name"] for x in res.get("constants", [])}
    glob_names = {x["name"] for x in res.get("globals", [])}
    leak = const_names & glob_names
    if leak:
        failed.append(f"DC2 const 变量混入 globals：{sorted(leak)}")
    else:
        passed.append("DC2 const 变量正确只入 constants，未漏进 globals")

    # DC3: add 的定义/声明区分
    adds = [f for f in res.get("functions", []) if f["name"] == "add"]
    defs = [f for f in adds if f.get("isDefinition")]
    decls = [f for f in adds if not f.get("isDefinition")]
    if len(defs) == 1 and len(decls) == 1:
        passed.append("DC3 add 的定义/声明正确区分（1 定义 + 1 声明）")
    else:
        failed.append(f"DC3 add 定义/声明区分异常：defs={len(defs)} decls={len(decls)}")

    # DC4: get_name 返回类型含 char*
    g = {f["name"]: f for f in res.get("functions", [])}
    if "get_name" in g and "char*" in (g["get_name"].get("returnType") or ""):
        passed.append("DC4 get_name 返回类型含 char*")
    else:
        failed.append("DC4 get_name 返回类型异常：" + str(g.get("get_name", {}).get("returnType")))

    # DC5: log_msg 变参参数含 ...
    if "log_msg" in g and "..." in (g["log_msg"].get("params") or ""):
        passed.append("DC5 log_msg 变参参数正确含 ...")
    else:
        failed.append("DC5 log_msg 参数异常：" + str(g.get("log_msg", {}).get("params")))

    # DC6: alloc 返回指针 int *
    rt = g.get("alloc", {}).get("returnType") or ""
    if "alloc" in g and "int" in rt and "*" in rt:
        passed.append(f"DC6 alloc 返回类型含指针（{rt}）")
    else:
        failed.append("DC6 alloc 返回类型异常：" + str(rt))

    # DC7: 结构体字段
    st = {s["name"]: s for s in res.get("structs", [])}
    if "Point" in st:
        fields = st["Point"].get("fields", [])
        if any("x" in f for f in fields) and any("y" in f for f in fields):
            passed.append("DC7 struct Point 字段(x,y)提取正确")
        else:
            failed.append("DC7 struct Point 字段提取异常：" + str(fields))
    else:
        failed.append("DC7 struct Point 未识别")

    # DC8: 枚举成员
    en = {e["name"]: e for e in res.get("enums", [])}
    if "Color" in en and en["Color"].get("members") == ["RED", "GREEN", "BLUE"]:
        passed.append("DC8 enum Color 成员[RED,GREEN,BLUE]提取正确")
    else:
        failed.append("DC8 enum Color 成员异常：" + str(en.get("Color", {}).get("members")))

    # DC9/DC10: 匿名 typedef 别名归 record 章（设计选择，确认未丢）
    if "Range" in st and "RangePtr" in st:
        passed.append("DC9 匿名 struct typedef 多别名(Range/RangePtr)入 structs 章（设计口径）")
    else:
        failed.append("DC9 匿名 struct typedef 别名丢失：" + str(list(st)))
    if "EnumTag" in en:
        passed.append("DC10 匿名 enum typedef 别名(EnumTag)入 enums 章（设计口径）")
    else:
        failed.append("DC10 匿名 enum typedef 别名丢失")

    return passed, failed, notes


def deep_checks_boundary(res):
    passed, failed, notes = [], [], []
    g = {f["name"]: f for f in res.get("functions", [])}
    st = {s["name"]: s for s in res.get("structs", [])}
    en = {e["name"]: e for e in res.get("enums", [])}
    glob = {x["name"] for x in res.get("globals", [])}

    # 正向：这些应在边界集里被识别
    for nm in ("fatal", "fast", "legacy"):
        (passed if nm in g else failed).append(
            f"BC+ {nm} 在边界集被正确识别为函数" if nm in g
            else f"BC- {nm} 未被识别（__attribute__/inline 修饰 / K&R 老式定义）")
    for nm in ("ops", "Outer", "Flags", "Cb"):
        cat = "ops" in {x["name"] for x in res.get("typedefs", [])} and nm == "ops"
        ok = (nm in {x["name"] for x in res.get("typedefs", [])}) if nm == "ops" else (nm in st)
        (passed if ok else failed).append(
            f"BC+ {nm} 在边界集被正确识别" if ok else f"BC- {nm} 未被识别")

    # 边界缺口（README 声明不做完整文法，记为已知局限而非实现缺陷）
    for nm in ("signal", "legacy", "cpp_func"):
        if nm not in g:
            notes.append(f"已知局限：'{nm}' 未被识别（函数返回函数指针 / K&R 老式定义 / extern \"C\" 块）")
    # 匿名 record 实例被误分类
    if "g_anon" in st:
        failed.append("BC- 匿名 union 实例 g_anon 被误归 structs 章（应为全局变量）")
    if "g_aenum" in en:
        failed.append("BC- 匿名 enum 实例 g_aenum 被误归 enums 章（应为全局变量）")
    # K&R 产生的垃圾全局
    junk = {"int", "a", "b"} & glob
    if junk:
        failed.append(f"BC- K&R 老式定义产生垃圾全局变量：{sorted(junk)}（应为无）")
    return passed, failed, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", default=None, help="写出 Markdown 报告路径")
    args = ap.parse_args()

    with open(os.path.join(HERE, "ground_truth.json"), encoding="utf-8") as f:
        gt = json.load(f)

    # 预读源码
    sources = {}
    for grp in ("core", "boundary"):
        for path in gt[grp]:
            sources[path] = load_source(os.path.join(ROOT, path))

    # 解析（缓存结果供深度校验）
    res_cache = {}
    all_paths = set(sources)
    for path in all_paths:
        res_cache[path] = parse_file(os.path.join(ROOT, path))

    out = []
    out.append("# CodeDocBench C 解析准确率评测报告\n")
    out.append(f"_解析器版本：{res_cache[list(sources)[0]].get('parserVersion')}_\n")

    for grp in ("core", "boundary"):
        out.append(f"\n## {grp.upper()} 语料（{len(gt[grp])} 文件）\n")
        group = {p: gt[grp][p] for p in gt[grp]}
        per_cat, table, micro = evaluate_group(group, sources)

        out.append("| 类别 | 期望 | 识别 | TP | FP | FN | 精确率 | 召回率 | F1 |")
        out.append("|---|---|---|---|---|---|---|---|---|")
        for c in CATEGORIES:
            m = table[c]
            out.append(f"| {c} | {m['exp_n']} | {m['pred_n']} | {len(m['tp'])} | "
                       f"{len(m['fp'])} | {len(m['fn'])} | {fmt_pct(m['precision'])} | "
                       f"{fmt_pct(m['recall'])} | {fmt_pct(m['f1'])} |")
        out.append(f"| **微平均** | | | {micro['tp']} | {micro['fp']} | {micro['fn']} | "
                   f"{fmt_pct(micro['precision'])} | {fmt_pct(micro['recall'])} | "
                   f"{fmt_pct(micro['f1'])} |")

        # 漏检/误检清单
        out.append("\n### 漏检（FN，应识别未识别）\n")
        any_fn = False
        for c in CATEGORIES:
            for name in sorted(per_cat[c]["fn_lines"]):
                line = per_cat[c]["fn_lines"][name]
                out.append(f"- `{c}` **{name}** — 源码约第 {line} 行")
                any_fn = True
        if not any_fn:
            out.append("- 无")

        out.append("\n### 误检（FP，识别了不应识别 / 错类）\n")
        any_fp = False
        for c in CATEGORIES:
            for name in sorted(per_cat[c]["fp_lines"]):
                line = per_cat[c]["fp_lines"][name]
                out.append(f"- `{c}` **{name}** — 预测行 {line}")
                any_fp = True
        if not any_fp:
            out.append("- 无")

    # 深度校验
    out.append("\n## 结构化深度校验\n")
    res_core = res_cache["bench/corpus_core.c"]
    res_boundary = res_cache["bench/corpus_boundary.c"]
    p1, f1, n1 = deep_checks_core(res_core, gt["core"]["bench/corpus_core.c"])
    p2, f2, n2 = deep_checks_boundary(res_boundary)

    out.append("\n### CORE 深度校验\n")
    for x in p1:
        out.append(f"- ✅ {x}")
    for x in f1:
        out.append(f"- ❌ {x}")
    out.append("\n### BOUNDARY 深度校验\n")
    for x in p2:
        out.append(f"- ✅ {x}")
    for x in n2:
        out.append(f"- ℹ️ {x}")
    for x in f2:
        out.append(f"- ❌ {x}")

    report = "\n".join(out)
    print(report)
    if args.report:
        with open(os.path.join(ROOT, args.report), "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n[已写出报告] {args.report}")


if __name__ == "__main__":
    main()
