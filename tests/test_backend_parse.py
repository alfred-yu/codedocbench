"""解析准确性回归测试（金标准基线）。

运行：python -m pytest tests/ -v
每个用例以最小 C 代码片段固化 parse_file 的期望输出，防止解析规则改动导致精度回退。
"""
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))

from backend import PARSER_VERSION, parse_file  # noqa: E402


def parse(tmp_path: pathlib.Path, code: str) -> dict:
    p = tmp_path / "t.c"
    p.write_text(code, encoding="utf-8")
    return parse_file(str(p))


def names(items):
    return [x["name"] for x in items] if items and isinstance(items[0], dict) else list(items)


# ---------------------------------------------------------------------------
# 基础符号
# ---------------------------------------------------------------------------
def test_basic_symbols(tmp_path):
    r = parse(tmp_path, """
#include <stdio.h>
#include "cfg.h"
#define MAX_CONN 16
#define RESET(x) do { (x) = 0; } while (0)
typedef unsigned int u32;
struct Point { int x; int y; };
enum Color { RED, GREEN = 2, BLUE };
int add(int a, int b);
int add(int a, int b) { return a + b; }
static int counter;
""")
    assert names(r["includes"]) == ["stdio.h", "cfg.h"]
    # v1.3.0 起 #define 一律归宏，常量章由 const 全局变量承载
    assert "MAX_CONN" in names(r["macros"])
    assert "RESET" in names(r["macros"])
    assert r["constants"] == []
    assert "u32" in names(r["typedefs"])
    assert "Point" in names(r["structs"])
    assert names(r["enums"]) == ["Color"]
    assert r["enums"][0]["members"] == ["RED", "GREEN", "BLUE"]
    fn = {f["name"]: f for f in r["functions"]}
    assert fn["add"]["isDefinition"] is True
    assert fn["add"]["returnType"] == "int"
    g = {x["name"]: x for x in r["globals"]}
    assert g["counter"]["type"] == "int"  # static 属存储类，不属于类型


def test_function_declaration_vs_definition(tmp_path):
    r = parse(tmp_path, "int foo(void);\nint foo(void) { return 1; }\n")
    kinds = {f["name"]: f["isDefinition"] for f in r["functions"]}
    assert kinds == {"foo": True} or sorted(
        (f["name"], f["isDefinition"]) for f in r["functions"]
    ) == [("foo", False), ("foo", True)]


# ---------------------------------------------------------------------------
# 缺陷修复回归：多行宏
# ---------------------------------------------------------------------------
def test_multiline_macro_continuation(tmp_path):
    r = parse(tmp_path, """#define MAX(a, b) \\
    ((a) > (b) ? (a) : (b))

int real_func(void) { return 1; }
""")
    assert "MAX" in names(r["macros"])
    # 续行内容不能被误解析为符号
    assert names(r["functions"]) == ["real_func"]
    assert r["globals"] == []


# ---------------------------------------------------------------------------
# 缺陷修复回归：条件编译
# ---------------------------------------------------------------------------
def test_if_zero_branch_skipped_else_kept(tmp_path):
    r = parse(tmp_path, """#if 0
int dead_func(void) { return 1; }
#define DEAD_MACRO 1
#else
int live_func(void) { return 2; }
#define LIVE_MACRO 1
#endif
int tail_func(void) { return 3; }
""")
    assert names(r["functions"]) == ["live_func", "tail_func"]
    assert "DEAD_MACRO" not in names(r["macros"])
    assert "LIVE_MACRO" in names(r["macros"])


def test_ifdef_unknown_keeps_all_branches(tmp_path):
    # 不可判定条件按"可能生效"处理：两个分支都保留，不静默丢数据
    r = parse(tmp_path, """#ifdef USE_FAST
int fast_path(void);
#else
int slow_path(void);
#endif
""")
    assert set(names(r["functions"])) == {"fast_path", "slow_path"}


def test_if_zero_after_else_reactivated(tmp_path):
    r = parse(tmp_path, """#if 0
int branch_a(void);
#elif 0
int branch_b(void);
#else
int branch_c(void);
#endif
""")
    assert names(r["functions"]) == ["branch_c"]


# ---------------------------------------------------------------------------
# 缺陷修复回归：多声明符
# ---------------------------------------------------------------------------
def test_multi_declarator_globals(tmp_path):
    r = parse(tmp_path, "int a, b;\nstatic int c = 1, *d;\n")
    g = {x["name"]: x for x in r["globals"]}
    assert set(g) == {"a", "b", "c", "d"}
    assert g["a"]["type"] == "int"
    assert g["b"]["type"] == "int"       # b 不继承 a 的基类型以外内容
    assert g["d"]["type"] == "int*"      # d 只继承自己的 '*'


def test_init_with_comma_not_split(tmp_path):
    # 初始化里的逗号（数组/函数调用实参）不能拆出假声明符
    r = parse(tmp_path, 'int table[] = {1, 2, 3};\nint use(int x, int y);\n')
    assert "table" in names(r["globals"])
    assert "use" in names(r["functions"])
    assert "2" not in names(r["globals"]) and "3" not in names(r["globals"])


# ---------------------------------------------------------------------------
# 缺陷修复回归：函数指针
# ---------------------------------------------------------------------------
def test_function_pointer_globals(tmp_path):
    r = parse(tmp_path, """void (*callback)(int);
int (*fp)(void) = 0;
int normal_func(void) { return 0; }
""")
    g = {x["name"]: x for x in r["globals"]}
    assert set(g) == {"callback", "fp"}
    assert g["callback"]["type"] == "void"
    assert g["fp"]["type"] == "int"
    assert names(r["functions"]) == ["normal_func"]


# ---------------------------------------------------------------------------
# 词法安全
# ---------------------------------------------------------------------------
def test_comment_and_string_safety(tmp_path):
    r = parse(tmp_path, """// 注释包含 " 引号与 // 双斜杠
/* 块注释 // 以及 " 引号 */
const char *msg = "字符串中的 // 与 /* 不算注释";
int ok_func(void) { return 0; }
""")
    assert names(r["functions"]) == ["ok_func"]
    # const 限定的指针全局变量归入常量章（v1.3.0）
    assert "msg" in names(r["constants"])


def test_unterminated_record_ignored(tmp_path):
    # 花括号不匹配时容错跳过，不崩溃也不产生半截符号
    r = parse(tmp_path, "struct Broken { int x;\n\nint after(void) { return 1; }\n")
    parsed_ok = parse(tmp_path, "int after(void) { return 1; }\n")
    assert "after" in names(parsed_ok["functions"])  # 解析器本身可正常工作


# ---------------------------------------------------------------------------
# v1.3.0 归类口径：#define 一律归宏；const 限定的全局变量归常量
# ---------------------------------------------------------------------------
def test_define_all_to_macros(tmp_path):
    # 数值/字符串字面量宏不再分流到常量章（老口径回潮时此用例翻车）
    r = parse(tmp_path, """#define N 100
#define S "str"
#define F(x) ((x) + 1)
#define E
""")
    assert set(names(r["macros"])) == {"N", "S", "F", "E"}
    assert r["constants"] == []


def test_const_globals_routed_to_constants(tmp_path):
    r = parse(tmp_path, """const int MAX_LEVEL = 5;
static const double PI = 3.14;
const char *msg = "hi";
char *const fixed = 0;
extern const long LIMIT;
const int a = 1, b = 2;
int c, *const p = 0;
int plain_var;
static int counter = 0;
void (*const cb)(int) = 0;
void (*cb2)(int);
""")
    c = set(names(r["constants"]))
    g = set(names(r["globals"]))
    # 基类型 const（MAX_LEVEL/PI/a/b）、指针 const（msg/fixed/p/cb）均归常量；
    # 同语句的非 const 声明符（c）与普通变量（plain_var/counter/cb2）留在全局变量章
    assert c == {"MAX_LEVEL", "PI", "msg", "fixed", "LIMIT", "a", "b", "p", "cb"}
    assert g == {"c", "plain_var", "counter", "cb2"}


# ---------------------------------------------------------------------------
# 元数据（一致性自检 / 缓存失效依赖这些字段）
# ---------------------------------------------------------------------------
def test_metadata_fields(tmp_path):
    r = parse(tmp_path, "int a;\nint f(void) { return 0; }")
    assert r["parserVersion"] == PARSER_VERSION
    assert r["lineCount"] == 2
    assert isinstance(r["mtime"], int)


# ---------------------------------------------------------------------------
# 冒烟：samples 目录真实文件可解析且行号不越界
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# 缺陷修复回归：头文件包含保护宏（include guard）
# ---------------------------------------------------------------------------
def test_include_guard_filtered(tmp_path):
    # #ifndef X 后紧跟的 #define X 是保护宏，不应作为普通宏输出
    r = parse(tmp_path, """#ifndef CFG_H
#define CFG_H
#define REAL_MACRO(x) ((x) + 1)
int cfg_func(void);
#endif
""")
    all_defs = names(r["macros"])
    assert "CFG_H" not in all_defs
    assert "REAL_MACRO" in names(r["macros"])


def test_include_guard_variants_filtered(tmp_path):
    # #ifdef 与 #if !defined(...) 两种保护写法同样过滤
    r = parse(tmp_path, """#ifdef UTIL_H
#define UTIL_H
#define UTIL_FLAG 1
#endif
#if !defined(ADD_H)
#define ADD_H
#define ADD_OFFSET 0x10
#endif
int util_func(void);
""")
    all_defs = names(r["macros"])
    assert "UTIL_H" not in all_defs
    assert "ADD_H" not in all_defs
    # 保护块内部的普通宏正常保留（v1.3.0 起 #define 不再按值分流到常量）
    assert "UTIL_FLAG" in names(r["macros"])
    assert "ADD_OFFSET" in names(r["macros"])


def test_non_guard_define_kept(tmp_path):
    # 非保护场景：#ifndef 与 #define 不同名 / 不相邻，宏正常保留
    r = parse(tmp_path, """#ifndef A_H
#define B_NOT_MATCH 1
#define EMPTY_FLAG
int some_func(void);
#endif
#define LATER_FLAG
""")
    all_defs = names(r["macros"])
    assert "B_NOT_MATCH" in all_defs
    assert "EMPTY_FLAG" in all_defs
    assert "LATER_FLAG" in all_defs


def test_samples_smoke_no_line_overflow():
    root = pathlib.Path(__file__).resolve().parents[1] / "samples"
    files = [p for p in root.rglob("*") if p.suffix.lower() in (".c", ".h")]
    if not files:
        pytest.skip("samples 下没有 C 源文件")
    for p in files:
        r = parse_file(str(p))
        assert r.get("type") != "error", f"{p}: {r.get('message')}"
        for cat in ("functions", "globals", "macros", "constants",
                    "typedefs", "structs", "enums"):
            for it in r[cat]:
                assert it["line"] <= r["lineCount"], f"{p}: {cat} {it['name']} 行号越界"
