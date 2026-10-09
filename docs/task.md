# dsh-workbuddy-native Tasks

> 依据：已批准的 `docs/spec.md`（含 F4 续写修订）与 `docs/plan.md`。
> 所有路径相对 `D:\deepseek herbess\deploy\workbuddy_native\`；运行时数据目录 `~/.dsh/plugins/workbuddy-native/`。

## 文件清单

| 操作 | 文件 | 职责 |
|---|---|---|
| 新建 | `package.json` | bundle 声明、pluginCenter、client 声明 |
| 新建 | `cordis.patch.yml` | 仅 insert 本 bundle |
| 新建 | `lib/realms.js` | 站点常量表 |
| 新建 | `lib/config.js` | Config 声明、clientVersion auto |
| 新建 | `lib/headers.js` | 三族请求头与 UA |
| 新建 | `lib/ledger.js` | JSONL 用量账本 |
| 新建 | `lib/authstore.js` | 保险柜凭证存取 |
| 新建 | `lib/legacy-import.js` | 旧账号只读导入 |
| 新建 | `lib/catalog.js` | 目录拉取/缓存/快照 |
| 新建 | `lib/price.js` | 倍率/促销/显示名 |
| 新建 | `lib/login.js` | 设备码登录与刷新 |
| 新建 | `lib/upstream.js` | 请求体构造 + SSE 解析 |
| 新建 | `lib/guard.js` | 预算/单次/上下文/免费额度四闸 |
| 新建 | `lib/direct.js` | 直连流式传输 |
| 新建 | `lib/wbipc.js` | 桌面端 IPC 传输 + 分段续写 |
| 新建 | `lib/balance.js` | 真实余额查询 |
| 新建 | `lib/adapter.js` | LlmAdapter 实现 |
| 新建 | `index.js` | 入口接线 |
| 新建 | `lib/panel-api.js` | 面板 HTTP API |
| 新建 | `lib/tools.js` | agent 工具（裸对象注册） |
| 新建 | `client.js` | 设置面板 + 状态胶囊 |

## T1: 包骨架

**文件：** `package.json`、`cordis.patch.yml`
**依赖：** 无
**步骤：**
1. `package.json`：name `dsh-workbuddy-native`、`type: module`、`main: index.js`、exports（`.`/`./client`/`./cordis.patch.yml`/`./package.json`）、`dsh.bundle.patch`、`dsh.client`（platform web，external 仅基座外模块——本插件无）、`dsh.pluginCenter`（expectedEntries/expectedClientModules、ownedData: workbuddy-native）。
2. `cordis.patch.yml`：单个 insert 条目，**不含任何 provider/models 配置行**。

**验证：** `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 通过；YAML 手读一遍。

## T2: 站点表与配置

**文件：** `lib/realms.js`、`lib/config.js`
**依赖：** T1
**步骤：**
1. `realms.js`：cn/global 常量表（chatBase/billingBase/origin/acceptLanguage/uaPlatform/configDir），`realmOf(route)` 把 `workbuddy-cn|workbuddy-global` 映射到 realm。
2. `config.js`：导出 `Config`（plan 的七个字段与默认值）；`clientVersion` 为 `'auto'` 时读 `~/.workbuddy{,-ai}/cache/acc-product-config-v3.json` 推导版本段，失败回退内置常量；导出 `resolveConfig(ctx)` 供各模块取生效值。

**验证：** `node --input-type=module -e "import('./lib/config.js').then(m=>console.log(Object.keys(m)))"` 列出导出；手动改缓存文件观察 auto 取值变化（不启动 DSH）。

## T3: 请求头

**文件：** `lib/headers.js`
**依赖：** T2
**步骤：** 移植三段式 UA、login/chat/billing 三族头、`hex36` 稳定机器码；`chatHeaders` 的 id/enterprise/domain 三分支与 `x-no-*` 兜底逐项对照旧实现。
**验证：** 单测脚本打印三族头，人工对照旧插件同函数输出（同 uid 输入一致）。

## T4: 账本

**文件：** `lib/ledger.js`
**依赖：** T2
**步骤：**
1. `append(entry)`：按本地日历日写 `ledger/<yyyy-mm-dd>.jsonl`，行内强制带 realm；request 行的字段集合 = plan 定义，**无 body 字段**。
2. `rebuildToday(realm)`：扫当日文件累加 credit（事件行兼容 `event==='request'`）。
3. `aggregateToday()`：按模型聚合调用数/积分/缓存命中/思考 token。
4. `cleanOld(retentionDays)`。

**验证：** 脚本写 3 行样例（含 1 行跨 realm）→ `rebuildToday` 与 `aggregateToday` 输出正确；断言文件内容不含样例中的"对话文本"字段。

## T5: 凭证存取

**文件：** `lib/authstore.js`
**依赖：** T2
**步骤：**
1. 注入 `ctx.credentials`；`ensureStore()` 校验 record 文法（`workbuddy-native/<小写连字符>`）。
2. `current/list/save/switchTo` 按 plan 的记录布局实现；写记录用 `modifyRecord`（读-改-写一次完成）。
3. 降级路径：credentials 接缝缺失时用 `~/.dsh/plugins/workbuddy-native/auths-<realm>.json`（0600），返回 `degraded=true` 供面板标注。

**验证：** mock 一个内存 credentials 实现跑全部方法；再在真实 DSH 会话中验（并入 T20）。

## T6: 旧账号导入

**文件：** `lib/legacy-import.js`
**依赖：** T5
**步骤：** 扫 `~/.dsh/plugins/workbuddy-proxy/auths/<realm>/*.json` → realm 归属判定（沿用旧 `legacyRealmOf` 逻辑）→ 目标 realm 无同 uid 记录时 `save`；完成写 `.legacy-import.done`；全程对旧目录只读。
**验证：** 在临时 HOME 下构造假旧目录跑一遍：账号出现在 `list()`、旧文件 mtime 未变、二次运行跳过。

## T7: 目录

**文件：** `lib/catalog.js`
**依赖：** T3、T5
**步骤：**
1. `refreshCatalog(realm, auth)`：GET `/v3/config`（三段式 UA + 探针记录的头族）→ 归一化 models/promos（enabled 过滤、modelIds 反查）/picker（default 白名单 + 滤路由档位）；成功后整体替换缓存并写快照；空 picker 保留旧值。
2. `getCatalog(realm)`：同步读内存，冷启动读快照文件。
3. `diffCatalog(a,b)` 供 index 决定是否 `replace()`。

**验证：** 用今天实抓的 `/v3/config` 样例（catalog-global.json 里的原始结构若无留存则现场抓一次只读请求）离线跑归一化：global 应得 22 个 picker 模型。

## T8: 价格

**文件：** `lib/price.js`
**依赖：** T7
**步骤：** 倍率解析、Asia/Shanghai 时段（跨夜窗口）、`effectivePrice(mid, exhausted)`、`nextFreeAt`（下一窗口开启时刻）、显示名渲染（免费/折后/原价三态 + 重名追加 id）。
**验证：** 构造三个促销样例（factor=0、factor=0.5、仅 badge）+ 一个跨夜窗口：断言现价、免费态、倒计时时刻。

## T9: 登录

**文件：** `lib/login.js`
**依赖：** T3、T5
**步骤：** `startLogin/pollLogin`（设备码流程，attempt 按 realm+attemptId 存放）；`refreshForce`（单飞：同账号并发合并为一次）与 `ensureFresh`（到期前 10 分钟窗口）；`ensureFresh401` 包装（401 → 强刷 → 重放一次）。
**验证：** mock 上游三个响应（pending/ok/过期）跑状态机；真实扫码并入 T20 验收。

## T10: 上游编解码

**文件：** `lib/upstream.js`
**依赖：** T3、T7
**步骤：**
1. `buildBody(options, modelMeta)`：首条强制 system、中段 system 降级带标记 user、`stream:true`+`include_usage`、按模型裁剪 `max_tokens`（gpt-5.6-luna 黑名单起步，表驱动）、tools 标准映射。
2. `createSseParser()`：增量解析，产出 `{type:'text'|'reasoning'|'toolcall-delta'|'usage'|'finish', ...}` 归一事件；usage 多字段名归一；toolcall 按 index 拼装。

**验证：** 用旧日志里留存的 SSE 形状构造样例流（含 reasoning_content、tool_calls 分片、末帧 usage）：断言事件序列与最终参数完整。

## T11: 守卫

**文件：** `lib/guard.js`
**依赖：** T4、T8
**步骤：** 四道闸 `check(realm, model, est)`：日预算（`ledger.rebuildToday`，state 文件仅缓存）、单次预估（msgChars/3 输入 + maxTokens 现价余量）、上下文预警（返回 warn 不拦截）、免费额度耗尽（`price.exhausted` + `allowPaidOverride`）。每道闸返回 `{ok, code, message, nextFreeAt?}`。
**验证：** 样例账本 + 极小预算：断言拦截码与文案；`allowPaidOverride=true` 时耗尽闸放行。

## T12: 直连传输

**文件：** `lib/direct.js`
**依赖：** T9、T10
**步骤：** `stream(realm, body, signal)`：fetch → SSE 事件异步迭代器；600s 空闲守卫；`options.signal` 与内部 abort 合流；finally 里已收 usage 交回调入账。
**验证：** 本地 mock SSE 服务器（node http）：断言事件流、中途断开时 usage 仍入账、signal 立即终止。

## T13: wbipc 传输（含续写）

**文件：** `lib/wbipc.js`
**依赖：** T10
**步骤：**
1. endpoint 发现（按 realm configDir）、握手（session_hello/prove）、RPC、单飞连接管理。
2. 请求预检 768KB → `PAYLOAD_TOO_LARGE`。
3. **分段续写**：响应触顶（inline-limit 错误或 finish 因长度截断）→ 以已收正文为 assistant 前缀发起续写请求，拼接分片继续输出，最多 3 段；仍触顶 → 结构化错误（含已收长度）。
**验证：** mock SSE 服务器返回超长响应：断言续写拼接完整、续写期间事件流连续、第 4 段触顶报错；桌面端在位时真机验证并入 T20。

## T14: 余额

**文件：** `lib/balance.js`
**依赖：** T5、T9、（wbipc 连接）
**步骤：** 按 realm 分端点与响应形状解析（cn 账目制/global 套餐制），返回 `{packages:[{code,remain,total}], remain, total}`；传输跟随当前模式。
**验证：** 旧日志/缓存里的响应形状样例离线解析；真实查询并入 T20。

## T15: 适配器与入口

**文件：** `lib/adapter.js`、`index.js`
**依赖：** T7–T14
**步骤：**
1. `adapter.js`：`providerInfo/providerRetryPolicy/listModels/resolveModel/stream` 按 plan 实现；stream 内 guard → 传输分发 → 事件→分片映射（usage 先于 finish、单一终止 finish、失败转 `finish{kind:'error'}`）；reasoning 事件 → `reasoning-delta`。
2. `index.js`：`name/inject/apply/Config` 导出；apply 内 legacy-import → 注册 adapter（存 registration handle）→ `ctx.inject` 逐个挂 credentials/webServer/tools（缺谁跳谁）→ 刷新循环（启动 + 1h + 登录事件），diff 非空时 `registration.replace(routes)`；dispose 清理。
**验证：** `node --check` 全部文件；在真实 DSH 里验证并入 T20（选择器出分组、热更新）。

## T16: 面板 API

**文件：** `lib/panel-api.js`
**依赖：** T15
**步骤：** webServer prefix `/workbuddy-native`：`/bootstrap`（同源判定移植旧实现）→ 保险柜 token；`/summary /pricing /balance /stats`、`POST /transport /accounts/switch /login`、`GET /login/poll`；环回 + sec-fetch-site 校验。
**验证：** curl 走一遍：无 token 访问 401、bootstrap 同源放行、summary 六项数据齐全。

## T17: agent 工具

**文件：** `lib/tools.js`
**依赖：** T15
**步骤：** 裸定义对象注册 `workbuddy_account`（balance/usage/list/switch/transport/pricing/login），**零宿主包导入**；直接调用 lib 函数不走 HTTP。
**验证：** DSH 会话里让 agent 调用各 action 并观察输出（并入 T20）。

## T18: 设置面板（客户端半）

**文件：** `client.js`
**依赖：** T16
**步骤：** `__ModuleLoader__` 形状；`settings.section` 槽注册全量控制面（账号/扫码/切换、传输开关、预算、价格表、每模型命中率与思考占比、今日明细、legacy 导入提示、credentials 降级标注）；色值全走 `--dsw-alias-*`。
**验证：** 桌面端设置页目检各区块；切深浅主题观察跟随（并入 T20）。

## T19: 状态胶囊（客户端半）

**文件：** `client.js`（续）
**依赖：** T16、T18
**步骤：** `conversation.composer.dock` 槽（备选 `conversation.input.overlay`）注册胶囊 + 悬停简易显示：六项（plan 定义）；30s 轮询 summary、余额点按才查；点击跳设置；六项数据与设置面板同源。
**验证：** 目检六项逐条可读、数值与设置面板一致（并入 T20）。

## T20: 安装与端到端验收

**文件：** 无新文件
**依赖：** T1–T19
**步骤：**
1. `dsh plugin --profile desktop add <本目录>`（CLI 在 `D:\deepseek herness\resources\runtime\cli\bin\dsh.cmd`），桌面端热挂载。
2. 按 `docs/checklist.md` 逐条跑（该文档在阶段四产出）。
**验证：** checklist 全绿。

## T21: F13 费用实验

**文件：** `docs/experiments.md`（结果记录）
**依赖：** T20
**步骤：** 三实验按 spec F13 口径执行；每步先报预估积分；总封顶 50；产出"属实/不属实 + 数据 + 优化方案"。
**验证：** 实验日志与结论文档齐备，总消耗 ≤ 50。

## 执行顺序

```
T1 → T2 → T3 → T7 → T8 ──────────┐
       └→ T4 → T5 → T6 → T9 ──┐  │
             T10 → T11 → T12 ─┼──┤
             T13 ─────────────┤  ├→ T15 → T16 → T17/T18/T19 → T20 → T21
             T14 ─────────────┘  │
```
