# Ncode · Niwa Labs

Ncode 是 Niwa Labs 独立维护的终端编程助手，基于 MiniMax Code（MCode）和 Pi 构建。你可以使用 MiniMax 模型，也可以连接自己的模型服务。

[English](README.md) · **简体中文**

[快速开始](#快速开始) · [文档](docs/README.md) · [示例](docs/examples.md) · [更新日志](packages/tui/CHANGELOG.zh-CN.md) · [贡献指南](CONTRIBUTING.md)

![Source preview](docs/assets/source-preview.svg) ![Compatibility: Node.js 22.19+, 24.2+, 25, and 26](docs/assets/node.svg) [![First-party default license: MIT](docs/assets/license.svg)](LICENSE-STATUS.md)

![Ncode 终端欢迎界面，显示本地服务在线，当前尚未登录，工作区为 pocket-pet](docs/assets/ncode-terminal.png)

## Ncode 在 MCode 基础上增加了什么

- **本地守护进程接管回合。** 终端、无界面运行和 ACP 客户端共用每个配置档的一个守护进程。关掉终端，任务继续运行。回到同一工作区，用继续选项查看进展。子代理还在工作时，按 Enter 可以立即给主代理新指令，按 Alt+Enter 则把请求排到下一回合。
- **守护进程启动会等待。** 新版本首次启动时，升级较大的数据目录可能需要几分钟。Ncode 最多等待该守护进程 30 分钟，不再重复启动，也不会中途放弃。重启守护进程同样会等待，并以它自己的配置档重新启动。
- **两个账号同时使用。** 每个配置档有独立的登录、会话和设置。在一个终端运行一个配置档，在另一个终端运行另一个。守护进程命令认你指定的配置档，写在命令前后都可以。
- **ACP 按会话限制工具。** 客户端指定会话可用的内置工具。列表随会话保存，重启后仍然有效，且只能继续收窄。列表之外的工具无论通过哪条路径调用，都会在运行前被拒绝。带列表的会话只能访问客户端提供的 MCP 服务器。
- **通过 ACP 接收完整回答。** 如果客户端只收到了思考内容，Ncode 会发送完整回答。如果已收到部分正文，Ncode 只发送剩余文本。客户端断开后，在结果保存之后，可以按回合 ID 取回最终回答、结果和失败原因。
- **在编辑器里翻看历史。** ACP 客户端无需接管会话，就能分页读取旧消息、工具调用、结果和上下文摘要，还能查看当前是否有活跃回合，以及有多少条输入正在排队。
- **长对话会提前准备摘要。** Ncode 在后台整理较早的消息，你可以继续工作。下一次模型调用需要腾出空间时，沿用这份摘要，并保留最近的消息，包括整理期间发来的新指令。原始对话仍可随时翻阅。
- **后台任务在重启后仍有结果。** Pi 负责流式返回回复和执行工具，Pi Durable 调度后台任务并将进度存入 SQLite。即使子代理刚完成任务守护进程就重启，主代理仍能收到结果。
- **每日签到。** 登录 MiniMax 后，在终端打开 Ncode 就能领取当天可领的积分。签到确认后，当天再打开同一配置档会跳过签到。ACP 和无界面运行不会自动签到。
- **TypeScript SDK。** 仓库包含一个 SDK，可在 Node.js 代码中启动、流式读取和续跑无界面对话。

[会话、ACP 历史和上下文](docs/architecture.md) · [账号配置档](docs/installation.md#profiles)

<a id="niwa-and-ncode"></a>

## Niwa 与 Ncode

Niwa 协调多个编程代理的工作流。如果工作流需要精确控制每个会话可以调用哪些工具，可选择 Ncode 作为 ACP 后端。Ncode 在 MCode 0.7.2 适配器的基础上增加了仅开放客户端指定工具的模式、按会话限制内置工具的策略、无需接管会话即可分页读取的历史，以及重连后查询当前回合和队列长度的能力。

- **按会话选择工具。** 在 Niwa 的 niwa-only 模式下，工作流可以授予任务列表工具，让代理查看分配给它的任务。模型的工具列表不会包含内置工具，也不会包含用户配置或工作区声明的 MCP 服务器。如果只想保留少数内置工具，工作流在打开会话时发送允许列表即可。另有一个 ACP 方法会报告会话实际保留的工具。
- **重启后继续工作。** 重启后，Niwa 恢复原会话并重新传入工具列表。它可以从 Ncode 的本地历史中读取消息、工具调用和结果，把历史调用与其结果对应起来，并查看任务是否仍在运行。
- **由操作人员审批工具调用。** Niwa 可以在创建或恢复会话时选择权限模式，显示每次工具调用的审批结果，并让操作人员选择仅允许本次调用或拒绝。对于支持保存决定的请求，Ncode 还向 ACP 客户端提供“始终拒绝”选项。
- **双向提问。** 当代理需要人做决定时，Niwa 向操作人员展示问卷并把答案传回。工作流需要代理给出结构化答案时，Niwa 会校验代理通过 ACP 返回的 JSON。

要仅开放会话指定的工具，请用两个选项启动 ACP 适配器：一个关闭内置工具，一个把 MCP 发现限制在会话自己提供的服务器。确切的选项名和策略细节见[架构指南](docs/architecture.md)。[Niwa 工作流示例](https://github.com/niwa-labs/niwa#niwa-and-ncode)

## 快速开始

### 1. 安装 Ncode

全局安装 npm 包 @niwa-labs/ncode，然后让 ncode 命令输出版本号。再次安装同一个包即可更新。

从源码构建需要 Git、Node.js 22.19+（22 系列）、24.2+（24 系列）、25 或 26，以及 pnpm 9.12.0。在 Windows 上，请将源码放在本地 NTFS 卷上，并避开云同步目录。具体步骤见[安装指南](docs/installation.md)。更新源码构建时，检出较新的修订并重新构建。MiniMax 官方安装器、注册表软件包和更新渠道由[上游](https://github.com/MiniMax-AI/minimax-code)维护。

### 2. 登录账号或配置 API Key

在终端运行登录命令，并在浏览器中完成登录。用它的区域选项选择国际版账号；不加该选项时，Ncode 登录中国大陆账号。然后打开 Ncode，在状态界面查看账号，在提供方界面选择模型。退出命令用于退出登录。

Token Plan 需要有可用额度的账号。Ncode 把用户数据放在主目录下名为 .minimax 的文件夹中；选择配置档后，文件夹名为 .minimax- 加配置档名。两个环境变量可以覆盖这个位置。安装器自己的目录与此无关。查找或删除配置和会话之前，请先阅读[账号与数据](docs/installation.md#accounts-and-data)。

#### 同时使用两个账号

命名配置档拥有独立的数据目录，其令牌、会话、设置、MCP 配置、插件和 Skills 不会与另一个账号混在一起。不指定时，Ncode 使用默认配置档。

用登录命令加配置档选项登录每个账号。启动时用同一个选项指定要用的配置档，也可以用配置档环境变量为整个 shell 指定。选项优先于环境变量。配置档命令可以列出和删除配置档。

名称为 1 到 64 个字符，可包含字母、数字、点、下划线和连字符，且必须以字母或数字开头和结尾。其他名称会被拒绝，不会被自动修正。名称 default 是保留名，与不加该选项含义相同。命名规则、隔离的状态和所有配置档子命令见[配置档](docs/installation.md#profiles)。

#### 使用自己的 API Key

自带密钥无需登录 MiniMax。把密钥放进环境变量，再用 provider add 命令添加提供方：给出名称、基础 URL、API 格式、模型和存放密钥的变量名。use 选项会先测试列表中的第一个模型，测试通过后保存并选用该提供方。测试失败不会保存任何内容。省略该选项则只保存，不测试。

支持三种 API 格式：OpenAI completions、OpenAI responses 和 Anthropic messages。自定义或本地模型请把上下文和输出上限设为服务实际支持的值，每个值必须是正整数，并适用于列出的每个模型。不设置时，Ncode 沿用默认上限。

这样添加的提供方保存在当前配置档设置文件的 custom provider 部分。这是接入第三方和自托管端点的受支持方式；minimax API 部分只保留给 MiniMax 官方 API。Anthropic 兼容端点的中转服务如需 Bearer 授权头，可在同一文件中设置自定义请求头。[模型示例](docs/examples.md#2-choose-your-own-model)给出具体命令、连接检查和单次运行的模型覆盖，[第三方中转与自定义认证头](docs/examples.md#third-party-relays-and-custom-auth-headers)说明请求头的写法。

### 3. 做一个自己的桌面宠物

给一只会眨眼的桌面宠物加上专注计时器，再要求长按暂停、计时结束时庆祝一下。你能看到一句需求变成真正可用的东西。

[![Pocket Pet：从眨眼的小脸到可用的专注伙伴](docs/assets/pocket-pet-demo.png)](docs/demo.md)

[观看构建故事和浏览器演示](docs/demo.md) · [亲自动手构建](examples/pocket-pet)

不需要任何硬件。示例在浏览器中本地运行，没有前端依赖，完成版也不需要模型账号。让 Ncode 修改代码需要有可用额度的 MiniMax 账号或自己的兼容模型 API，模型调用可能产生费用。[完整流程](examples/pocket-pet)包含准备和启动步骤、需要粘贴的两条提示词以及完成版演示模式。另见[小型代码修复示例](examples/clamp)和[模型、搜索与工具](docs/examples.md)。

### 在自己的项目中使用

在项目目录打开终端并启动 Ncode。在终端里描述任务，也可以在启动时把任务作为第一个参数传入。init 命令会把项目指引写入 AGENTS.md；请说明期望的结果、允许的改动和验证方式。

| 入口 | 适用场景 |
| --- | --- |
| 交互式终端 | 探索代码、继续对话、审查改动和权限。 |
| 无界面 exec 命令 | Shell 脚本、CI、批量任务和评测。 |
| ACP 适配器 | 支持 Agent Client Protocol 的编辑器和客户端。 |
| [TypeScript SDK](packages/code-sdk/README.md) | 在 Node.js 代码中启动、流式读取和续跑无界面对话。需从源码目录构建。 |

### 轻量对话

对于简单提问或通用知识问答，用 mode 选项在轻量模式下创建新会话。轻量模式只发送精简的对话提示词，不发送工具 schema，并省略工作区指令、Skills、记忆块、MCP schema 和完整环境块，因此不能读取或修改本地文件。默认是标准模式，编程请使用标准模式。

模式在根会话创建时固定，因此轻量模式不能与 session 或 continue 选项同时使用。子代理会话不继承该模式，压缩仍使用标准上下文，ACP 与桌面端会话始终是标准模式。重新打开轻量会话时会保留该模式，并在状态栏显示 Lightweight。

### 继续之前的工作

continue 选项恢复当前工作区最近的会话，session 选项打开会话选择器。在终端内，/sessions 查找以前的会话，/help 列出命令和快捷键。查看和停止守护进程见[守护进程命令](docs/installation.md#local-daemon)。

| 操作 | 快捷键 |
| --- | --- |
| 发送消息或为运行中的任务补充指令 | Enter |
| 任务运行时把后续请求排入队列 | Alt+Enter |
| 插入换行 | Shift+Enter |
| 引用工作区文件或目录 | @ |
| 切换 Plan Mode | Shift+Tab |
| 切换权限模式 | Alt+M |
| 关闭面板或中断正在运行的任务；在模型回复之前中断会把消息放回输入框 | Esc |

## 卸载

用 npm 的全局卸载命令移除 Ncode 的 npm 包。会话历史仍保存在本机。卸载 MiniMax Code 官方版本、清理 shell 的 PATH 以及删除用户数据，见[更新与卸载](docs/installation.md#update-or-remove)。请先备份需要的内容：删除用户数据会永久移除登录状态、提供方配置、缓存和会话。

## 可以做什么

| 场景 | 使用方式 |
| --- | --- |
| **修改与验证代码** | 读取文件、查看 diff、执行 Shell 和测试；通过权限与沙箱控制工具执行。 |
| **选择模型** | MiniMax 账号 / Token Plan，或兼容 OpenAI、Anthropic 格式的自定义提供方。 |
| **搜索与多模态** | 内置搜索、mcode-tools 媒体工具、MCP 和托管连接器；按账号权限和服务额度使用。 |
| **延续工作** | 会话恢复、任务规划、子代理、官方 / 本地 / GitHub 插件与内置 Skills。 |
| **接入工作流** | 用无界面 CLI 运行脚本任务，用 SDK 从 Node.js 驱动，或通过 ACP 连接编辑器和客户端。 |

账号、更新、反馈与诊断能力也在。托管工具需要网络和相应授权，详细边界见[能力与服务边界](docs/tui-capabilities.md)。

## 从源码构建

开发 Ncode 或运行本仓库源码需要 Git、Node.js 22.19+（22 系列）、24.2+（24 系列）、25 或 26，以及 pnpm 9.12.0。在 Windows 上，请在 pnpm 创建 workspace link 前运行源码位置检查。首次构建需要联网：依赖和经过校验的 mcode-tools 均来自公共 npm。pnpm 安装、系统依赖、从其他目录运行构建产物以及更新方法见[安装指南](docs/installation.md)。

本仓库构建 **Niwa Labs Ncode 0.1.4**。上游基线和内置工具版本见[源码状态](docs/open-source-status.md#version-and-evidence-baseline)。

## 文档与贡献

- [安装与账号配置档](docs/installation.md)
- [架构](docs/architecture.md)
- [贡献指南](CONTRIBUTING.md)、[安全报告](SECURITY.md)和[第三方声明](THIRD_PARTY_NOTICES.md)

如需反馈分支问题，请使用 Niwa Labs 分支的 Issues。MiniMax 账号、官方安装器和桌面应用请参阅[上游 MiniMax Code](https://github.com/MiniMax-AI/minimax-code)。

## 许可

第一方代码默认采用 [MIT](LICENSE)；文件或子包已有独立声明时保留原许可。依赖、资源与 mcode-tools 的许可分别见[第三方声明](THIRD_PARTY_NOTICES.md)和[许可状态](LICENSE-STATUS.md)。
