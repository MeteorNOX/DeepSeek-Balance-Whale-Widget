"""Mux the source audio track back into the transparent deliverables."""
import os
import subprocess

WS = r"C:\Users\19721\vscode_files\fork_work\DeepSeek-Balance-Whale-Widget-main"
OUT = os.path.join(WS, "output", "VideoProject5_transparent")
SRC = (r"C:\Users\19721\.dsh\attachments\v1\files\6b"
       r"\6b0444061d306354c41dce6b9d73dd7a2962b5b8a8946696b49c7b4f552fe3ef"
       r"\Video Project 5.mp4")
FFMPEG = r"C:\Dev\py311\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

JOBS = [
    ("character_transparent_1920x1080.mov", ["-c:v", "copy", "-c:a", "copy"]),
    ("character_transparent_tight.mov", ["-c:v", "copy", "-c:a", "copy"]),
    ("character_transparent_1920x1080.webm",
     ["-c:v", "copy", "-c:a", "libopus", "-b:a", "128k"]),
    ("character_transparent_tight.webm",
     ["-c:v", "copy", "-c:a", "libopus", "-b:a", "128k"]),
    ("preview_checkerboard_1080p.mp4", ["-c:v", "copy", "-c:a", "copy"]),
]


def main():
    for name, acodec in JOBS:
        src_v = os.path.join(OUT, name)
        if not os.path.exists(src_v):
            print("skip (missing)", name)
            continue
        tmp = os.path.join(OUT, "_tmp_" + name)
        cmd = [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
               "-i", src_v, "-i", SRC, "-map", "0:v:0", "-map", "1:a:0",
               "-shortest"] + acodec + [tmp]
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            print("FAILED", name, p.stderr[-800:])
            continue
        os.replace(tmp, src_v)
        print("muxed audio ->", name, round(os.path.getsize(src_v) / 1e6, 2), "MB")


if __name__ == "__main__":
    main()
