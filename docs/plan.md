# dsh-workbuddy-native Plan

> 依据：已批准的 `docs/spec.md`。语言：Node.js ESM（宿主 runtime 为 Node 24），宿主为 cordis 插件体系。
> 探针事实依据见项目记忆 `dsh-native-seams`。

## 架构概览

插件分宿主（Node 侧）与客户端（浏览器侧）两半，宿主半是核心：

```
DSH agent ──ctx.llm.stream()──► WorkBuddyAdapter（进程内，注册 workbuddy-cn / workbuddy-global 两路由）
                                   │
                    ┌──────────────┴──────────────┐
                    │ direct（默认，OAuth 设备码）  │ wbipc（显式切换，桌面端代持）
                    ▼                             ▼
                     WorkBuddy 上游 /v2/chat/completions（SSE）

后台：catalog 定时刷新 → 内存缓存 + 磁盘快照 → registration.replace() → 选择器热更新
面板：client.js（React/无构建） ──webServer 前缀 /workbuddy-native──► panel-api（token 由保险柜托管）
凭证：ctx.credentials 记录（保险柜） + login.js 设备码流程（面板自绘入口）
观测：ledger JSONL（元数据） → guard 日预算重建 → 面板统计（命中率/思考占比）
```

三条原则贯穿全部模块：**目录只从缓存答、网络只在后台跑**（探针 P3）；**只用官方接缝，缺失即降级**（spec N1）；**对话体永不落盘**（spec N2）。

## 核心数据结构

### Realm 配置（模块内常量表）

```js
// 每站点一份；值移植自旧插件并逐项核对
{ id: 'cn' | 'global', chatBase, billingBase, origin, acceptLanguage,
  uaPlatform, configDir /* ~/.workbuddy 或 ~/.workbuddy-ai */ }
```

### Catalog（每 realm 一份，内存常驻 + 磁盘快照）

```js
{
  fetchedAt: string | null,
  models: Map<id, { baseMult, contextWindow, maxTokens, supportsImages, name }>,
  promos: Map<id, Promo[]>,          // enabled 促销，含 discount.factor / schedule.daily / badge / hover
  picker: string[],                  // 上游 default 白名单，已滤路由档位
}
```

### EffectivePrice（price.js 纯函数输出）

```js
{ base, effective, free: boolean, exhausted: boolean, label, note, nextFreeAt: Date | null }
```

`exhausted` 由 ledger 判定（免费档出现 credit>0 即标记当日该模型耗尽）；`nextFreeAt` 由促销 `schedule.daily` 窗口推算，供 F6 倒计时。

### 凭证记录（宿主保险柜，key 文法 `<scope>/<小写连字符id>`）

```js
// scope 固定 'workbuddy-native'；realm 拼进 id 段
workbuddy-native/cn                  → { currentUid }
workbuddy-native/cn-<uid>            → { accessToken, refreshToken, expiresAt, uid, nickname, domain, enterpriseId }
workbuddy-native/global(-<uid>)      → 同上
workbuddy-native/panel-token         → { token }   // 面板 API 共享密钥，自动生成，用户无感
```

### Ledger 行（JSONL，每天一个文件，本地日历日）

```js
{ ts, realm, event: 'request', model, mode, status, durationMs, firstByteMs, aborted,
  msgCount, msgChars, prefixTail, usage: { promptTokens, completionTokens, thinkingTokens,
  cacheReadTokens, cacheMissTokens, credit } }
```

其余事件（`login` / `budget_blocked` / `free_exhausted` / `catalog` / `error`）同文件，`event` 区分。**结构上不存在 body 字段**。

### 插件 Config（声明式，设置面板自动可编辑）

```js
{ defaultTransport: 'direct' | 'wbipc',
  dailyCreditBudget: number,        // 每 realm 各自生效
  perRequestCreditBudget: number,
  contextWarnTokens: number,
  logRetentionDays: number,
  allowPaidOverride: boolean,       // F6 的默认关闭开关
  clientVersion: 'auto' | string,   // auto = 从桌面端缓存文件读取，漂移免疫
  cliVersion: string }
```

## 模块设计

### lib/realms.js
**职责：** 站点常量表与 realm 解析。
**对外接口：** `REALMS`、`realmOf(route)`（`workbuddy-cn` → cn）。
**依赖：** 无。

### lib/config.js
**职责：** Config 声明（导出 `Config`）、默认值、clientVersion `auto` 解析（读 `~/.workbuddy{,-ai}/cache/acc-product-config-v3.json`，失败回退内置常量并在面板标注来源）。
**依赖：** realms。

### lib/catalog.js
**职责：** 拉取并归一化 `/v3/config`（三段式 UA，来自 headers）；维护每 realm 内存缓存与磁盘快照（`~/.dsh/plugins/workbuddy-native/catalog-<realm>.json`）；暴露同步读取。
**对外接口：** `getCatalog(realm)`（同步，绝不等待网络）、`refreshCatalog(realm, auth)`（async，后台调用）、`onCatalogChanged` 回调位。
**依赖：** headers、authstore、realms。

### lib/price.js
**职责：** 纯函数层——倍率解析、Asia/Shanghai 促销时段（含跨夜窗口）、有效价计算、`nextFreeAt` 推算、显示名渲染（`名称 (x0.29)` / `名称 (现免费)`，冲突时追加 id）。
**依赖：** catalog（读）、guard（问 exhausted）。

### lib/authstore.js
**职责：** 保险柜读写（`ctx.credentials` 注入，缺失时降级为数据目录内 0600 文件并在面板标注）；多账号记录、当前指针、`legacy-import` 的一次性导入标记。
**对外接口：** `current(realm)`、`save(realm, account)`、`list(realm)`、`switchTo(realm, uid)`、`ensureStore()`。
**依赖：** 无（credentials 由 index 注入传递）。

### lib/login.js
**职责：** 设备码流程（`auth/state` → authUrl → 轮询 `auth/token` → `login/account` 补资料）；token 刷新单飞（同一账号并发只发一次）；401 强制刷新重试一次。流程状态按 realm+attempt 存放，多面板并发登录互不覆盖（修复旧 B4）。
**对外接口：** `startLogin(realm) → { authUrl, attemptId }`、`pollLogin(realm, attemptId)`、`ensureFresh(realm)`。
**依赖：** authstore、headers、realms、ledger。

### lib/headers.js
**职责：** 三段式 UA、chat/login/billing 三族请求头、稳定机器码（移植旧实现，逐项核对）。
**依赖：** config、realms。

### lib/upstream.js
**职责：** 请求体构造（首条强制 system，中段 system 降级为带标记的 user；按模型裁剪 `max_tokens`——已知 gpt-5.6-luna 拒收；强制 `stream:true + include_usage`）与 SSE 增量解析（usage 多字段名归一、`reasoning_content` → 思考增量、tool-call 参数按 index 拼装）。
**依赖：** realms、catalog（查模型元数据）。

### lib/direct.js
**职责：** 直连传输：fetch 流式转发为异步迭代器；600s 上游空闲守卫；signal 贯穿（options.signal 与内部 abort 合流）；断连时已收 usage 仍入账。
**依赖：** upstream、authstore、login、headers、ledger。

### lib/wbipc.js
**职责：** 桌面端 IPC 传输：endpoint.json 发现（按 realm 取 `~/.workbuddy{,-ai}`）、握手、`wb.request` RPC、768KB/640KB 上限预检。**响应超限自动分段续写**：把已收正文作为 assistant 前缀发起续写请求并拼接分片，最多 3 段，续写期间保持分片流式输出不中断；3 段后仍触顶则返回结构化错误（含已收长度与建议）。**请求体超限不切分**（上游帧协议不允许安全切分）：返回 `PAYLOAD_TOO_LARGE` 明确报错，文案提示压缩图片/缩短上下文或切换 direct。
**依赖：** upstream、realms、ledger。

### lib/adapter.js
**职责：** LlmAdapter 实现。宿主派发只走 `prepareCall(provider, model, signal)` → `{model, stream(options)}`（安装版本里 `adapter.stream` 无调用点），因此对外方法是 `prepareCall`，内部生成器 `openStream` 经 handle 暴露：guard 前置 → 按 Config.defaultTransport 分发 → 分片映射（`block-start/text-delta/reasoning-delta/tool-call-delta/block-end/usage/finish`，usage 在 finish 前，恰好一个终止 finish）；任何失败转 `finish{kind:'error'}`。`listModels`/`resolveModel` 同步读 catalog 缓存；`resolveModel` 与 `prepareCall` 返回的 model 同一形状：`context{contextWindow}`、`defaultMaxTokens`、`inputModalities`、`reasoning.efforts`（目录含则报）。`providerRetryPolicy` 返回 undefined（用宿主默认）。
**依赖：** direct、wbipc、guard、catalog、price、ledger。

### lib/guard.js
**职责：** 四道闸：日预算（本地日，从当日 ledger 重建，state 文件仅缓存——旧 B3 的教训）、单次预估上限（输入估算 + 该模型现价 + maxTokens 余量）、超长上下文预警（不改行为，面板展示）、免费额度耗尽阻断（F6：拒绝 + `nextFreeAt` 文案；`allowPaidOverride` 放行并按原价入账）。
**依赖：** ledger、price。

### lib/ledger.js
**职责：** JSONL 追加（0600 目录）、保留期清理、当日重建、按模型聚合（今日调用/积分/缓存命中率/思考 token 占比）供面板与工具。
**依赖：** config、realms。

### lib/balance.js
**职责：** 真实余额查询，按 realm 分端点（cn: get-user-resource 套餐账目；global: get-user-resource-summary），返回分包明细与合计。传输跟随当前模式（wbipc 可代持查询）。
**依赖：** authstore、login、headers、realms、（wbipc 客户端）。

### lib/panel-api.js
**职责：** `webServer.register({ kind:'prefix', path:'/workbuddy-native' })` 路由：`GET /bootstrap`（仅同源）发 token，其余全 bearer；`GET /summary /pricing /balance /stats`、`POST /transport /accounts/switch /login`、`GET /login/poll`。token 存保险柜 `workbuddy-native/panel-token`，首次生成，**用户不需要同步任何密钥**。环回 + sec-fetch-site 校验移植旧实现。
**依赖：** 几乎全部（只读门面）。

### lib/tools.js
**职责：** 用**裸定义对象**注册 `workbuddy_account`（action: balance/usage/list/switch/transport/pricing/login）。零宿主包导入（探针 P2）。
**依赖：** panel 同源数据函数（直接调 lib，不走 HTTP）。

### lib/legacy-import.js
**职责：** 首次 apply 时，从 `~/.dsh/plugins/workbuddy-proxy/auths/<realm>/*.json` **只读**导入账号记录；完成后在新数据目录写 `.legacy-import.done`；旧目录零写入。
**依赖：** authstore、ledger。

### index.js（入口）
**职责：** `export const name/inject/apply/Config`；`inject:['llm']`；`apply` 内：legacy-import → guard/ledger 初始化 → 注册 adapter（保存 registration handle）→ 可选 `ctx.inject(['credentials','webServer','tools'], …)` 逐个降级挂载 → 目录刷新循环（启动 + 每小时）：`refreshCatalog` 成功且内容变化时 `registration.replace(routes)` 触发选择器热更新（探针已验证 `llm/adapters-updated` 链）。dispose 时关定时器、断 wbipc、落盘缓存。

### client.js（浏览器半）
**职责：** `__ModuleLoader__` 形状，React 取自平台基座。两处注册：
1. `settings.section` → 设置面板（F12 全量控制面）；
2. `conversation.composer.dock`（备选 `conversation.input.overlay`）→ 状态胶囊 + 悬停简易显示（F11 六项）。
全部色值走 `--dsw-alias-*` 令牌；面板数据经 `/workbuddy-native`（bootstrap 取 token 后缓存）。两个界面各自独立挂载，任一失败不影响另一处与主链路。

## 模块交互

**一次对话请求：**
```
ctx.llm.stream({provider:'workbuddy-global', model, messages, tools, signal})
→ 宿主 prepareCall(provider, model, signal) → handle.stream(options)
  → guard.check：预算?（读 ledger 当日） 单次预估? 免费耗尽? → 任一拦截即 finish{error} 带文案
  → transport 分发：
      direct → login.ensureFresh → upstream.build → fetch(SSE) → upstream.parse 增量产出
      wbipc  → wbipc.call（超限→结构化错误）
  → yield 分片 … usage 帧解析 credit → guard 记账 → ledger.append
  → finish{reason}（上游错误 → finish{kind:'error', failure}）
```

**目录刷新：**
```
定时器/登录事件 → catalog.refreshCatalog(realm, auth)
  → 成功且 diff 非空：写快照 + registration.replace(['workbuddy-cn','workbuddy-global'])
  → llm/adapters-updated → 宿主重建目录 → 选择器更新（无重启）
  → 失败：保留旧缓存，面板标注 fetchedAt 与错误
```

**扫码登录：**
```
面板 POST /login {realm} → login.startLogin → authUrl 返回面板展示（面板自绘，探针 P1）
面板轮询 /login/poll → 登录成功 → authstore.save → 触发该 realm 目录刷新
```

**简易显示数据流：** 胶囊挂载 → `GET /bootstrap`（同源）→ token → `GET /summary`（含六项数据）→ 30s 轮询 + 手动刷新余额（点按才查上游，不做后台轮询）。

## 文件组织

```
D:\deepseek herbess\deploy\workbuddy_native\
├── package.json          # dsh bundle 声明 + pluginCenter（ownedData: workbuddy-native）+ client 声明
├── cordis.patch.yml      # 仅 insert 本 bundle；不含任何 provider/models 行（模型层由 adapter 原生提供）
├── index.js              # 入口与接线
├── client.js             # 浏览器半（设置面板 + 状态胶囊）
├── lib/
│   ├── realms.js  config.js  headers.js
│   ├── catalog.js  price.js
│   ├── authstore.js  login.js  legacy-import.js
│   ├── upstream.js  direct.js  wbipc.js
│   ├── adapter.js  guard.js  ledger.js  balance.js
│   └── panel-api.js  tools.js
└── docs/                 # spec/plan/task/checklist

运行时数据：~/.dsh/plugins/workbuddy-native/
├── catalog-cn.json  catalog-global.json
├── ledger/2026-10-09.jsonl
├── state-<realm>.json（缓存，非真源）
└── .legacy-import.done
```

## 技术决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 路由模型 | 两条路由 `workbuddy-cn`/`workbuddy-global`，不做 realm 开关 | 站点语义静态化，mid-request 竞态、unknown_model 400、切换回滚防御整类消失；选择器两分组并存符合 F1 |
| 目录应答 | listModels/resolveModel 同步读缓存，网络只在后台 | 探针 P3：目录构建无缓存无超时，阻塞即卡死选择器 |
| 刷新通知 | `registration.replace()` → `llm/adapters-updated` | 探针证实的官方热更新链，无需 YAML |
| 工具注册 | 裸定义对象，零宿主包导入 | 探针 P2；根除现有插件"硬编码回退路径→工具全灭"的故障类 |
| 登录 UI | 插件面板自绘入口 | 探针 P1：宿主不渲染第三方 flow |
| 凭证存储 | 宿主保险柜记录，credentials 接缝缺失时降级 0600 文件 | spec F5/N2；降级保证 N1 |
| 面板通道 | webServer 前缀 + 保险柜托管 token | 已验证可用；`ctx.remote` 第三方注册通路不明，列为后续演进；token 自动生成免手工同步 |
| wbipc 超限 | 响应分段续写（已收正文作前缀，最多 3 段，续写期间流式不中断）；请求超限明确报错 | 用户点名保留该修复（旧 wbipc 640KB 一天打死 62 次长思考请求）；续写逻辑独立成 wbipc 内部函数，direct 不受影响 |
| clientVersion | `auto` 从桌面端缓存读取，可覆写 | 根治 5.5.4 漂移（记忆：该值静默缩目录） |
| 预算真源 | 当日 ledger 重建 | 旧 B3（计数 0 实花 1348）的教训；spec F7 |
| 日切点 | 本地日历日 | 旧 B2（UTC 早 8 点跳日）的教训 |
| 思考内容 | `reasoning_content` → `reasoning-delta` 原生分片 | F10 净增能力；旧链路该字段整段丢失 |
| 构建方式 | 无构建：宿主 ESM 直跑，客户端手写 `__ModuleLoader__` | 与宿主分发形态一致，少一条构建链 |

## 实现偏差（开发完成后回填，与代码一致）

| 计划 | 实际 | 原因 |
|---|---|---|
| 声明式 `Config` + 设置面板自动表单 | 插件自有 JSON 配置 + 面板 API 校验写入 | `link:` 安装下宿主包（schemastery/cordis）不可解析——这正是旧插件工具全灭的同一条死路。改为零宿主导入，配置项逐个类型/范围校验（`saveConfig` 返回 `{config,error}`） |
| wbipc 响应超限"以已收正文续写" | 主动分段预算（默认 8000 token，触顶折半）+ 已收正文续写 + 分段 usage 累加 | 真机 mock 证明：broker 拒绝整段响应时**没有任何已收正文可续**，纯续写不成立 |
| 免费耗尽显示"原价 xN" | `baseUnknown` 标记 + 文案"免费已用完" | 促销生效期间上游把模型自身倍率写成折后值（x0.00），原价不可得，编造即撒谎 |
| 面板 token 启动时铸造 | 按请求惰性解析 + 回读校验 + 成功后删明文 | 启动时 credentials 接缝尚未挂载，铸造只会落明文；实测曾出现"徽章说进柜了、文件还在盘上" |
| 单一 wbipc 客户端 | 每站点一个客户端实例 | 单例会让国际版请求走国内版桌面端并由其账号计费，账本却记国际版 |
| 面板安全 = Host 头 + sec-fetch-site | 增加 socket 对端地址校验、`/bootstrap` 强制同源 + Origin 校验、`no-store` | Host 头可被任意本地进程伪造 |
| 思考档位硬编码 low/medium/high | 按目录 `reasoning.supportedEfforts` 暴露与转发 | 目录里就有权威词表，自造档位会让上游 400 |

## 与 spec 的覆盖对照

F1/F3→adapter+price；F2→catalog+index 刷新循环；F4→direct/wbipc/config；F5→login/authstore/legacy-import；F6→guard；F7→guard/ledger；F8→ledger；F9→tools；F10→upstream/adapter；F11/F12→client.js+panel-api；F13→开发后实验脚本（task 阶段定义）；N1–N6 为上述实现的约束而非独立组件。
