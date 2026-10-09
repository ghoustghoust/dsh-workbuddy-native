// dsh-workbuddy-native — client half (browser module)
//
// Hand-authored in the same __ModuleLoader__ shape the harness uses for client
// bundles, so this plugin needs no build step. React comes from the platform
// base; everything else is local. Two surfaces are registered:
//   · conversation.composer.dock → compact status capsule (six live numbers)
//   · settings.section           → full control panel
// Both read the same /workbuddy-native summary, so the two can never disagree.
//
// 呈现层约定：只消费 dsw-alias 主题令牌（不写死前景色）；文案全部中文，
// 模型 id / 时间窗这类专有名词除外。

window.__ModuleLoader__.load({
  id: "dsh-workbuddy-native",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback, useRef } = React;

    const BASE = "/workbuddy-native";
    const REFRESH_MS = 30000;

    const T = {
      layer: "var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08))",
      elevated: "var(--dsw-alias-bg-elevated, rgba(30,30,30,0.96))",
      // 悬浮面板不再是一块黑底：跟随平台的菜单玻璃材质（明暗自适应），
      // 令牌缺失时退回主题层色而不是写死的深色。
      menu: "var(--dsw-menu-surface-fill, var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.08)))))",
      menuBlur: "var(--dsw-menu-backdrop-filter, blur(40px) saturate(150%))",
      card: "var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06)))",
      border: "var(--dsw-alias-border-l2, rgba(127,127,127,0.18))",
      borderStrong: "var(--dsw-alias-border-l3, var(--dsw-alias-border-l2, rgba(127,127,127,0.28)))",
      primary: "var(--dsw-alias-label-primary, currentColor)",
      secondary: "var(--dsw-alias-label-secondary, currentColor)",
      tertiary: "var(--dsw-alias-label-tertiary, var(--dsw-alias-label-dimmed, currentColor))",
      caption: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary, currentColor))",
      accent: "var(--dsw-alias-brand-primary, #4d8dff)",
      onAccent: "var(--dsw-alias-label-on-brand, var(--dsw-alias-bg-elevated, #fff))",
      success: "var(--dsw-alias-state-success-primary, #34a853)",
      warn: "var(--dsw-alias-state-warn-label, #e8a33d)",
      error: "var(--dsw-alias-state-error-primary, #d93025)",
      hover: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.10))",
      elevPanel: "var(--dsw-elevation-panel, 0 0 0 .5px rgba(127,127,127,.28), 0 3px 8px rgba(0,0,0,.06), 0 0 16px rgba(0,0,0,.04))",
      radius: "var(--dsw-radius-lg, 10px)",
    };

    // 「积分」一律是红色数字：这是本插件唯一的强视觉约定，两处界面共用。
    const CREDIT_COLOR = "var(--dsw-alias-state-error-primary, #d54941)";


    const CSS = `
.wbn{font-size:13px;line-height:20px;color:${T.primary}}
/* 胶囊：一行读完「哪个站 · 今天花了多少 · 余额还剩多少」 */
.wbn-capsule{display:inline-flex;align-items:center;gap:8px;padding:3px 10px;border:1px solid ${T.border};border-radius:999px;background:${T.layer};cursor:default;white-space:nowrap;transition:background .15s,border-color .15s}
.wbn-capsule:hover{background:${T.hover};border-color:${T.borderStrong}}
.wbn-dot{width:6px;height:6px;border-radius:50%;background:${T.tertiary};flex:0 0 auto}
.wbn-dot.on{background:${T.success}}
.wbn-dot.off{background:${T.error}}

/* 悬浮面板：浅色玻璃卡片，明暗自适应，不再是黑底 */
.wbn-pop{position:absolute;bottom:calc(100% + 10px);right:0;z-index:40;width:380px;max-width:min(380px,94vw);max-height:min(70vh,620px);overflow-y:auto;padding:14px;border:0;border-radius:14px;background:${T.menu};backdrop-filter:${T.menuBlur};-webkit-backdrop-filter:${T.menuBlur};box-shadow:${T.elevPanel};display:flex;flex-direction:column;gap:12px}
.wbn-wrap{position:relative;display:inline-flex}
.wbn-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.wbn-title{font-size:14px;font-weight:600}
/* 面板标题行 */
.wbn-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-bottom:2px}
.wbn-headL{display:flex;align-items:center;gap:8px;min-width:0}
.wbn-headR{display:flex;align-items:center;gap:6px;flex:0 0 auto}
.wbn-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:4px;background:${T.layer};color:${T.tertiary};white-space:nowrap}
.wbn-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;min-width:0}
.wbn-k{color:${T.secondary};white-space:nowrap}
.wbn-v{font-variant-numeric:tabular-nums;text-align:right;overflow-wrap:anywhere;min-width:0}
.wbn-pct{font-size:11px;color:${T.tertiary}}
.wbn-free{color:${T.success};font-weight:700}
.wbn-over{color:${T.error};font-weight:700}
/* 积分数字：红色、等宽数位，任何界面里都表示"钱" */
.wbn-credit{color:${CREDIT_COLOR};font-weight:600;font-variant-numeric:tabular-nums}
.wbn-sep{height:1px;background:${T.border};margin:2px 0}
.wbn-card{border:1px solid ${T.border};border-radius:${T.radius};padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-width:0;background:${T.card}}
.wbn-card>.wbn-h{justify-content:space-between}

/* 余额区：两站并排，直接显示数字，不用点击 */
.wbn-bals{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wbn-bal{border:1px solid ${T.border};border-radius:${T.radius};background:${T.card};padding:10px 12px;display:flex;flex-direction:column;gap:2px;min-width:0}
.wbn-bal.active{border-color:${T.accent}}
.wbn-balTop{display:flex;align-items:center;gap:6px;min-width:0}
.wbn-balName{font-size:12px;color:${T.secondary};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbn-balNow{font-size:11px;line-height:15px;padding:0 5px;border-radius:999px;background:${T.accent};color:${T.onAccent};white-space:nowrap;flex:0 0 auto}
.wbn-balNum{font-size:20px;line-height:26px;font-weight:700;font-variant-numeric:tabular-nums;color:${CREDIT_COLOR};display:flex;align-items:baseline;gap:4px;overflow-wrap:anywhere}
.wbn-balNum.bad{font-size:15px;line-height:22px;font-weight:600}
.wbn-balSub{font-size:11px;line-height:15px;color:${T.tertiary};overflow-wrap:anywhere}

.wbn-stats{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}
.wbn-stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.wbn-stat .wbn-big{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:4px}
.wbn-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;padding-right:6px;scrollbar-gutter:stable}
.wbn-table{display:flex;flex-direction:column;gap:2px}
.wbn-tblHead{font-size:11px;color:${T.caption};letter-spacing:.03em;margin-bottom:2px}
.wbn-tr{display:flex;justify-content:space-between;gap:10px;align-items:baseline;padding:4px 0;border-bottom:1px solid ${T.border};min-width:0}
.wbn-tr:last-child{border-bottom:0}
.wbn-td{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.wbn-td.num{font-variant-numeric:tabular-nums;text-align:right;flex:0 0 auto}
.wbn-seg{display:inline-flex;border:1px solid ${T.border};border-radius:8px;overflow:hidden;background:${T.card}}
.wbn-seg button{border:0;background:transparent;color:${T.secondary};padding:4px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.wbn-seg button:hover{background:${T.hover}}
.wbn-seg button.on{background:${T.accent};color:${T.onAccent};font-weight:600}
.wbn-seg button+button{border-left:1px solid ${T.border}}
.wbn-btn{border:1px solid ${T.border};background:transparent;color:${T.primary};border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap}
.wbn-btn:hover{background:${T.hover}}
.wbn-btn:disabled{opacity:.5;cursor:default}
.wbn-ghost{border:0;background:transparent;color:${T.accent};padding:0;font-size:12px;cursor:pointer;font-family:inherit}
.wbn-ghost:hover{text-decoration:underline}
.wbn-ghost:disabled{opacity:.5;cursor:default;text-decoration:none}
.wbn-btns{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.wbn-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wbn-input{border:1px solid ${T.border};background:transparent;color:${T.primary};border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;font-variant-numeric:tabular-nums}
.wbn-input:focus{outline:none;border-color:${T.accent}}
select.wbn-input{cursor:pointer}
.wbn-check{accent-color:${T.accent};width:14px;height:14px;cursor:pointer}
.wbn-msg{font-size:12px;color:${T.tertiary};white-space:pre-wrap;overflow-wrap:anywhere}
.wbn-form{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;align-items:center}
.wbn-form .wbn-k{justify-self:start}
.wbn-form .wbn-ctl{display:flex;justify-content:flex-end;align-items:center;gap:6px;min-width:0}
.wbn{display:flex;flex-direction:column;gap:12px;min-width:300px;padding-bottom:8px;container-type:inline-size}
@container (max-width:300px){.wbn-stats{grid-template-columns:1fr}.wbn-bals{grid-template-columns:1fr}.wbn-form{grid-template-columns:1fr}.wbn-form .wbn-ctl{justify-content:flex-start}.wbn-row{flex-direction:column;align-items:flex-start;gap:2px}.wbn-v{text-align:left}}
`;


    let cachedToken = null;
    async function api(path, opts) {
      if (!cachedToken && path !== "/bootstrap") {
        const r = await fetch(BASE + "/bootstrap");
        if (!r.ok) throw new Error("桥接不可达（HTTP " + r.status + "）");
        cachedToken = (await r.json()).token;
      }
      const res = await fetch(BASE + path, {
        ...opts,
        headers: { "content-type": "application/json", authorization: "Bearer " + cachedToken, ...((opts && opts.headers) || {}) },
      });
      if (res.status === 401) cachedToken = null; // a rotated panel token re-bootstraps on the next call
      const j = await res.json().catch(() => null);
      if (!res.ok) throw new Error((j && j.error && j.error.message) || "HTTP " + res.status);
      return j;
    }

    // The authorization link comes from the upstream response, so it is only
    // opened when it points at a known WorkBuddy host, and never with an opener
    // handle back into the harness.
    const AUTH_HOSTS = ["www.codebuddy.cn", "copilot.tencent.com", "www.workbuddy.ai"];
    function safeAuthUrl(url) {
      try { return AUTH_HOSTS.includes(new URL(String(url)).hostname) ? String(url) : ""; } catch { return ""; }
    }

    function fmt(n, digits) {
      if (typeof n !== "number" || !isFinite(n)) return "—";
      const d = digits === undefined ? 2 : digits;
      return String(Math.round(n * Math.pow(10, d)) / Math.pow(10, d));
    }
    function fmtTime(ms) {
      if (!ms) return "—";
      const d = new Date(ms);
      const p = (x) => String(x).padStart(2, "0");
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }
    function countdown(ms) {
      if (!ms) return "";
      const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
      const h = Math.floor(mins / 60);
      return h > 0 ? h + " 小时 " + (mins % 60) + " 分钟后" : mins + " 分钟后";
    }
    function fmtTokens(n) {
      if (typeof n !== "number" || !isFinite(n) || n <= 0) return "关";
      return n >= 10000 ? Math.round(n / 10000) + " 万" : String(n);
    }
    function realmName(realmId) { return realmId === "global" ? "国际版" : "国内版"; }

    // 上游促销文案可能是英文原文；只翻译已知句式并保留日期与时间窗数字。
    // 冒号只在其后有空格时替换（否则会把 23:00 这类时间窗拆坏）。
    function zhNote(note) {
      if (!note) return "免费";
      let s = String(note)
        .replace(/free daily use with unlimited credits/gi, "每日免费，不限量")
        .replace(/free daily use/gi, "每日免费额度")
        .replace(/:\s+/g, "，")
        .replace(/\bbefore\s+/gi, "截止 ")
        .replace(/[.。]\s*$/, "");
      const months = { Jan: "1", Feb: "2", Mar: "3", Apr: "4", May: "5", Jun: "6", Jul: "7", Aug: "8", Sep: "9", Oct: "10", Nov: "11", Dec: "12" };
      s = s.replace(/([A-Z][a-z]{2}) (\d{1,2})/g, (m, mo, d) => (months[mo] ? months[mo] + "月" + d + "日" : m));
      return s;
    }
    // 倍率一律「×N」；0 倍显示「免费」。
    function fmtMult(x) {
      if (!x || typeof x.effective !== "number") return "";
      return x.effective === 0 ? "免费" : "×" + fmt(x.effective);
    }

    const h = React.createElement;

    // 积分金额统一走这两个渲染器，保证「红色数字」不会在某个角落被漏掉。
    function Credit(props) {
      return h("span", { className: "wbn-credit", title: props.title || undefined }, props.value, props.unit === false ? null : " 积分");
    }
    /** 余额数字可能很大；千分位便于一眼读出量级。 */
    function fmtBalance(n) {
      const v = Math.round(Number(n) || 0);
      return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /**
     * 一个站点的剩余余额。数据来自 /summary（后端已自动查询），所以这里是
     * 直接显示而不是「点按查询」；查询失败也如实说明，不伪装成 0。
     */
    function BalanceTile(props) {
      const b = props.balance;
      const ok = b && b.ok && typeof b.remain === "number";
      // The failed case keeps the same line count as the good one, so a site
      // that cannot be queried does not make the two tiles jump in height.
      return h("div", { className: "wbn-bal" + (props.active ? " active" : "") },
        h("div", { className: "wbn-balTop" },
          h("span", { className: "wbn-balName", title: props.label }, props.name),
          props.active ? h("span", { className: "wbn-balNow" }, "当前") : null,
          b && b.stale ? h("span", { className: "wbn-pct", title: "上游查询失败，显示上一次成功的结果" }, "· 旧数据") : null
        ),
        ok
          ? h("span", { className: "wbn-balNum" }, fmtBalance(b.remain), h("span", { className: "wbn-balSub", style: { color: T.tertiary } }, "积分"))
          : h("span", { className: "wbn-balNum bad", style: { color: T.warn }, title: (b && b.error) || "" }, props.hint || "查询失败"),
        h("span", { className: "wbn-balSub" }, ok
          ? "总额 " + fmtBalance(b.total) + " 积分"
          : (props.hint ? "需要先登录该站点" : "上游账单接口不可达"))
      );
    }

    /** 两站余额并排。当前站高亮，但不隐藏另一站——这正是用户要看的信息。 */
    function BalanceGrid(props) {
      const ids = ["cn", "global"];
      return h("div", { className: "wbn-bals" }, ids.map((id) => h(BalanceTile, {
        key: id,
        name: realmName(id),
        label: realmName(id),
        active: id === props.activeRealm,
        balance: (props.data.realms[id] || {}).balance,
        hint: (props.data.realms[id] || {}).account ? "暂不可用" : "未登录",
      })));    }

    /** One site's live facts, shared by the capsule popover and the panel. */
    function SiteFacts(props) {
      const r = props.data.realms[props.realmId];
      if (!r) return null;
      const pricing = r.pricing || [];
      const discounted = pricing.filter((x) => x.free && !x.exhausted);
      const reverted = pricing.filter((x) => x.exhausted);
      const current = r.usage && r.usage.last && r.usage.last.model;
      const currentPrice = current ? pricing.find((x) => x.id === current) : null;
      return h("div", { className: "wbn-site", style: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 } },
        h("div", { className: "wbn-stats" },
          h("div", { className: "wbn-stat" },
            h("span", { className: "wbn-k" }, "今日已用"),
            h("span", { className: "wbn-big" }, h(Credit, { value: fmt(r.spendToday, 3) }),
              h("span", { className: "wbn-pct" }, " / " + (props.data.config.dailyCreditBudget > 0 ? props.data.config.dailyCreditBudget : "不限制")))
          ),
          h("div", { className: "wbn-stat" },
            h("span", { className: "wbn-k" }, "当前模型"),
            h("span", { className: "wbn-big", style: { fontSize: 14, fontWeight: 600 } }, current
              ? (currentPrice ? currentPrice.name : current) + (currentPrice ? " · " + fmtMult(currentPrice) : "")
              : "今天还没调用")
          )
        ),
        discounted.length ? h("div", { className: "wbn-table" },
          h("span", { className: "wbn-tblHead" }, "限时免费 · " + discounted.length + " 个模型"),
          discounted.map((x) => h("div", { className: "wbn-tr", key: x.id },
            h("span", { className: "wbn-td wbn-free", title: x.id }, x.name),
            h("span", { className: "wbn-td num wbn-free", title: x.note || "" }, zhNote(x.note))
          ))
        ) : null,
        reverted.length ? h("div", { className: "wbn-table" },
          h("span", { className: "wbn-tblHead" }, "免费已用完 · 回原价"),
          reverted.map((x) => h("div", { className: "wbn-tr", key: x.id },
            h("span", { className: "wbn-td wbn-over" }, x.name),
            h("span", { className: "wbn-td num wbn-over" }, fmtMult(x) + (x.nextFreeAt ? " · " + countdown(x.nextFreeAt) : ""))
          ))
        ) : null,
        (r.usage.models || []).length ? h("div", { className: "wbn-table" },
          h("span", { className: "wbn-tblHead" }, "今日明细"),
          r.usage.models.map((m) => {
            const p = pricing.find((x) => x.id === m.model);
            const detail = m.calls + " 次 · 缓存 " + (m.promptTokens ? Math.round(m.cacheReadTokens / m.promptTokens * 100) : 0) + "% · 思考 " + (m.completionTokens ? Math.round(m.completionTokens ? m.thinkingTokens / m.completionTokens * 100 : 0) : 0) + "%";
            return h("div", { className: "wbn-tr", key: m.model },
              h("span", { className: "wbn-td", title: m.model }, p ? p.name : m.model),
              h("span", { className: "wbn-td num" }, h(Credit, { value: fmt(m.credit, 3) }),
                h("span", { className: "wbn-pct" }, " · " + detail)));
          })
        ) : null
      );
    }


    function Capsule(props) {
      const data = props.data;
      const [open, setOpen] = useState(false);

      if (!data) return null;
      // Everything follows the one configured site; the fallback only matters
      // for a summary produced by an older host half.
      const active = data.realms[data.config.realm] ? data.config.realm : Object.keys(data.realms)[0];
      const a = data.realms[active];
      const over = (a.pricing || []).filter((x) => x.exhausted);
      const bal = a.balance;
      const balOk = bal && bal.ok && typeof bal.remain === "number";

      return h("div", { className: "wbn-wrap wbn" },
        h("style", null, CSS),
        h("div", {
          className: "wbn-capsule",
          onMouseEnter: () => setOpen(true),
          onMouseLeave: () => setOpen(false),
          onClick: () => setOpen((v) => !v),
        },
          h("span", { className: "wbn-dot " + (a.account ? "on" : "off") }),
          h("span", null, realmName(active)),
          // 消耗多少积分：红色数字直接写在胶囊上，不再用「免费 ×N」这种计数
          // （那个数字原本只是"有几个模型在免费期"，容易被读成可用次数）。
          h("span", { title: "今日已消耗积分" }, "今日 ", h(Credit, { value: fmt(a.spendToday, 3) })),
          // 剩余多少积分：同样红色直接显示，不需要点开面板。
          balOk
            ? h("span", { title: "剩余 " + fmtBalance(bal.remain) + " / 总额 " + fmtBalance(bal.total) + " 积分" }, "剩 ", h(Credit, { value: fmtBalance(bal.remain) }))
            : h("span", { className: "wbn-pct", title: (bal && bal.error) || "余额暂不可用" }, "余额—"),
          over.length ? h("span", { className: "wbn-over", title: over.map((x) => x.name).join("、") + " 免费额度已用完" }, "超限 ×" + over.length) : null
        ),
        open ? h("div", { className: "wbn-pop" },
          h("div", { className: "wbn-head" },
            h("div", { className: "wbn-headL" },
              h("span", { className: "wbn-title" }, "WorkBuddy 用量"),
              h("span", { className: "wbn-badge" }, (a.catalog.picker || 0) + " 个模型")),
            h("div", { className: "wbn-headR" },
              h("button", { className: "wbn-btn", onClick: () => props.onReload(true) }, "刷新"))),
          // 余额在最上面：这是打开面板第一个要看的信息。
          h(BalanceGrid, { data, activeRealm: active }),
          h("div", { className: "wbn-sep" }),
          h(SiteFacts, { realmId: active, data }),
          h("div", { className: "wbn-sep" }),
          h("div", { className: "wbn-foot" },
            h("span", { className: "wbn-pct" }, "数据随会话自动刷新"),
            h("button", { className: "wbn-ghost", onClick: () => { setOpen(false); props.onOpenSettings && props.onOpenSettings(); } }, "在设置中打开完整面板"))
        ) : null
      );
    }

    function Panel(props) {
      const data = props.data;
      const err = props.err;
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [loginUrl, setLoginUrl] = useState("");
      const [loginFor, setLoginFor] = useState("");
      const pollRef = useRef(null);
      useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

      const act = useCallback(async (fn, okText) => {
        setBusy(true); setMsg("");
        try { const r = await fn(); setMsg(okText ? okText(r) : (r && r.warnings ? r.warnings.join("\n") : "已更新")); await props.onReload(); }
        catch (e) { setMsg("失败：" + (e && e.message || e)); }
        setBusy(false);
      }, [props.onReload]);

      // 登录永远对"这张卡"的站点发起，不再有全局站点下拉。
      const startLogin = (realmId) => act(async () => {
        const r = await api("/login", { method: "POST", body: JSON.stringify({ realm: realmId }) });
        const url = safeAuthUrl(r.authUrl);
        if (!url) throw new Error("上游返回的授权链接不可信，已拒绝打开");
        setLoginFor(realmId);
        setLoginUrl(url);
        window.open(url, "_blank", "noopener,noreferrer");
        if (pollRef.current) clearInterval(pollRef.current);
        const deadline = Date.now() + 10 * 60 * 1000;
        let failures = 0;
        pollRef.current = setInterval(async () => {
          if (Date.now() > deadline) { clearInterval(pollRef.current); pollRef.current = null; setMsg("登录超时，请重试"); setLoginUrl(""); setLoginFor(""); return; }
          try {
            const p = await api("/login/poll?attemptId=" + encodeURIComponent(r.attemptId));
            failures = 0;
            if (p.status === "ok") {
              clearInterval(pollRef.current); pollRef.current = null;
              setMsg("登录成功：" + (p.nickname || p.uid)); setLoginUrl(""); setLoginFor("");
              await props.onReload();
            } else if (p.vendorMsg) {
              setMsg("等待扫码…（上游：" + p.vendorMsg + "）");
            }
          } catch (e) {
            // A poll that keeps failing must be reported, not swallowed: the
            // alternative is a spinner that never resolves.
            if (++failures >= 3) { clearInterval(pollRef.current); pollRef.current = null; setMsg("登录检测中断：" + ((e && e.message) || e)); setBusy(false); }
          }
        }, 3000);
        return r;
      }, () => "已打开授权页；若被拦截请复制链接到浏览器打开。");

      if (err && !data) {
        return h("div", { className: "wbn" }, h("style", null, CSS),
          h("div", { className: "wbn-card" },
            h("div", { style: { color: T.warn, fontWeight: 600 } }, "桥接不可达"),
            h("div", { className: "wbn-msg" }, err),
            h("div", null, h("button", { className: "wbn-btn", onClick: props.onReload }, "重试"))));
      }
      if (!data) return h("div", { className: "wbn" }, h("style", null, CSS), h("div", { className: "wbn-msg" }, "加载中…"));

      const cfg = data.config;
      const activeRealm = data.realms[cfg.realm] ? cfg.realm : "global";
      const transportDesc = cfg.defaultTransport === "direct"
        ? "直连上游：真流式、无尺寸上限、不依赖桌面端。"
        : "桌面代持：鉴权由桌面端代管、本地不落凭证；响应超限自动续写，请求超限明确报错。";
      const switchRealm = (r) => act(
        () => api("/config", { method: "POST", body: JSON.stringify({ realm: r }) }),
        () => "已切换到" + realmName(r) + "：模型选择器与状态胶囊已同步，另一站点的会话需切回才能继续。"
      );
      return h("div", { className: "wbn" },
        h("style", null, CSS),
        h("div", { className: "wbn-h" },
          h("span", { className: "wbn-title" }, "WorkBuddy 桥接（原生）"),
          h("span", { className: "wbn-seg" },
            h("button", { className: activeRealm === "cn" ? "on" : "", disabled: busy, onClick: () => switchRealm("cn") }, "国内版"),
            h("button", { className: activeRealm === "global" ? "on" : "", disabled: busy, onClick: () => switchRealm("global") }, "国际版")
          ),
          h("span", { className: "wbn-badge" }, cfg.defaultTransport === "direct" ? "直连" : "桌面代持"),
          data.credentialsDegraded ? h("span", { className: "wbn-badge", style: { color: T.warn } }, "凭证已降级为本地文件") : null
        ),

        h("div", { className: "wbn-card" },
          h("div", { className: "wbn-row" },
            h("span", { className: "wbn-k" }, "传输模式"),
            h("span", { className: "wbn-seg" },
              h("button", { className: cfg.defaultTransport === "direct" ? "on" : "", disabled: busy, onClick: () => act(() => api("/transport", { method: "POST", body: JSON.stringify({ transport: "direct" }) })) }, "直连"),
              h("button", { className: cfg.defaultTransport === "wbipc" ? "on" : "", disabled: busy, onClick: () => act(() => api("/transport", { method: "POST", body: JSON.stringify({ transport: "wbipc" }) })) }, "桌面代持")
            )
          ),
          h("div", { className: "wbn-msg" }, transportDesc)
        ),

        [activeRealm].map((realmId) => {
          const r = data.realms[realmId];
          const cred = r.credentialStore && r.credentialStore.mode;
          return h("div", { className: "wbn-card", key: realmId },
            h("div", { className: "wbn-h" },
              h("div", { className: "wbn-h" },
                h("span", { className: "wbn-title" }, realmName(realmId)),
                r.account ? null : h("span", { className: "wbn-badge", style: { color: T.warn } }, "未登录"),
                cred === "file" ? h("span", { className: "wbn-badge", style: { color: T.warn }, title: (r.credentialStore && r.credentialStore.error) || "" }, "凭证：本地文件") : null
              ),
              h("div", { className: "wbn-h" },
                h("span", {
                  className: "wbn-badge",
                  style: { color: r.ipc.online ? T.success : T.tertiary },
                  title: "桌面端 " + (r.ipc.online ? "在线" : "离线") + "；上游版本 " + r.clientVersion.value + "（" + (r.clientVersion.source === "desktop-cache" ? "读自桌面端" : r.clientVersion.source === "config" ? "手工固定" : "内置回退") + "）"
                }, r.ipc.online ? "桌面端在线" : "桌面端离线"),
                h("span", { className: "wbn-badge", title: "上游版本 " + r.clientVersion.value }, (r.catalog.picker || 0) + " 个模型")
              )
            ),
            // 两个站的余额都直接显示，红色数字，无需点击查询。
            h(BalanceGrid, { data, activeRealm: realmId }),
            h("div", { className: "wbn-sep" }),
            h(SiteFacts, { realmId, data }),
            h("div", { className: "wbn-sep" }),
            h("div", { className: "wbn-row" },
              h("span", { className: "wbn-k" }, "当前账号"),
              h("span", { className: "wbn-v" }, r.account ? (r.account.nickname || String(r.account.uid).slice(0, 8)) + "（到期 " + fmtTime(r.account.expiresAt) + "）" : "未登录")
            ),
            (r.accounts || []).length > 1 ? h("div", { className: "wbn-list" }, r.accounts.map((acc) => h("div", { className: "wbn-row", key: acc.uid },
              h("span", { className: "wbn-td" }, acc.current ? h("span", { style: { color: T.success, fontWeight: 600 } }, "● ") : null, acc.nickname || String(acc.uid).slice(0, 8)),
              acc.current ? null : h("button", { className: "wbn-btn", disabled: busy, onClick: () => act(() => api("/accounts/switch", { method: "POST", body: JSON.stringify({ realm: realmId, uid: acc.uid }) }), () => "已切换到 " + (acc.nickname || acc.uid)) }, "切换")
            ))) : null,
            h("div", { className: "wbn-btns" },
              h("button", { className: "wbn-btn", disabled: busy, onClick: () => startLogin(realmId) }, "扫码登录 / 加新账号"),
              loginFor === realmId && loginUrl ? h("input", { className: "wbn-input", style: { width: 220 }, readOnly: true, value: loginUrl, onClick: (e) => e.target.select() }) : null
            )
          );
        }),

        h("div", { className: "wbn-card" },
          h("span", { className: "wbn-title" }, "用量治理"),
          h("div", { className: "wbn-form" },
            h("span", { className: "wbn-k" }, "每日积分预算"),
            h("span", { className: "wbn-ctl" }, h("input", { className: "wbn-input", style: { width: 90, textAlign: "right" }, defaultValue: cfg.dailyCreditBudget, type: "number", id: "wbn-budget" }), h("span", { className: "wbn-pct" }, "积分")),
            h("span", { className: "wbn-k" }, "单次预估上限"),
            h("span", { className: "wbn-ctl" }, h("input", { className: "wbn-input", style: { width: 90, textAlign: "right" }, defaultValue: cfg.perRequestCreditBudget, type: "number", id: "wbn-per-call" }), h("span", { className: "wbn-pct" }, "积分")),
            h("span", { className: "wbn-k" }, "超长上下文预警"),
            h("span", { className: "wbn-ctl" }, h("span", { className: "wbn-v" }, fmtTokens(cfg.contextWarnTokens))),
            h("span", { className: "wbn-k" }, "免费额度用完后"),
            h("span", { className: "wbn-ctl" },
              h("span", { className: "wbn-seg" },
                h("button", { className: cfg.allowPaidOverride ? "" : "on", disabled: busy, id: "wbn-stop", onClick: segPick(false) }, "自动停止"),
                h("button", { className: cfg.allowPaidOverride ? "on" : "", disabled: busy, id: "wbn-continue", onClick: segPick(true) }, "按原价继续")
              ))
          ),
          h("div", { className: "wbn-row" },
            h("span", { className: "wbn-pct" }, "保存后即时生效，无需重启"),
            h("button", {
              className: "wbn-btn", disabled: busy,
              onClick: (e) => {
                const root = e.target.closest(".wbn");
                const budget = Number(root.querySelector("#wbn-budget").value);
                const perCall = Number(root.querySelector("#wbn-per-call").value);
                const allow = root.querySelector("#wbn-continue").className.includes("on");
                return act(() => api("/config", { method: "POST", body: JSON.stringify({ dailyCreditBudget: budget, perRequestCreditBudget: perCall, allowPaidOverride: allow }) }), () => "已保存");
              }
            }, "保存")
          )
        ),

        msg ? h("div", { className: "wbn-msg" }, msg) : null
      );

      function segPick(v) {
        return (e) => {
          const root = e.target.closest(".wbn-seg");
          root.querySelector("#wbn-stop").className = v ? "" : "on";
          root.querySelector("#wbn-continue").className = v ? "on" : "";
        };
      }
    }

    function useSharedSummary() {
      const [state, setState] = useState({ data: null, err: "" });
      // force=true 是用户手动刷新：跳过后端余额缓存，立刻看到真实数字。
      const reload = useCallback(async (force) => {
        try { const d = await api("/summary" + (force ? "?refresh=1" : "")); setState({ data: d, err: "" }); }
        catch (e) { setState((s) => ({ ...s, err: String((e && e.message) || e) })); }
      }, []);
      useEffect(() => {
        reload();
        const t = setInterval(() => reload(), REFRESH_MS);
        return () => clearInterval(t);
      }, [reload]);
      return { ...state, reload };
    }

    function SettingsPanel() {
      const s = useSharedSummary();
      return h(Panel, { data: s.data, err: s.err, onReload: s.reload });
    }

    function StatusCapsule() {
      const s = useSharedSummary();
      if (!s.data) return null;
      return h(Capsule, { data: s.data, onReload: s.reload, onOpenSettings: () => { try { window.location.hash = "#/settings"; } catch { /* no router */ } } });
    }

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          { name: "settings.section", id: "workbuddy-native", order: 112, label: "WorkBuddy 桥接（原生）" },
          SettingsPanel,
        ));
      ctx.slots.inject("conversation.composer.dock", () =>
        ctx.slots.register(
          { name: "conversation.composer.dock", id: "workbuddy-native-capsule", order: 60 },
          StatusCapsule,
        ));
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.Panel = SettingsPanel;
    exports.Capsule = StatusCapsule;
    return module.exports;
  },
});
