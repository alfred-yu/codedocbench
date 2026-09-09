"""CodeDocBench 的 Python 后端。

命令行模式：python backend.py <mode> <path>
  - scan_dir   递归遍历目录，输出嵌套目录树 JSON
  - parse_file 解析单个 C/C++ 源码文件，输出符号 JSON

解析目标是"够用且确定"：不做完整 C 文法解析，基于轻量分词器 + 文件作用域规则，
对无法识别的片段容错跳过（符合 DO-178C 严谨可控的取向）。
"""
import json
import os
import re
import sys

# 可解析的源码后缀
SOURCE_EXTS = {".c", ".h", ".cpp", ".hpp", ".cc", ".cxx"}

# 目录遍历时跳过的目录
SKIP_DIRS = {
    ".git", ".svn", ".hg", "node_modules", "target", "build", ".venv",
    "venv", "env", "__pycache__", "dist", ".idea", ".vscode",
}

# 类型/存储/限定关键字（用于识别"看起来像类型前缀"）
_TYPE_KEYWORDS = {
    "auto", "char", "const", "double", "enum", "extern", "float", "inline",
    "int", "long", "register", "restrict", "short", "signed", "static",
    "struct", "typedef", "union", "unsigned", "void", "volatile", "_Bool",
    "_Complex", "bool", "unsigned char", "wchar_t", "size_t", "int8_t",
    "uint8_t", "int16_t", "uint16_t", "int32_t", "uint32_t", "int64_t",
    "uint64_t", "int8_t",
}
_CONTROL_KEYWORDS = {
    "if", "else", "while", "for", "switch", "case", "return", "sizeof",
    "new", "delete", "throw", "catch", "try", "goto", "do",
}
_QUALIFIERS = {"const", "volatile", "static", "extern", "register", "inline", "restrict"}
# 存储类说明符仅表示作用域/存储期，不属于类型本身；组装类型时应剔除
_STORAGE_CLASS = {"static", "extern", "register", "auto"}


# ---------------------------------------------------------------------------
# 目录树
# ---------------------------------------------------------------------------
def scan_dir(path: str) -> dict:
    root = os.path.abspath(path)
    if not os.path.isdir(root):
        return {"type": "error", "message": f"路径不存在或不是目录: {path}"}
    return _build_node(root, root)


def _is_parsable(name: str) -> bool:
    return os.path.splitext(name)[1].lower() in SOURCE_EXTS


def _build_node(fs_path: str, root: str) -> dict:
    name = os.path.basename(fs_path) or fs_path
    if os.path.isdir(fs_path):
        children = []
        try:
            entries = sorted(os.listdir(fs_path), key=lambda s: s.lower())
        except OSError:
            entries = []
        for entry in entries:
            full = os.path.join(fs_path, entry)
            if os.path.isdir(full):
                if entry in SKIP_DIRS:
                    continue
                child = _build_node(full, root)
                if child.get("children"):
                    children.append(child)
            else:
                # 仅保留可解析的源码文件（.c/.h 等）
                if _is_parsable(entry):
                    children.append({
                        "type": "file", "name": entry, "path": full,
                        "parsable": True,
                    })
        node = {"type": "dir", "name": name, "path": fs_path, "children": children}
        if fs_path == root:
            node["isRoot"] = True
        return node
    return {"type": "file", "name": name, "path": fs_path, "parsable": _is_parsable(name)}


# ---------------------------------------------------------------------------
# 分词器
# ---------------------------------------------------------------------------
_TOKEN_RE = re.compile(
    r"""
    (?P<comment>//[^\n]*|/\*.*?\*/)
    |(?P<ws>\s+)
    |(?P<num>0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)
    |(?P<char>'(?:\\.|[^'\\])')
    |(?P<str>"(?:\\.|[^"\\])*")
    |(?P<pp>[#]\w*)                       # 预处理关键字（#include/#define 等），行首探测
    |(?P<punct>[{}();,=<>+\-*/%&|!~^?:\[\].@\\])
    |(?P<ident>[A-Za-z_]\w*)
    |(?P<other>.)
    """,
    re.VERBOSE | re.MULTILINE,
)


def _strip_comments_line(line: str, in_block: bool):
    """去除单行注释/块注释，跨行的块注释由 in_block 状态延续。
    同时跳过字符串/字符字面量，避免其中的 // 或 /* 被误判为注释。
    返回 (处理后行内容, 进入/退出块注释后的新状态)。"""
    out = []
    i, n = 0, len(line)
    while i < n:
        c = line[i]
        if in_block:
            if c == "*" and i + 1 < n and line[i + 1] == "/":
                in_block = False
                i += 2
                continue
            i += 1
            continue
        if c == "/":
            nxt = line[i + 1] if i + 1 < n else ""
            if nxt == "/":
                break  # 行注释，删掉剩余
            if nxt == "*":
                in_block = True
                i += 2
                continue
        if c == '"':
            j = i + 1
            while j < n:
                if line[j] == "\\":
                    j += 2
                    continue
                if line[j] == '"':
                    j += 1
                    break
                j += 1
            out.append(line[i:j])
            i = j
            continue
        if c == "'":
            j = i + 1
            while j < n and line[j] != "'":
                if line[j] == "\\":
                    j += 2
                    continue
                j += 1
            j = min(j + 1, n)
            out.append(line[i:j])
            i = j
            continue
        out.append(c)
        i += 1
    return "".join(out), in_block


def _tokenize(source: str) -> list:
    """返回 token 列表，每个元素: [kind, value, line]。"""
    tokens = []
    in_block = False
    # 逐行处理：先做跨行安全的注释剔除，再按 token 正则切分
    for lineno, raw in enumerate(source.split("\n"), start=1):
        raw, in_block = _strip_comments_line(raw, in_block)
        pos = 0
        n = len(raw)
        while pos < n:
            m = _TOKEN_RE.match(raw, pos)
            if not m:
                pos += 1
                continue
            kind, val = m.lastgroup, m.group()
            pos = m.end()
            if kind in ("comment", "ws"):
                continue
            if kind == "pp" and val.startswith("#"):
                # 整行预处理指令整体作为 prepro token
                rest = raw[pos:].rstrip()
                tokens.append(("prepro", val + rest, lineno))
                break
            tokens.append((kind, val, lineno))
    return tokens


# ---------------------------------------------------------------------------
# 文件级解析
# ---------------------------------------------------------------------------
def parse_file(path: str) -> dict:
    if not os.path.isfile(path):
        return {"type": "error", "message": f"文件不存在: {path}"}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            source = f.read()
    except OSError as e:
        return {"type": "error", "message": f"读取文件失败: {e}"}

    tokens = _tokenize(source)
    result = {
        "includes": [], "macros": [], "typedefs": [],
        "functions": [], "structs": [], "enums": [], "globals": [],
    }

    # 1) 预处理指令
    for tok in tokens:
        if tok[0] == "prepro":
            _parse_prepro(tok[1], tok[2], result)

    # 2) 文件作用域符号扫描（跳过预处理，避免重复）
    body = [t for t in tokens if t[0] != "prepro"]
    _scan_top_level(body, result)
    return result


def _parse_prepro(text: str, line: int, result: dict) -> None:
    m = re.match(r"#\s*(\w+)(.*)$", text)
    if not m:
        return
    directive, rest = m.group(1), m.group(2).strip()
    if directive == "include":
        inc = re.match(r"[<\"]([^>\"]+)[>\"]", rest)
        if inc:
            result["includes"].append(inc.group(1))
    elif directive == "define":
        dm = re.match(r"([A-Za-z_]\w*)(.*)$", rest)
        if dm:
            result["macros"].append({
                "name": dm.group(1),
                "value": dm.group(2).strip() or "(empty)",
                "line": line,
            })


# ---------------------------------------------------------------------------
# 文件作用域扫描
# ---------------------------------------------------------------------------
def _scan_top_level(tokens: list, result: dict) -> None:
    i, n = 0, len(tokens)
    depth = 0
    while i < n:
        kind, val, line = tokens[i]
        if depth > 0:
            # 花括号套内（未被记录/函数整体消费时）只跟踪深度
            if val == "{":
                depth += 1
            elif val == "}":
                depth -= 1
            i += 1
            continue
        if val in ("struct", "union", "enum"):
            rec = _consume_record(tokens, i)
            if rec:
                rkind, info, j = rec
                result[rkind].append(info)
                i = j
                continue
        elif val == "typedef":
            # 简单 typedef：typedef <type...> alias;
            td = _consume_typedef(tokens, i)
            if td:
                info, j = td
                result["typedefs"].append(info)
                i = j
                continue
        elif val == "{":
            depth += 1
            i += 1
            continue
        elif val == "}":
            if depth > 0:
                depth -= 1
            i += 1
            continue
        elif val == ";":
            i += 1
            continue
        elif kind == "ident" and val not in _CONTROL_KEYWORDS:
            f = _consume_function(tokens, i)
            if f:
                info, j = f
                result["functions"].append(info)
                i = j
                continue
            g = _consume_global(tokens, i)
            if g:
                info, j = g
                result["globals"].append(info)
                i = j
                continue
        i += 1


# -- 结构体/联合/枚举 --------------------------------------------------------
def _match_brace(tokens: list, start: int) -> int:
    """从 start 找到第一个 '{'，返回其后匹配的 '}' 的下标；找不到返回 -1。"""
    depth = 0
    started = False
    for k in range(start, len(tokens)):
        if tokens[k][1] == "{":
            depth += 1
            started = True
        elif tokens[k][1] == "}":
            depth -= 1
            if started and depth == 0:
                return k
    return -1


def _consume_record(tokens: list, i: int) -> tuple | None:
    keyword = tokens[i][1]              # struct / union / enum
    kind_map = {"struct": "structs", "union": "structs", "enum": "enums"}
    target = kind_map[keyword]
    # 记录名称（可选）
    name = None
    j = i + 1
    if j < len(tokens) and tokens[j][0] == "ident" and tokens[j][1] != "typedef":
        name = tokens[j][1]
        j += 1
    # 必须紧跟 '{' 才算记录定义；否则如 "struct Point p;" / "struct Foo bar(...)"
    # 属于对既有类型的使用，交给函数/全局变量逻辑处理。
    if j >= len(tokens) or tokens[j][1] != "{":
        return None
    open_idx = j
    end = _match_brace(tokens, j)
    if end < 0:
        return None
    # 提取成员/枚举值：取开括号后到闭括号之前的 token
    inner = tokens[open_idx + 1: end]
    line = tokens[i][2]
    # 闭括号后可选别名 + 分号：`typedef struct {...} Alias;` 或 `struct Foo {...} var;`
    alias = None
    k = end + 1
    trailing = []
    while k < len(tokens) and tokens[k][1] != ";":
        if tokens[k][1] in ("{", "}"):
            break
        if tokens[k][0] == "ident" and tokens[k][1] not in _TYPE_KEYWORDS:
            trailing.append(tokens[k][1])
        k += 1
    # 取闭括号后的最后一个标识符作为别名（覆盖匿名 typedef 别名场景）
    if trailing:
        alias = trailing[-1]
    if k < len(tokens) and tokens[k][1] == ";":
        k += 1

    if target == "enums":
        members = [t[1] for t in inner if t[0] == "ident"]
        info = {"name": name or alias or "(anonymous)", "members": members, "line": line}
    else:
        fields = _extract_fields(inner)
        info = {
            "name": name or alias or "(anonymous)",
            "kind": keyword,
            "fields": fields,
            "line": line,
        }
    return target, info, k


def _extract_fields(inner: list) -> list:
    """尽力从结构体内部提取字段：type name; 或 type name[..];"""
    fields = []
    field_tokens = []
    depth = 0
    for t in [x for x in inner if x[0] != "comment"]:
        if t[1] in ("{",):
            depth += 1
            field_tokens.append(t)
        elif t[1] in ("}",):
            depth -= 1
            field_tokens.append(t)
        elif t[1] == ";" and depth == 0:
            # 完成一个字段声明
            f = _field_from_tokens(field_tokens)
            if f:
                fields.append(f)
            field_tokens = []
        else:
            field_tokens.append(t)
    # 最后一个字段（无分号结尾时兜底）
    if field_tokens:
        f = _field_from_tokens(field_tokens)
        if f:
            fields.append(f)
    return fields


def _field_from_tokens(ft: list) -> str | None:
    """从字段 token 提取 '类型 名称' 文本。"""
    idents = [t for t in ft if t[0] == "ident" and t[1] not in _TYPE_KEYWORDS]
    if not idents:
        return None
    name_tok = idents[-1]
    # 简单实现：取最后一个标识符为字段名
    chars = ""
    for t in ft:
        v = t[1]
        if v in (")", "]", "}", ",", ";"):
            chars = chars.rstrip() + v
        elif v in ("(", "[", "{", "::"):
            chars = chars.rstrip() + v
        elif chars and not chars.endswith(("(", "[", "{")) and v not in ("*", "&"):
            chars += " " + v
        else:
            chars += v
    return chars.strip()


# -- typedef ------------------------------------------------------------------
def _consume_typedef(tokens: list, i: int) -> tuple | None:
    j = i + 1
    # 收集后部，直到分号
    buf = []
    while j < len(tokens) and tokens[j][1] != ";":
        if tokens[j][1] in ("{", "}"):
            break
        buf.append(tokens[j])
        j += 1
    if not buf:
        return None
    # 别名 = 最后出现的标识符（且在闭合括号之外）
    # 场景：typedef Foo Bar; / typedef struct {...} Bar; 已在 record 处理
    alias = None
    alias_idx = -1
    for idx in range(len(buf) - 1, -1, -1):
        if buf[idx][0] == "ident" and buf[idx][1] not in _TYPE_KEYWORDS:
            alias = buf[idx][1]
            alias_idx = idx
            break
    if not alias:
        return None
    type_text = _join(buf[:alias_idx]) or "(anonymous)"
    if j < len(tokens) and tokens[j][1] == ";":
        j += 1
    return {"name": alias, "type": type_text, "line": tokens[i][2]}, j


# -- 函数 ---------------------------------------------------------------------
def _consume_function(tokens: list, i: int) -> tuple | None:
    """识别 top-level 函数定义/声明。前提：tokens[i] 是标识符（返回类型或函数名）。"""
    n = len(tokens)
    # 条件：不是控制关键字
    # 向前寻找 '('：括号必须出现在同一语句（遇到 ';' '=' '{' 则失败）
    paren_idx = -1
    for k in range(i, n):
        v = tokens[k][1]
        if v == ";":
            break
        if v == "{":
            break  # 前面的类型里不应有裸 '{'
        if v == "(":
            # 仅当 '(' 前的 token 是标识符（候选函数名）时成立
            prev = tokens[k - 1] if k > i else None
            if prev and prev[0] == "ident" and prev[1] not in _TYPE_KEYWORDS:
                # 确认前缀类型合理：前缀不为空
                prefix = tokens[i:k - 1]
                if _prefix_is_type(prefix):
                    paren_idx = k
                    name = prev[1]
                    name_line = prev[2]
                    break
        if v == "=" or v == ",":
            # 遇到赋值/逗号：不太像函数定义，跳出
            break
    if paren_idx < 0:
        return None

    # 找匹配的 ')'（跟踪括号深度）
    depth = 0
    close_idx = -1
    for k in range(paren_idx, n):
        if tokens[k][1] == "(":
            depth += 1
        elif tokens[k][1] == ")":
            depth -= 1
            if depth == 0:
                close_idx = k
                break
    if close_idx < 0:
        return None

    # 参数文本
    params = _join(tokens[paren_idx + 1: close_idx]) or "(void)"
    # 返回类型
    ret_type = _fmt_type(tokens[i:paren_idx - 1]) or "int"

    # 分号/花括号区分声明与定义
    j = close_idx + 1
    if j < n and tokens[j][1] == "{":
        is_def = True
        # 定义：跳到其函数体结尾（匹配到 '}' 或下一个 top-level 分号）
        k2 = _match_brace(tokens, j)
        j = k2 + 1 if k2 > 0 else j + 1
    elif j < n and tokens[j][1] == ";":
        is_def = False
        j += 1
    else:
        return None

    return (
        {
            "name": name,
            "returnType": ret_type,
            "params": params or "(void)",
            "line": name_line,
            "isDefinition": is_def,
        },
        j,
    )


def _join(toks: list) -> str:
    """将 token 拼接为可读文本（合理加空格）。"""
    s = ""
    for t in toks:
        v = t[1]
        if v in (")", "]", "}", ",", ";", ":", "."):
            s = s.rstrip() + v
        elif v in ("(", "[", "{", "::"):
            s = s.rstrip() + v
        elif s and not s.endswith(("(", "[", "{", "::", "*", "&", "->")) and v not in ("*", "&"):
            s += " " + v
        else:
            s += v
    return s.strip()


def _fmt_type(toks: list) -> str:
    """组装类型文本：剔除存储类说明符（static/extern/register/auto），
    保留真正的类型与限定词（const/volatile）。"""
    return _join([t for t in toks if t[1] not in _STORAGE_CLASS])


def _prefix_is_type(prefix: list) -> bool:
    """判定函数名之前的前缀是否像返回值类型前缀。"""
    if not prefix:
        return False
    if any(t[1] in _TYPE_KEYWORDS for t in prefix):
        return True
    # 允许 'MyType*'、'MyType ' 等自定义类型前缀（前缀仅含标识符/指针/限定符）
    allowed_punct = {"*", "&", "::", "[", "]", ">", "<", "::"}
    for t in prefix:
        if t[1] in allowed_punct or t[1] in _QUALIFIERS:
            continue
        if t[0] == "ident":
            continue
        return False
    # 前缀至少含一个标识符
    return any(t[0] == "ident" for t in prefix)


# -- 全局变量 ------------------------------------------------------------------
def _consume_global(tokens: list, i: int) -> tuple | None:
    """识别 top-level 全局变量声明：type name [= init] ; 且不是函数。"""
    n = len(tokens)
    # 起始必须是类型/存储关键字，或以标识符类型开头 + 限定符
    first = tokens[i]
    if not (first[0] == "ident" or first[1] in _TYPE_KEYWORDS):
        return None
    # 收集到分号，若期间出现 '(' 则可能先是函数，跳过；出现 '{' 跳过
    buf = []
    j = i
    has_paren = False
    while j < n:
        v = tokens[j][1]
        if v == ";":
            break
        if v == "{":
            return None
        if v == "(":
            has_paren = True
            break
        buf.append(tokens[j])
        j += 1
    if not has_paren and buf and j < n and tokens[j][1] == ";":
        # 提取：最后一个标识符为变量名，其前为类型
        idents = [t for t in buf if t[0] == "ident" and t[1] not in _TYPE_KEYWORDS]
        if not idents:
            return None
        name_tok = idents[-1]
        idx = None
        for pos, t in enumerate(buf):
            if t is name_tok:
                idx = pos
                break
        if idx is None:
            return None
        type_text = _fmt_type(buf[:idx])
        return {"name": name_tok[1], "type": type_text or "?", "line": name_tok[2]}, j + 1
    return None


# ---------------------------------------------------------------------------
def _init_utf8_stdio() -> None:
    """强制 stdout/stderr 使用 UTF-8，避免被外部编码（如 GBK/管道）破坏 JSON。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main(argv) -> int:
    _init_utf8_stdio()
    if len(argv) < 3:
        print(json.dumps({
            "type": "error",
            "message": "用法: python backend.py <scan_dir|parse_file> <path>",
        }, ensure_ascii=False))
        return 1
    mode, path = argv[1], argv[2]
    if mode == "scan_dir":
        data = scan_dir(path)
    elif mode == "parse_file":
        data = parse_file(path)
    else:
        data = {"type": "error", "message": f"未知模式: {mode}"}
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))