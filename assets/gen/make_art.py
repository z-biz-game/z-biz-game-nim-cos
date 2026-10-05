#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""尼姆堆 · NIM 的美术母题生成器：一支脚本产全部位图 —— 图标、社交卡、游戏内纹理。

母题（先定风格，再画东西）：暗色牌桌上立着的三列石子 1|2|3。那是异或和为 0 的 P 位，
本仓全部玩法论断的起点；顶栏那个 `≡` brand mark 就是它的横版。配色不在这里编，每个
三元组都是从 css/game.css 的 :root 与 js/view.js 的 drawStone/drawStrip 实测抄来的
（--bg/--bg-2/--line/--win/--lose/--pick/--ink），所以图标、社交卡、棋盘桌布和屏幕上的
石子是同一套颜色，不是"另画一张像的"。

可复现：无外部素材、无随机 —— 桌布噪声由坐标的整数哈希算出，同一命令跑两次输出逐字节
相同（PIL 写 PNG 不带时间戳，脚本也不塞 metadata）。

依赖: Pillow（与组合量具 make_icons.py 用的是同一支）。

用法: python3 assets/gen/make_art.py     # 全量重画到 assets/
      python3 assets/gen/make_art.py --dry
"""
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))

# 实测取色：css/game.css :root + js/view.js 的渐变端点
BG = (20, 22, 26)            # --bg #14161a
BG2 = (27, 30, 36)           # --bg-2 #1b1e24
LINE = (43, 48, 56)          # --line #2b3038
STONE_TOP = (232, 228, 215)  # drawStone 渐变上端（#ded9cc 提亮一档）
STONE_BOT = (162, 156, 142)  # #a29c8e
WIN = (87, 201, 138)         # --win #57c98a
LOSE = (215, 105, 95)        # --lose #d7695f
PICK = (224, 182, 74)        # --pick #e0b64a
INK = (232, 230, 225)        # --ink #e8e6e1
INK_DIM = (157, 154, 147)    # --ink-dim #9d9a93

SS = 2                       # 形状画在 2 倍图上再 LANCZOS 收下：抗锯齿，不糊
HEAPS = [1, 2, 3]            # nim-sum 0：图标的全部叙事
FONTS = ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/STHeiti Medium.ttc',
         '/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/Songti.ttc']


def hashed_field(w, h, base, alt, strength):
    """桌布：底色调到 alt 与 base 之间，逐像素由坐标的整数哈希抖动 strength 档。"""
    px = bytearray(w * h * 3)
    i = 0
    for y in range(h):
        yy = y * 1543
        for x in range(w):
            n = (x * 7349 + yy + ((x ^ y) * 397)) & 0x3ff
            jitter = (n * 2654435761 >> 19) % strength - strength // 2
            cx = (x / (w - 1.0) - 0.5) * 2.0
            cy = (y / (h - 1.0) - 0.5) * 2.0
            fall = 0.74 + 0.26 * (1.0 - min(1.0, cx * cx * 0.62 + cy * cy * 0.44))
            for c in range(3):
                v = (base[c] + (alt[c] - base[c]) * 0.35 + jitter) * fall
                px[i] = 0 if v < 0 else 255 if v > 255 else int(v)
                i += 1
    return Image.frombytes('RGB', (w, h), bytes(px))


def stone(img, draw, box, radius):
    """一颗石子：投影 + 竖向渐变体 + 顶光。与 js/view.js 的 drawStone 同一套画法。"""
    x0, y0, x1, y1 = [int(v) for v in box]
    bw, bh = max(1, x1 - x0), max(1, y1 - y0)
    draw.rounded_rectangle((x0 + bh * 0.07, y0 + bh * 0.09, x1 + bh * 0.07, y1 + bh * 0.09),
                           radius=radius, fill=(7, 8, 10))
    row = bytearray(3)
    buf = bytearray(bw * bh * 3)
    for t in range(bh):
        f = t / (bh - 1.0) if bh > 1 else 0.0
        for c in range(3):
            row[c] = int(STONE_TOP[c] + (STONE_BOT[c] - STONE_TOP[c]) * f)
        buf[t * bw * 3:(t + 1) * bw * 3] = row * bw
    body = Image.frombytes('RGB', (bw, bh), bytes(buf))
    mask = Image.new('L', (bw, bh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bw - 1, bh - 1), radius=int(radius), fill=255)
    img.paste(body, (x0, y0), mask)
    draw.rounded_rectangle((x0, y0, x1, y1), radius=radius, outline=(0, 0, 0), width=max(1, SS))
    hl = max(2, int(bh * 0.26))
    draw.rounded_rectangle((x0 + bw * 0.10, y0 + bh * 0.10, x0 + bw * 0.90, y0 + bh * 0.10 + hl),
                           radius=hl // 2, fill=(255, 255, 255, 58))


def icon(target):
    """一张 target×target 的圆角方图标：桌布 + 三列石子 + 基线 + 一枚金色读数点。"""
    s = target * SS
    img = hashed_field(s, s, BG, BG2, 18).convert('RGBA')
    d = ImageDraw.Draw(img)
    pad = 0.185 * s
    n = len(HEAPS)
    gap = 0.05 * s
    cw = (s - 2 * pad - (n - 1) * gap) / n
    ch = cw * 0.58
    vgap = ch * 0.36
    floor = s - pad - 0.05 * s
    d.rectangle((pad * 0.8, floor + vgap * 0.62, s - pad * 0.8, floor + vgap * 0.62 + 0.012 * s), fill=LINE)
    for i, count in enumerate(HEAPS):
        x0 = pad + i * (cw + gap)
        for t in range(count):
            y1 = floor - t * (ch + vgap)
            stone(img, d, (x0, y1 - ch, x0 + cw, y1), radius=ch * 0.34)
    # 金色读数点落在最矮那列上方：P 位不是"死局"，是"本步没有必胜着法"
    tx = pad + HEAPS.index(min(HEAPS)) * (cw + gap) + cw * 0.5
    ty = floor - min(HEAPS) * (ch + vgap) + vgap * 0.34
    r = cw * 0.075
    d.ellipse((tx - r, ty - r, tx + r, ty + r), fill=PICK)
    return img.convert('RGB').resize((target, target), Image.LANCZOS)


def rounded_safe(img, size, ratio=0.22):
    """maskable：内容缩进 78% 安全区，再压圆角，Android 裁圆/方都不切石子。"""
    inner = int(size * 0.78)
    canvas = Image.new('RGBA', (size, size), BG + (255,))
    canvas.paste(img.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * ratio), fill=255)
    canvas.putalpha(mask)
    return canvas


def spark(color, size=64):
    """粒子贴图：中心实、外缘化开的辉光。游戏里石屑与提示光点直接 drawImage 它。"""
    b = size * 4
    c = b / 2.0
    buf = bytearray(b * b * 4)
    for y in range(b):
        dy = (y - c) / c
        for x in range(b):
            dx = (x - c) / c
            r = (dx * dx + dy * dy) ** 0.5
            a = max(0.0, 1.0 - r)
            a = a * a * a
            core = max(0.0, 1.0 - r * 2.5)
            i = (y * b + x) * 4
            buf[i] = min(255, int(color[0] + (255 - color[0]) * core))
            buf[i + 1] = min(255, int(color[1] + (255 - color[1]) * core))
            buf[i + 2] = min(255, int(color[2] + (255 - color[2]) * core))
            buf[i + 3] = int(255 * a)
    return Image.frombytes('RGBA', (b, b), bytes(buf)).resize((size, size), Image.LANCZOS)


def font(size):
    from PIL import ImageFont
    for p in FONTS:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default(size)


def wrap_to(draw, text, fnt, max_w):
    """按实测宽度断行：中日韩没有空格，只能逐字量。`max_w` 是右边距内可用的像素宽。

    这张卡上一版把正文写糊到画布外去了（"倒推分析"被切成"倒推分析"的前半截），
    所以这里不是"排版好看一点"，是让文字全部落在盘上——宁可多出一行，不许少一个字。
    """
    lines = []
    for hard in str(text).split('\n'):
        cur = ''
        for ch in hard:
            if draw.textlength(cur + ch, font=fnt) <= max_w:
                cur += ch
                continue
            lines.append(cur)
            cur = ch.lstrip()
        lines.append(cur)
    for ln in lines:
        if draw.textlength(ln, font=fnt) > max_w:
            raise RuntimeError('一行文字比可用宽度还长，必然被切掉: %r (%.0f > %.0f)'
                               % (ln[:12], draw.textlength(ln, font=fnt), max_w))
    return lines


def og_card():
    """1200x630 社交卡：左边同一条 1|2|3，右边写它读出来的三个数。"""
    w, h = 1200, 630
    img = hashed_field(w, h, BG, BG2, 12).convert('RGBA')
    d = ImageDraw.Draw(img)
    pad = 62
    n = len(HEAPS)
    cw, ch, vgap, gap = 104, 60, 22, 44
    floor = h - pad - 46
    d.rectangle((pad, floor + vgap * 0.62, pad + n * (cw + gap) - gap, floor + vgap * 0.62 + 3), fill=LINE)
    for i, count in enumerate(HEAPS):
        x0 = pad + i * (cw + gap)
        for t in range(count):
            y1 = floor - t * (ch + vgap)
            stone(img, d, (x0, y1 - ch, x0 + cw, y1), radius=ch * 0.34)
    divide = pad + n * (cw + gap) + 34
    d.line((divide, pad, divide, h - pad), fill=LINE, width=2)
    tx = divide + 56
    avail = w - pad - tx          # 右边距之内才是能写字的地方，超出一个像素都算画坏了
    f_title, f_sub, f_form, f_body, f_foot = font(92), font(32), font(38), font(27), font(28)
    y = pad - 6
    blocks = [
        (wrap_to(d, '尼姆堆', f_title, avail), f_title, INK),
        (wrap_to(d, 'NIM · 每一关的难度都是一次测量', f_sub, avail), f_sub, INK_DIM),
        (wrap_to(d, '1 ⊕ 2 ⊕ 3 = 0  后手必胜的 P 位', f_form, avail), f_form, PICK),
        (wrap_to(d, 'outcome 是 Bouton 闭式判定，par 是完整倒推分析量出来的'
                    '最优局长，两者逐态对账，不是估值。', f_body, avail), f_body, INK_DIM),
    ]
    for lines, fnt, color in blocks:
        for ln in lines:
            d.text((tx, y), ln, font=fnt, fill=color)
            y += int(fnt.size * 1.32) + 10
        y += 6
    foot = wrap_to(d, '取最后一枚者胜 · 或负 · 对手是完美玩家', f_foot, avail)
    # 页脚钉在正文流之下：文案一改多出一行，也不许和它叠在一起
    d.text((tx, max(h - pad - 52, y + 10)), foot[0], font=f_foot, fill=WIN)
    return img.convert('RGB')


def build():
    out = []
    out.append((icon(1024), 'assets/icons/master-1024.png'))
    for size in (512, 192, 180, 96, 64, 48, 32, 16):
        out.append((icon(size), 'assets/icons/icon-%d.png' % size))
    out.append((icon(180), 'assets/icons/apple-touch-icon.png'))
    out.append((rounded_safe(icon(512), 512), 'assets/icons/maskable-512.png'))
    out.append((og_card(), 'assets/og/og-card.png'))
    out.append((hashed_field(768, 512, BG, BG2, 11), 'assets/textures/table.png'))
    out.append((spark(WIN), 'assets/textures/spark-win.png'))
    out.append((spark(PICK), 'assets/textures/spark-pick.png'))
    out.append((spark(LOSE), 'assets/textures/spark-lose.png'))
    out.append((spark(INK), 'assets/textures/spark-stone.png'))
    return out


def main():
    if '--dry' in sys.argv:
        for img, rel in build():
            print('%-40s %dx%d' % (rel, img.size[0], img.size[1]))
        return
    for img, rel in build():
        path = os.path.join(ROOT, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        img.save(path, 'PNG', optimize=True)
        print('%-40s %4dx%-4d %8d B' % (rel, img.size[0], img.size[1], os.path.getsize(path)))


if __name__ == '__main__':
    main()
