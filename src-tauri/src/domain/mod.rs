//! 领域层（Domain）
//!
//! 每个领域（限界上下文）一个子目录，目录内固定包含该领域的三类内容：
//! - `model/`：领域模型，按职责分桶 —— `aggregate/` 聚合根、`entity/` 实体、`valobj/` 值对象；
//! - `service/`：该领域的纯业务规则（不依赖 Tauri、文件系统与网络，可完整单测）；
//! - `repository/`：仓储 / 网关抽象（trait），由 `infrastructure` 实现，完成依赖倒置。
//!
//! | 领域 | model | service | 职责 |
//! | --- | :---: | :---: | --- |
//! | `config` | ✓ | ✓ | 应用配置模型 + 规范化规则 |
//! | `bubble` | ✓ | — | 模块化气泡模型（气泡组 / 行 / 模块） |
//! | `audio` | ✓ | ✓ | 音效组模型 + 命名与参数值域规则 |
//! | `widget_image` | ✓ | ✓ | 图片组模型 + 命名与素材校验规则 |
//! | `ledger` | ✓ | ✓ | 账本模型 + 记账规则 |
//! | `window` | ✓ | ✓ | 窗口模型 + 尺寸换算与边缘吸附算法 |
//! | `update` | ✓ | ✓ | 版本检查结果模型 + 版本比较规则 |
//! | `supplier` | ✓ | ✓ | 供应商模型 + slug / scope / 归一化 / 必填校验规则 |
//! | `client` | ✓ | ✓ | 客户端注册表（标签页 / logo / 配置文件归属）+ 配置渲染值对象 |
//! | `asset` | — | — | 素材导入端口（从本地挑选音效 / 图片 / 字体 / 气泡媒体） |
//! | `system` | — | — | 宿主环境端口（便携数据目录 / 系统默认程序） |
//! | `balance` | ✓ | — | 仅对外载荷模型（编排在 application，远端在 infrastructure） |
//! | `pricing` | — | ✓ | 峰谷判定规则（取值 `PeakPeriod` 收敛在 `types::enums`） |
//!
//! 依赖方向：`domain` 只依赖 `types`，不依赖任何业务层。
//!
//! 需要外部能力的领域（`repository/` 里的 trait）一律由 `infrastructure` 实现：
//! 落盘仓储、系统对话框、客户端配置文件、抠图推理、HTTP 客户端与系统启动项都是这样接入的。

pub mod asset;
pub mod audio;
pub mod balance;
pub mod bubble;
pub mod client;
pub mod config;
pub mod ledger;
pub mod pricing;
pub mod supplier;
pub mod system;
pub mod update;
pub mod widget_image;
pub mod window;
