import cv2, numpy as np, os, glob
from PIL import Image

W = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
SRC = os.path.join(W, "output", "VideoProject5_transparent", "png_sequence_1920x1080")
T = os.path.join(W, "matte_work", "export_3")
os.makedirs(T, exist_ok=True)

files = sorted(glob.glob(os.path.join(SRC, "*.png")))
BX0, BY0, BX1, BY1 = [int(v) for v in np.load(os.path.join(W, "matte_work", "_bbox.npy"))]
CW_, CH_ = BX1 - BX0 + 1, BY1 - BY0 + 1
CAN, MARGIN_L, MARGIN_T = 610, 30, 10
scale = (CAN - MARGIN_T) / CH_
pre_w = CW_ + int(round(MARGIN_L / scale))
pre_h = CH_ + int(round(MARGIN_T / scale))
lm, tm = int(round(MARGIN_L / scale)), int(round(MARGIN_T / scale))

out8 = np.zeros((len(files), CAN, CAN, 4), np.uint8)
for i, f in enumerate(files):
    im = cv2.imread(f, cv2.IMREAD_UNCHANGED)                 # BGRA, but transparent px
    sub = im[BY0:BY1 + 1, BX0:BX1 + 1]                        # carry a RED edge bleed.
    a = sub[..., 3]
    # --- neutralise the incoming bleed BEFORE resampling: give the fully transparent
    #     pixels a colour that cannot poison the alpha edges, then resize RGB and alpha
    #     separately so no dark/red colour is averaged into the boundary ---
    sub = sub.copy()
    sub[a == 0, 0:3] = 0                                      # ignore transparent colour entirely
    canvas = np.zeros((pre_h, pre_w, 4), np.uint8)
    canvas[tm:tm + CH_, lm:lm + CW_] = sub
    rgb = canvas[..., :3].astype(np.float32)
    al = canvas[..., 3].astype(np.float32)

    # premultiplied-ish resize: weight colour by alpha so transparent pixels contribute nothing
    w = al / 255.0
    prem = rgb * w[..., None]
    small_prem = cv2.resize(prem, (CAN, CAN), interpolation=cv2.INTER_AREA)
    small_w = cv2.resize(w, (CAN, CAN), interpolation=cv2.INTER_AREA)
    with np.errstate(invalid="ignore", divide="ignore"):
        small_rgb = np.where(small_w[..., None] > 1e-6, small_prem / np.maximum(small_w[..., None], 1e-6), 0.0)
    small_al = np.clip(small_w * 255.0 + 0.5, 0, 255).astype(np.uint8)
    small_rgb = np.clip(small_rgb, 0, 255).astype(np.uint8)
    out8[i, :, :, :3] = small_rgb
    out8[i, :, :, 3] = small_al
    if i % 30 == 0:
        print("  frame", i, flush=True)

# --- recompute edge bleed from the ACTUAL visible character colours ---
for i in range(len(out8)):
    a = out8[i, :, :, 3]
    solid = (a > 0).astype(np.uint8)
    if solid.all() or not solid.any():
        continue
    _, lbl = cv2.distanceTransformWithLabels(1 - solid, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.where(solid > 0)
    n = int(lbl.max()) + 1
    cnt = np.bincount(lbl[ys, xs], minlength=n).astype(np.float64)
    lut = np.zeros((n, 3), np.float32)
    for c in range(3):
        lut[:, c] = np.bincount(lbl[ys, xs], weights=out8[i, ys, xs, c].astype(np.float64), minlength=n) / np.maximum(cnt, 1)
    empty = solid == 0
    out8[i, :, :, :3] = np.where(empty[..., None], lut[lbl].astype(np.uint8), out8[i, :, :, :3])
print("done, saving")
np.save(os.path.join(T, "frames610_3.npy"), out8)

# --- report: what colour now lives under transparent / semi-transparent pixels ---
p = out8[61]
pb, pg, pr, pa = p[..., 0].astype(np.int32), p[..., 1].astype(np.int32), p[..., 2].astype(np.int32), p[..., 3]
for lo, hi, tag in [(0, 1, "alpha==0"), (1, 40, "alpha 1-40"), (40, 200, "alpha 40-200"), (200, 256, "alpha>=200")]:
    m = (pa >= lo) & (pa < hi)
    if m.sum() == 0:
        print(f"  {tag}: none"); continue
    print(f"  {tag}: n={int(m.sum())} mean RGB=({pr[m].mean():.1f},{pg[m].mean():.1f},{pb[m].mean():.1f})")

# side-by-side over white against the OLD export
old = np.load(os.path.join(W, "matte_work", "export_2", "frames610_2.npy"))[61] if os.path.exists(
    os.path.join(W, "matte_work", "export_2", "frames610_2.npy")) else None


def onwhite(bgra):
    al = bgra[..., 3:4].astype(np.float32) / 255.0
    return (bgra[..., :3].astype(np.float32) * al + 255 * (1 - al)).astype(np.uint8)


if old is not None:
    gap = np.full((610, 20, 3), 255, np.uint8)
    cv2.imwrite(os.path.join(T, "old_vs_new_on_white.png"), np.hstack([onwhite(old), gap, onwhite(p)]))
    print("wrote old_vs_new_on_white.png")
