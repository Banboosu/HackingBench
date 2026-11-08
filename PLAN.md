# HackingBench — LLM 游玩 Hacknet 的 Benchmark 规划与实施记录

> 状态:**已按你的“开始 coding / 继续”授权进入实现；v0.1 工作台和基础 smoke test 已完成，完整 benchmark 尚未验证。未修改全局 pi/Steam 原件，已启动并清理项目内独立游戏副本。**
> 下文保留原设计与用户决策，含尚未实现的路线；当前可用范围与限制以 `README.md` 和第 10 节为准。
> 标记:✅ = 已读源码/文档/本机确认;❓ = 假设,仍需验证。

## 0. 先看三个对设计影响最大的现场发现

| #   | 发现                                                                                                                                                                                                                                                                                                                                                                                          | 影响                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ✅ 你的 Hacknet 是**原版 Steam 安装**(`D:\Game\SteamLibrary\steamapps\common\Hacknet`),**没有** BepInEx / Pathfinder / HNPF bridge;且**调研时游戏正在运行**(PID 25572，仅历史快照)。HNPF 的默认 `HNPF_GAME=D:\Game\Hacknet+DLC+Pathfinder\Hacknet.exe` 不存在                                                                                                                                               | benchmark **必须用一份独立拷贝** `runtime/game/`,永不触碰 Steam 那份。自己按 PID 启停,**绝不** `taskkill /IM Hacknet.exe`                             |
| 2   | ✅ HNPF-MCP 的 64 个工具里有大量"作弊/越权"能力:`get_computer` 直接返回用户密码和 `firewall.solution`;`open_port` / `take_admin` / `solve_firewall` / `set_flag` / `run_action` / `write_file`;`launch_game` 会 spawn powershell,默认还带 `-enabledebug -enablefc`;`game_log_tail` 可读宿主文件;`save_game` 写宿主目录;其进程检测按**进程名** `Hacknet.exe`(会把你正在玩的那份当成"已在运行") | LLM **绝不能**直接看到 HNPF 原生 MCP 工具集。agent 侧用**自己的窄工具**,HNPF 只作为 in-game bridge(C# 插件 + 命名管道)复用                            |
| 3   | ✅ `~/.pi/agent/settings.json` 全局加载了 `npm:pi-web-access`(模型可联网搜攻略)和 `pi-provider`;该目录还有 `auth.json`、`relays.json`。✅ bridge 的 `AllowedCommands` **只校验第一个空格前的 token**(`parts[0]`);❓ 不确定 `os.runCommand` 是否支持 `&&`/换行串联                                                                                                                             | bench 里的 pi 必须跑在**隔离的 `PI_CODING_AGENT_DIR`** + `--no-extensions`;命令白名单必须在我们自己的工具层**先做一遍**(含元字符拒绝),不能只靠 bridge |

另外:✅ 你是在 **Windows Terminal → PowerShell 7 → Windows 原生 pi 1.5** 中运行;只有当前 `bash` 工具子进程经 `C:\Windows\System32\bash.exe` 进入 WSL Ubuntu。已通过 Windows 进程父子链确认,并非 pi 本身运行在 WSL。原因是未配置 `shellPath`,Git Bash 安装在 Scoop 自定义目录,不在 pi 优先探测的两个默认安装目录中,于是回退到 PATH 上的旧版 WSL `bash.exe` 启动器。**benchmark 不依赖 WSL**,按后续指示改为使用 Windows 原生 Bun 直接连接 Hacknet 的命名管道 `\\.\pipe\…`,启动时检查 Bun 版本及 `process.platform === "win32"`;不根据开发工具的 Bash 环境推断应用运行环境。

---

## 1. 三个上游各自的角色

| 上游                      | 在本项目里干什么                                                                                                                                                                                               | 不干什么                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **pi-coding-agent 1.5.0** | agent 循环 / 多 provider / 会话日志 / token & cost 统计(`get_session_stats`)/ `abort`。以 **`pi --mode rpc` 子进程**方式嵌入(进程隔离、可 kill-tree、每 run 独立 env)                                          | 不给模型任何内置工具(read/bash/edit/write/powershell/grep/find/ls 全关) |
| **HNPF-MCP**              | ① `bridge/`(游戏内 BepInEx 插件,NamedPipe JSON-RPC)作为游戏控制面;② `server/src/bridge.js`(136 行管道客户端)vendoring 复用;③ 其 `Safety`(AllowedCommands/Token)作为第二道防线;④ 其 `menu.*` 方法做"读档进扩展" | **不**把原生 MCP server 暴露给模型;不用它的 `launch_game`               |
| **pi-provider**           | 你用 `/provider` 管理中转站/模型(`~/.pi/agent/models.json`);bench 把它当"**模型清单来源**"读取,并复用它的"catalog probe + chat test"思路做 preflight                                                           | 不在 bench 的 agent run 里加载(它是交互式 UI 扩展)                      |

---

## 2. 总体架构

```
┌─ bench CLI(TS, Windows Bun, 特权) ───────────────────────────────┐
│ ModelMatrix  读 models.json → 选模型 → preflight(1 次 chat ping)    │
│ GameManager  复制干净游戏 → 写 bridge cfg(随机 Token/白名单/管道名)  │
│              → 按 PID 启动 → 等 bridge → 读档进场景 → 结束按 PID 杀   │
│ TaskRunner   (model × task × repeat) 循环,断点续跑                  │
│ Scorer       特权 bridge 客户端:任务/Flag/文件/管理员/事件 → 判分    │
│ Watchdog     墙钟/步数/token/卡死 → RPC abort → kill-tree            │
│ Reporter     results.jsonl → leaderboard.md/html                     │
└──────┬───────────────────────────────────────────────┬───────────┘
       │ spawn(jail 参数 + 隔离 env)                    │ NamedPipe(特权)
┌──────▼──────────────────────────┐          ┌─────────▼───────────────┐
│ pi --mode rpc  (被关进笼子)       │  pipe    │ Hacknet 拷贝 + BepInEx   │
│  只加载 extension/hacknet-player │◄────────►│ + Pathfinder + bridge    │
│  工具: hn_cmd / hn_screen /      │ (玩家级)  │ + HackBench 扩展(任务内容) │
│        hn_mail / hn_wait …       │          └─────────────────────────┘
└─────────────────────────────────┘
```

**agent 侧集成方案(推荐 B,请确认)**

- A. 用 pi 内置 MCP 接原生 HNPF server,`exposure` 默认 hidden + 白名单 8 个工具设 `direct`,再用 `tool_call`/`tool_result` hook 过滤/脱敏。优点:零胶水。缺点:输出里的密码/Flag 等字段要靠 hook 脱敏(脆弱);server 还会带出 resources/prompts 工具;多一个常驻进程。
- **B(推荐). 自写 pi 扩展 `hacknet-player.ts`,直接说管道协议**,只注册 ~6 个工具。攻击面最小;观测内容按"人类玩家在屏幕上能看到的"设计(公平);计时/日志/限流在同一处。
- 原生 server 保留为**开发调试**用。

---

## 3. 权限与安全模型("别把我电脑黑了")

纵深防御,**默认 fail-closed**:

| 层                        | 措施                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0 模型无任何代码执行路径 | pi 子进程参数:`--tools "hn_*"`(显式白名单,**无** read/write/edit/bash/powershell)、`--no-mcp`、`--no-extensions -e extension/hacknet-player.ts`、`--no-skills --no-prompt-templates --no-themes --no-context-files`、`--no-approve`(不加载项目 `.pi`)、cwd=空的 run 目录。env:`PI_CODING_AGENT_DIR=runtime/pi-agent`(隔离,**不含**你的 auth.json / pi-web-access / relays.json)、`PI_TELEMETRY=0`、`PI_SKIP_VERSION_CHECK=1` |
| L0.5 工具集断言           | 扩展在 `session_start` / `before_agent_start` 调 `pi.setActiveTools(allowlist)`;`tool_call` 钩子对白名单外工具一律 `block`;启动后若发现活跃工具 ⊄ 白名单 → 该 run 记 `infra_error` 并中止                                                                                                                                                                                                                                    |
| L1 命令校验(自己的工具层) | `hn_cmd`:**首 token 白名单**(原版玩家命令 + 本机 /bin 里的 exe 名,最终清单在 M0 从游戏 `help`/`exe` 输出导出)、**拒绝** `& \| ; \` $ ( ) < > \n \r`、长度 ≤200、拒绝盘符/UNC 路径、**明确禁止** `mcp / loadmission / loadactions / dscan / debug\* / sudo / execute / fastHack / revealAll`;速率限制                                                                                                                         |
| L2 bridge 自带 Safety     | 写入游戏拷贝的 cfg:`AllowedCommands=<同一份清单>`、`AutoToken` 每 run 由 bench 生成随机 Token、管道名 `hnpf-bench-<runId>`(不与你正在玩的实例冲突)。注:`ReadOnly=true` 会连 `execute_command` 一起拦,所以不能用                                                                                                                                                                                                              |
| L3 游戏拷贝               | 独立目录 `runtime/game/`;启动**不带** `-enabledebug -enablefc`;存档/Documents 写入范围在 M0 确认(Pathfinder 存 `Documents\My Games\HacknetPathfinder\`,与你原版存档的 `My Games\Hacknet` 分开);每 run 前从模板目录恢复                                                                                                                                                                                                       |
| L4 进程卫生               | 只按自己 spawn 的 PID 终止,Windows 下 `taskkill /PID <pid> /T /F`;启动前检查 `runtime/` 外是否有同名管道;**永不**按进程名杀                                                                                                                                                                                                                                                                                                  |
| L5 网络                   | pi 子进程只需要访问你选定的 LLM endpoint。提供可选 `scripts/harden-firewall.ps1`(**需你自己以管理员运行,我不会替你提权**),给 `runtime/game/Hacknet.exe` 加出站拒绝规则                                                                                                                                                                                                                                                       |
| L6 密钥                   | `runtime/` 与 `.env` 进 `.gitignore`;`bench models sync` 只把**选中**的 provider 导出到隔离 `models.json`(限 ACL;或改成 `$ENV_VAR` 引用,见决策点 7);日志写盘前正则脱敏 `sk-…`/Bearer;模型看不到 env(无 shell)                                                                                                                                                                                                                |
| L7 可选的更强隔离         | Tier B:整套(游戏+pi+orchestrator)放进 Windows Sandbox / Hyper-V VM,仅放行 LLM API 出站。pi 官方 `security.md` 也认为整进程隔离是最强方案。v1 不做,先留接口                                                                                                                                                                                                                                                                   |

**M0 安全 spike(必做,先于一切)**:对 L1 白名单做对抗测试——`ls&&…`、换行、Unicode 空白、超长、大小写、`exe` 名带路径、`scp`/`upload` 路径穿越、`mcp exec`、login 提示态下的输入 —— 确认没有任何一条能离开游戏虚拟文件系统/触达宿主。

残余风险(诚实说明):模型没有 shell,只有一个受限的游戏终端;剩下的攻击面是 bridge/Pathfinder 本身的 bug,以及白名单实现缺陷——所以 spike 才排在第一位。

---

## 4. 计时器与预算(多层)

| 层                | 默认值(可配)                                                                                                                | 触发后                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 单次 LLM 请求超时 | `retry.provider.timeoutMs` = 120s(写进隔离 settings.json);`retry.maxRetries`=3                                              | 重试仍失败 → `infra_error`(**不扣模型分**,自动补跑) |
| 单次工具调用      | `hn_cmd` 等输出稳定:最长 `settleMs`≈4s;bridge 调用超时 8s                                                                   | 返回 `[timeout]` 观测,不中止 run                    |
| **单任务墙钟**    | 按 tier:T0 3min / T1 8min / T2 15min / T3 20min                                                                             | RPC `abort` → 判分 → `timeout`                      |
| 步数              | 工具调用 ≤150;连续失败命令 ≤15                                                                                              | `budget_exhausted`                                  |
| 卡死检测          | 同一命令 + 同一观测 重复 ≥6 次                                                                                              | `stalled`                                           |
| Token 预算        | 输入+输出 ≤ 每任务上限(每个 turn_end 轮询 `get_session_stats`)。**用 token 而非美元**:pi-provider 对未知中转模型默认 cost=0 | `budget_exhausted`                                  |
| 整个套件          | 总墙钟 / 总 token;`results.jsonl` 追加写,按 `(model,task,rep)` 断点续跑                                                     | 优雅停止                                            |
| 时钟记录          | 每步记:墙钟、LLM 思考耗时、工具耗时、(可得时)游戏内时间                                                                     | 写入结果                                            |

**时间模型(决策点 2)**:Hacknet 是**实时**游戏(追踪计时器按真实时间走),LLM 思考时游戏照走 → 慢模型被惩罚且结果不可复现。

- v1:实时模式 + 早期任务不含硬追踪计时;同时报告"LLM 思考时间"与"游戏时间"。
- v2(可选,要 fork bridge):Harmony 补丁冻结 `OS.Update`,仅在 `hn_cmd` 结算窗口 / `hn_wait` 期间解冻 → "回合制"、可复现。

---

## 5. agent 工具设计(公平性:只给玩家屏幕上看得到的)

| 工具                  | 说明                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `hn_cmd(cmd)`         | 执行一条白名单终端命令,等待输出稳定,返回**新增终端行**(截断 ≤4KB)                    |
| `hn_screen()`         | 当前连接节点/目录、RAM、进程(ps)、**已发现**的网络地图(无密码/Flag/防火墙答案)       |
| `hn_mail(action,id?)` | 邮件列表/正文(游戏 UI 本来就能看)                                                    |
| `hn_input(text)`      | ❓ 终端处于提示态(如 `login`)时的输入;依赖 spike 确认 `os.runCommand` 在提示态的行为 |
| `hn_wait(seconds)`    | 让游戏时间流逝(上限 30s),计入预算                                                    |
| `hn_give_up(reason)`  | 允许模型显式放弃(区分 gave_up 与 timeout)                                            |

系统提示词按**知识档位**做成可对比维度:L0 = 只给目标,靠游戏内 `help` 自学;L1 = 附 `HN命令速查.md` 精简版(含"scp 方向相反/exe 是列表"等坑)。默认 L1。

---

## 6. 任务与评分

**任务内容**:自制 Pathfinder 扩展 `HackBench`(自己的节点/任务 XML),原因:确定性、不在训练语料里、每题 <10 分钟。可选后期:按 seed 渲染 XML 模板(随机 IP/密码)防背题。

| Tier    | 能力点(草案)                                                  |
| ------- | ------------------------------------------------------------- |
| T0 烟雾 | `connect` → `cat` → 提交字符串答案                            |
| T1 基础 | `scan`/`probe` → 开端口程序(SSHcrack 等)→ `porthack` → 读凭据 |
| T2 多跳 | 沿链接多跳、从日志/邮件找线索、`scp` 取文件、清日志           |
| T3 防御 | 防火墙 `analyze`→`solve`、代理过载(shell)、RAM 管理、追踪计时 |
| T4 长程 | 多任务链(后期:原版战役片段,需要 `LoadMission`)                |

**任务描述** `tasks/<id>.yaml`:`setup`(扩展名/存档快照/初始 run_action/Flag)、`prompt`、`success`(特权谓词:Flag / 任务完成 / 某节点 admin / 文件存在或含某内容 / 答案串)、`failure`(被追踪 game-over 等)、`budgets`、`knowledgeLevel`。

**指标**:`status ∈ {success, game_over, timeout, budget_exhausted, stalled, gave_up, infra_error}`;`score`(0–1,按任务目标加权部分得分,来自 `mission_detail`);步数、墙钟、游戏时间、tokens(in/out/cache)、非法/被拒命令率、工具调用格式错误率。多次重复(默认 3)报 pass@1 ± CI;`infra_error` 不计入模型成绩。**记录** `provider id + baseUrl 主机 + modelId + thinking level`(同名模型在不同中转站质量可能不同)。

**公平性控制**:同一提示词/工具描述/seed;`(模型×任务×重复)` 顺序随机化,稀释中转站负载波动;观测统一截断;pi 自动 compaction 保持默认并记录事件。

---

## 7. 目录规划

```
HackingBench/
├─ PLAN.md
├─ package.json / tsconfig.json
├─ bench/                    # orchestrator CLI:doctor | setup | models | run | report | clean
│  └─ src/{cli,config}.ts  game/{manager,launcher,bridgeClient}.ts
│        pi/{rpcRunner,jail}.ts  tasks/{loader,predicates}.ts  timers/{budget,watchdog}.ts  report/
├─ extension/hacknet-player.ts   # pi 扩展:窄工具 + 守卫 + 断言 + 单步计时
├─ vendor/hnpf-mcp/              # git submodule,钉死 commit(bridge/ + bridge.js)
├─ content/HackBench/            # Pathfinder 扩展(任务内容)
├─ tasks/*.yaml
├─ config/{bench.config.json, allowed-commands.json, pi-agent-template/settings.json}
├─ scripts/{install-game.ps1, harden-firewall.ps1(可选,需手动提权)}
├─ test/                         # fake-bridge(复用 HNPF 的 fake-bridge 思路)→ 无游戏也能 CI
└─ runtime/   (gitignored)       # game/ pi-agent/ runs/<runId>/{session.jsonl,commands.jsonl,events.jsonl,result.json}
```

---

## 8. 里程碑

| M                  | 内容                                                                                                                                                                                                                                                       | 退出条件                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **M0 Spike**(先做) | 复制游戏 → 装 BepInEx+Pathfinder → `dotnet build` bridge 并部署 → 管道连通;验证 ❓ 项:`&&`/换行、login 提示态、`-enabledebug` 是否必需、get_network_map 可见性字段、追踪/game-over 事件、读档进场景耗时、DLC 是否存在、文档目录写入范围;**跑安全对抗测试** | 每个 ❓ 有结论;安全 spike 无逃逸               |
| M1 笼子与工具      | `hacknet-player.ts` + 白名单 + 工具集断言 + fake-bridge 单测                                                                                                                                                                                               | 无游戏下单测全绿;断言能拦住额外工具            |
| M2 单任务闭环      | GameManager + RpcRunner + Watchdog + 日志;1 模型 × T0                                                                                                                                                                                                      | 超时/卡死/预算各触发一次且清理干净(无残留进程) |
| M3 任务集 v0       | HackBench 扩展 + 8~12 题 + 谓词判分                                                                                                                                                                                                                        | 人工通关每题;空 agent 得 0 分                  |
| M4 矩阵与报告      | 读 models.json、preflight、重复、续跑、leaderboard                                                                                                                                                                                                         | 一键跑 N 模型 × 全套件                         |
| M5 可选            | 时间冻结补丁、Tier B 沙箱、并行多实例(管道名已按 run 区分)、截图/视觉模态、原版战役切片                                                                                                                                                                    | —                                              |

---

## 9. 需要你拍板的决策点

1. **隔离强度**:v1 = L0–L6(工具笼 + 独立游戏拷贝,无沙箱)可以吗?还是要一上来就 Windows Sandbox/VM(工作量显著增加,且命名管道需改走 TCP 或整套放进去)?

v1 ok

1. **时间模型**:v1 实时 + 双时钟记录,v2 再做冻结补丁——OK?

v1 ok

1. **agent 侧集成**:选 B(自写扩展直连管道)?

选B

1. **任务内容**:自制 `HackBench` 扩展(推荐)还是优先原版战役片段?你的游戏有 Labyrinths DLC 吗(M0 会确认)?

用原版游戏，有dlc

1. **默认知识档位**:L1(带命令速查)作为主榜,L0 作副榜?

ok

1. **观测模态**:仅文本(推荐),还是预留截图/视觉通道?

作为一个option

1. **密钥处理**:隔离目录里放选中 provider 的 `models.json` 副本(含 key,限 ACL),还是你把 key 改成 `$ENV_VAR` 引用、由 bench 注入 env?(我倾向后者更干净)

后者

1. **并行**:v1 串行一个游戏实例,可以吗?

ok

1. **我会动你机器的范围**(请确认):仅在 `D:\Playground\HackingBench` 下创建文件;复制一份 Hacknet 目录到 `runtime/game/`(多大请你确认磁盘空间);联网下载 BepInEx/Pathfinder;**不**改 `~/.pi/agent`、**不**碰 Steam 安装、**不**提权。

ok

我希望这个程序启动后自动检测、配置环境，输入api和密钥后启动一个完善精美的、符合游戏风格并且易用的tui，用户start后llm开始速通hacknet

---

## 10. v0.1 实施记录（当前状态，不替代上述用户决策）

### 已实现与实测

- Windows 原生 Bun ≥1.4.4 + pi 1.5.0 RPC；Hacknet 风格 Ink TUI、配置页、masked 会话密钥、provider 元数据导入、Start/Stop、doctor/setup/demo/report。
- 真实 run 前用无工具、隔离 pi 做 API preflight；不会加载用户全局的 web/provider/MCP 扩展。Pi session 改为仅内存，持久化轨迹统一经编排器脱敏，避免原生会话绕开日志脱敏。
- 固定 HNPF-MCP commit 已作为 Git 子模块记录；Pathfinder 5.3.4、Roslyn 4.8.0 下载有固定 SHA-256，无需额外安装 .NET SDK。
- 已从 Steam 原件**复制并冷安装**项目副本；离线 patch 处理 game/Pathfinder/BepInEx 的 Documents 调用、禁用 Steam 初始化，并保留 Pathfinder 所需 IL 结构。安装契约 version 2、offline patch version 2；启动和重编译前验证四个敏感二进制，不能通过普通 adapter rebuild 掩盖已改变的隔离程序集。
- 游戏 smoke：原版菜单新账号 → 正常启动教程 → 只能点击可见 Continue/Hint → 普通 connect 推进教程；login 用户名/密码提示态可正常输入，输入不会 dispatch 为命令；独立 XML 存档、游戏 framebuffer 截图、owned-PID 清理均通过。个人 Hacknet Accounts / Pathfinder 目录前后指纹未变化。
- 模型只见 9 个 `hn_*` 工具，image 模式增加 1 个截图工具；命令与提示态输入分别处理，没有通用 shell、宿主文件或原生 MCP 工具。
- 墙钟、步数、token、连续错误/重复卡死限制，扩展 admission + 外层 watchdog；result 保存 thinking、预算、版本指纹；报告排除 demo，并把 infra/cancel 排除于通过率之外。
- `bun run check`：TypeScript + **63 个单元/回归测试**；`bun run smoke:pi` 用真实 pi + 本地假模型/假桥接验证工具握手、调用往返和 token 统计，**不使用真实 API/key**。

### Bun 迁移（按后续用户指示）

- 安装、运行 TS/TSX、类型检查、测试、smoke 和 PowerShell 启动器统一改为 Bun；固定 `bun.lock`，移除 npm lock 和 tsx 依赖。
- `bunfig.toml` 禁用自动 .env 加载，缓存放项目 `runtime/`；锁定安装跳过 lifecycle scripts。
- doctor / GameSession 检查 Windows 原生 Bun，结果记录真实 Bun runtime，而不是 Bun 的 Node 兼容版本号。
- Bun 1.4.4 下已重跑 63 个测试、真实 pi RPC + 本地假 API smoke、项目游戏副本 smoke（含真实 NamedPipe、教程/提示态、XML 存档、framebuffer 和 owned-PID 清理）。未使用真实模型/key。

### 尚未完成（不能宣称完整 benchmark 已可用）

- 没有调用用户真实模型，也没有进行真实 LLM 原版完整通关。
- 当前目标只有原版结局；DLC 文件保留/检测，但 DLC 交互面（包括 IRC 等）、完整通关目标与评分尚未实现。
- credits mission 终局谓词、game-over、全程邮件/合同/教程仍缺完整流程回归；当前 goal 明确标为 experimental。
- 模型矩阵、重复、断点续跑、任务集、正式 leaderboard、冻结游戏时间仍属于后续里程碑。
- 工具笼不构成 OS sandbox；没有自动提权/防火墙规则，强隔离仍需外部 Sandbox / VM。

使用方式、可选截图、安全边界和恢复步骤见 `README.md` / `SECURITY.md`。
