[简体中文](#commandcode-usage-context) | [English](#english)

# commandcode-usage-context

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **⚠️ 非官方工具** — 本项目是 Command Code CLI 的第三方 mod，与 CommandCode 官方无关，亦未获官方认可。使用风险自负。

**Command Code CLI 非官方 mod：底部状态栏实时显示 token 用量、缓存率、费用（峰谷感知 2× 计费）与上下文进度条，零 token 消耗。**

在 Command Code CLI 交互界面底部常驻一行实时状态栏，无需发消息、无需切窗口：

```
输入: 696.7万|输出: 12.1万|缓存: 686.4万|缓存率: 98.5%|费用: 0.1086|上下文: ██░░░░░░░░ 19.5% 194.8k/1M
```

- **每次模型响应完成即刷新**（时间粒度 = 每次 API 调用）
- **峰谷感知计费**：工作日北京时间 9-12、14-18 为峰段（2× 价），周末与其余时段谷段（1×）
- **上下文窗口进度条**：一眼看出当前会话上下文占用
- 全程本地运行、不联网、不向模型注入任何内容，**零 token 消耗**

## 工作原理

mod 通过 CLI 自带的 mod 加载机制（`~/.commandcode/mods/`）注册钩子，增量解析本机
`~/.commandcode/projects/` 下的会话记录（每条 AI 回复落盘时都带有完整的 token 用量与牌价费用），
在 attach / 每次请求完成 / 回合结束时刷新状态栏。识别"刚恢复了哪个会话"依据文件的
**访问时间（atime）**——恢复会话时 CLI 必然读取被选中对话的文件。

## 要求

- Command Code CLI（npm 包 `command-code`），v1.53.x 验证可用
- Windows 10/11（会话文件需位于系统盘的 NTFS 分区，atime 功能依赖此默认策略）

## 安装

**双击 `install.bat`**，看到全部 `[OK]` 后**重开 commandcode 会话**即可。

安装器会自动检测：CLI 数据目录、cmdc 命令与版本、atime 是否开启，任何异常都会明确提示。

（手动方式：把 `commandcode-usage` 文件夹整体复制到 `%USERPROFILE%\.commandcode\mods\` 下）

## 显示口径

| 项 | 含义 |
|---|---|
| 输入 / 输出 / 缓存 | CLI 落盘的官方真实用量（每条回复落盘时记录） |
| 缓存率 | 缓存读 ÷ 输入（缓存读是输入的子集，越高越省钱） |
| 费用 | 按官方牌价折算的**参考值**（峰谷感知），非实际账单——订阅套餐扣的是额度，精确账单以官网为准 |
| 上下文 | 最近一次请求的总输入 ÷ 窗口上限（估算口径，与 CLI 内置指示一致） |

## 自定义（编辑 index.mjs 顶部常量）

| 常量 | 说明 |
|---|---|
| `CONTEXT_LIMIT` | 上下文窗口上限，默认 1M（deepseek-v4.1-flash）；换其他窗口大小的模型请同步修改 |
| `COLOR` / `RESET` / `GREEN` | 状态栏配色（默认按 CLI 暗色主题校准：文字 #8A94A8、进度条 #2EBD8E） |
| `BAND_MODEL_IDS` | 峰谷计费模型清单（CLI 新增时段计费模型时补 id） |

## 排障

### /sessions 恢复会话后，显示的是别的会话的数据？

mod 通过文件的**访问时间（atime）**识别"你刚恢复了哪个会话"（恢复时 CLI 必然读取该会话文件）。
若系统关闭了 atime 更新，此功能退化：恢复较老对话时可能先显示其他会话的数据，发一条消息后自动校正。

检查与开启（管理员终端）：

```
fsutil behavior query disablelastaccess     （值应为 2：系统托管，已启用）
fsutil behavior set disablelastaccess 2     （开启后重开会话生效）
```

### 其他问题

用 `set CC_USAGE_DEBUG=1&& cmdc` 启动会话，每次刷新会追加日志到 `%TEMP%\cc-usage-mod.log`；
删除 `%USERPROFILE%\.commandcode\mods\usage-context\` 文件夹即彻底移除，无任何残留。

## 已知限制

- mod 依赖 CLI 未文档化的内部接口，CLI 大版本更新后如失效，删除本文件夹即可，无残留
- 仅交互模式渲染；`-p` 无头模式不显示（属 CLI 行为）
- 状态栏为单行设计（CLI 状态栏机制限制），配色按暗色主题校准

## License

[MIT](LICENSE)

---

## English

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **⚠️ Unofficial tool** — A third-party mod for the Command Code CLI. Not affiliated with, endorsed by, or sponsored by CommandCode. Use at your own risk.

**Unofficial mod for Command Code CLI — a persistent status bar at the bottom of the interactive UI, showing token usage, cache hit rate, cost (peak/off-peak aware) and a context window indicator in real time. Zero token overhead.**

A live status bar pinned to the bottom of the Command Code CLI interactive UI — no need to send a message or switch windows:

```
Input: 696.7万|Output: 12.1万|Cache: 686.4万|Cache rate: 98.5%|Cost: 0.1086|Context: ██░░░░░░░░ 19.5% 194.8k/1M
```

- **Refreshes on every model response** (granularity = per API call)
- **Peak/off-peak aware cost**: weekdays 9:00-12:00 & 14:00-18:00 Beijing time are peak (2× rates); weekends and all other hours are off-peak (1×)
- **Context window progress bar**: see session context usage at a glance
- Runs fully locally, never goes online, injects nothing into the model — **zero token overhead**

## How it works

The mod registers hooks through the CLI's built-in mod loading mechanism (`~/.commandcode/mods/`) and
incrementally parses local session logs under `~/.commandcode/projects/` (every AI reply is written to
disk with full token usage and list-price cost). The status bar refreshes on session attach, after each
model request, and at turn end. "Which session was just resumed" is identified by the file's
**access time (atime)** — resuming a session always reads the selected conversation file.

## Requirements

- Command Code CLI (npm package `command-code`), verified on v1.53.x
- Windows 10/11 (session files must be on an NTFS partition of the system drive; the atime feature relies on this default policy)

## Install

**Double-click `install.bat`** — once every check shows `[OK]`, **restart your commandcode session**.

The installer auto-detects: the CLI data directory, the cmdc command and version, and whether atime is enabled — anything abnormal gets a clear message.

(Manual: copy the `commandcode-usage` folder into `%USERPROFILE%\.commandcode\mods\`)

## Display semantics

| Item | Meaning |
|---|---|
| Input / Output / Cache | Official usage as written by the CLI (recorded per reply) |
| Cache rate | cache read ÷ input (cache read is a subset of input; higher = cheaper) |
| Cost | A **reference value** converted at official list prices (peak/off-peak aware), not an actual bill — subscriptions deduct quota; exact billing per the official site |
| Context | Latest request's total input ÷ window limit (estimated, same as the CLI's built-in indicator) |

## Customization (constants at the top of index.mjs)

| Constant | Meaning |
|---|---|
| `CONTEXT_LIMIT` | Context window limit, default 1M (deepseek-v4.1-flash); adjust when switching models |
| `COLOR` / `RESET` / `GREEN` | Status bar colors (calibrated for the CLI dark theme: text #8A94A8, bar #2EBD8E) |
| `BAND_MODEL_IDS` | Peak/off-peak billing model list (add ids when the CLI adds time-based models) |

## Troubleshooting

### After switching sessions via /sessions, is another conversation's data shown?

The mod identifies "which session you just resumed" via the file's **access time (atime)** (resuming
a session always reads the selected conversation file). If your system has atime updates disabled, this
degrades: resuming older conversations may briefly show another conversation's data; it self-corrects
after one message.

Check and enable (admin terminal):

```
fsutil behavior query disablelastaccess     (should be 2: system managed, enabled)
fsutil behavior set disablelastaccess 2     (restart the session after changing)
```

### Other issues

Start with `set CC_USAGE_DEBUG=1&& cmdc` — every refresh appends to `%TEMP%\cc-usage-mod.log`;
delete `%USERPROFILE%\.commandcode\mods\usage-context\` to remove the mod completely, no leftovers.

## Known limitations

- The mod relies on undocumented CLI internals; if a CLI major update breaks it, just delete this folder — no residue
- Renders in interactive mode only; `-p` headless mode shows nothing (CLI behavior)
- Single-line status bar (CLI status bar mechanism limit); colors calibrated for the dark theme

## License

[MIT](LICENSE)
