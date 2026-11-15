<p align="center">
  <img src="assets/icon-256.png" width="112" alt="Agent HUD for Windows 图标">
</p>

<h1 align="center">Agent HUD for Windows</h1>

<p align="center">
  <strong>你的编程 Agent 是在工作、在等你，还是已经完成？</strong><br>
  一个始终置顶的小窗口，一眼看清 27 个 Agent 的状态。
</p>

<p align="center">
  <a href="https://www.microsoft.com/windows"><img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4?logo=windows&logoColor=white" alt="Windows 10 / 11"></a>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white" alt="Electron 33"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%E2%89%A520-5FA04E?logo=nodedotjs&logoColor=white" alt="Node 20+"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="Apache-2.0"></a>
  <img src="https://img.shields.io/badge/agents-27-8A63D2" alt="27 个 Agent">
  <img src="https://img.shields.io/badge/tests-passing-3DDC97" alt="测试通过">
  <img src="https://img.shields.io/badge/read--only-%E4%B8%8D%E6%94%B9%E4%BB%BB%E4%BD%95%E9%85%8D%E7%BD%AE-F2B705" alt="只读，不修改任何配置">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#支持的-agent">支持的 Agent</a> ·
  <a href="#工作原理">工作原理</a>
</p>

<p align="center">
  <img src="docs/hero.png" alt="三种大小的 Agent HUD：只有图标、标准面板、展开全部会话的宽面板" width="900">
</p>

你在 Claude Code 里开了一个任务，在 Codex 里开了第二个，在 OpenCode 里开了第三个，然后回去做自己的事。
Agent HUD 停在屏幕边缘，给每个 Agent 显示三种状态之一：

| 状态 | 含义 | 你看到的 |
| --- | --- | --- |
| **工作中** | Agent 正在忙 | 吉祥物上下浮动、眨眼，外圈蓝色转动 |
| **等你** | 需要你回答或批准 | 吉祥物放大，外圈琥珀色呼吸 |
| **已完成** | 这一轮结束了 | 安静的吉祥物，带绿色对勾 |

没有额度、没有 token 图表，也不需要先配置什么。它只读取 Agent 本来就会写的文件。

## 功能

- **每个 Agent 一个吉祥物。** 27 个手绘形象，各有自己的形状和颜色。
- **随内容缩放。** 拖左右边缘，版式随宽度变化，从只有图标到带各状态数量的完整面板；高度始终跟随内容，不会被裁掉也没有空白。
- **点一行就展开。** 窗口变大显示这个 Agent 的所有会话；收起后回到之前的位置和大小。
- **各状态数量。** 每个 Agent 显示 `工作中 2 · 等你 1 · 已完成 5`。
- **自选 Agent。** 设置里列出全部支持的 Agent，已安装的排在前面，每个都有开关。
- **English 和中文。** 默认英文，在设置里切换。
- **只读。** 不修改任何 Agent 的配置，也不向外发送任何数据。
- **桌面快捷方式**，带全局启动键（`Ctrl+Alt+H`）。

## 快速开始

需要 Windows 10 或 11、[Node.js](https://nodejs.org/) 20 及以上、Git。（截图脚本 `scripts/shoot.js` 需要 Node 22 及以上。）

```powershell
git clone https://github.com/kjw0716/agent-hud-win.git agent-hud-win
cd agent-hud-win
npm install
npm start
```

创建桌面和开始菜单快捷方式（之后可以用 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> 启动）：

```powershell
npm run shortcut
```

没有任何 Agent 在运行时，也可以先看演示：

```powershell
npm run demo
```

想开机自启，在设置里打开「开机自启」。

## 截图

<p align="center">
  <img src="docs/states.png" alt="Claude 等你、Codex 工作中、OpenCode 已完成" width="420">
  &nbsp;&nbsp;
  <img src="docs/settings.png" alt="设置：每个 Agent 一个开关，置顶、开机自启、语言" width="300">
</p>

<p align="center">
  <img src="docs/mascots.png" alt="27 个吉祥物在工作中、等你、已完成三种状态下的样子" width="860">
</p>

## 使用

| 操作 | 效果 |
| --- | --- |
| 点某个 Agent 一行 | 窗口变大并显示它的会话；再点一下（或收起最后一行）回到原来的样子 |
| 点顶部的展开按钮 | 一次展开或收起全部 |
| 拖左右边缘 | 改变宽度和版式，高度跟随内容 |
| 拖顶部横条 | 移动窗口 |
| 点滑块按钮 | 设置：显示哪些 Agent、置顶、开机自启、语言、重置、退出 |
| 右键或托盘图标 | 重置位置和大小、退出 |

按宽度的版式：**只有图标** → **图标加状态** → **一行** → **一行加各状态数量** → **展开每个会话**。

## 支持的 Agent

Claude Code 和 Codex 有专门的读取器，其余 Agent 共用一个读取器，查看它们保存的文件。

| Agent | 状态来源 | 等你 | 在真机上验证 |
| --- | --- | :---: | --- |
| **Claude Code** | `~/.claude/sessions/<pid>.json`（`busy`、`waiting`、`idle`） | ✓ | 工作中、等你、已完成均已验证 |
| **Codex** | 最新的 `~/.codex/sessions/**/rollout-*.jsonl` | ✓（批准和提问） | 工作中和已完成已验证；等你只有单元测试 |
| **OpenCode** | `~/.local/share/opencode/opencode.db` 和程序进程 | – | 已确认文件位置和空闲时的表现；工作中未验证 |
| Kilo Code · MiMo Code · Cursor · GitHub Copilot · Gemini CLI · Antigravity · Grok · DeepSeek · Kimi · Pi · Oh My Pi · OpenClaw · Hermes · Factory Droid · TRAE · Qoder · ZCode · CodeBuddy · WorkBuddy · Qwen Code · Devin · Cline · Roo Code · Goose | 各自的会话目录或数据库，路径取自 agent-hud-open 的发现表 | – | 尚未验证 |

「等你」需要 Agent 自己暴露这个信息，目前只有 Claude Code 和 Codex 有，其余 Agent 只显示工作中或已完成。
标「尚未验证」的路径没有在本机测过；如果有错，改 [`agents.js`](agents.js) 里对应的一行即可。

## 工作原理

- **Claude Code** 为每个运行中的进程保存一个登记文件。HUD 读取其中的 `status`，忽略进程已退出的条目：`busy → 工作中`、`waiting → 等你`、`idle → 已完成`。
- **Codex** 每个事件写一行 JSON。HUD 读取最新会话文件的末尾：`task_started` 是工作中，`task_complete` 或 `turn_aborted` 是已完成，没回答的提问或批准是等你。工作中的一轮静默超过 30 分钟按已完成算；没回答的提问或批准会一直保持「等你」。
- **其他 Agent：** 会话文件在最近 12 秒内有写入算工作中；程序在运行，或 6 小时内有活动算已完成；更久的不显示。
- 运行中的程序列表来自 `tasklist`，每 5 秒异步刷新，不会卡住界面。

Claude 的 `waiting` 字段不是公开接口，不同版本的 Claude Code 可能会变。

## 你的数据

- 数据不会离开你的电脑，没有任何网络请求。
- 不会修改或安装任何 Agent 自己的配置。
- HUD 在 `~/.agent-hud-win/` 下写两个小文件：`config.json`（位置、宽度、启用的 Agent、语言）和 `state.json`（最近显示的状态）。
- 不会显示消息内容。从 Agent 取用的文字只有会话名（没有时用项目文件夹名），以及事件类型和时间戳。

## 配置

| 设置 | 方式 |
| --- | --- |
| Agent、置顶、开机自启、语言 | 设置（滑块按钮） |
| 数据目录 | 环境变量 `AGENT_HUD_DATA` |
| 状态组合变化时保存窗口截图 | 环境变量 `AGENT_HUD_SHOT_DIR` |
| 演示数据 | `npm run demo` |

## 开发

```powershell
npm test                                   # 读取器和状态归约，使用注入的时钟和文件系统
npx electron scripts/render-svg.js assets/logo.svg assets/icon-512.png 512   # 渲染图标（要用 Electron，不能用 node 直接跑）
```

```text
main.js        窗口、托盘、缩放、设置、轮询
sources.js     Claude Code 和 Codex 的读取器、按 Agent 汇总
agents.js      其余 25 个 Agent：路径、程序名、工作中/已完成规则
index.html     整个界面：27 个吉祥物、各种版式、设置、中英文
preload.js     页面允许调用的少数几个接口
scripts/       图标渲染、截图、快捷方式创建
test/          node:test 测试
```

## 后续计划

- 在更多真机上验证各 Agent 的路径，并在 Agent 提供时支持「等你」。
- 点一行跳回该 Agent 的窗口。
- Agent 开始等你时可选的提示音或通知。

## 致谢与许可

布局思路、「每个 Agent 一个吉祥物」的想法，以及各 Agent 文件位置表，来自
[jazzenchen/agent-hud-open](https://github.com/jazzenchen/agent-hud-open)（Apache-2.0）。那是一个大得多的项目，
支持 macOS、Windows、Linux，还有额度、批准、手机端等。本项目是对其最简模式的 Windows 小实现，从零编写，
没有复制其代码或图片素材。见 [NOTICE](NOTICE)。

Agent 的名称和颜色归各自所有者。吉祥物是原创绘制，不是官方标志。

使用 [Apache License 2.0](LICENSE) 许可。

<sub>建议的 GitHub 主题标签：`windows` `electron` `desktop-widget` `hud` `ai-agents` `coding-agents` `claude-code` `codex` `opencode` `cursor` `gemini-cli` `github-copilot` `developer-tools`</sub>
