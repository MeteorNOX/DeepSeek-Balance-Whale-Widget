# DSH 小鲸鱼余额挂件（DeepSeek Balance Whale Widget）

DeepSeek Harness（DSH）Web 界面右下角的常驻余额挂件：本地小鲸鱼气泡图 + DeepSeek API 余额，每次打开界面自动启用。本项目是标准 DSH 插件包，可通过 `dsh plugin` 安装/卸载。

## 特性

- 🐋 常驻自启：随 DSH Web 界面每次打开自动出现（标准 DSH bundle 插件）
- 💰 余额：60 秒自动刷新 + 点击手动刷新；余额变化时数字**滚动动画**；瞬时网络抖动自动沿用最近余额不报错
- 🖱️ 拖拽 + **四边四分之一吸附**（左/右/上/下，角落可组合）
- 🔄 左吸附时整体**水平镜像翻转**（文字同步反向、带动画）
- 🧸 **按压 Q 弹**玩偶效果（按压时底部坐标不变）
- 🎚️ 悬停显示大小调节按钮（0.6–1.4 倍，尺寸记忆）
- 📐 随浏览器窗口自动缩放；文字位置/字号与图片联动

## 目录结构

```text
dsh-whale-widget/
├── package.json          # DSH bundle 插件元数据
├── README.md             # 本文件
├── cordis.patch.yml      # 插件挂载声明
├── lib/
│   └── index.js          # 宿主侧插件本体
├── assets/
│   └── DSniang02.png     # 小鲸鱼气泡图
└── whale-widget-prompt.md # 完整规格/维护提示词
```

## 安装

### 方式 A：本地开发安装（当前项目）

在项目根目录（`DeepSeek-Balance-Whale-Widget-main`）执行：

```powershell
dsh plugin --profile web add link:.\dsh-whale-widget
```

说明：

- `dsh plugin` 会把参数转发给 pnpm，并在成功后自动把 `dsh-whale-widget` 加入 `dsh.profile.bundles`
- 使用 `link:` 会在 profile 的 `node_modules` 里链接到当前源码目录，方便继续改代码
- 安装完成后重启 `dsh web`，再 F5 刷新浏览器
- **如果之后移动了源码目录**，必须重新到新的项目根目录执行一次：
  ```powershell
  dsh plugin --profile web add link:.\dsh-whale-widget
  ```
  因为 `link:` 记录的是源目录的绝对路径；移动后旧链接会失效。若提示已存在/冲突，可先 `dsh plugin --profile web remove dsh-whale-widget` 再重新 add。

### 方式 B：发布到 npm 后安装

如果你把这个包发布到 npm：

```powershell
cd dsh-whale-widget
npm publish
```

然后任意机器上安装：

```powershell
dsh plugin --profile web add dsh-whale-widget
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-whale-widget
```

## 从旧手动安装升级

如果你之前按旧方式手动安装过（复制 `whale-balance.mjs` + 改 `cordis.patch.yml`），先清理：

```powershell
$web = "$env:USERPROFILE\.dsh\profiles\web"

Remove-Item "$web\whale-balance.mjs" -ErrorAction SilentlyContinue
Remove-Item "$web\DSniang02.png" -ErrorAction SilentlyContinue
```

然后编辑 `$web\cordis.patch.yml`，删除这段旧补丁：

```yaml
- insert:
    - id: whale-balance-widget
      name: ./whale-balance.mjs?v=1
```

如果里面只有这段，直接改成：

```yaml
[]
```

清理后再执行上面的安装命令。

## 验证

```powershell
dsh --profile web --dump-config | Select-String -Pattern "whale"

curl http://127.0.0.1:3080/dsh-whale/image.png
curl http://127.0.0.1:3080/dsh-whale/balance.json
```

- `/dsh-whale/image.png` → 200 `image/png`
- `/dsh-whale/balance.json` → 200，含 `{"ok":true,"totalBalance":...,"currency":"CNY"}`
- 浏览器 F5 后右下角出现挂件

## 常见问题

- **挂件不出现**：确认 `dsh plugin add` 成功；`dsh --profile web --dump-config` 里能看到 `dsh-whale-widget`；重启 `dsh web` 后 F5。
- **图片不显示**：确认 `assets/DSniang02.png` 在插件包内，且没有把旧文件放在 profile 里占用了同名路由。
- **余额报「未配置 DEEPSEEK_API_KEY」**：去 DSH 配置凭据。
- **本地开发改了代码不生效**：使用 `link:` 安装时，修改源码后重启 `dsh web`（ESM 模块缓存）；如果用已发布版本，需要 `npm publish` 新版本后 `dsh plugin --profile web update dsh-whale-widget`。
- **自定义图片**：必须是 1026×1026、气泡几何一致（中心 455,247、长轴 710、纵轴 430），否则按 `whale-widget-prompt.md` 调整文字定位参数。

## 开发与维护

完整规格、视觉参数、架构结论和生成提示词见 `whale-widget-prompt.md`。修改文字位置、颜色、动画、吸附逻辑时参考该文件。

---

## 桌面版（WinForms，免 DSH）

不想装 DSH、想直接双击常驻桌面的用户，用 `desktop/` 目录里的独立桌面版：纯 WinForms + GDI+，零依赖。解压后双击 `start-widget.vbs` 启动，右键鲸鱼填自己的 DeepSeek API Key 即可。详见 `desktop/README.md`。
