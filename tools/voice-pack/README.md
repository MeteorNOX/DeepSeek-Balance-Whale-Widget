# 语录配音工具（voice-pack）

把「随机语句」的语录做成语音包，并保证它与挂件源码始终对得上。工具只负责**清单同步、打包与校验**：
wav 片段本身由你自己的配音 / TTS 流程产出，逐句对应挂件原文即可。

## 包含的脚本

| 文件 | 作用 |
|---|---|
| `sync_quotes_from_widget.mjs` | **语录清单的唯一正确来源**：直接从挂件源码 `BUBBLE_DEFAULT_ITEMS` 抠出内置语录（含嵌套 `choice` 结构） |
| `verify_coverage.mjs` | **覆盖率闸门**：挂件内置语录 ↔ 已安装语音包逐条核对；有语录没声音 / 包里有挂件不显示的条目 → 退出码 1 |
| `build_pack.mjs` | 把 wav 片段 + 语录原文打成语音包，落到 `$DSH_HOME/whale-voice/`（清单 + 注册表 + 选中配置），幂等可重跑；**同一句给多个文件会自动归并成「变体」** |
| `runtime-variants.test.mjs` | **运行时多变体自测**：真跑一遍 `assets/whale-voice-runtime.js`（桩 window / Audio / fetch），验证「多版本都会播 / 不连续重复 / 单版本向后兼容 / 未匹配静默」 |

## 用法

```bash
# 1. 以挂件源码为准，列出 / 校验语录清单
node tools/voice-pack/sync_quotes_from_widget.mjs

# 2. 把 wav 片段打成语音包（jobs.json: [{ "out": "<wav 路径>", "text": "<挂件原文>" }, ...]）
node tools/voice-pack/build_pack.mjs --pack <packId> --label <显示名> --jobs jobs.json

# 3. 覆盖率闸门（缺一条即退出码 1）
node tools/voice-pack/verify_coverage.mjs --pack <packId>

# 4. 运行时多变体自测
node tools/voice-pack/runtime-variants.test.mjs
```

## 约定

- 指纹依据是**挂件显示原文**（`widget_text`），不是念出来的文本；`spoken` 只用于「↓」「QAQ」这类符号不念、或 "V50" → "V五十" 的改写。
- 同一句放多个文件即成为变体，第一个是主版本；某个变体文件缺失时该条仍可播（不会整条静音）。
- 清单里不写绝对路径：只存文件名，由宿主按包目录解析（越界的相对路径会被拒绝）。
