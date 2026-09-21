# 分发包构建（tools/dist）

把插件打包成**可以直接交给别人**的压缩包：插件本体 + 安装器 + 语音包（可选）+ 许可与出处文件。

## 出什么

```
tools/dist/out/
├─ dsh-whale-widget-<版本>-full.zip    完整版：插件 + 语音包（diona-v1，约 9.8MB）
├─ dsh-whale-widget-<版本>-code.zip    仅代码版：只有插件（约 4.6MB）
└─ SHA256SUMS.txt                      两个 zip 的校验和
```

| 形态 | 给谁 | 语音包 |
|---|---|---|
| **full** | 朋友私下用（语音是角色音色克隆，**权利状态特殊**，见包内 `NOTICE-VOICE.md`） | 含 |
| **code** | 可以公开分发（npm / GitHub Release / 网盘公开） | 不含，使用者自备 |

## 怎么构建

```powershell
# 两个形态都出（语音包默认取 ~/.dsh/whale-voice/packs/diona-v1）
node tools/dist/build_dist.mjs

node tools/dist/build_dist.mjs --flavor full         # 只出完整版
node tools/dist/build_dist.mjs --pack <语音包目录>    # 换语音包源
node tools/dist/clean.mjs                            # 清构建产物
```

## 怎么验收（必做）

```powershell
# 在沙箱 DSH_HOME 里真跑安装器：装/幂等/不覆盖用户配置/卸载/清理/code 版，26 项断言
pwsh -NoProfile -File tools/dist/test_install.ps1

# 单独验证"官方登记入口"在隔离环境可用（会真的调 dsh plugin add）
pwsh -NoProfile -File tools/dist/test_register.ps1
```

发布前至少跑一次 `test_install.ps1` 并全绿；改动过安装器或包结构后**必须**重跑。

## 分发包结构

```
dsh-whale-widget-<版本>-<形态>/
├─ install.cmd / install.sh      双击 / 一行命令入口
├─ INSTALL.md                    收件人向安装说明（由 payload/INSTALL.md 模板生成）
├─ NOTICE-VOICE.md               语音包权利说明（full 版才有意义）
├─ LICENSE / PROVENANCE.md       代码许可 + 素材出处（顶层再放一份，便于一眼看到）
├─ SHA256SUMS                    全包逐文件校验和（安装器启动时自检）
├─ plugin/                       插件本体（= 这个仓库，按 package.json 的 files 白名单）
├─ installer/install.mjs         安装逻辑（跨平台、零依赖）
└─ voicepacks/diona-v1/          语音包（含自己的 SHA256SUMS 与 PROVENANCE.json）
```

## 设计要点（踩过的坑，别重犯）

1. **走官方登记入口**：`dsh plugin --profile <名> add link:<目录>`。DSH 的这条命令是把参数转发给
   profile 目录里的 pnpm，**并自动把插件对账进 `dsh.profile.bundles`**。所以安装器只调它，
   绝不自己改 profile 的 `package.json`——手改要同时维护"依赖树"和"bundles 列表"两处一致，
   很容易做成半截状态。找不到 `dsh` 时，安装器会打印这条命令让人手工执行。
2. **插件装到版本目录 + 稳定链接**：`~/.dsh/dev/<包名>-<版本>/` 是真身，`~/.dsh/dev/<包名>`
   是指向它的 junction（Windows，免管理员）/ 目录符号链接（macOS/Linux）。升级＝换链接，回滚＝换回旧链接。
   目标路径若**不是链接**（手工复制来的），安装器会停下并要求 `--force`（先备份成 `.bak-<时间戳>`），
   绝不递归删除别人的目录。
3. **不静默写用户数据**：语音包"缺则装、有则不动"；`config.json` 已存在就**绝不覆盖**——
   用户选中的音色是用户的（沙箱测试里专门用哨兵值验证了这条）。
4. **staging 不要放在被打包的目录里**：`tools/` 是分发包内容，第一次把 staging 放在
   `tools/dist/out/staging` 时，复制 `tools/` 会把 staging 复制进它自己 → 路径无限嵌套
   （`ENAMETOOLONG`）。现在 staging 在系统临时目录，并且复制时有**排除表**（排除要作用在
   "复制动作"上，不能等复制完再清理）。
5. **zip 要连最外层文件夹一起打**：`Compress-Archive -Path '<root>\*'` 会让收件人解压出一堆散文件；
   正确姿势是 `-Path '<root>'`（POSIX：`zip -qr x.zip <name>`，cwd 在 staging 父目录）。
6. **包内自带校验和**：顶层 `SHA256SUMS`（安装器启动自检）+ 语音包自己的 `SHA256SUMS`（逐文件验），
   这样"文件被网盘/杀软改坏"能被发现，而不是变成玄学问题。
7. **语音与代码分开处理**：代码 MIT、素材 as-is、语音是角色音色克隆且未获授权。
   所以发布形态分 full / code 两种，`NOTICE-VOICE.md` 与 `voicepacks/<id>/PROVENANCE.json`
   把"是什么、哪来的、能不能再分发"写清楚。
8. **不要在插件 `apply()` 里偷偷安装语音包**：启动阶段不该静默改用户目录，也无法完成许可确认。
   安装交给显式安装器；运行时缺包就静默不播，不影响挂件本体。

## 附：在 Windows 上调用 `dsh` 的两个坑（实测，别重犯）

1. **不要** `spawnSync('dsh', args, { shell: true })`：Node 会报 `DEP0190`（args 不转义、只做字符串拼接），
   而且含空格的路径会被拆断。
2. **也不要**自己拼好引号再塞进 `cmd.exe` 的 **args 数组**：Node 会对数组里的参数**再转义一次**，
   `"dsh"` 会变成 `\"dsh\"`，直接报 `is not recognized as an internal or external command`。
3. **正确做法**：把整条命令拼成**一个字符串**交给 `shell: true`（Windows）；POSIX 上直接 exec 数组。
   cmd 的引号语义是"双引号内 `& ^ ( ) | < >` 均为字面量"，所以只需外层包裹双引号；
   真正无法安全表达的是 `"` 与 `%`（后者会做变量展开）——安装器启动时就检查 `DSH_HOME` 是否含这两个字符，
   含则直接给出提示，而不是硬塞一条可能被展开的命令。
4. 实测覆盖：普通 / 含空格 / 含 `&` `(` `)` / 含 `^` `|` / 中文+空间 五类参数都能完整送达，
   且不再出现 DEP0190。

## 回馈上游

改动要能作为补丁回上游时，只提交通用部分：
`lib/voice-registry.mjs`（语音包格式与解析）、`assets/whale-voice-runtime.js`、缺包降级、
`tools/voice-pack/*`（打包/覆盖率/运行时测试），以及 `docs`。**不要**提交角色音频、
默认选中配置或任何品牌化内容。
