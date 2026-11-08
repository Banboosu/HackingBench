# HackingBench

基于 **pi-coding-agent 1.5.0 + HNPF-MCP** 的 Windows 本地 LLM Hacknet 速通工作台。

> **v0.1 / 实验性适配器，不是已验证的完整 benchmark。**
> TUI、独立游戏副本、原版新账号启动、受限工具、计时/预算、日志与基础报告已经实现并做过 smoke test。
> **尚未用真实模型跑完原版战役；Labyrinths 文件会保留，但 DLC 全流程交互与评分尚未完成。**
> 原版结局检测也尚未用完整通关回归验证。当前报告不能作为正式排行榜。

## 快速开始（PowerShell 7 / Windows Terminal）

需要 Windows 原生 **Bun ≥1.4.4** 和合法安装的 Hacknet。推荐终端至少 100×32；Bun 不要使用 WSL 版本。依赖中已固定 **pi 1.5.0**，优先使用项目内安装，也可在配置中指定外部 pi。

```powershell
cd D:\Playground\HackingBench

# 首次从 Git 获取项目时：
git submodule update --init --recursive

# 自动安装本项目锁定依赖，然后进入 TUI：
.\start.ps1
```

如果当前 ExecutionPolicy 阻止运行脚本，可只对这个子进程绕过，不修改系统策略：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

也可以手动启动：

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run start
```

工作台运行、依赖安装和测试统一使用 **Bun**：直接执行 TS/TSX，使用 `bun.lock` 和 `bun test`，不再依赖 tsx/npm 或宿主 Node。共享桥接代码有意保留 Bun 支持的 `node:*` 兼容 API，供独立 pi 扩展复用；不改动 pi 自身的实现。

TUI 启动后检测 Windows Bun、pi 版本、Steam 游戏目录、DLC 和已准备的副本。首次没有密钥时进入配置页：

1. 设置 API 协议、Base URL、Model ID；协议必须和服务商匹配。
2. 使用环境变量密钥，或填写 **Session-only key**（遮罩输入，仅本次进程内存）。
3. `Ctrl+S` 保存非敏感配置，`Esc` 返回主界面。
4. 可先按 **T** 做真实 API 连接测试、**P** 准备游戏副本。
5. **S / Start** 才会开始真实尝试：preflight → 必要的 setup → 项目游戏副本 → 新账号 → 工具集握手 → LLM 游玩。

**T 和真实 Start 的 preflight 会调用所选 API，可能计费。** 启动 TUI、Doctor、Prepare、Demo 不调用真实模型。不要把真实密钥发到聊天或写进仓库；在本机界面输入或使用环境变量。

### 凭据与模型目录

推荐先在当前 PowerShell 会话设置 `HACKINGBENCH_API_KEY`，或在配置页更改变量名。`bunfig.toml` 已禁用 Bun 自动读取 `.env`，也不复制 `~/.pi/agent/auth.json` 或 `relays.json`。

**I / Import** 只读取 pi-provider 管理的 `~/.pi/agent/models.json` 中的 provider 名称、API、Base URL、model ID；不读取/执行 `!command`，不复制 key 或 headers。需要自定义认证 headers 的服务商目前不支持直接导入认证配置。

API 支持：

| 配置值 | 接口 |
|---|---|
| `openai-responses` | Responses |
| `openai-completions` | Chat Completions |
| `anthropic-messages` | Anthropic Messages |

非本机地址必须使用 HTTPS；拒绝 URL 中的用户名、密码、query 和 fragment。对本机模型服务允许 `http://127.0.0.1:…/v1`。

## 操作

| 快捷键 | 行为 |
|---|---|
| **S** | Start，新账号开始一次真实尝试；demo 模式下只播放合成轨迹 |
| **C** | 配置 API、模型、密钥来源、预算、观测模式 |
| **T** | 用无工具、隔离 pi 做真实 API preflight |
| **P** | 复制并准备项目内游戏，不启动游戏 |
| **D** | 重新检测环境 |
| **I** | 导入 pi-provider 的非敏感模型元数据 |
| **Esc** | 请求停止当前 run；配置页中返回/取消编辑 |
| **Q / Ctrl+C** | 退出；有 run 时先清理自己启动的进程 |

setup 和 preflight 当前不是即时可取消的；退出请求会等待该阶段完成或超时。run 开始后通过 RPC abort 和 owned-PID 清理停止。不要直接强杀工作台，否则可能留下项目内的游戏或锁文件。

### 无风险预览与命令行

```powershell
bun run demo                           # TUI 合成预览，无游戏/API/正式分数
bun run start --demo --headless          # 可脚本运行的合成预览
bun run doctor                         # 只读检测，不调用 API
bun run setup                          # 复制、下载、patch、编译，不启动游戏
bun run start models                   # 只输出模型元数据
bun run start run                      # 使用已保存配置 + 环境变量密钥开始真实尝试
bun run start report                   # 汇总真实结果
```

Demo 的成功只表示预览结束，`demo: true`、`score: 0`，不进入结果榜单。Demo 界面中的动作、耗时和中间指标为合成数据。

## Setup 实际做什么

1. 从 Steam registry / `libraryfolders.vdf` 自动定位 Hacknet，也支持手动路径。
2. 复制到 `runtime/game.staging/`，不修改 Steam 原件，不导入已有 Accounts、Reports、BepInEx 插件等。
3. 下载固定版本 **Pathfinder 5.3.4** 和 **Roslyn 4.8.0**，校验固定 SHA-256；构建无需安装 .NET SDK，使用 Windows 的 .NET Framework。
4. 在副本上安装 Pathfinder/BepInEx，移除 updater。
5. 对副本做离线/存档隔离 patch：禁用 Steam 初始化，把保存目录与游戏/Pathfinder/BepInEx 的 Documents 查询定向到 run 目录。保留 Pathfinder 自身依赖的 IL 结构；不兼容时拒绝继续。
6. 使用固定 HNPF-MCP 子模块源码和 `bridge/` 编译自有适配器，不使用上游的扩展菜单开局逻辑。
7. 写安装标记及游戏、两个 Documents 隔离相关程序集和 bridge 的指纹，完成后重命名为 `runtime/game/`。

至少需要 1.5 GB 可用磁盘空间。全部下载、编译器、游戏副本和存档位于项目 `runtime/` 下，不会提交到 Git。游戏由 Windows 原生 Bun 启动；开发时 Bash 是否来自 WSL 不影响应用架构。

启动时通过随机、鉴权的 NamedPipe 验证真实存档根，再调用原版菜单同一 New Game 回调。**不带 debug 参数，不调用 LoadMission，不跳过教程。**

## 给模型的工具

默认只开放以下 9 个工具；选择 `text+image` 后增加 `hn_screenshot`：

| 工具 | 范围 |
|---|---|
| `hn_screen` | 终端历史、已发现节点、RAM/进程、教程当前文字与按钮状态；不返回隐藏密码、Flag 或任务目标答案 |
| `hn_cmd` | 一条经过静态白名单校验的游戏虚拟终端命令；不是宿主 shell |
| `hn_wait` | 等待 0.1–30 秒，再观察游戏 |
| `hn_input` | 只在程序等待输入时提交用户名/密码/答案，永不按命令 dispatch |
| `hn_tutorial` | 只允许当前可见的教程 Continue / Hint 按钮，不能任意推进教程状态 |
| `hn_mail` | 只列出/读取当前玩家的 inbox |
| `hn_reply` | 通过原任务目标和 sender 验证提交邮件回复 |
| `hn_hub` | 当前连接的任务板中可见合同的列出/接受 |
| `hn_give_up` | 结束无法继续的尝试；不能自行宣布成功 |
| `hn_screenshot` | **可选**，只读取游戏 framebuffer，不截图桌面；需要支持图像输入的模型 |

命令拒绝控制字符、不可见分隔符、shell 元字符、盘符/UNC、父目录穿越，以及 `mcp`、`loadmission`、`dscan` 等作弊命令。未知 exe 不自动加入白名单。因此部分原版虚拟路径用法（例如 `cd ..`）也被保守禁用；可以改用绝对虚拟路径。

模型不获得 read/bash/write、浏览器、任意 MCP 或 provider 管理命令。pi 使用独立 agent 目录、空 workspace、明确工具名单、禁用自动扩展/MCP/上下文文件，并在启动和每次 agent 开始时再次断言工具集。**原生 pi 会话仅在内存中保存**；磁盘轨迹由工作台统一脱敏后写入。

## 计时、判定和产物

- 默认：7200 秒、1500 次工具调用、2,000,000 个报告 token，可配置。
- 墙钟从游戏接受输入、启动隔离 agent 的阶段开始；不含游戏复制/下载/初始开机，停止后不把清理时间算入。
- 分别记录墙钟、assistant 响应时间和工具执行耗时。**游戏实时运行，模型思考时不暂停追踪计时。**
- 外层 watchdog 和扩展工具 admission 双重限制；最多 15 次连续错误、6 次相同动作/相同观测会停止。
- token 由 pi 统计轮询获取，包含 session 统计报告的 cached/summary 等用量；**不是计费硬上限**，可能越过设定值一个进行中的请求。
- judge 是 runner 的特权通道，不把隐藏答案交给模型。当前仅实验性识别原版 credits mission，未完成完整通关回归。
- `infra_error` / `cancelled` 不计入通过率；demo 不写真实结果集。报告按 endpoint、协议、模型、thinking、知识/观测、goal、版本指纹及预算分组。

```text
runtime/
  bench.json                       非敏感配置
  game/                            独立、离线 patch 后的游戏副本
  runs/<id>/
    accounts/                      这个账号的独立 XML 存档
    documents/                     游戏/Pathfinder 的独立 Documents 根
    pi-agent/                      只有本次 provider 定义；key 为环境变量引用
    workspace/                     空的模型工作目录
    config.json                    本次非敏感配置
    commands.jsonl                 游戏终端调用
    events.jsonl                   脱敏后的 RPC、观测、assistant 和诊断事件
    result.json                    状态、分数、耗时、预算用量、版本、judge evidence
  results.jsonl                    真实尝试总表
  leaderboard.md                   实验性汇总，不是正式排行榜
```

密钥不写入配置、命令行参数或 system prompt；编排器日志和结果中的已知 key/token 会脱敏。日志仍可能包含你的 endpoint、模型名称、游戏内信息，按本地敏感资料管理，不自动上传。

## 验证

```powershell
bun run check                        # TypeScript + 63 个单元/回归测试，无真实 API/游戏
bun run smoke:pi                     # 真实 pi 1.5 RPC + 本机假模型/假桥接，无真实 API/游戏
bun run smoke:game                   # 显式启动项目内游戏 GUI，无 LLM/API/正式分数
```

已在本机验证：

- Windows Bun 1.4.4 下 TypeScript 和 63 个测试通过：命令对抗、JSONL Unicode/分片、鉴权/超时/取消、工具集、预算、路径链接、凭据脱敏、报告、TUI、Bun 版本门槛和禁用 .env 自动加载。
- 真实 pi RPC 的加载、无工具 preflight、准确工具集握手、假模型发起 `hn_screen`、假桥接响应、token 统计。
- 原版新账号、教程 Continue 的可见状态约束、普通 connect 命令推进教程、login 提示态的两段输入、终端观测、独立 XML 保存、游戏-only 截图、按 owned PID 清理。
- 游戏 smoke 前后检查个人 Hacknet Accounts 与 Pathfinder 目录指纹，未发生变化。

**尚未完成**：真实模型的长时间 campaign run、完整教程/邮件/任务板回归、可靠 game-over/终局验证、DLC 全流程及评分、模型矩阵/重复/断点续跑、冻结游戏时间。`PLAN.md` 保留设计与这些后续里程碑。

## 故障处理

- **提示使用旧隔离 patch**：先确保没有工作台 run，把项目 `runtime/game/` 移开，再 `bun run setup`。不要对 Steam 原件运行 patch 脚本。
- **`setup.lock` / `active-run.lock` 已存在**：先检查对应工作台是否仍活着；异常退出后确认项目游戏和 pi 子进程都已结束，再手动移除该锁。程序不会按游戏进程名清场。
- **`game.staging/` 已存在**：表示安装被中断。检查后移开这个项目临时目录，再重试；程序不会擅自覆盖未知目录。
- **API 401/协议错误**：检查变量名、Base URL、接口协议和精确 model ID；先使用 T。不要把 key 放进 URL。
- **提示需要 Bun / 意外使用 WSL Bun**：从 Windows PowerShell 启动 `bun run doctor`，确认输出 `platform: win32`、`runtime: Bun …`。不要用 `node` 或 `tsx` 启动工作台。

## 隔离边界与上游

这是 **工具笼 + 独立游戏/存档 + 进程卫生**，**不是 OS sandbox**。游戏和 pi 仍以你的 Windows 用户权限执行；无法保证第三方原生插件漏洞、恶意 endpoint 或本地同用户攻击下的系统隔离。需要强安全边界时应放入 Windows Sandbox / VM。详见 [SECURITY.md](SECURITY.md)。项目不提权、不配置防火墙、不修改全局 pi 设置、不按进程名终止游戏。

- [pi-coding-agent](https://github.com/earendil-works/pi)：RPC/模型适配与 agent 循环。
- [HNPF-MCP](https://github.com/LDTchara/HNPF-MCP)：固定 commit `46b13a132f84939ab26f2e2137001824d76e8f61` 的 bridge 源码作为 Git 子模块复用；不暴露原生 MCP server。
- [pi-provider](https://github.com/BlueOcean223/pi-provider)：只作为非敏感模型目录来源，不在 benchmark agent 中加载。
- [Hacknet-Pathfinder](https://github.com/Arkhist/Hacknet-Pathfinder)：只安装到项目游戏副本。

不分发 Hacknet 游戏文件。使用游戏及第三方组件时遵循各自许可。
