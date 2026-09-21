# 鲸鱼余额挂件（带配音）· 安装说明

**版本 {{VERSION}}** ｜ 打包时间 {{DATE}} ｜ 形态 **{{FLAVOR_LABEL}}**

这是 DSH（DeepSeek Harness）Web 界面右下角「余额小鲸鱼挂件」的一个修改版：
在原挂件基础上加了**语录配音**——挂件弹出内置语录时会用中文配音念出来，同一句还能有多个版本随机播。

---

## 一、你需要什么

| 需要 | 说明 |
|---|---|
| DSH | 已经装好并能跑起来（`dsh web` 能打开界面）。没装的话：`npm i -g @deepseek-ai/dsh` |
| Node.js 18+ | 安装器用它跑（DSH 本身也依赖 Node，通常你已经有了） |
| Windows / macOS / Linux | 三个平台都支持；Windows 上双击 `install.cmd` 就行 |

## 二、怎么装（三步）

1. **解压**这个压缩包到任意目录（不要在压缩包里直接运行）。
2. 运行安装器：
   - **Windows**：双击 `install.cmd`
   - **macOS / Linux**：终端里 `./install.sh`
   - 想自己控参数：`node installer/install.mjs --help`
3. **重启** DSH Web：关掉正在跑的 `dsh web`，再执行一次 `dsh web`。

装完打开界面，右下角挂件照旧；点泡泡（或等它自己弹）就会听到配音。

### 自检（可选）
浏览器打开 `http://127.0.0.1:3080/dsh-whale/voice-packs.json`，
{{VOICE_SELFTEST}}

## 三、安装器做了什么

不放心可以先看它要做什么：`node installer/install.mjs --dry-run`（只打印，不改任何东西）。

1. 把插件解到 `~/.dsh/dev/dsh-whale-widget-{{VERSION}}/`，并建立稳定链接 `~/.dsh/dev/dsh-whale-widget`；
2. 用 DSH 官方命令登记到 profile：`dsh plugin --profile web add "link:~/.dsh/dev/dsh-whale-widget"`
   （官方命令会同时把插件加进该 profile 的 `dsh.profile.bundles`，所以**不要**自己去改配置文件）；
3. 语音包（本包含）安装到 `~/.dsh/whale-voice/packs/`，并登记注册表；
   - **已存在就不动**；`~/.dsh/whale-voice/config.json` 若已存在，**绝不覆盖**（你选的音色是你的事）；
4. 安装状态写到 `~/.dsh/install-state/dsh-whale-widget.json`，方便卸载与回滚。

**安全和隐私**：安装器只写 `~/.dsh/` 下的东西，不联网，不装服务，不改系统设置。

## 四、常用参数

```bash
node installer/install.mjs --dry-run           # 只演示，不改动
node installer/install.mjs --no-voice          # 只装插件，不装语音包
node installer/install.mjs --no-register       # 只铺文件，不登记（手工登记时用）
node installer/install.mjs --profile web       # 指定 profile（默认 web）
node installer/install.mjs --home D:/myhome    # 指定 DSH_HOME（默认 ~/.dsh）
node installer/install.mjs --copy              # 不建链接，直接复制（环境不允许链接时用）
node installer/install.mjs --force             # 目标路径不是链接时，备份后继续
```

## 五、卸载

```bash
node installer/install.mjs --uninstall                 # 注销 + 移除链接，保留你的数据
node installer/install.mjs --uninstall --purge-data    # 连语音包一起删
```

余额历史、自定义角色、自定义音效、泡泡图片等**都在 `~/.dsh/` 里保留**，不会因为卸载而丢。

## 六、常见问题

**装了没声音？**
1. 确认**重启过** `dsh web`（插件路由是在启动时注册的）；
2. 打开 `http://127.0.0.1:3080/dsh-whale/voice-packs.json`，能看到 `diona-v1` 才算装上；
3. 挂件里语音开关（悬浮编辑面板）是否被关掉；
4. 如果是从**局域网其它设备**（如手机 `http://192.168.x.x:3080`）访问，语音也能播——指纹计算不依赖 `crypto.subtle`（已内置纯 JS SHA-256 兜底）。

**装过原版挂件，能直接覆盖吗？**
可以。安装器会把非链接的旧目录备份成 `<路径>.bak-<时间戳>`，数据文件完全兼容。
（同一 profile 里同一个包名只能装一份，本包名就是 `dsh-whale-widget`。）

**想换回原版？**
`node installer/install.mjs --uninstall`，然后按原版仓库说明重装。

**杀软报毒？**
安装器是纯 Node 脚本，只做复制文件和建目录链接。可能是 `dsh plugin` 调用 pnpm 时触发的误报。

## 七、许可与出处

- **代码**（`plugin/` 下的 `lib/`、`tools/`、配置文件与文档）：**MIT**，见 `LICENSE`；原挂件由
  [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 开发，本包是它的修改版。
- **美术素材**（`plugin/assets/**`，图片/动图/音效）：不受 MIT 覆盖，出处见 `PROVENANCE.md`。
- **语音包**（`voicepacks/`）：**免费粉丝向作品，权利状态特殊**——请务必先读 `NOTICE-VOICE.md`。
  {{VOICE_LICENSE_LINE}}

有任何问题，把安装器输出的文字发回给分发者即可。
