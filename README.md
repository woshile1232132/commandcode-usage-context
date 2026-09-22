[简体中文](#commandcode-usage-context) | [English](#english)

# commandcode-usage-context

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **⚠️ 非官方工具** — 本项目是 Command Code CLI 的第三方 mod，与 CommandCode 官方无关，亦未获官方认可。使用风险自负。

**Command Code CLI 非官方 mod：底部状态栏实时显示 token 用量、缓存率、费用（峰谷感知 2× 计费）、上下文进度条与账号剩余额度（可选），零 token 消耗。**

在 Command Code CLI 交互界面底部常驻一行实时状态栏，无需发消息、无需切窗口：

```
额度剩余 64% · 已用 36%|峰2.0x|距谷2h13m|输入:696.7万|输出:12.1万|缓存率:98.5%|费用:0.1086|上下文:██░░░░░░░░ 19.5% 194.8k/1M
```

- **每次模型响应完成即刷新**（时间粒度 = 每次 API 调用）
- **峰谷感知计费**：工作日北京时间 9-12、14-18 为峰段（2× 价），周末与其余时段谷段（1×）
- **峰谷实时标记**：状态栏最左显示 `峰2.0x` / `谷1.0x` 与 `距峰/距谷` 倒计时，跨边界自动翻转
- **剩余额度查询（可选）**：读本机 `auth.json` 凭据只读查询套餐额度，显示剩余/已用百分比；未登录或 BYOK 时自动隐藏该段
- **上下文窗口进度条**：一眼看出当前会话上下文占用
- token / 费用 / 上下文全程本地解析、不联网；仅「剩余额度查询」会向 `api.commandcode.ai` 发只读请求（可用 `QUOTA.enabled` 关闭）。不向模型注入任何内容，**零 token 消耗**

## 工作原理

mod 通过 CLI 自带的 mod 加载机制（`~/.commandcode/mods/`）注册钩子，增量解析本机
`~/.commandcode/projects/` 下的会话记录（每条 AI 回复落盘时都带有完整的 token 用量与牌价费用），
在 attach / 每次请求完成 / 回合结束时刷新状态栏。识别"刚恢复了哪个会话"依据文件的
**访问时间（atime）**——恢复会话时 CLI 必然读取被选中对话的文件。
「剩余额度查询」走另一条独立通路：只读 GET CLI 的账单接口（`/alpha/billing/*`），按 `QUOTA.ttlMs` 节流刷新，失败时保留上次值。

## 要求

- Command Code CLI（npm 包 `command-code`），v1.53.x 验证可用
- 官方订阅账号（「剩余额度查询」需要；BYOK / 未登录时该段自动隐藏，其余功能不受影响）
- Windows 10/11（会话文件需位于系统盘的 NTFS 分区，atime 功能依赖此默认策略）

## 安装

**双击 `install.bat`**，看到全部 `[OK]` 后**重开 commandcode 会话**即可。

安装器会自动检测：CLI 数据目录、cmdc 命令与版本、atime 是否开启，任何异常都会明确提示。

（手动方式：把 `commandcode-usage-context` 文件夹整体复制到 `%USERPROFILE%\.commandcode\mods\` 下）

## 显示口径

| 项 | 含义 |
|---|---|
| 输入 / 输出 / 缓存 | CLI 落盘的官方真实用量（每条回复落盘时记录）。**缓存绝对量默认不显示** —— 它与缓存率信息重叠（缓存 ≈ 输入 × 缓存率），需要时把 `SHOW.cacheAbs` 改成 `true` |
| 缓存率 | 缓存读 ÷ 输入（缓存读是输入的子集，越高越省钱） |
| 费用 | 按官方牌价折算的**参考值**（峰谷感知），非实际账单——订阅套餐扣的是额度，精确账单以官网为准 |
| 上下文 | 最近一次请求的总输入 ÷ 窗口上限（估算口径，与 CLI 内置指示一致） |
| 额度 | 套餐月度额度池的剩余 / 已用百分比（月池口径）；有购买 / 赠送额度时自动改为显示绝对剩余，避免误导 |

## 剩余额度查询（可选，默认开启）

从本机 `~/.commandcode/auth.json` 读取凭据（或环境变量 `COMMAND_CODE_API_KEY`），只读查询 CLI 的账单接口：

- **请求量**：会话开始 2~3 个请求，之后最多每 2 分钟 1 个（`QUOTA.ttlMs` 节流）；**不消耗 token / 额度**
- **隐私**：凭据只在本机读取、只发给 `api.commandcode.ai`；不落盘、不外发其它域名
- **口径**：`已用% =（套餐额度总额 − 月度剩余）/ 总额`；购买 / 赠送池不计入百分比，有额外额度时自动改用绝对剩余
- **关闭**：把 `QUOTA` 里的 `enabled` 改成 `false`（即回到完全本地、零网络请求）
- ⚠️ `/alpha/*` 是 CLI 内部接口（官方未公开承诺）；接口变动时该段会静默消失，不影响其它显示

## 自定义（编辑 index.mjs 顶部常量）

| 常量 | 说明 |
|---|---|
| `CONTEXT_LIMIT` | 上下文窗口上限，默认 1M（deepseek-v4.1-flash）；换其他窗口大小的模型请同步修改 |
| `LANG` | 界面语言：`"zh-CN"`（默认，万/亿）/ `"en"`（英文标签 + k/M 单位） |
| `SHOW.cacheAbs` | 是否显示「缓存」绝对量（默认 `false`，只留缓存率，省 13 列） |
| `QUOTA.enabled` | 剩余额度查询开关（默认 `true`；设 `false` 即完全本地、零网络请求） |
| `QUOTA.position` | 额度段位置：`"head"` 放最左（窄终端也保得住）/ `"tail"` 追加行尾 |
| `QUOTA.ttlMs` | 额度刷新节流（默认 120000 = 2 分钟）；别调到 10s 以下，那是内部账单接口 |
| `QUOTA.template` / `fallback` / `extrasFallback` | 额度文案模板（占位符 `{rpct}` `{pct}` `{left}` `{plan}`） |
| `COLOR` / `RESET` / `GREEN` / `RED` / `BLUE` / `PURPLE` | 状态栏配色（暗色主题校准：文字 #8A94A8、进度条 #2EBD8E、峰段 #D65A5A、缓存率 #5096E6、费用 #A078DC） |
| `BAND_MODEL_IDS` | 峰谷计费模型清单（CLI 新增时段计费模型时补 id） |

## 多语言（切换到 English）

两种方式任选其一，**改完重开 commandcode 会话**才生效：

1. **改常量**（推荐）：把 `commandcode-usage-context/index.mjs` 顶部的 `LANG` 改成 `"en"`，保存后双击 `install.bat` 重新安装。
2. **环境变量**（不改文件，优先级更高）：

   ```
   set CC_USAGE_LANG=en&& cmdc
   ```

   想长期生效就写进系统环境变量。

> 语言只影响标签与数字单位（`输入/输出/缓存/缓存率/费用/上下文` ↔ `in/out/cache/cache hit/cost/ctx`，`万/亿` ↔ `k/M`），不影响任何数字口径。

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
删除 `%USERPROFILE%\.commandcode\mods\commandcode-usage-context\` 文件夹即彻底移除，无任何残留。

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

**Unofficial mod for Command Code CLI — a persistent status bar at the bottom of the interactive UI, showing token usage, cache hit rate, cost (peak/off-peak aware), a context window indicator and your remaining plan credits (optional), in real time. Zero token overhead.**

A live status bar pinned to the bottom of the Command Code CLI interactive UI — no need to send a message or switch windows:

```
Credits 64% left · 36% used|peak2x|to offpeak 2h13m|Input:696.7万|Output:12.1万|Cache rate:98.5%|Cost:0.1086|Context:██░░░░░░░░ 19.5% 194.8k/1M
```

- **Refreshes on every model response** (granularity = per API call)
- **Peak/off-peak aware cost**: weekdays 9:00-12:00 & 14:00-18:00 Beijing time are peak (2× rates); weekends and all other hours are off-peak (1×)
- **Live peak/off-peak tag**: the leftmost segment shows `peak2x` / `offpeak1x` plus a `to peak` / `to offpeak` countdown that flips automatically at the boundary
- **Remaining credits (optional)**: reads your local `auth.json` credential and queries your plan quota read-only, showing the left/used percentage; hidden automatically when you are on BYOK or not logged in
- **Context window progress bar**: see session context usage at a glance
- Tokens / cost / context are parsed fully locally with no network; only the optional credits lookup sends read-only requests to `api.commandcode.ai` (disable with `QUOTA.enabled`). Nothing is ever injected into the model — **zero token overhead**

## How it works

The mod registers hooks through the CLI's built-in mod loading mechanism (`~/.commandcode/mods/`) and
incrementally parses local session logs under `~/.commandcode/projects/` (every AI reply is written to
disk with full token usage and list-price cost). The status bar refreshes on session attach, after each
model request, and at turn end. "Which session was just resumed" is identified by the file's
**access time (atime)** — resuming a session always reads the selected conversation file.
The credits lookup uses a separate path: read-only GETs to the CLI's billing endpoints (`/alpha/billing/*`), throttled by `QUOTA.ttlMs`, keeping the last known value on failure.

## Requirements

- Command Code CLI (npm package `command-code`), verified on v1.53.x
- An official subscription account (needed for the credits lookup; on BYOK / not logged in the segment hides itself, everything else keeps working)
- Windows 10/11 (session files must be on an NTFS partition of the system drive; the atime feature relies on this default policy)

## Install

**Double-click `install.bat`** — once every check shows `[OK]`, **restart your commandcode session**.

The installer auto-detects: the CLI data directory, the cmdc command and version, and whether atime is enabled — anything abnormal gets a clear message.

(Manual: copy the `commandcode-usage-context` folder into `%USERPROFILE%\.commandcode\mods\`)

## Display semantics

| Item | Meaning |
|---|---|
| Input / Output / Cache | Real usage written by the CLI. The **absolute cache figure is hidden by default** — it overlaps with the cache rate (cache ≈ input × cache rate); set `SHOW.cacheAbs` to `true` to show it |
| Cache rate | cache read ÷ input (cache read is a subset of input; higher = cheaper) |
| Cost | A **reference value** converted at official list prices (peak/off-peak aware), not an actual bill — subscriptions deduct quota; exact billing per the official site |
| Context | Latest request's total input ÷ window limit (estimated, same as the CLI's built-in indicator) |
| Credits | Left / used percentage of your plan's monthly credit pool (monthly-pool basis); switches to absolute remaining when you own purchased/free credits |

## Remaining credits (optional, on by default)

Reads the credential from your local `~/.commandcode/auth.json` (or the `COMMAND_CODE_API_KEY` env var) and queries the CLI's billing endpoints read-only:

- **Request volume**: 2–3 requests at session start, then at most one every 2 minutes (`QUOTA.ttlMs`); **no token / credit cost**
- **Privacy**: the credential is read locally and sent only to `api.commandcode.ai`; nothing is written to disk or sent anywhere else
- **Semantics**: `used% = (plan total − monthly remaining) / plan total`; purchased / free pools are excluded from the percentage, so the segment switches to absolute remaining when you own extras
- **Disable**: set `enabled` to `false` inside `QUOTA` (back to fully local, zero network)
- ⚠️ `/alpha/*` is an internal CLI endpoint (not officially documented); if it changes, this segment silently disappears while everything else keeps working

## Customization (constants at the top of index.mjs)

| Constant | Meaning |
|---|---|
| `CONTEXT_LIMIT` | Context window limit, default 1M (deepseek-v4.1-flash); adjust when switching models |
| `LANG` | UI language: `"zh-CN"` (default, 万/亿) / `"en"` (English labels + k/M units) |
| `SHOW.cacheAbs` | Show the absolute cache figure (default `false`; cache rate only, saves ~13 columns) |
| `QUOTA.enabled` | Remaining-credits switch (default `true`; set `false` for fully local, zero network requests) |
| `QUOTA.position` | Credit segment position: `"head"` leftmost (survives narrow terminals) / `"tail"` appended |
| `QUOTA.ttlMs` | Credits refresh throttle (default 120000 = 2 min); don't go below ~10s, it's an internal billing endpoint |
| `QUOTA.template` / `fallback` / `extrasFallback` | Credit text templates (placeholders `{rpct}` `{pct}` `{left}` `{plan}`) |
| `COLOR` / `RESET` / `GREEN` / `RED` / `BLUE` / `PURPLE` | Status bar colors (dark theme: text #8A94A8, bar #2EBD8E, peak #D65A5A, cache rate #5096E6, cost #A078DC) |
| `BAND_MODEL_IDS` | Peak/off-peak billing model list (add ids when the CLI adds time-based models) |

## Language (switching to English)

Two ways, pick one — **restart your commandcode session** afterwards:

1. **Edit the constant** (recommended): set `LANG` at the top of `commandcode-usage-context/index.mjs` to `"en"`, save, then double-click `install.bat` to reinstall.
2. **Environment variable** (no file edit, takes precedence):

   ```
   set CC_USAGE_LANG=en&& cmdc
   ```

   Put it in your system environment variables to make it stick.

> The language only changes labels and units (`输入/输出/缓存/缓存率/费用/上下文` ↔ `in/out/cache/cache hit/cost/ctx`, `万/亿` ↔ `k/M`); no metric changes.

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
delete `%USERPROFILE%\.commandcode\mods\commandcode-usage-context\` to remove the mod completely, no leftovers.

## Known limitations

- The mod relies on undocumented CLI internals; if a CLI major update breaks it, just delete this folder — no residue
- Renders in interactive mode only; `-p` headless mode shows nothing (CLI behavior)
- Single-line status bar (CLI status bar mechanism limit); colors calibrated for the dark theme

## License

[MIT](LICENSE)
