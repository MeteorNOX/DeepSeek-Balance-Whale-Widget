# 语录配音工具（voice-pack）

给挂件的「随机语句」模块配音用的最小工具集：**审计参考音 → 批量生成 → 打进语音包 → 校验**。

## 在这里的东西

| 文件 | 作用 |
|---|---|
| `sync_quotes_from_widget.mjs` | **语录清单的唯一正确来源**：直接从挂件源码 `BUBBLE_DEFAULT_ITEMS` 抠出内置语录（含嵌套 `choice` 结构），按文本沿用旧档位、列出待归类的新条目 |
| `verify_coverage.mjs` | **覆盖率闸门**：挂件内置语录 ↔ 已安装语音包逐条核对；有语录没声音 / 包里有挂件不会显示的条目 → 退出码 1 |
| `audit_refs.py` | **建参考音之前的闸门**：逐条 ASR 源素材，拦下"非语音 / 只有语气词 / 来自战斗·受击目录"的片段。不合格退出码 1，可直接卡住建包流程 |
| `build_pack.mjs` | 把生成好的 wav + 语录原文打成语音包，落到 `~/.dsh/whale-voice/`（清单 + 注册表 + 选中配置），幂等可重跑；**同一句给多条录音会自动归并成"变体"** |
| `runtime-variants.test.mjs` | **运行时多变体自测**：真跑一遍 `assets/whale-voice-runtime.js`（桩 window/Audio/fetch），验证"多版本都会播 / 不连续重复 / 单版本向后兼容 / 未匹配静默" |

批量生成、择优、试听页这些属于**具体一次配音工程**的工作目录，不入库（依赖具体音色素材与试听页面）。
本次迪奥娜的完整工程目录里另有：`gen_jobs.mjs`（语录 → 任务）、`pick_best.mjs`（多 take 按 ASR 择优）、
`assemble_final.mjs`（汇总成品）、`build_all_page.mjs`（试听页）、`verify_default_quotes.mjs`（覆盖率验收的工作副本）。

## 多变体：同一句话多个版本随机播放

**怎么加**：在 jobs 里给同一句（`widget_text` 相同）**放多条录音**即可，第一条是主版本，其余自动进 `variants`：

```
jobs.json:  [ {out: take_a.wav, widget_text: "哦鲸鲸...", text: "哦…鲸鲸…"},
              {out: take_b.wav, widget_text: "哦鲸鲸...", text: "哦…鲸鲸…"},
              {out: take_c.wav, widget_text: "哦鲸鲸...", text: "哦…鲸鲸…"} ]
→ 包内文件: quote.003.<hash8>.wav / .v2.wav / .v3.wav
→ 清单:     { id: "quote.003", file: "quote.003.<hash8>.wav",
              variants: [ {file: "quote.003.<hash8>.wav", ...}, {file: "...v2.wav"}, {file: "...v3.wav"} ] }
```

- **向后兼容**：`file` 始终是主版本；没有 `variants` 的旧清单照旧可用（前端只认 `url`）。
- **宿主/前端链路**：`publicManifest` 输出 `urls: [...]`（主版本 URL 不带参数，其余带 `&v=N`），
  `resolveById(homeDir, packId, id, variantIndex)` 按 `v` 取第 N 个文件；前端每次随机挑一个，
  **避开上一次播的那个**（不会连着两次同一版本）。
- **变体间响度必须接近（≤1.5dB）**：`build_pack.mjs` 会算每条变体的整段 PCM RMS 并告警。
  实测差 2~3dB 就会被听成"忽大忽小 / 过低"，于是"味道"的评价会被音量噪声污染。
  注意口径：**要用整段 RMS（打包器同款），不是 `audio_analyze.py` 的 `rms_db_mean`（分帧均值）**——
  两个口径不通用，混用会出现"我配平了但打包器仍报 2.2dB 差"。
- **改完必跑**：`node build_pack.mjs ... ` → `node verify_coverage.mjs --transcription <jobs>` →
  `node runtime-variants.test.mjs`；改到 `lib/`（宿主路由）时**必须重启 dsh web**。

## 流程

```powershell
# 0. 选定音色后，从游戏语音库里挑同情绪的**纯台词**片段，写 cfg（格式同 build_refs.py）
# 1. 同步权威语录清单（必做，且改过语录后要重跑）
node sync_quotes_from_widget.mjs --carry <上一版清单.json> -o quotes.json
# 2. 审计参考音（必做）：不合格就别往下走
python audit_refs.py refs\<voice>.cfg.json --json out\audit.json
# 3. 建 10~25s 参考音（indextts2-batch-tts 技能自带）
python <skills>\indextts2-batch-tts\scripts\build_refs.py refs\<voice>.cfg.json
# 4. 批量生成（jobs 里 text=实际念的文本，widget_text=挂件显示的原文，指纹按后者算）
node <skills>\indextts2-batch-tts\scripts\batch_tts.mjs jobs.json --skip-existing
# 5. 打包含指纹
node build_pack.mjs --pack <packId> --voice <音色名> --label <显示名> --jobs jobs.json
# 6. 覆盖率闸门 + 转录交叉核对（必做）
node verify_coverage.mjs --transcription <jobs.json>
# 7. 重启 dsh web 后生效
```

## 规则（都是踩过的坑，别重犯）

1. **参考音只能用台词素材**。战斗/受击语音里那些「喵…喵…！」「呀呀。」是**呻吟**，不是台词；
   若被放进参考音（尤其**权重最高的首句**），整档配音会变成"光呻吟 + 发音飘"。
   文件名字幕看不出来，**必须过 `audit_refs.py`**。
2. **参考音要纯**：单一情绪、10~25s、同一角色。混了得瑟/平静/受惊的台词会让情绪底色糊掉。
3. **温度别乱调高**。实测把温度从 0.8 提到 0.9 会把「用户」念成"有狐/诱惑"；
   温度只影响表现力、不改情绪底色 → 保持 0.8，表达力靠参考音和情绪向量拿。
4. **参考音覆盖不到的音会念歪**。参考音里没有 `miao` 这个音素时，「没吃饱喵」在 4 个温度下都会被念成
   "没吃饱镖/保镖"；补一个音（写作「没吃饱喵呜」）才念对。清单里的 `spoken` 字段就是用来记录这种
   "显示原文 ≠ 实际念的文本"的。
5. **符号/英文要单独处理**：`↓`、`QAQ`、`(?` 这类给眼睛看的东西不念；`V50亿` 会被念乱，写 `V五十亿`。
6. **指纹按挂件原文算**（`widget_text`），不是按实际念的文本。这样改文案自动静音，永远不会"显示 A 播 B"。
7. **多 take 择优**：同一条语录生成 2~3 个 take，用 ASR 转写与期望文本的 LCS 相似度选最好的，
   比"只生成一条然后听天由命"稳得多；相似度低的条目再人工听。
8. **语录清单以挂件源码为准，别手工转录、更别写死条数**。
   真实事故：语音包只配了 40 条，而挂件内置其实是 **48 行 / 47 条唯一文本**（都在第二泡那个 `choice` →
   `random` 模块里，权重 10），另有 1 条转录时少抄了结尾的 `...` → 合计约 1/6 的概率弹出语录却没声音。
   更糟的是当时的测试**全绿**：它拿"我转录的清单"验"我打的包"，自洽但错。
   现在一律用 `sync_quotes_from_widget.mjs` 同步 + `verify_coverage.mjs` 把关（以挂件源码为唯一事实来源）。
   挂件里同一句话被写两次是允许的（如「哦鲸鲸...」），指纹按文本算，共用一条语音即可；
   若想给同一句配**多个版本随机播放**，见上一节"多变体"。
10. **让用户试听前先配平响度**。实测同一句的候选比线上低 2~3dB 时，评价会直接变成"过低"——
   那时听到的是"弱"而不是"音高低"，据此改参数会越改越偏（本项目为此白跑过一轮：
   音高其实更高，却被打回"全部过低"）。口径与阈值见上节，测量脚本用整段 PCM RMS。
9. **生成前必须过显存门槛，且同一时刻只能有一个批量任务**（这条曾经把电脑跑卡死过）。
   12GB 卡上 IndexTTS2 一次吃约 8GB，**两个 worker 同时加载就会把整机拖死**。
   技能侧已做结构性防护（worker 独占单例端口 + 加载中标记 + 客户端"只要有 worker 就只等待"，
   见 `~/.agents/skills/indextts2-batch-tts/SKILL.md`，回归测试 `node scripts/tests/singleton-guard.test.mjs`），
   但调用方仍要守纪律：
   - 开工前 `nvidia-smi` 确认真实空闲 **≥5GB**（技能内置同门槛，不足会直接拒绝启动）；
   - **一批没结束不要起第二批**；不要中途强杀批量客户端（改代码/重跑前先等它结束或走 stop 流程）；
   - 需要长时间无人值守时用 `node <skill>/scripts/watch_gpu.mjs` 采样监视，>11GB 立即处理；
   - 批量结束后确认显存回落到 <1GB；要主动释放就 `node <skill>/scripts/tts.mjs stop`（写 `disabled`，阻止自动拉起）。
   参考音按技能建议用 **20-30s**（本工程早期为省时间用过 13-16s，属偏离，效果也更飘）。
