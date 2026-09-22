"""Verify the encoded deliverables: alpha really survives, sizes/durations ok."""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matte import W, CS, X0, Y0, crop_stack, decode  # noqa: E402

WS = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
OUT = os.path.join(WS, "output", "VideoProject5_transparent")
FFMPEG = r"C:\Dev\py311\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
TMP = os.path.join(W, "_verify")
FRAME = 61
MARGIN = 8
ALPHA_EPS = 0.004


def probe(path):
    p = subprocess.run([FFMPEG, "-hide_banner", "-i", path],
                       capture_output=True, text=True)
    return [ln.strip() for ln in p.stderr.splitlines()
            if any(k in ln for k in ("Stream #", "Duration", "alpha_mode"))]


def decode_rgba(path, idx, out_png, vp9=False):
    cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error"]
    if vp9:
        cmd += ["-c:v", "libvpx-vp9"]
    cmd += ["-i", path, "-vf", f"select=eq(n\\,{idx})", "-vsync", "0",
            "-frames:v", "1", "-pix_fmt", "rgba", "-update", "1", out_png]
    subprocess.run(cmd, check=True)
    img = cv2.imread(out_png, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.dtype == np.uint16:          # prores 4444 -> 16-bit png
        f = img.astype(np.float32) / 65535.0
    elif img.dtype == np.uint8:
        f = img.astype(np.float32) / 255.0
    else:
        return None
    if f.ndim != 3 or f.shape[2] != 4:
        return {"channels": None if f.ndim < 3 else f.shape[2]}
    # cv2 loads BGR(A) -> hand back RGB(A) to match the numpy pipeline
    return {"rgb": f[:, :, [2, 1, 0]], "a": f[:, :, 3]}


def tight_box(alpha):
    vis = np.zeros((CS, CS), bool)
    for a in alpha:
        vis |= a > ALPHA_EPS
    ys, xs = np.nonzero(vis)
    ty0 = max(0, ys.min() - MARGIN)
    ty1 = min(CS, ys.max() + 1 + MARGIN)
    tx0 = max(0, xs.min() - MARGIN)
    tx1 = min(CS, xs.max() + 1 + MARGIN)
    if (ty1 - ty0) % 2:
        ty1 -= 1
    if (tx1 - tx0) % 2:
        tx1 -= 1
    return ty0, ty1, tx0, tx1


def main():
    os.makedirs(TMP, exist_ok=True)
    alpha = np.load(os.path.join(W, "alpha_v2.npy")).astype(np.float32)
    color = np.load(os.path.join(W, "color_v2.npy"))
    ty0, ty1, tx0, tx1 = tight_box(alpha)
    full_a = np.zeros((1080, 1920), np.float32)
    full_a[Y0:Y0 + CS, X0:X0 + CS] = alpha[FRAME]
    tight_a = full_a[ty0 + Y0:ty1 + Y0, tx0 + X0:tx1 + X0]
    full_rgb = np.zeros((1080, 1920, 3), np.float32)
    tight_rgb = np.zeros_like(full_rgb[ty0 + Y0:ty1 + Y0, tx0 + X0:tx1 + X0])
    w = color[FRAME]
    m = alpha[FRAME] > 0
    sub = full_rgb[Y0:Y0 + CS, X0:X0 + CS]
    sub[m] = w[m] / 255.0
    tight_rgb = full_rgb[ty0 + Y0:ty1 + Y0, tx0 + X0:tx1 + X0]

    cases = [
        ("character_transparent_1920x1080.mov", False, full_a, full_rgb),
        ("character_transparent_tight.mov", False, tight_a, tight_rgb),
        ("character_transparent_1920x1080.webm", True, full_a, full_rgb),
        ("character_transparent_tight.webm", True, tight_a, tight_rgb),
    ]
    report = {}
    for name, vp9, exp_a, exp_rgb in cases:
        path = os.path.join(OUT, name)
        rec = {"MB": round(os.path.getsize(path) / 1e6, 2), "probe": probe(path)}
        png = os.path.join(TMP, name.replace(".", "_") + ".png")
        got = decode_rgba(path, FRAME, png, vp9=vp9)
        if not isinstance(got, dict) or "a" not in got:
            rec["decode"] = got
            report[name] = rec
            continue
        a = got["a"]
        rec["shape"] = list(a.shape)
        if a.shape == exp_a.shape:
            da = np.abs(a - exp_a)
            rec["alpha"] = {
                "min": round(float(a.min()), 3), "max": round(float(a.max()), 3),
                "soft_px": int(((a > 0.02) & (a < 0.98)).sum()),
                "mean_abs_err_vs_source": round(float(da.mean()), 4),
                "px_err_gt_0.1": int((da > 0.1).sum()),
                "px_err_gt_0.1_pct_of_fg": round(
                    float((da > 0.1).sum()) / max(int((exp_a > 0.02).sum()), 1) * 100, 3),
            }
            edge = (exp_a > 0.02) & (exp_a < 0.98)
            if edge.any():
                rec["alpha"]["rim_mean_abs_err"] = round(float(da[edge].mean()), 4)
            drgb = np.abs(got["rgb"] - exp_rgb)
            inside = exp_a > 0.9
            rec["rgb_err_inside_mean"] = round(float(drgb[inside].mean() * 255), 3)
            rec["rgb_err_inside_p99"] = round(
                float(np.percentile(drgb[inside] * 255, 99)), 2)
        report[name] = rec

    prev = os.path.join(OUT, "preview_checkerboard_1080p.mp4")
    report["preview_checkerboard_1080p.mp4"] = {
        "MB": round(os.path.getsize(prev) / 1e6, 2), "probe": probe(prev)}
    print(json.dumps(report, indent=2, ensure_ascii=False))

    # QC sheet: original plate vs decoded transparent result over a checkerboard
    frames = decode()
    yy, xx = np.mgrid[0:1080, 0:1920]
    chk = ((((yy // 16) + (xx // 16)) % 2) * 51 + 153).astype(np.float32)
    chk = np.dstack([chk] * 3)
    tiles = []
    for idx in (0, 61, 100):
        png = os.path.join(TMP, f"sheet_{idx}.png")
        g = decode_rgba(os.path.join(OUT, "character_transparent_1920x1080.webm"),
                        idx, png, vp9=True)
        if not isinstance(g, dict) or "a" not in g:
            continue
        af = g["a"][..., None]
        comp = (g["rgb"] * 255 * af + chk * (1 - af)).astype(np.uint8)
        row = np.concatenate([frames[idx], comp], axis=1)
        row = cv2.resize(row, (row.shape[1] // 3, row.shape[0] // 3),
                         interpolation=cv2.INTER_AREA)
        tiles.append(row)
    if tiles:
        fp = os.path.join(OUT, "qc_decoded_webm.png")
        cv2.imwrite(fp, cv2.cvtColor(np.concatenate(tiles, axis=0), cv2.COLOR_RGB2BGR))
        print("wrote", fp)


if __name__ == "__main__":
    main()
