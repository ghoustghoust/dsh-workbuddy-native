# dsh-workbuddy-native 对抗性审查报告

日期：2026-10-09（凌晨）。方法：两个独立审查代理（正确性/并发/资源 与 安全/隐私/契约）逐文件攻击 + 真机探测 + 三套自动化测试。所有 finding 都带 file:line 与可复现场景；下表状态列标注本轮处置。

## 一、Blocker（3 项，全部已修）

| # | 发现 | 场景 | 处置 |
|---|---|---|---|
| B1 | 可选接缝与适配器共用一个 try/catch，且 tools.register() 的抛错未捕获 | 工具名冲突或热挂载重复注册 → `mount()` 中断 → **模型分组根本不出现**（违反 spec N1「各自独立存活」，正是上次把桌面端搞崩的那一类） | `index.js` 重写：适配器**最先**单独注册；每个接缝独立 `tryMount`；`tools.register` 抛错被捕获并记账 |
| B2 | wbipc 单例跨站点串号 | ① `WORKBUDDY_CONFIG_DIR` 钉在 cn 时，`workbuddy-global` 请求走 cn 桌面端、由 cn 账号计费，账本却记 global；② 一个站点正在连接时另一个站点复用其 `connectPromise` → 在错误信道上发请求 | `lib/wbipc.js`：**每站点一个 client 实例**；钉死目录明确指向另一站点时拒绝并说明原因 |
| B3 | 宿主 `iterator.return()`（用户点停止）时**完全不记账** | 停掉一次 3 万 token 的长回答：上游已扣积分，面板显示 0，日预算形同虚设 | `lib/adapter.js`：所有计费/日志收敛到 `finally`，任何退出路径都记一次且只记一次；新增回归测试断言"停止的生成仍写入账本" |

## 二、High（10 项，全部已修）

| # | 发现 | 处置 |
|---|---|---|
| H1 | 错误路径先写账本再加预算，触发跨站点重建 → **积分重复计** | 统一顺序：先 `addSpend` 后 `appendLedger`；预算缓存改为**每站点独立**（原来单槽位导致每次跨站点都重扫账本） |
| H2 | wbipc 分段续写只保留最后一段 usage；循环可能无 finish 退出 | 分段 usage **累加**；每次 `continue` 前不再丢账；循环耗尽仍产出终止分片 |
| H3 | 上游空响应被当成成功的 `stop`（DSH 契约要求 `EMPTY_RESPONSE` 且可重试） | 无内容且无 finish → `finish{kind:'error', code:'EMPTY_RESPONSE'}`；有内容无 finish → 补 `stop` |
| H4 | wbipc 不接 `options.signal`、RPC 无超时 → 用户按停止后桌面端继续生成并计费，pending 表无界增长 | `call()` 支持 signal + 300s 超时，abort/timeout/drop 都能结算 |
| H5 | `refreshAll` 合并请求时把登录后的刷新**丢掉** → 选择器最长空 1 小时 | 改为 rerun 标志 + `do/while`，请求不丢 |
| H6 | `listModels`/`resolveModel` 每个模型同步读整个当日账本 → 卡住选择器（探针 P3 明令禁止） | 耗尽集合与预算**按站点按日缓存**，内存增量更新 |
| H7 | 保险柜写入的"校验"只数账号个数，然后把唯一的明文副本**删掉** → 轮换后的 refreshToken 哪都没有，下次刷新即失败，徽章还显示绿的 | 写入后**整体回读比对**，不一致就不删文件并记 `credential_store verify` 事件 |
| H8 | 被替换 socket 的 close 事件会拆掉**当前**连接；握手超时不销毁 socket | 监听器带 socket 身份判断；`drop()` 先摘监听器；连接前与超时时主动清理 |
| H9 | 只带图片、无文字的消息被**整条丢掉**（截图直接提问 → 模型看到空气） | 条件修正为 `text || images.length`，无文字时补占位 |
| H10 | 面板只校验 `Host` 头，`/bootstrap` 无凭据即发 token | 校验 **socket 对端地址**（Host 可伪造）；`/bootstrap` 必须 `sec-fetch-site: same-origin` 且 Origin 为回环；全部响应加 `no-store`。真机验证：无同源证明 → 403 |

## 三、安全 finding（含一项中危逻辑漏洞）

| 项 | 发现 | 处置 |
|---|---|---|
| 原型污染 | `accounts[uid]` 用普通对象，`__proto__`/`constructor` 被判定"存在" → 可把当前账号指针指向伪账号，随后向真实上游发 `Bearer undefined`，且真实账号被静默停用。**agent 工具也能触发**（网页提示注入 → 一次工具调用） | 账号表改为 `Object.create(null)` + `uid` 白名单正则；面板/工具入口都校验；测试断言 404 |
| 配置校验 | `/config` 不校验类型：`dailyCreditBudget:"abc"` → `NaN > 0` 为 false → **日预算闸静默失效**；`clientVersion` 可注入任意 UA 串 | `saveConfig` 逐字段校验（数值/枚举/版本号正则），未知键拒绝；测试覆盖分数预算不被取整、非法 UA 被拒 |
| 隐私窄口 | 上游错误体被截断 300 字符塞进 `error`，而 `error` 既落账本又回传宿主——内容审查类 4xx 常会引用对话片段 | 错误只保留 HTTP 状态与上游 `code`，不再回显响应体 |
| 面板密钥说谎 | token 在 credentials 接缝挂载**之前**铸造 → 落明文 `panel.json`，而徽章按"接缝存在与否"显示"已在宿主保险柜" | token 改为**按请求惰性解析** + 回读校验 + 成功后删除明文；面板按真实落点显示。真机验证：`panelStore: vault` |
| 网络文本 | 模型名/促销文案/hover 无长度与字符约束，可把 bidi 控制符或超长文本注入选择器与拒绝消息；磁盘快照被篡改后不再校验 | `safeText()` 去控制/双向字符并截断；快照加载走 `sanitizeCatalog`（id 正则、picker⊆models、字段白名单） |
| 授权链接 | `window.open(authUrl)` 无方案/域名白名单、保留 opener | 白名单（codebuddy.cn / copilot.tencent.com / workbuddy.ai）+ `noopener,noreferrer`，不可信即拒绝打开 |
| 中文低估 | token 估算 `chars/3` 对中文约低 2 倍 → 失控闸偏晚 | 改为 `chars/2` 并把 tools 定义计入 |
| 每段计费 | wbipc 续写最多 7 次真实计费调用，但预算闸只跑一次 | `beforeSegment` 钩子：第二段起重新过闸 |

## 四、遗留风险（明确不修，说明理由）

1. **wbipc 无双向认证**：桌面端 broker 只验客户端证明，不验服务端证明。任何能监听该命名管道、或能写 `~/.workbuddy*/wbipc/endpoint.json` 的同用户进程，都能读到对话内容并伪造"助手回复"。这是**桌面端协议**的性质，不是本插件能单方面修的；缓解是同用户进程本就能读你的保险柜与账本。已在面板显示管道目录与钉死状态，便于自查。
2. **Windows 文件权限**：`mode:0o600` 在 win32 是空操作（实测文件 `mode=666`、ACL 仅继承）。因此降级路径的明文副本只受用户目录 ACL 保护。主路径已进保险柜；若接缝缺失，面板会明说"凭证：本地文件"。
3. **原价未知不等于免费**：促销生效时上游把模型自身倍率写成折后值（`x0.00`），真实原价不可得。界面因此显示"免费已用完"而非编造的"原价 x0"，`baseUnknown` 字段随价格数据一起暴露。
4. **reasoning_effort 效果未证实**：真机上 hy4-preview-f 的 `low` 档思考 token（1420）反而高于 `high`（743），说明该模型可能不遵循档位。已确认的是思考 token 计入输出计费（见下节 E1）。档位仍按目录声明暴露，用户可自行取舍。

## 五、费用断言实测结论（spec F13，累计消耗 0.00 积分——全部命中免费模型）

| 断言 | 结论 | 数据 |
|---|---|---|
| ① 长推理额外计费 | **属实**。思考 token 计入输出 | hy4-preview-f 同一道题：completion 1944（其中 thinking 1420）vs completion 1139（thinking 743）。输入只有 110 token，费用几乎全来自输出侧思考 |
| ② 免费额度耗尽后按原价 | **属实**。 | 昨日账本里 `deepseek-v4.1-flash` 实扣约 0.4、`hy4-preview` 实扣约 5.2（数值脱敏），而这两个 id 今天仍带 factor=0 的免费促销 → 免费期外/额度耗尽后确实回价计费 |
| ③ 未命中上游缓存额外付费 | **属实**。 | 同一 1245-token 前缀连打两次：第一次 hit 0 / miss 1245；第二次 **hit 1024 / miss 221**。即命中时输入侧只按 ~18% 计费；不命中就多付 82% 输入 |
| kimi-k3 为何是重灾区 | ①+③ 叠加 | 该模型既长思考，又（按共识实验）约 5 分钟掉缓存，两个乘数相乘 |

**补一条真机数据（断言③的量化形式）**：修好 `prepareCall` 后的第一道真实问答，输入 16,097 token / 输出 1 token，缓存只命中 6,912（43%）。也就是说**一轮对话的成本几乎全在"每步固定开销"**（宿主系统提示 + 工具定义 + 历史），与问题难度无关；走免费模型时它被促销吸收（实扣 0），换到 `glm-5.3`(x0.79)/`kimi-k3`(x1.62) 就是纯支出。宿主自己的用量条也显示 `23K tok · 缓存命中 30%`，两侧独立吻合。

**优化方案（已实现/待做）**：已实现——思考档位按目录声明暴露并只在支持时转发；缓存命中与思考占比进面板与 agent 工具；免费耗尽自动停止避免"以为免费实际全价"。待做——对已知不缓存的模型（glm/hy 系）在长上下文时主动提示"每次全价"。

## 七、真机验证阶段抓到的四次自伤回归（最有价值的部分）

审查修完再装回真实环境，结果**新代码把插件弄哑了四次**——这四条都值得写进方法论：

| 回归 | 症状 | 根因 | 修法 | 教训 |
|---|---|---|---|---|
| 缺 `providerRetryPolicy` | 首次挂载即被防抛外壳吞掉 | 宿主在**注册期**对每条 route 急切调用 `providerInfo` + `providerRetryPolicy`，测试替身只调了 `providerInfo` | 补方法，并让 mock 与宿主一样急切 | 接缝面清单不能靠读文档凑齐 |
| bootstrap 同源闸门 | 状态胶囊消失 | 桌面壳的 `dsh-app://` 代理会**剥掉 `sec-fetch-site` 与 `Origin`**，我按浏览器语义要求它们存在 → 面板拿不到 token。浏览器里一切正常，真实客户端里空 | 接受两种合法形状：浏览器（same-origin + Origin 校验）与桌面壳（两者皆缺 + 带会话 Cookie） | 记忆里就有这条（上次面板 403 也是同一个坑），我还是踩了。**宿主 UI 的测试替身不能替代真实壳** |
| 导入期 TDZ | 插件**完全不挂载**（无账本行、无 stage_failed、路由 404） | `catalog.js` 的快照加载循环在 import 期调用 `safeText`，而它依赖的 `const CAPPED_CHARS` 声明在循环之后 → `ReferenceError`；**宿主对入口导入期抛错的处置是"跳过整个 bundle"，且不写任何我们的日志** | 常量上移；新增 `test/snapshot-load.mjs` 用真实快照文件跑导入路径 | 离线测试全绿也拦不住：临时目录里没有快照文件，那条分支从没被执行过。**"加载期代码路径"必须有带真实数据形状的测试** |
| 缺 `prepareCall` | 应用内发消息 → 「本轮运行失败 / registration.adapter.prepareCall is not a function」，而胶囊、目录、面板全好 | **安装的宿主版本里 `adapter.stream(` 出现 0 次**：派发只走 `adapter.prepareCall(provider, model, signal)` 返回的 handle（`{model, stream}`）。我的适配器把逻辑放在 `stream` 上，测试也直接调 `stream`，于是整条派发路径从未被真实形状覆盖 | `prepareCall` 返回 `{model, stream}`；`stream` 不再是公开方法；测试改为与宿主同形的 `dispatch()`，并加适配器表面断言（5 个方法逐一存在） | 前两次是"少一个方法"，第三次是"**方法在但放错了地方**"。同一类错误的第三次说明：必须在测试替身里复刻宿主的**调用形状**，而不只是调用清单 |

宿主适配器表面（从运行中的 `app.asar` 反查调用点得到，权威）：

```
providerInfo(provider)                     注册期急切
providerRetryPolicy(provider)              注册期急切
listModels(provider)                       目录构建
resolveModel(provider, model, signal)      模型信息
prepareCall(provider, model, signal)       → { model, stream(options) }   派发唯一入口
```

同时补上可观测性：面板鉴权双向留痕——`panel_denied`（带被拒的真实头形状）与 `panel_ui_reached`（首次成功，注明来自浏览器还是桌面壳）。修好后真机记录到：

```
{"ts":"2026-10-08T18:09:41.344Z","event":"panel_ui_reached","realm":"cn","via":"desktop-shell"}
```

这条比截图硬：它证明客户端模块真的加载了、真的取到了 token、真的会去轮询。

## 八、复核清单（给下一位）

- 四套自动化：`node test/offline.mjs`、`transports`、`entry`、`snapshot-load`（全部 ALL PASS）。
- 真机：`GET /workbuddy-native/bootstrap` 带 `sec-fetch-site: same-origin` → 200；账本出现 `adapter`/`tool`/`panel`/`catalog` 与 `panel_ui_reached`。
- 安装：`dsh plugin --profile desktop add <本目录>`；**改代码后必须重启 DSH**（模块缓存不会因 `dsh plugin add` 失效，热挂载只在 bundle 列表变化时重新解析入口）。
- 回退：~~旧插件 `dsh-workbuddy-bridge` 全程未动，仍在 37321 正常服务~~ **2026-10-09 已退役**（源码/数据目录删除，profile 与生成模型层清理，备份见 `~/.dsh/` 下 `.bak-pre-retire-20261009`；卸载新插件只需 `dsh plugin --profile desktop remove dsh-workbuddy-native`）。

## 九、验收状态

自动化：`test/offline.mjs`（目录归一化、价格/时段/倒计时、请求体构造、SSE 解析、账本、四道闸、UA 与 effort 门控）、`test/transports.mjs`（mock 上游真流式、mock 桌面端 IPC 握手 + 分段续写 + 折半重试、适配器分片协议）、`test/entry.mjs`（mock 宿主 ctx 全量接线、面板 API 安全探针、保险柜落点、停止计费、空响应）、`test/snapshot-load.mjs`（导入期快照路径）——**四套全部通过**。

真机（用户实际运行的桌面端）：两分组注册、目录 16/22、多个旧账号只读导入、余额真实查询成功（数值已脱敏，分 2 个套餐）、凭证与面板 token 均在宿主保险柜、`panel_ui_reached via desktop-shell` 证明客户端模块已加载并成功鉴权、旧插件全程未受影响。

**应用内端到端（最后一道，已通过）**：在真实客户端新建会话、发消息「只回答一个阿拉伯数字：199 加 1 等于多少？」，界面回「已完成 / 200」，无「本轮运行失败」；同一时刻账本落两行 `event:"request"`：

```
18:35:01 global deepseek-v4.1-flash 200 credit=0 in=124   hit=0    out=8  think=0   ← 会话标题（宿主内部调用）
18:35:02 global deepseek-v4.1-flash 200 credit=0 in=16097 hit=6912 out=1  think=0   ← 正文这一轮
```

这条比前面所有断言都硬：说明派发确实走的是新适配器（不是旧中转），思考/正文/工具分片协议、usage 归一化、缓存命中映射、按站点记账、免费促销计价在真实宿主里全部工作。

顺带暴露一个值得留档的成本事实：**一轮问答的输入侧固定成本远大于输出**——正文只产出 1 个 token，而提示侧 16,097 token（系统提示 + 工具定义 + 历史），其中仅 6,912 命中上游缓存。走免费模型时它是 0 积分，切到 `glm-5.3`（x0.79）或 `kimi-k3`（x1.62）时同样的 16k 就是真金白银；这也是第五节断言③在长会话里被放大的原因。

设置面板已在真机目视确认（截图 + 可访问性树双证）：左侧同时列出「WorkBuddy 桥接」（旧插件）与「WorkBuddy 桥接（原生）」；新分区渲染 传输模式开关（direct 选中，wbipc 标注"代持"）、两张站点卡（16/22 个模型、UA 5.7.6 读自桌面端、桌面端在线、凭证：宿主保险柜、今日已用 0/3000、当前模型 `deepseek-v4.1-flash · x0`、折扣中模型**绿色加粗**并带额度时段、账号到期时间与切换按钮）、今日明细（`0 积分 · 2 次 · 缓存 43% · 思考 0%`）、预算与治理（三项阈值 + "免费用完后按原价继续 → 自动停止"）。底部胶囊显示 国际版 / 0 积分 / 免费 3（绿色）。宿主自己的用量条也印证了成本结构：`23K tok · 缓存命中 30%`。

剩余需要用户配合才能验的项，已逐条写进 `docs/checklist.md` 的 ⬜ 段落（扫码登录、双站点交替、真机 wbipc 触顶、停桌面端降级、主题切换、免费耗尽红色态三处同步）。
