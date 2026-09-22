import numpy as np, os, cv2, subprocess, colorsys
from PIL import Image
import imageio_ffmpeg

W = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
A = os.path.join(W, "assets")
T = os.path.join(W, "matte_work", "DEFINITIVE")
SEQ = os.path.join(T, "seq")
os.makedirs(SEQ, exist_ok=True)
ff = imageio_ffmpeg.get_ffmpeg_exe()

raw = np.load(os.path.join(W, "matte_work", "export_3", "frames610_3.npy"))
# THE FIX: this array was built by a pipeline that swapped R and B (verified against
# DSniang1.png: its hue is 231 deg = blue, this array's is 1.7 deg = red, identical
# structure). Correct the colour channels, keep alpha (index 3) untouched.
src = raw.copy()
src[..., 0], src[..., 2] = raw[..., 2], raw[..., 0]
N = len(src)

print("after correcting R/B:")
vis = src[61][..., 3] > 200
px = src[61][..., :3][vis][::7] / 255.0
ang = np.array([colorsys.rgb_to_hsv(*q)[0] * 2 * np.pi for q in px])
hue = (np.arctan2(np.sin(ang).mean(), np.cos(ang).mean()) % (2 * np.pi)) / (2 * np.pi) * 360
print(f"  frame 61 mean hue = {hue:.1f} deg   (DSniang1 = 231.0 deg = blue)")


def to_bgra(x):
    return np.ascontiguousarray(cv2.cvtColor(np.ascontiguousarray(x), cv2.COLOR_RGBA2BGRA))


for i in range(N):
    cv2.imwrite(os.path.join(SEQ, f"{i:04d}.png"), to_bgra(src[i]), [cv2.IMWRITE_PNG_COMPRESSION, 6])

png = os.path.join(A, "DSniang_eating_rice_2.png")
cv2.imwrite(png, to_bgra(src[0]), [cv2.IMWRITE_PNG_COMPRESSION, 9])

webm = os.path.join(A, "DSniang_eating_rice_2.webm")
p = subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-framerate", "30", "-i",
                    os.path.join(SEQ, "%04d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                    "-b:v", "0", "-crf", "25", "-auto-alt-ref", "0", "-row-mt", "1",
                    "-metadata:s:v:0", "alpha_mode=1", webm], capture_output=True)
print("webm rc", p.returncode, p.stderr.decode()[:120])

webp = os.path.join(A, "DSniang_eating_rice_2.webp")
ims = [Image.open(os.path.join(SEQ, f"{i:04d}.png")).convert("RGBA") for i in range(N)]
ims[0].save(webp, save_all=True, append_images=ims[1:], duration=33, loop=0,
            lossless=False, quality=80, method=4)


def hue_of(arr, frame=61):
    a = arr if arr.ndim == 3 else arr[frame]
    v = a[..., 3] > 200
    q = a[..., :3][v][::7] / 255.0
    g = np.array([colorsys.rgb_to_hsv(*z)[0] * 2 * np.pi for z in q])
    return (np.arctan2(np.sin(g).mean(), np.cos(g).mean()) % (2 * np.pi)) / (2 * np.pi) * 360


def load_webm(frame=61):
    o = os.path.join(T, "v.png")
    subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-c:v", "libvpx-vp9", "-i", webm,
                    "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1", "-pix_fmt", "rgba", o],
                   capture_output=True)
    return np.array(Image.open(o).convert("RGBA"))


wp = Image.open(webp); wp.seek(61)
res = {
    "SOURCE(fixed)": src[61],
    "PNG": np.array(Image.open(png).convert("RGBA")),
    "WEBM": load_webm(),
    "WEBP": np.array(wp.convert("RGBA")),
    "DSniang1": np.array(Image.open(os.path.join(A, "DSniang1.png")).convert("RGBA")),
}
print("\nFINAL VERIFICATION (frame 0 / 61):")
for tag, arr in res.items():
    f = 0 if tag == "PNG" else 61
    a = np.array(Image.open(png).convert("RGBA")) if tag == "PNG" else arr
    v = a[..., 3] > 200
    print(f"  {tag:13s} hue={hue_of(a):6.1f}  alpha_mean={a[...,3].mean():6.1f}  opaque={v.mean():.3f}  "
          f"visRGB=({a[...,0][v].mean():5.1f},{a[...,1][v].mean():5.1f},{a[...,2][v].mean():5.1f})")

print("\n  PNG vs fixed source (frame 0): max diff",
      int(np.abs(np.array(Image.open(png).convert('RGBA')).astype(int) - src[0].astype(int)).max()))
d = np.abs(load_webm().astype(int) - src[61].astype(int))
print(f"  WEBM vs fixed source: RGB mean|d|={d[...,:3].mean():.2f} alpha mean|d|={d[...,3].mean():.2f}")
print("\nsizes:", {os.path.basename(f): round(os.path.getsize(f) / 1024, 1) for f in (png, webm, webp)})
