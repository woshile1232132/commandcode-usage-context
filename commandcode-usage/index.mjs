// commandcode-usage mod — 在 CommandCode 交互界面底部常驻显示当前会话的
// token 用量与牌价费用。数据源为本机会话记录（~/.commandcode/projects/），
// 运行时事件仅作为刷新触发器，不向模型注入任何内容，零 token 消耗。
//
// 数字口径：token 为 CLI 落盘的官方真实用量；费用为峰谷感知重算
//   （谷段 1×、峰段 2×，价目与窗口取自 CLI 内置价目表，周末全谷），非实际账单。
//
// 环境变量 CC_USAGE_DEBUG=1 时，把每次刷新的状态文本追加到 %TEMP%/cc-usage-mod.log
// 便于无头模式验证与排障。
import { closeSync, readdirSync, readSync, appendFileSync, openSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const freshTotals = () => ({ req: 0, "in": 0, out: 0, cr: 0, cw: 0, cost: 0, ctx: 0 });

// 与 CLI 底部提示行（"? for shortcuts · taste off"）一致的主题 DIM 色 #8A94A8；
// 浅色主题或其他偏好请改这里（sanitizeStatusText 不剥 ANSI 码，可透传）
const COLOR = "\u001b[38;2;138;148;168m";
const RESET = "\u001b[0m";
const GREEN = "\u001b[38;2;46;189;142m"; // 主题 GREEN #2EBD8E，用于进度条

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

function fmtTokens(n) {
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

// 与 CLI 内置 formatContextTokenCount 同风格：30.0k / 1M
function fmtK(n) {
  if (n >= 1e6) {
    const v = Math.round(n / 1e5) / 10;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + "M";
  }
  if (n >= 1e3) return (Math.round(n / 100) / 10).toFixed(1) + "k";
  return String(n);
}

export default async function (ctx) {
  const st = {
    sessionId: null,
    file: null,       // 定位到的会话 JSONL 路径
    offset: 0,        // 已消费的字节偏移
    totals: freshTotals(),
    lastText: "",
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
        const h = ts.getUTCHours(), day = ts.getUTCDay();
        if (PEAK_DAYS_UTC.includes(day) && PEAK_WINDOWS_UTC.some(([ws, we]) => h >= ws && h < we)) {
          cost = recorded * 2;
        }
      }
      st.totals.cost += cost;
    }
  };

  const render = () => {
    const t = st.totals;
    if (t.req === 0) return;
    const rate = t["in"] > 0 ? (t.cr / t["in"] * 100).toFixed(1) : "0";
    let text = COLOR
      + `输入: ${fmtTokens(t["in"])}|输出: ${fmtTokens(t.out)}|缓存: ${fmtTokens(t.cr)}`
      + `|缓存率: ${rate}%|费用: ${t.cost.toFixed(4)}`;
    if (t.ctx > 0) {
      const pct = Math.min(100, t.ctx / CONTEXT_LIMIT * 100);
      const filled = Math.round(pct / 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      text += `|上下文: ${GREEN}${bar}${COLOR} ${pct.toFixed(1)}% ${fmtK(t.ctx)}/${fmtK(CONTEXT_LIMIT)}`;
    }
    text += RESET;
    if (text !== st.lastText) {
      st.lastText = text;
      ctx.ui.setStatus(text);
      debug(text);
    }
  };

  const refresh = () => {
    try {
      debug(`refresh sid=${st.sessionId} file=${st.file || "-"} req=${st.totals.req}`);
      locateFile(); consume(); render();
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
  });
}
