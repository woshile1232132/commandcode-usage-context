// commandcode-usage mod — 在 CommandCode 交互界面底部常驻显示当前会话的
// token 用量与牌价费用。数据源为本机会话记录（~/.commandcode/projects/），
// 运行时事件仅作为刷新触发器，不向模型注入任何内容，零 token 消耗。
// 另可选开启「剩余额度查询」：只读 CLI 账单接口（见文件内 QUOTA 配置，可关闭）。
//
// 数字口径：token 为 CLI 落盘的官方真实用量；费用为峰谷感知重算
//   （谷段 1×、峰段 2×，价目与窗口取自 CLI 内置价目表，周末全谷），非实际账单。
//
// 环境变量 CC_USAGE_DEBUG=1 时，把每次刷新的状态文本追加到 %TEMP%/cc-usage-mod.log
// 便于无头模式验证与排障。
import { closeSync, readdirSync, readSync, appendFileSync, openSync, statSync, utimesSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const freshTotals = () => ({ req: 0, "in": 0, out: 0, cr: 0, cw: 0, cost: 0, ctx: 0 });

// 与 CLI 底部提示行（"? for shortcuts · taste off"）一致的主题 DIM 色 #8A94A8；
// 浅色主题或其他偏好请改这里（sanitizeStatusText 不剥 ANSI 码，可透传）
const COLOR = "\u001b[38;2;138;148;168m";
const QUOTA_COLOR = COLOR;               // 剩余额度段配色（想单独配色就换一个 ANSI 码）

// 显示哪些段：false = 隐藏。缓存绝对量与缓存率信息重叠（缓存 ≈ 输入 × 缓存率，可自己推算），
// 默认只留缓存率，省 13 列；想看绝对量把它打开即可。
const SHOW = { cacheAbs: false, ctxAbs: false };
// ctxAbs=false：上下文段只显示百分比（不显示 33.6k/1M）
const RESET = "\u001b[0m";
const CTX_BAR_CELLS = 6;                 // 上下文进度条格数（10 → 6，省 8 列）
const GREEN = "\u001b[38;2;46;189;142m"; // 主题 GREEN #2EBD8E，用于进度条
const RED = "\u001b[38;2;214;90;90m";    // 峰段标记，提醒当前按 2x 计费
const BLUE = "\u001b[38;2;80;150;230m";  // 缓存率
const PURPLE = "\u001b[38;2;160;120;220m"; // 费用

// 峰谷规则——取自 CLI 内置价目表：峰段 = UTC 周一至周五的 01-04 与 06-10 点
// （北京时间 9-12、14-18），周末与其余时段为谷段；时段计费模型的峰段价恒为谷段价 2×，
// 且 CLI 落盘的 costUsd 恒按谷段价计，故峰段发生的请求按 2× 修正，其余照原值记录。
const PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];
const PEAK_DAYS_UTC = [1, 2, 3, 4, 5];
// 时段计费模型清单（CLI 价目表 advertised band 成员 + deepseek 家族按前缀）
const BAND_MODEL_IDS = new Set([
  "zai-org/glm-5.2-fast", "minimaxai/minimax-m3", "minimax/minimax-m3-free",
  "stepfun/step-3.7-flash", "sakana/fugu-ultra", "xai/grok-4.5", "xai/grok-4.6",
  "meta/muse-spark-1.1", "meta/muse-spark-1.2", "meta/muse-spark-1.2-contributor",
  "meta/muse-spark-1.3", "meta/muse-spark-1.3-contributor",
  "poolside/laguna-s-2.1-free", "qwen/qwen3.8-max-0902", "meituan/longcat-2.0:free",
]);

// 上下文窗口上限（deepseek-v4.1-flash = 1M，与 CLI 内置指示一致）。换模型请改这里
const CONTEXT_LIMIT = 1_000_000;

// 界面语言，两种切法（任选其一）：
//   ① 改下面的 LANG（"zh-CN" 中文 / "en" English），重新安装后重开会话；
//   ② 设环境变量 CC_USAGE_LANG=en（不改文件，优先级更高），例如：set CC_USAGE_LANG=en&& cmdc
// 想让别的语言也能用，照 LABELS 的形状加一项就行。
const LANG = process.env.CC_USAGE_LANG || "zh-CN";
const LABELS = {
  "zh-CN": {
    units: "myriad",                                       // 万 / 亿
    peak: "峰2.0x", off: "谷1.0x", toPeak: "距峰", toOff: "距谷",
    input: "输入:", output: "输出:", cache: "缓存:",
    rate: "缓存率:", cost: "费用:", ctx: "上下文:",
    quota: "额度剩余 {rpct}%",
    quotaExtras: "额度 {left}",
    quotaFallback: "额度 {left}",
  },
  en: {
    units: "si",                                           // k / M
    peak: "peak2x", off: "offpeak1x", toPeak: "to peak ", toOff: "to off ",
    input: "in:", output: "out:", cache: "cache:",
    rate: "hit:", cost: "$", ctx: "ctx:",
    quota: "credits {rpct}% left",
    quotaExtras: "credits {left}",
    quotaFallback: "credits {left}",
  },
};
const L = LABELS[LANG] ?? LABELS["zh-CN"];

// ===================== 剩余额度查询（默认开启，可用 QUOTA.enabled 关掉） =====================
// 只读 GET，不走模型网关、不消耗 token；未登录 / BYOK（auth.json 无 apiKey）时自动跳过。
const QUOTA = {
  enabled: true,
  ttlMs: 120_000,          // 刷新节流：两次请求最小间隔；别调到 10s 以下——这是 CLI 的内部账单接口
  timeoutMs: 8_000,        // 单次请求超时
  position: "head",        // "head" 放最左（窄终端也能保住）/ "tail" 追加行尾
  template: L.quota,       // 占位符：{rpct} 剩余% {rpct1} 剩余%(1位) {pct} 已用% {left} 绝对额度 {plan} 套餐名
  fallback: L.quotaFallback,      // 套餐不在下表时退化为只显示绝对额度
  extrasFallback: true,           // 有购买/赠送额度时用 L.quotaExtras（只算月池的百分比会误导）
};
// 内置套餐额度表（额度百分比的分子/分母口径）。官方加或改套餐时同步；不在表里的 plan 只显示绝对额度。
const PLAN_TOTAL_CREDITS = {
  "individual-go": 10, "individual-goat": 70, "individual-pro": 30,
  "individual-pro-v1": 80, "individual-provider": 15, "individual-max": 150,
  "individual-ultra": 300, "teams-pro": 40,
};
const PLAN_LABELS = {
  "individual-go": "Go", "individual-goat": "GOAT", "individual-pro": "Pro",
  "individual-pro-v1": "Pro", "individual-provider": "Provider",
  "individual-max": "Max", "individual-ultra": "Ultra", "teams-pro": "Teams Pro",
};
const API_BASE = "https://api.commandcode.ai";
const API_KEY_ENV = ["COMMAND_CODE_API_KEY"];   // 与 CLI 一致的环境变量回退

function fmtTokens(n) {
  if (L.units === "si") {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e4) return (n / 1e3).toFixed(1) + "k";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "k";
    return String(n);
  }
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(n);
}

// 是否属于时段计费模型（deepseek 家族按前缀，其余按 id 精确匹配，忽略大小写）
function isBandModel(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  return m.startsWith("deepseek/deepseek-") || BAND_MODEL_IDS.has(m);
}

// 某时刻是否落在峰段（UTC 周一至周五的 01-04、06-10 点）。
// 与 render 的峰谷标记共用，避免计费修正与状态显示口径漂移。
function isPeakAt(d) {
  return PEAK_DAYS_UTC.includes(d.getUTCDay())
    && PEAK_WINDOWS_UTC.some(([ws, we]) => d.getUTCHours() >= ws && d.getUTCHours() < we);
}

// 峰谷状态：给定时刻是否落在峰段，以及距下一个边界的毫秒数。
// 峰段 = PEAK_DAYS_UTC 的 PEAK_WINDOWS_UTC 内；边界即各窗口的开点与闭点。
function peakStateAt(now) {
  const nowMs = now.getTime();
  const inPeak = isPeakAt(now);
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
  let next = null;
  // 往后扫 8 天，足以跨过整个周末（最长空档 = 周五 10 点 → 周一 1 点，79 小时）
  for (let d = 0; d <= 8; d++) {
    const dayStart = base + d * 86400000;
    if (!PEAK_DAYS_UTC.includes(new Date(dayStart).getUTCDay())) continue;
    for (const [ws, we] of PEAK_WINDOWS_UTC) {
      for (const b of [ws, we]) {
        const t = dayStart + b * 3600000;
        if (t <= nowMs) continue;
        if (next === null || t < next) next = t;
      }
    }
  }
  return { inPeak, ms: next === null ? 0 : next - nowMs };
}

// 倒计时文案：<1h 用分钟，否则 h+2 位分钟；>24h 用天
function fmtCountdown(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return min + "m";
  if (min < 1440) return Math.floor(min / 60) + "h" + String(min % 60).padStart(2, "0") + "m";
  return Math.floor(min / 1440) + "d" + Math.floor((min % 1440) / 60) + "h";
}

// 与 CLI 内置 formatContextTokenCount 同风格：30.0k / 1M
function fmtK(n) {
  if (n >= 1e6) {
    const v = Math.round(n / 1e5) / 10;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "M";
  }
  if (n >= 1e3) return (Math.round(n / 100) / 10).toFixed(1) + "k";
  return String(n);
}

// ------------------------- 剩余额度：取数与渲染 -------------------------
// 读本机 auth.json 的 apiKey（与 CLI 同源）；环境变量优先
function readAuthKey() {
  for (const k of API_KEY_ENV) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".commandcode", "auth.json"), "utf8"));
    return typeof j.apiKey === "string" && j.apiKey ? j.apiKey : null;
  } catch { return null; }
}

const pick = (...vals) => vals.find((v) => v !== undefined && v !== null) ?? null;

function fmtCredits(n) {
  if (!Number.isFinite(n)) return "-";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// 返回 {planLabel,total,remaining,pctUsed,pctLeft,hasExtras} 或 null（不可用时静默跳过）
async function fetchQuota() {
  if (!QUOTA.enabled) return null;
  const key = readAuthKey();
  if (!key) return null;                        // 未登录 / BYOK → 不显示额度段
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + key };
  const get = async (path) => {
    const r = await fetch(API_BASE + path, { headers, signal: AbortSignal.timeout(QUOTA.timeoutMs) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  };
  const who = await get("/alpha/whoami?limits=1").catch(() => null);   // orgId（个人号为空）
  const orgId = pick(who?.org?.id, who?.data?.org?.id);
  const q = orgId ? "?orgId=" + encodeURIComponent(orgId) : "";
  const [sub, cr] = await Promise.all([
    get("/alpha/billing/subscriptions" + q).catch(() => null),
    get("/alpha/billing/credits" + q),
  ]);
  const planId = pick(sub?.data?.data?.planId, sub?.data?.planId, sub?.planId);
  const c = pick(cr?.data?.credits, cr?.credits) ?? cr?.data ?? cr;
  const monthly = Number(pick(c?.monthlyCredits, 0));
  const purchased = Number(pick(c?.purchasedCredits, 0));
  const free = Number(pick(c?.freeCredits, 0));
  const remaining = monthly + purchased + free;
  const total = planId ? (PLAN_TOTAL_CREDITS[String(planId).toLowerCase()] ?? null) : null;
  // 与 CLI 同口径：已用% 只看月度池 (总额 − 月度余额) / 总额；购买/赠送不参与百分比
  const pctUsed = total ? Math.min(100, Math.max(0, (total - monthly) / total * 100)) : null;
  return {
    planLabel: planId ? (PLAN_LABELS[String(planId).toLowerCase()] ?? planId) : null,
    total, remaining, pctUsed,
    pctLeft: pctUsed === null ? null : 100 - pctUsed,
    hasExtras: purchased + free > 0,
  };
}

function renderQuota(q) {
  if (!q) return "";
  const has = (x) => x !== null && x !== undefined;
  const vals = {
    rpct: has(q.pctLeft) ? String(Math.round(q.pctLeft)) : "",
    rpct1: has(q.pctLeft) ? q.pctLeft.toFixed(1) : "",
    pct: has(q.pctUsed) ? String(Math.round(q.pctUsed)) : "",
    left: fmtCredits(q.remaining),
    plan: q.planLabel ?? "",
  };
  let tpl = QUOTA.template;
  if (q.hasExtras && QUOTA.extrasFallback) tpl = L.quotaExtras;
  if (!has(q.pctLeft)) tpl = QUOTA.fallback;
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m)).trim();
}

export default async function (ctx) {
  const st = {
    sessionId: null,
    file: null,       // 定位到的会话 JSONL 路径
    offset: 0,        // 已消费的字节偏移
    totals: freshTotals(),
    lastText: "",
    quota: null,      // 最近一次成功取到的额度
    quotaAt: 0,       // 上次尝试时间（失败也记账，避免每轮重试打网络）
    quotaBusy: false,
  };

  const debug = (msg) => {
    if (process.env.CC_USAGE_DEBUG === "1") {
      try { appendFileSync(join(process.env.TEMP || ".", "cc-usage-mod.log"), msg + "\n"); } catch {}
    }
  };

  // 会话 id 变化后，在 projects 各项目目录里定位 <sessionId>.jsonl
  const locateFile = () => {
    if (!st.sessionId || st.file) return;
    const root = join(homedir(), ".commandcode", "projects");
    let dirs;
    try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const p = join(root, d.name, st.sessionId + ".jsonl");
      try { if (statSync(p).isFile()) { st.file = p; return; } } catch {}
    }
  };

  // 从上次偏移增量解析会话文件，累加带 usage 的消息
  const consume = () => {
    if (!st.file) return;
    let size;
    try { size = statSync(st.file).size; } catch { return; }
    if (size < st.offset) { // 文件被重写（分支切换等），从头再来
      st.offset = 0; st.totals = freshTotals();
    }
    if (size === st.offset) return;
    let chunk;
    try {
      const fh = openSync(st.file, "r");
      try {
        chunk = Buffer.alloc(size - st.offset);
        let read = 0;
        while (read < chunk.length) {
          const n = readSync(fh, chunk, read, chunk.length - read, st.offset + read);
          if (n <= 0) break;
          read += n;
        }
        if (read < chunk.length) chunk = chunk.subarray(0, read);
      } finally { closeSync(fh); }
    } catch { return; }

    // 绝对偏移推进：chunk 从 offset 起读、天然包含上次未完整的行，
    // 只解析到最后一个换行（边界是 ASCII 字节，多字节字符安全），其余留给下次
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) return;
    st.offset += lastNl + 1;
    for (const line of chunk.toString("utf8", 0, lastNl + 1).split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let d;
      try { d = JSON.parse(s); } catch { continue; }
      if (!d || d.type !== "message") continue;
      const u = d.usage;
      if (!u) continue;
      st.totals.req += 1;
      st.totals["in"] += u.inputTokens || 0;
      st.totals.out += u.outputTokens || 0;
      st.totals.cr += u.cacheReadTokens || 0;
      st.totals.cw += u.cacheWriteTokens || 0;
      st.totals.ctx = u.inputTokens || 0; // 最近一次请求的总输入 ≈ 当前上下文占用
      // 峰谷感知：时段计费模型的 costUsd 落盘恒为谷段价，
      // 峰段发生的请求按 2× 修正；非时段模型全天一口价，照原值记录
      const recorded = u.costUsd || 0;
      let cost = recorded;
      const ts = d.timestamp ? new Date(d.timestamp) : null;
      if (!isNaN(ts) && isBandModel(d.model)) {
        if (isPeakAt(ts)) cost = recorded * 2;
      }
      st.totals.cost += cost;
    }
  };

  const render = () => {
    const t = st.totals;
    // 会话刚开始还没用量：只要有额度数字就先显示，等第一轮用量落盘再补齐
    if (t.req === 0 && !renderQuota(st.quota)) return;
    const rate = t["in"] > 0 ? (t.cr / t["in"] * 100).toFixed(1) : "0";
    const ps = peakStateAt(new Date());
    // 窄屏适配：冒号后的空格、各段前导空格一律省掉，每项省 1 列，8 项共省 8 列。
    // 峰谷最左（决策信息），尾部费用/上下文在窄终端被 truncate 砍掉时最先牺牲。
    const peakTag = ps.inPeak ? `${RED}${L.peak}${COLOR}` : L.off;
    const etaTag = (ps.inPeak ? L.toOff : L.toPeak) + fmtCountdown(ps.ms);
    const quotaText = renderQuota(st.quota);
    let text = COLOR;
    if (quotaText && QUOTA.position === "head") text += `${QUOTA_COLOR}${quotaText}${COLOR}|`;
    text += `${peakTag}|${etaTag}`;
    if (t.req > 0) {
      text += `|${L.input}${fmtTokens(t["in"])}|${L.output}${fmtTokens(t.out)}`;
      if (SHOW.cacheAbs) text += `|${L.cache}${fmtTokens(t.cr)}`;
      text += `|${BLUE}${L.rate}${rate}%${COLOR}|${PURPLE}${L.cost}${t.cost.toFixed(4)}${COLOR}`;
      if (t.ctx > 0) {
        const pct = Math.min(100, t.ctx / CONTEXT_LIMIT * 100);
        const cells = CTX_BAR_CELLS;
        const filled = Math.round(pct / 100 * cells);
        const bar = "█".repeat(filled) + "░".repeat(cells - filled);
        text += `|${L.ctx}${GREEN}${bar}${COLOR} ${pct.toFixed(1)}%`;
        if (SHOW.ctxAbs) text += ` ${fmtK(t.ctx)}/${fmtK(CONTEXT_LIMIT)}`;
      }
    }
    if (quotaText && QUOTA.position === "tail") text += `|${QUOTA_COLOR}${quotaText}${COLOR}`;
    text += RESET;
    if (text !== st.lastText) {
      st.lastText = text;
      ctx.ui.setStatus(text);
      debug(text);
    }
  };

  // 峰谷状态是时钟函数，不依赖任何 CLI 事件——空闲时必须靠定时器自行刷新，
  // 否则倒计时会停在最后一次事件触发的时刻、跨过边界也不翻转。
  // 用递归 timeout 而非固定 interval：延迟取「距下次边界 +2s」与 60s 的较小值，
  // 边界处能精确翻转，空闲时也不过是每分钟一次空刷新。
  let peakTimer = null;
  const schedulePeakTick = () => {
    if (peakTimer) clearTimeout(peakTimer);
    const ps = peakStateAt(new Date());
    const delay = Math.min(60_000, Math.max(1_000, ps.ms + 2_000));
    peakTimer = setTimeout(() => { refresh(); schedulePeakTick(); }, delay);
    peakTimer.unref && peakTimer.unref();
  };
  const stopPeakTimer = () => { if (peakTimer) { clearTimeout(peakTimer); peakTimer = null; } };

  // 额度刷新：与会话用量相互独立，按 ttlMs 节流；失败保留上次值、静默降级
  const refreshQuota = (force) => {
    if (!QUOTA.enabled || st.quotaBusy) return;
    if (!force && Date.now() - st.quotaAt < QUOTA.ttlMs) return;
    st.quotaBusy = true;
    st.quotaAt = Date.now();
    fetchQuota()
      .then((q) => { if (q) { st.quota = q; render(); } })
      .catch((e) => { debug(`quota error ${e && e.message}`); })
      .finally(() => { st.quotaBusy = false; });
  };

  const refresh = () => {
    try {
      debug(`refresh sid=${st.sessionId} file=${st.file || "-"} req=${st.totals.req}`);
      locateFile(); consume(); render();
      refreshQuota(false);   // 内部按 QUOTA.ttlMs 节流，调用是廉价的
    } catch {}
  };

  // 回合结束后延迟补刷：CLI 把该轮用量落盘可能晚于 mod 的最后一次读取，
  // 竞争会导致第一轮数字要等下一轮才出现
  const refreshSoon = (ms) => {
    const t = setTimeout(refresh, ms);
    t.unref && t.unref();
  };
  const refreshWithRetry = () => { refresh(); refreshSoon(300); refreshSoon(1000); };

  // attach 时刻负载不含 sessionId。识别依据：/sessions 恢复会话时 CLI 必然
  // 读取被选中会话的文件，其 atime（访问时间）刷新为选择时刻——取 atime 最新
  // 的 cwd 匹配文件即为刚选中的会话（乱序/回访均精确）。扫描读取自身也会碰
  // atime，故逐个恢复原值，避免自污染信号。
  const seedLatestSession = (leaving) => {
    debug(`seed START leaving=${leaving}`);
    const root = join(homedir(), ".commandcode", "projects");
    let dirs;
    try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return; }
    const norm = (x) => x.toLowerCase().replace(/[\\/]+/g, "");
    const target = norm(ctx.cwd);
    let best = null;
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const dd = join(root, d.name);
      let files;
      try { files = readdirSync(dd); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl") || f.endsWith(".checkpoints.jsonl")) continue;
        const p = join(dd, f);
        try {
          const stt = statSync(p);
          if (!stt.isFile()) continue;
          const at = stt.atimeMs, mt = stt.mtimeMs;
          const fh = openSync(p, "r");
          let head;
          try {
            head = Buffer.alloc(512);
            const rn = readSync(fh, head, 0, 512, 0);
            head = head.toString("utf8", 0, rn);
          } finally { closeSync(fh); }
          try { utimesSync(p, new Date(at), new Date(mt)); } catch {} // 恢复 atime
          const mid = head.match(/"id":"([^"]+)"/);
          if (!mid || mid[1] === leaving) continue; // 排除正在离开的会话
          const mc = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
          if (!mc) continue;
          let cwdHeader = mc[1];
          try { cwdHeader = JSON.parse('"' + cwdHeader + '"'); } catch {}
          if (norm(cwdHeader) !== target) continue;
          debug(`seed cand ${p}`);
          if (!best || at > best.at) best = { path: p, at, id: mid[1] };
        } catch {}
      }
    }
    debug(`seed END best=${best ? best.path : "NONE"}`);
    if (best && best.id) {
      st.sessionId = best.id; st.file = best.path;
      st.offset = 0; st.totals = freshTotals(); st.lastText = "";
    }
  };

  const adoptSession = (sid) => {
    if (sid && sid !== st.sessionId) {
      st.sessionId = sid; st.file = null;
      st.offset = 0; st.totals = freshTotals(); st.lastText = "";
    }
  };

  ctx.hooks({
    async onSessionStart(arg) {
      debug(`attach source=${arg && arg.source}`);
      const leaving = st.sessionId; // 正在离开的会话（新进程启动时为 null）
      st.sessionId = null; st.file = null;
      st.offset = 0; st.totals = freshTotals(); st.lastText = "";
      // 仅恢复会话（/sessions、-r、-c 的 source=resume）时种子定位并立即显示；
      // 全新会话（startup）从零开始
      if (arg && arg.source === "resume") {
        try { seedLatestSession(leaving); if (st.file) refresh(); } catch {}
      }
      schedulePeakTick(); // 峰谷状态与用量无关，会话一开始就要显示并在边界自动翻转
      refreshQuota(true); // 额度同理：会话一开始就取，不等第一次交互
      try {
        for (const ev of ["model_request_end", "turn_start"]) {
          ctx.events.on(ev, refresh);
        }
        ctx.events.on("turn_end", refreshWithRetry);
      } catch {}
    },
    async onTurnStart(e) {
      try { adoptSession(e && e.state && e.state.sessionId); refreshWithRetry(); } catch {}
      return e.state;
    },
    async onStop(e) {
      try { adoptSession(e && e.state && e.state.sessionId); refreshWithRetry(); } catch {}
      return e && e.state !== undefined ? e.state : undefined;
    },
    async onTurnEnd(e) {
      try { adoptSession(e && e.state && e.state.sessionId); refreshWithRetry(); } catch {}
      return e.state;
    },
    async onSessionEnd() {
      stopPeakTimer();
    },
  });
}

// 供排障用：node -e "import(...).then(async m=>console.log(await m.__test.fetchQuota()))"
export const __test = { fetchQuota, renderQuota, readAuthKey, fmtTokens, fmtK, peakStateAt, QUOTA, LABELS };
