# 关于本目录的音频

本目录是**示例语音包**：给挂件「随机语句」模块配音的 47 条音频（共 50 个 wav 片段，22050Hz 单声道）。

- 音频为**开源 TTS 合成的示例语音**，非真人录音；**不是官方素材，也没有得到任何官方授权**。
- **不属于本仓库的 MIT 许可**：代码为 MIT，本目录下的音频随包仅作示例分发。
- **本目录可整体移除**：插件在没有语音包时完全不发声，行为与旧版一致，删除后其余功能不受影响。
- 启用方法：把本目录复制到 `~/.dsh/whale-voice/packs/example-pack/`，在 `~/.dsh/whale-voice/registry.json` 里登记
  （`id` / `manifest` / `enabled`），并在 `config.json` 里把 `packId` 设为 `example-pack`。
