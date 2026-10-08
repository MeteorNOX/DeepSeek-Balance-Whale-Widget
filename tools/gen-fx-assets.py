#!/usr/bin/env python3
"""重新生成 assets/fx-*.png(彩蛋素材)。

素材全部取自 Minecraft 原版资源,不做任何手绘:
  · 铁砧      = 原版铁砧的背包图标渲染图(32x32)
  · 经验球    = 原版 entity/experience_orb.png 里那只实心球格(16x16)
  · 烟雾粒子  = 原版 particle/generic_0..7.png 八帧,拼成一张横向精灵表
  · 装备      = 原版 item/*.png 的 16x16 贴图(钻石剑 / 钻石镐 / 金苹果 / 金锭 / 绿宝石)

像素画一律用最近邻放大,避免被插值糊掉。用法:
    pip install Pillow
    python tools/gen-fx-assets.py
"""
import io
import os
import sys
import urllib.request

from PIL import Image

BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.20.4/assets/minecraft/textures'
WIKI = 'https://minecraft.wiki/images'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')

# (下载地址, 落地文件名)
SOURCES = [
    (WIKI + '/Invicon_Anvil.png', 'anvil_item.png'),
    (BASE + '/entity/experience_orb.png', 'experience_orb.png'),
    (BASE + '/item/diamond_sword.png', 'diamond_sword.png'),
    (BASE + '/item/diamond_pickaxe.png', 'diamond_pickaxe.png'),
    (BASE + '/item/golden_apple.png', 'golden_apple.png'),
    (BASE + '/item/gold_ingot.png', 'gold_ingot.png'),
    (BASE + '/item/emerald.png', 'emerald.png'),
] + [(BASE + '/particle/generic_%d.png' % i, 'generic_%d.png' % i) for i in range(8)]

# 放大倍数
ANVIL_ZOOM = 8
ORB_ZOOM = 8
ITEM_ZOOM = 8
SMOKE_ZOOM = 6


def fetch(url, tries=4):
    last = None
    for _ in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'dsh-whale-widget/asset-builder'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except Exception as e:      # 网络抖动很常见,重试即可
            last = e
    raise RuntimeError('下载失败 %s: %s' % (url, last))


def main():
    cache = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.mc-cache')
    os.makedirs(cache, exist_ok=True)
    for url, name in SOURCES:
        p = os.path.join(cache, name)
        if not os.path.exists(p) or os.path.getsize(p) == 0:
            data = fetch(url)
            with open(p, 'wb') as f:
                f.write(data)
            print('  下载 %-22s %d 字节' % (name, len(data)))
        else:
            print('  复用 %-22s' % name)

    def load(n):
        return Image.open(os.path.join(cache, n)).convert('RGBA')

    def save(im, name):
        im.save(os.path.join(OUT, name))
        print('  %-24s %s' % (name, '%dx%d' % im.size))

    # 铁砧:原版背包图标就是 3D 渲染,直接最近邻放大
    anvil = load('anvil_item.png')
    save(anvil.resize((anvil.width * ANVIL_ZOOM, anvil.height * ANVIL_ZOOM), Image.NEAREST), 'fx-anvil.png')

    # 经验球:64x64 是 4x4 张 16x16,挑“中心最不透明”的那格当实心球
    orb = load('experience_orb.png')
    px = orb.load()
    best = None
    for cy in range(4):
        for cx in range(4):
            s = 0
            for y in range(cy * 16 + 4, cy * 16 + 12):
                for x in range(cx * 16 + 4, cx * 16 + 12):
                    s += px[x, y][3]
            if best is None or s > best[0]:
                best = (s, cx, cy)
    _, bx, by = best
    cell = orb.crop((bx * 16, by * 16, bx * 16 + 16, by * 16 + 16))
    save(cell.resize((16 * ORB_ZOOM, 16 * ORB_ZOOM), Image.NEAREST), 'fx-exp-orb.png')

    # 烟雾:8 帧 8x8 横向拼接成精灵表,前端用 background-position 逐帧播放
    sheet = Image.new('RGBA', (8 * 8, 8), (0, 0, 0, 0))
    for i in range(8):
        sheet.paste(load('generic_%d.png' % i), (i * 8, 0))
    save(sheet.resize((sheet.width * SMOKE_ZOOM, sheet.height * SMOKE_ZOOM), Image.NEAREST), 'fx-smoke.png')

    # 装备
    for src, dst in [('diamond_sword.png', 'fx-item-sword.png'),
                     ('diamond_pickaxe.png', 'fx-item-pickaxe.png'),
                     ('golden_apple.png', 'fx-item-apple.png'),
                     ('gold_ingot.png', 'fx-item-ingot.png'),
                     ('emerald.png', 'fx-item-emerald.png')]:
        im = load(src)
        save(im.resize((im.width * ITEM_ZOOM, im.height * ITEM_ZOOM), Image.NEAREST), dst)
    print('完成')


if __name__ == '__main__':
    main()

