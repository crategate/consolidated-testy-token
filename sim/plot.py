"""Minimal stdlib raster canvas + PNG writer for the NYSEH sim explainers.

No dependencies. RGB pixel buffer (list of bytearrays), Bresenham lines,
rects, a 3x5 bitmap font, a Plot helper (axes/ticks/labels/series with
None-gap support), and a PNG encoder (raw scanlines with filter byte 0,
zlib.compress, struct-packed IHDR/IDAT/IEND chunks with crc32).

    c = Canvas(900, 600)
    p = Plot(c, 70, 30, 860, 540, xr=(0, 10000), yr=(0, 5.5))
    p.frame(xticks=[(0, "0"), (5000, "5000")], yticks=[(0, "0"), (5, "5%")],
            xlabel="MOMENTUM", ylabel="% VAULT")
    p.series(xs, ys, BLUE)
    save_png(c, "out.png"); check_png("out.png")
"""

import struct
import zlib

WHITE = (255, 255, 255)
INK = (25, 25, 25)
BLUE = (26, 76, 160)
RED = (184, 34, 34)
GREEN = (18, 122, 62)
GRAY = (150, 150, 150)
LGRAY = (230, 230, 230)

# 3x5 glyphs, 5 rows of 3 pixels ('#' on, '.' off). Lowercase maps to upper.
FONT = {
    " ": ("...", "...", "...", "...", "..."),
    "0": ("###", "#.#", "#.#", "#.#", "###"),
    "1": (".#.", "##.", ".#.", ".#.", "###"),
    "2": ("###", "..#", "###", "#..", "###"),
    "3": ("###", "..#", ".##", "..#", "###"),
    "4": ("#.#", "#.#", "###", "..#", "..#"),
    "5": ("###", "#..", "###", "..#", "###"),
    "6": ("###", "#..", "###", "#.#", "###"),
    "7": ("###", "..#", "..#", ".#.", ".#."),
    "8": ("###", "#.#", "###", "#.#", "###"),
    "9": ("###", "#.#", "###", "..#", "###"),
    "A": (".#.", "#.#", "###", "#.#", "#.#"),
    "B": ("##.", "#.#", "##.", "#.#", "##."),
    "C": (".##", "#..", "#..", "#..", ".##"),
    "D": ("##.", "#.#", "#.#", "#.#", "##."),
    "E": ("###", "#..", "##.", "#..", "###"),
    "F": ("###", "#..", "##.", "#..", "#.."),
    "G": (".##", "#..", "#.#", "#.#", ".##"),
    "H": ("#.#", "#.#", "###", "#.#", "#.#"),
    "I": ("###", ".#.", ".#.", ".#.", "###"),
    "J": ("..#", "..#", "..#", "#.#", ".#."),
    "K": ("#.#", "#.#", "##.", "#.#", "#.#"),
    "L": ("#..", "#..", "#..", "#..", "###"),
    "M": ("#.#", "###", "###", "#.#", "#.#"),
    "N": ("#.#", "##.", "###", ".##", "#.#"),
    "O": ("###", "#.#", "#.#", "#.#", "###"),
    "P": ("###", "#.#", "###", "#..", "#.."),
    "Q": ("###", "#.#", "#.#", "###", "..#"),
    "R": ("##.", "#.#", "##.", "#.#", "#.#"),
    "S": (".##", "#..", ".#.", "..#", "##."),
    "T": ("###", ".#.", ".#.", ".#.", ".#."),
    "U": ("#.#", "#.#", "#.#", "#.#", "###"),
    "V": ("#.#", "#.#", "#.#", "#.#", ".#."),
    "W": ("#.#", "#.#", "###", "###", "#.#"),
    "X": ("#.#", "#.#", ".#.", "#.#", "#.#"),
    "Y": ("#.#", "#.#", ".#.", ".#.", ".#."),
    "Z": ("###", "..#", ".#.", "#..", "###"),
    ".": ("...", "...", "...", "...", ".#."),
    ",": ("...", "...", "...", "..#", ".#."),
    "-": ("...", "...", "###", "...", "..."),
    "+": ("...", ".#.", "###", ".#.", "..."),
    "%": ("#.#", "..#", ".#.", "#..", "#.#"),
    "/": ("..#", "..#", ".#.", "#..", "#.."),
    "(": (".#.", "#..", "#..", "#..", ".#."),
    ")": (".#.", "..#", "..#", "..#", ".#."),
    ":": ("...", ".#.", "...", ".#.", "..."),
    "<": ("..#", ".#.", "#..", ".#.", "..#"),
    ">": ("#..", ".#.", "..#", ".#.", "#.."),
    "=": ("...", "###", "...", "###", "..."),
    "'": (".#.", ".#.", "...", "...", "..."),
}

GLYPH_W = 4  # 3px glyph + 1px spacing, times scale


class Canvas:
    def __init__(self, w, h, bg=WHITE):
        self.w, self.h = w, h
        self.pix = [bytearray(bg * w) for _ in range(h)]

    def set(self, x, y, color):
        if 0 <= x < self.w and 0 <= y < self.h:
            row = self.pix[y]
            i = x * 3
            row[i:i + 3] = bytes(color)

    def line(self, x0, y0, x1, y1, color):
        """Bresenham."""
        x0, y0, x1, y1 = int(round(x0)), int(round(y0)), int(round(x1)), int(round(y1))
        dx, dy = abs(x1 - x0), -abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx + dy
        while True:
            self.set(x0, y0, color)
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 >= dy:
                err += dy
                x0 += sx
            if e2 <= dx:
                err += dx
                y0 += sy

    def rect(self, x0, y0, x1, y1, color, fill=False):
        x0, x1 = sorted((int(x0), int(x1)))
        y0, y1 = sorted((int(y0), int(y1)))
        if fill:
            for y in range(max(0, y0), min(self.h, y1 + 1)):
                for x in range(max(0, x0), min(self.w, x1 + 1)):
                    self.set(x, y, color)
        else:
            self.line(x0, y0, x1, y0, color)
            self.line(x0, y1, x1, y1, color)
            self.line(x0, y0, x0, y1, color)
            self.line(x1, y0, x1, y1, color)

    def text(self, x, y, s, color=INK, scale=1):
        for ch in s.upper():
            glyph = FONT.get(ch, FONT[" "])
            for gy, row in enumerate(glyph):
                for gx, px in enumerate(row):
                    if px == "#":
                        self.rect(x + gx * scale, y + gy * scale,
                                  x + (gx + 1) * scale - 1, y + (gy + 1) * scale - 1,
                                  color, fill=True)
            x += GLYPH_W * scale

    @staticmethod
    def text_w(s, scale=1):
        return GLYPH_W * scale * len(s)


class Plot:
    """A data-mapped rectangle inside a Canvas. y axis points up."""

    def __init__(self, c, x0, y0, x1, y1, xr, yr):
        self.c = c
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1  # y0 = top pixel
        self.xr, self.yr = xr, yr

    def X(self, x):
        return self.x0 + (x - self.xr[0]) / (self.xr[1] - self.xr[0]) * (self.x1 - self.x0)

    def Y(self, y):
        return self.y1 - (y - self.yr[0]) / (self.yr[1] - self.yr[0]) * (self.y1 - self.y0)

    def frame(self, xticks=(), yticks=(), xlabel="", ylabel="", y2ticks=(), scale=1):
        c = self.c
        c.line(self.x0, self.y1, self.x1, self.y1, INK)   # x axis
        c.line(self.x0, self.y0, self.x0, self.y1, INK)   # y axis
        for v, lab in xticks:
            px = self.X(v)
            c.line(px, self.y1, px, self.y1 + 3, INK)
            c.text(px - Canvas.text_w(lab, scale) // 2, self.y1 + 6, lab, INK, scale)
        for v, lab in yticks:
            py = self.Y(v)
            c.line(self.x0 - 3, py, self.x0, py, INK)
            c.text(self.x0 - 6 - Canvas.text_w(lab, scale), py - 3 * scale, lab, INK, scale)
        for v, lab in y2ticks:
            py = self.Y(v)
            c.line(self.x1, py, self.x1 + 3, py, INK)
            c.text(self.x1 + 6, py - 3 * scale, lab, INK, scale)
        if xlabel:
            c.text((self.x0 + self.x1 - Canvas.text_w(xlabel, scale)) // 2,
                   self.y1 + 6 + 8 * scale, xlabel, INK, scale)
        if ylabel:  # horizontal, above the y axis
            c.text(self.x0, self.y0 - 8 * scale, ylabel, INK, scale)

    def series(self, xs, ys, color):
        """Polyline; None in ys breaks the line (gap)."""
        prev = None
        for x, y in zip(xs, ys):
            if y is None:
                prev = None
                continue
            if prev is not None:
                self.c.line(self.X(prev[0]), self.Y(prev[1]), self.X(x), self.Y(y), color)
            prev = (x, y)

    def bars(self, xs, ys, color, base=0.0, half_w=3):
        """Vertical bars from base (for daily returns)."""
        for x, y in zip(xs, ys):
            if y is None:
                continue
            px = self.X(x)
            self.c.rect(px - half_w, self.Y(base), px + half_w, self.Y(y), color, fill=True)

    def hline(self, y, color):
        self.c.line(self.x0, self.Y(y), self.x1, self.Y(y), color)

    def text(self, px, py, s, color=INK, scale=1):
        """Draw text at PIXEL coordinates inside this plot's canvas."""
        self.c.text(px, py, s, color, scale)

    def vline(self, x, color):
        self.c.line(self.X(x), self.y0, self.X(x), self.y1, color)

    def band(self, xa, xb, color):
        """Shaded vertical band over data x-range (draw before series)."""
        self.c.rect(self.X(xa), self.y0, self.X(xb), self.y1, color, fill=True)


def save_png(canvas, path):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = b"".join(b"\x00" + bytes(row) for row in canvas.pix)
    ihdr = struct.pack(">IIBBBBB", canvas.w, canvas.h, 8, 2, 0, 0, 0)  # RGB8
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def check_png(path):
    """Parse signature + IHDR back; return (w, h). Raises on any mismatch."""
    with open(path, "rb") as f:
        data = f.read(33)
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path}: bad signature"
    length, tag = struct.unpack(">I4s", data[8:16])
    assert tag == b"IHDR" and length == 13, f"{path}: bad IHDR"
    w, h, depth, ctype = struct.unpack(">IIBB", data[16:26])
    assert depth == 8 and ctype == 2, f"{path}: unexpected format"
    return w, h
