"""Black-background keying, v2.

v1 pulled in H.264 blocking noise because the 'weak' threshold (3) sits below the
codec's noise floor (~9).  v2 constrains the soft rim to a fixed distance from the
solid core and only keeps noise pixels that are actually attached to it.

  mx      = max colour channel
  strong  = mx > STRONG                    solid artwork core
  keep    = reconstruction of strong inside mx > NOISE   (attached, non-black)
  dist    = distance to strong
  opaque  = strong | (keep & dist > R)     anything deep inside is fully solid
  rim     = keep & 0 < dist <= R           the anti-aliased boundary band
  alpha   = 1 on opaque; on the rim the least-squares solution of C = a*F with F
            taken from the nearest opaque pixel; 0 everywhere else
"""
import os
import sys

import cv2
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matte import W, CS, X0, Y0, crop_stack, decode  # noqa: E402

STRONG = 26.0
NOISE = 8.0
R = 4
MIN_ALPHA = 0.04
MIN_BLOB = 64


def key_frame(rgb, temporal_med=False):
    c = rgb.astype(np.float32)
    mx = c.max(axis=2)
    strong = mx > STRONG
    keep = ndi.binary_propagation(strong, mask=mx > NOISE)
    dist = ndi.distance_transform_edt(~strong)
    opaque = strong | (keep & (dist > R))
    rim = keep & (dist > 0) & (dist <= R)

    _, (iy, ix) = ndi.distance_transform_edt(~opaque, return_indices=True)
    fest = c[iy, ix]
    num = (c * fest).sum(axis=2)
    den = (fest * fest).sum(axis=2) + 1e-6
    a = np.clip(num / den, 0.0, 1.0)
    a = np.where(opaque, 1.0, a)
    a = np.where(opaque | rim, a, 0.0)
    a[a < MIN_ALPHA] = 0.0

    lab, n = ndi.label(a > 0.5)
    if n:
        sizes = ndi.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
        big = int(np.argmax(sizes)) + 1
        drop = np.isin(lab, [i + 1 for i, s in enumerate(sizes)
                             if s < MIN_BLOB and i + 1 != big])
        a[drop] = 0.0

    if temporal_med:
        pass  # applied as a stack later

    fg = np.clip(c / np.maximum(a, 1e-3)[..., None], 0, 255)
    out = np.where(a[..., None] > 0, fg, fest).astype(np.uint8)
    return a.astype(np.float32), out, mx


def main():
    tag = sys.argv[1] if len(sys.argv) > 1 else "v2"
    crops = crop_stack(decode())
    n = len(crops)
    alpha = np.zeros((n, CS, CS), np.float16)
    color = np.zeros((n, CS, CS, 3), np.uint8)
    for i in range(n):
        a, col, _ = key_frame(crops[i])
        alpha[i] = a.astype(np.float16)
        color[i] = col
        if i % 30 == 0:
            print(f"  {i}/{n}", flush=True)

    # temporal median-3 on alpha to kill codec flicker on the rim
    a32 = alpha.astype(np.float32)
    padded = np.concatenate([a32[:1], a32, a32[-1:]], axis=0)
    amed = np.median(np.stack([padded[:-2], padded[1:-1], padded[2:]]), axis=0)
    alpha_med = amed.astype(np.float16)

    np.save(os.path.join(W, f"alpha_{tag}.npy"), alpha)
    np.save(os.path.join(W, f"alpha_{tag}_tm.npy"), alpha_med)
    np.save(os.path.join(W, f"color_{tag}.npy"), color)

    for name, arr in (("raw", a32), ("temporal-median-3", amed)):
        cov = (arr > 0.5).mean(axis=(1, 2))
        soft = ((arr > 0) & (arr < 0.98)).sum(axis=(1, 2))
        print(f"{name}: coverage>0.5 std {cov.std():.5f}  soft px "
              f"min {soft.min()} max {soft.max()} mean {soft.mean():.0f}")

    # how much does the alpha change frame to frame (flicker proxy)
    d = np.abs(np.diff(a32, axis=0))
    print("raw frame-to-frame |dalpha|>0.1 px: mean %.1f max %d" %
          ((d > 0.1).sum(axis=(1, 2)).mean(), (d > 0.1).sum(axis=(1, 2)).max()))
    dm = np.abs(np.diff(amed, axis=0))
    print("tm  frame-to-frame |dalpha|>0.1 px: mean %.1f max %d" %
          ((dm > 0.1).sum(axis=(1, 2)).mean(), (dm > 0.1).sum(axis=(1, 2)).max()))


if __name__ == "__main__":
    main()
