import numpy as np, os, subprocess
from PIL import Image
import imageio_ffmpeg

W = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
A = os.path.join(W, "assets")
T = os.path.join(W, "matte_work", "LOOK")
os.makedirs(T, exist_ok=True)
ff = imageio_ffmpeg.get_ffmpeg_exe()

strip = np.zeros((56, 610, 3), np.uint8)
strip[:, :305] = (255, 0, 0)
strip[:, 305:] = (0, 0, 255)          # left RED, right BLUE (calibration)


def flat(rgba):
    im = Image.fromarray(rgba, "RGBA")
    bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
    return np.array(Image.alpha_composite(bg, im).convert("RGB"))


subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i",
                os.path.join(A, "DSniang_eating_rice_2.webm"), "-vf", "select=eq(n\\,61)",
                "-frames:v", "1", "-pix_fmt", "rgba", os.path.join(T, "w.png")], capture_output=True)

tiles = [flat(np.array(Image.open(os.path.join(A, "DSniang1.png")).convert("RGBA"))),
         flat(np.array(Image.open(os.path.join(A, "DSniang_eating_rice_2.png")).convert("RGBA"))),
         flat(np.array(Image.open(os.path.join(T, "w.png")).convert("RGBA")))]
gap = np.full((610, 12, 3), 255, np.uint8)
row = tiles[0]
for t in tiles[1:]:
    row = np.hstack([row, gap, t])

wide = np.full((56, row.shape[1], 3), 255, np.uint8)
wide[:, :610] = strip
full = np.vstack([wide, row])
Image.fromarray(full).save(os.path.join(T, "SDEFINITIVE_check.png"))
print("wrote LOOK/SDEFINITIVE_check.png  (strip: LEFT=RED, RIGHT=BLUE)")
print("  panels: [DSniang1.png] [new PNG] [new WEBM]")
