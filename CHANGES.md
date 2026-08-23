# 跳跳喵皮肤（fork 修改说明）

> 基于 MeteorNOX/DeepSeek-Balance-Whale-Widget 的本地定制分支（`feature/tiaotiao`）。
> 本改动只影响挂件外观/音效，不改 DSH 本体、不影响余额/记账逻辑。

## 改动清单

1. **形象：鲸鱼娘 → 跳跳喵**
   - `assets/DSniang1.png` 替换为跳跳（像素风坐姿小猫，蓝底经颜色键抠图 → 全透明背景）
   - 原图备份为 `assets/DSniang1.orig.png`
   - 透明背景解决了原图矩形硬边问题（挂件左下角不再有棱角）
   - 抠图脚本：`make_tiaotiao_cutout.py`（PIL：颜色键 + 高斯羽化 + 内容裁剪）

2. **待机动画：idle bob**
   - `lib/index.js` 追加规则：`.dshwv-img` 2.8s 循环轻微上下浮动 + 微缩放（呼吸感）
   - 不影响按压 Q 弹（按压在 `.dshwv-body`）与左吸附翻转（在 `.dshwv-root`）

3. **新增音效组「猫喵」**
   - `assets/E1.mp3`（按压：上扬啁啾 pip!）/ `assets/E2.mp3`（回弹：下滑 boop）
   - 用 ffmpeg `aevalsrc` 合成（无版权音源）
   - `lib/index.js`：`SOUND_SETS` 新增 `cat` 组；音效选择菜单新增「猫喵」选项

4. **本地预览**：`preview.html`（双击打开即可看效果，无需重启 DSH）

## 怎么进 DSH

重启 DSH（关 "DSH Server" 窗口 → 重新双击启动脚本）→ 浏览器 F5，右下角即跳跳喵。
菜单里音效可切「猫喵」。

## 换成别的形象（奶龙等）

准备一张**透明背景 PNG**，替换 `assets/DSniang1.png` 即可（比例建议接近 707x894 的纵向构图；
参考 `assets/tiaotiao-widget.png`）。也可以先看 `make_tiaotiao_cutout.py` 换源图重新抠。

## 给上游提 PR（可选）

本次改动集中在：`lib/index.js`（3 处）、`assets/`（新增 E1/E2.mp3、tiaotiao-widget.png）、`preview.html`。
若上游愿意接纳"皮肤机制"，更友好的做法是把角色/音效做成可选 skin（不影响默认鲸鱼娘），
即在 `assets/` 下加 `skin/` 覆盖目录，代码里把查找顺序改为"skin 优先、包内兜底"。
