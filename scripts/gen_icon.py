"""使用 Python 标准库生成一个合法的 ICO 文件（内嵌单张 256x256 RGBA PNG）。"""
import struct
import zlib

SIZE = 32
color = (70, 130, 210, 255)  # 纯色图标


def make_png(width: int, height: int, rgba: tuple) -> bytes:
    raw = b""
    row = b"\x00" + bytes(rgba) * width
    for _ in range(height):
        raw += row
    def chunk(typ: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw))
           + chunk(b"IEND", b""))
    return png


def make_ico(png: bytes) -> bytes:
    header = struct.pack("<HHH", 0, 1, 1)
    entry = struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22)
    return header + entry + png


if __name__ == "__main__":
    png_data = make_png(SIZE, SIZE, color)
    ico = make_ico(png_data)
    out = r"C:\Users\Administrator\Desktop\CodeDocBench\src-tauri\icons\icon.ico"
    with open(out, "wb") as f:
        f.write(ico)
    print(f"wrote {out} ({len(ico)} bytes)")