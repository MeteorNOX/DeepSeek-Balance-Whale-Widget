# -*- coding: utf-8 -*-
"""参考音审计：在建参考音之前，逐条 ASR 源素材，拦下"非语音/呻吟/只有语气词"的片段。

为什么需要它（教训）：撒娇档参考音首位曾放进 `战斗语音 - Battle/vo_diona_life_less30_02.wav`
（战斗受伤的呻吟，台词标注是「喵…喵…！」），ASR 只能听出「呀呀。」、无情绪标签。
该片段权重最高 → 整档配音变成"光呻吟、发音不对"。这类错误靠肉眼看文件名/字幕看不出来。

用法:
    python audit_refs.py <cfg.json> [--json 输出.json]
    cfg 格式与 build_refs.py 相同: { "voices": { "out.wav": { "dir": ..., "files": [...] } } }
退出码非 0 表示有片段不合格（可直接用来 gate 建参考音这一步）。
"""
import argparse
import json
import os
import re
import subprocess
import sys

SKILL_DIR = r"C:\Users\linmz\.agents\skills\indextts2-batch-tts\scripts"
ASR = os.path.join(SKILL_DIR, "asr_transcribe.py")

BATTLE_HINTS = ("战斗语音", "Battle", "battle", "受伤", "受击")
INTERJECTION_ONLY = re.compile(r"^[嗯啊呜呀哦哈喵呃嗨哎诶哼噢喔嘞啰哟]+[。！？…、,，~～]*$")
STAGE_DIRECTION = re.compile(r"[（(][^）)]*[）)]")


def resolve(root, rel):
    """cfg 里的文件名可能是 '子目录/xxx.wav' 或裸文件名（裸名递归找）。"""
    p = os.path.join(root, rel.replace("/", os.sep))
    if os.path.exists(p):
        return p
    base = os.path.basename(rel)
    for dirpath, _dirnames, filenames in os.walk(root):
        if base in filenames:
            return os.path.join(dirpath, base)
    return None


def transcribe(files):
    """一次调用 ASR 脚本（模型只加载一次），返回 {basename: {text, emotion}}。"""
    out_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out", "_audit_asr.json")
    os.makedirs(os.path.dirname(out_json), exist_ok=True)
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    subprocess.run([sys.executable, ASR, *files, "--json", out_json],
                   check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with open(out_json, encoding="utf-8") as fh:
        rows = json.load(fh)
    return {os.path.basename(r["file"]): r for r in rows}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cfg")
    ap.add_argument("--json", default=None)
    a = ap.parse_args()

    with open(a.cfg, encoding="utf-8") as fh:
        cfg = json.load(fh)

    # 收集所有待审片段（去重）
    wanted = []
    for out_name, spec in cfg.get("voices", {}).items():
        root = spec["dir"]
        for rel in spec["files"]:
            p = resolve(root, rel)
            if not p:
                print("!! 找不到源素材: %s (in %s)" % (rel, out_name))
                continue
            if p not in wanted:
                wanted.append(p)

    print("审计 %d 条源素材 ..." % len(wanted))
    asr = transcribe(wanted)

    bad = []
    report = []
    for p in wanted:
        base = os.path.basename(p)
        row = asr.get(base, {})
        text = (row.get("text") or "").strip()
        emotion = row.get("emotion") or []
        reasons = []
        if any(h in p for h in BATTLE_HINTS):
            reasons.append("来自战斗/受击素材目录（多半是呻吟，不是台词）")
        if not text:
            reasons.append("ASR 听不出任何内容（非语音）")
        elif len(text) <= 2 or INTERJECTION_ONLY.match(text):
            reasons.append("只有语气词，没有实际台词")
        report.append({"file": base, "path": p, "text": text, "emotion": emotion, "reasons": reasons})
        mark = "✗" if reasons else "✓"
        print("  %s %-38s 「%s」%s" % (mark, base, text, ("  << " + "；".join(reasons)) if reasons else ""))
        if reasons:
            bad.append(base)

    print("\n不合格 %d / %d 条" % (len(bad), len(wanted)))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=1)
        print("-> %s" % a.json)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
