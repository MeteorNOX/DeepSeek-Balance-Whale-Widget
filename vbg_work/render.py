"""Final render: RGBA PNG sequences, ProRes 4444, VP9-alpha WebM, preview MP4.

Inputs (from extract2.py):  alpha_v2.npy (float16 HxW stack), color_v2.npy (uint8)
Both are on the fixed CS x CS crop placed at (X0, Y0) of the 1920x1080 plate.
"""
import os
import shutil
import subprocess
import sys

import cv2
import numpy as np
from scipy import ndimage as ndi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matte import W, CS, X0, Y0, crop_stack, decode  # noqa: E402

WS = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
OUT = os.path.join(WS, "output", "VideoProject5_transparent")
FFMPEG = r"C:\Dev\py311\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
FPS = 30
FW, FH = 1920, 1080
MARGIN = 8
ALPHA_EPS = 0.004


def checker(h, w, s=16):
    yy, xx = np.mgrid[0:h, 0:w]
    c = (((yy // s) + (xx // s)) % 2).astype(np.uint8)
    return (c * 51 + 153)[..., None].repeat(3, 2).astype(np.uint8)


def build_bleed_canvas(seed_rgb, seed_alpha):
    """Static colour plate: character colours bled over the whole 1920x1080 frame."""
    canvas = np.zeros((FH, FW, 3), np.uint8)
    canvas[Y0:Y0 + CS, X0:X0 + CS] = np.where(
        (seed_alpha > 0)[..., None], seed_rgb, 0)
    filled = np.zeros((FH, FW), bool)
    filled[Y0:Y0 + CS, X0:X0 + CS] = seed_alpha > 0
    _, (iy, ix) = ndi.distance_transform_edt(~filled, return_indices=True)
    return canvas[iy, ix]


def run(cmd, label):
    print(f"  $ {label}", flush=True)
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        print(p.stdout[-3000:])
        print(p.stderr[-3000:])
        raise SystemExit(f"ffmpeg failed: {label}")
    tail = [ln for ln in p.stderr.strip().splitlines() if ln.strip()][-1:]
    if tail:
        print("    " + tail[0][:160], flush=True)


def main():
    alpha = np.load(os.path.join(W, "alpha_v2.npy")).astype(np.float32)
    color = np.load(os.path.join(W, "color_v2.npy"))
    crops = crop_stack(decode())
    n = len(alpha)
    assert len(crops) == n, (len(crops), n)

    # tight box from the union of everything ever visible
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
    print(f"tight box in crop coords: x {tx0}..{tx1} y {ty0}..{ty1} "
          f"-> {tx1-tx0}x{ty1-ty0}")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    dirs = {
        "full": os.path.join(OUT, "png_sequence_1920x1080"),
        "tight": os.path.join(OUT, "png_sequence_tight"),
        "prev": os.path.join(W, "_prev_frames"),
    }
    for d in dirs.values():
        os.makedirs(d, exist_ok=True)

    bleed = build_bleed_canvas(color[61], alpha[61])
    chk = checker(FH, FW)

    for i in range(n):
        a = alpha[i]
        col = color[i]
        full_c = bleed.copy()
        m = a > 0
        window = full_c[Y0:Y0 + CS, X0:X0 + CS]
        window[m] = col[m]
        full_a = np.zeros((FH, FW), np.float32)
        full_a[Y0:Y0 + CS, X0:X0 + CS] = a
        a8 = np.clip(full_a * 255.0 + 0.5, 0, 255).astype(np.uint8)

        rgba = np.dstack([cv2.cvtColor(full_c, cv2.COLOR_RGB2BGR), a8])
        cv2.imwrite(os.path.join(dirs["full"], f"{i:04d}.png"), rgba)
        cv2.imwrite(os.path.join(dirs["tight"], f"{i:04d}.png"),
                    rgba[ty0 + Y0:ty1 + Y0, tx0 + X0:tx1 + X0])

        prev = (full_c.astype(np.float32) * full_a[..., None]
                + chk.astype(np.float32) * (1 - full_a[..., None]))
        cv2.imwrite(os.path.join(dirs["prev"], f"{i:04d}.png"),
                    cv2.cvtColor(prev.astype(np.uint8), cv2.COLOR_RGB2BGR))
        if i % 30 == 0:
            print(f"  frames {i}/{n}", flush=True)
    print("png sequences written", flush=True)

    full_png = os.path.join(dirs["full"], "%04d.png")
    tight_png = os.path.join(dirs["tight"], "%04d.png")
    prev_png = os.path.join(dirs["prev"], "%04d.png")

    common = ["-y", "-framerate", str(FPS), "-i"]
    # ProRes 4444 with alpha (editing)
    run([FFMPEG] + common + [full_png, "-c:v", "prores_ks", "-profile:v", "4444",
                             "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                             "-vendor", "apl0",
                             os.path.join(OUT, "character_transparent_1920x1080.mov")],
        "prores full")
    run([FFMPEG] + common + [tight_png, "-c:v", "prores_ks", "-profile:v", "4444",
                             "-pix_fmt", "yuva444p10le", "-alpha_bits", "16",
                             "-vendor", "apl0",
                             os.path.join(OUT, "character_transparent_tight.mov")],
        "prores tight")
    # VP9 with alpha (web / OBS)
    vp9 = ["-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0",
           "-crf", "24", "-row-mt", "1", "-cpu-used", "2", "-auto-alt-ref", "0"]
    run([FFMPEG] + common + [full_png] + vp9 +
        [os.path.join(OUT, "character_transparent_1920x1080.webm")], "vp9 full")
    run([FFMPEG] + common + [tight_png] + vp9 +
        [os.path.join(OUT, "character_transparent_tight.webm")], "vp9 tight")
    # plain H.264 preview over a checkerboard (plays anywhere)
    run([FFMPEG] + common + [prev_png, "-c:v", "libx264", "-crf", "16",
                             "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                             os.path.join(OUT, "preview_checkerboard_1080p.mp4")],
        "h264 preview")
    shutil.rmtree(dirs["prev"], ignore_errors=True)
    print("OUT", OUT)


if __name__ == "__main__":
    main()
