# dsh-workbuddy-native Checklist

> 每一项通过运行代码或观察行为来验证。对应 `docs/spec.md` 的 AC1–AC13 与 `docs/plan.md` 的集成点。
> 验收环境：用户真实运行的 DeepSeek Harness 桌面端（不是浏览器替身）。
> 执行日期 2026-10-09。图例：✅ 有证据 · ⬜ 未验（写明缺什么）。

## 实现完整性

- ✅ 插件包结构合法：`package.json` 可解析、bundle 声明齐全、`cordis.patch.yml` 仅含 insert
  证据：`dsh plugin --profile desktop add` 安装为 `node_modules/dsh-workbuddy-native`；重启后账本出现 `adapter`/`tool`/`panel`/`catalog` 四类挂载事件。
- ✅ 全部 lib 模块可导入且相对导入解析
  证据：`node --check` 对 20 个文件（index/client/lib/*）零输出；`test/entry.mjs` 在 mock 宿主里加载入口无 SyntaxError；真机选择器与面板均出现。
- ✅ 工具注册不依赖任何宿主包导入
  证据：`grep -rn "@deepseek-ai" index.js client.js lib/` → **0 命中**；真机账本 `{"event":"tool","registered":true,"reason":"ok"}`。
- ✅ 账本无对话体字段
  证据：当日 88 行 JSONL 的**全部嵌套键**枚举为 `changed, completion_thinking_tokens, completion_tokens, credit, durationMs, error, event, firstByteMs, imported, key, mode, model, mounted, moved, op, prompt_cache_hit_tokens, prompt_cache_miss_tokens, prompt_tokens, realm, reason, registered, routes, status, transport, ts, uid, usage, via` —— 无 messages/content/body/response 类键，只有计数器。
- ✅ 旧账号一次性导入且旧目录零写入
  证据：`test/entry.mjs` 断言导入后旧 `auths/cn/current.json` 的 mtime 与导入前相同、新库出现 `uid-legacy`；真机设置面板账号列表显示全部旧账号（昵称略）。`workbuddy-proxy` 字面量仅出现在 `lib/legacy-import.js` 的只读路径。
- ⬜ 目录同步应答：断网状态重启 DSH，选择器仍立即显示上次缓存的分组
  未验原因：导入期快照路径已由 `test/snapshot-load.mjs` 覆盖（6 项断言），但"物理断网 + 重启 + 掐表看选择器"这个真机场景没跑。

## 集成

- ✅ 适配器注册链：当前站点路由出现在 `ctx.llm`（站点切换时热替换）
  证据：账本 `"routes":"workbuddy-global"`（单站点模式前为双路由）；真机模型选择器显示 `Deepseek-V4.1-Flash (现免费)`；设置面板两张站点卡片分别列出 16 / 22 个模型。
- ✅ guard → adapter 链：预算拦截发生在发起网络请求之前
  证据：`test/entry.mjs` 两条断言——`budget blocks the next call before the error` 与 `blocked call made no upstream request`（mock 上游计数不变）。
- ✅ ledger → 面板链：请求后设置面板与账本合计一致
  证据：真机一轮问答后账本落 2 行 `request`（credit 0），面板「今日明细」同步显示 `deepseek-v4.1-flash · 0 积分 · 2 次 · 缓存 43% · 思考 0%`（6912/16097=42.9%）；`test/entry.mjs` 断言 `spend visible to the panel = 0.3`。
- ✅ 面板 token 链：`/bootstrap` 放行形状与无凭据拒绝
  证据：`test/entry.mjs` 五连——无 token 401、裸本地进程 403、浏览器 same-origin 200、桌面壳形状 200、Origin 不匹配 403；真机账本 `panel_ui_reached via desktop-shell`。
- ⬜ 目录热更新链：临时改快照里某模型显示名 → 刷新 → 选择器无重启变化
  未验原因：`registration.replace()` → `llm/adapters-updated` 的机制在探针阶段已被证实存在于宿主，但这条端到端"改名可见"没在真机走过。
- ⬜ 登录 → 目录联动：扫码成功后该站点目录自动刷新
  未验原因：本轮没有新的扫码登录（两站点凭证已在）。代码路径 `scheduleRefresh('login:'+realm)` 存在且有测试外的静态审查。
- ⬜ 客户端半独立存活：停掉面板路由后聊天与模型选择不受影响
  未验原因：挂载顺序（适配器最先 + 每接缝独立 tryMount）与 `no mount errors` 断言覆盖了"面板坏不拖累聊天"，但没做"人为让面板路由失败"的正向验证。

## 编译与静态

- ✅ `node --check` 对 `index.js`、`client.js`、全部 `lib/*.js` 通过（20/20）
- ✅ 四套自动化全部 ALL PASS：`offline`(48) / `transports`(28) / `entry`(46) / `snapshot-load`(6)
- ✅ 源码中无 `%TEMP%`、无写旧插件目录的代码路径（`workbuddy-proxy` 仅 1 处，只读导入）

## 端到端场景

- ✅ **场景 1（主链路）**：真机新建会话 → 提问「只回答一个阿拉伯数字：199 加 1 等于多少？」→ 界面「已完成 / 200」，无「本轮运行失败」；账本两行 `request` 落账；胶囊与设置面板同步。**部分**：本轮 `think=0`（flash 未开思考），"思考过程可见"在真机上未用思考型模型复验（分片协议层由 `test/transports.mjs` 的 `reasoning-delta` 断言覆盖）。
- ✅ **场景 7（共存与回退 → 已转为退役）**：并存期间验证通过（设置左侧两个分区、默认模型指向新分组正常对话、旧插件独立服务）。2026-10-09 用户下令退役：旧插件源码目录（改动已推送其原仓库）与数据目录已删除，profile 清单与生成模型层已清理（均有本地备份）；退役后重启实测新链路无回归（真实消息落账 `status 200`），旧中转端口关闭。
- ⬜ **场景 2（登录）**、**场景 3（站点并存交替对话）**、**场景 5（真机 wbipc 超限续写）**、**场景 6（停桌面端降级）**、**场景 8（主题切换）**
  未验原因：需要用户配合的动作（扫码、切站点、关桌面端、换主题）。mock 层面等价路径已覆盖（`transports.mjs` 的 mock broker 续写与折半重试 9 项断言）。
- ⬜ **场景 4（免费额度治理）**：红色态与"下一次免费在 xx"提示
  部分证据：`offline.mjs` 断言耗尽后 `FREE_QUOTA_EXHAUSTED` 与"原价未知不编造"；`entry.mjs` 真跑出了 `glm-5.3 已回原价，下一次免费在 21 小时 29 分钟后` 的拦截。缺的是真机三处（选择器/胶囊/设置）**同时**显示红色的目视确认。

## 对应 AC 一览（防漏）

AC1→集成1+场景1；AC2→⬜快照真机+集成2；AC3→场景1（思考可见为部分）；AC4→场景5+场景6（⬜真机）；AC5→场景3（⬜）；AC6→场景4（部分）；AC7→集成3+场景4；AC8→实现4 ✅；AC9→工具注册 ✅；AC10→场景8（⬜）+集成5 ✅；AC11→实现3 ✅；AC12→`docs/adversarial-review.md` 第五节 ✅；AC13→场景7 ✅。

## 结论

自动化与静态项**全绿**；真机主链路（场景 1）与共存（场景 7）**已通过**。剩余 6 项全部需要用户配合动作或一次可控的破坏性操作，已在上面逐条写明缺什么。
