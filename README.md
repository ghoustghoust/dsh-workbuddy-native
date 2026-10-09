# dsh-workbuddy-native

[DeepSeek Harness](https://www.deepseek.com/)（DSH）的 **WorkBuddy 原生适配器插件**：把 WorkBuddy 国内版 / 国际版的模型以 DSH 原生 LLM 适配器的形式接入 harness，进程内直连上游，无本地 HTTP 中转、无共享密钥。

> **免责声明**：本项目与 WorkBuddy、CodeBuddy、腾讯或 DeepSeek 均无隶属关系，也未获得任何授权。插件通过逆向 WorkBuddy 客户端的私有 API 实现，**随时可能因上游改动而失效**。使用本插件可能违反 WorkBuddy 的服务条款，相关风险由使用者自行承担。模型本身的输出与计费条款归属于 WorkBuddy 平台及各模型厂商，与本插件无关。软件按「现状」提供，不附带任何担保（详见 [LICENSE](./LICENSE)）。

## 功能

- 单站点原生路由：`workbuddy-cn`（国内版）/ `workbuddy-global`（国际版），模型目录运行时从上游拉取并热更新；站点在面板一键切换，路由热替换
- 真·流式输出：思考过程（reasoning）、工具调用、usage 全部映射为 DSH 原生分片协议
- 双站点独立凭证（多账号），存入宿主凭证保险柜，接缝缺失时降级为 0600 本地文件并如实提示
- 余额 / 今日用量 / 缓存命中率 / 思考占比实时面板 + 对话输入区状态胶囊
- 治理闸门：每日积分预算、单次预估上限、超长上下文预警、免费额度耗尽自动停止（可选按原价继续）
- 韧性：限流（429）自动指数退避、5xx/断连可重试、wbipc 超限响应自动续写、工具调用历史回放归一化

## 数据流向（隐私声明）

插件**无遥测、无统计上报、无任何第三方数据接收方**。所有网络通信只发生在下表列出的方向：

| 数据 | 发送到 | 何时 |
|---|---|---|
| 对话消息（system / user / assistant / 工具结果） | WorkBuddy 官方 API：国内版 `copilot.tencent.com`，国际版 `www.workbuddy.ai` | 每次对话请求 |
| 模型目录（模型列表 / 倍率 / 促销时段） | 同上（`/v3/config`） | 启动 + 每小时刷新 |
| 账号令牌（仅用于鉴权头） | 同上（对话 / 计费 / 刷新端点） | 随对应请求 |
| 余额查询请求 | 国内版 `www.codebuddy.cn`，国际版 `www.workbuddy.ai` 计费端点 | 面板查询 / 周期刷新 |
| 设备码登录 | 官方授权页（域名白名单：`www.codebuddy.cn`、`copilot.tencent.com`、`www.workbuddy.ai`，非白名单一律拒绝打开） | 仅当用户主动扫码 |

**只留在本机、绝不上传的数据**：

- 凭证（access/refresh token）：宿主凭证保险柜（`~/.dsh/.credentials.yaml`），保险柜不可用时降级为 0600 权限的本地文件并如实显示
- 使用账本：`~/.dsh/plugins/workbuddy-native/ledger/` —— **只有元数据**（模型名、token 计数、积分、错误码、耗时），**绝不落对话内容或请求/响应体**
- 上游报错只保留 HTTP 状态码与错误码，**不回显上游响应体**（错误体可能引用对话片段）

**Prompt 注入说明**：与任何 LLM 客户端一样，上游模型返回的内容会进入 agent 的对话链。本插件的 agent 工具（`workbuddy_account`）只提供查询/切换/登录动作，**不执行任意命令**；登录链接经域名白名单校验；配置项逐字段校验（未知键、非数字预算、非法 UA 一律拒绝）。

## 权限（最小化）

| 注入接缝 | 用途 |
|---|---|
| `llm` | 注册适配器（必需） |
| `credentials` | 凭证读写（可选，缺失时降级文件） |
| `webServer` | 本机回环的面板 API（可选，缺失时仅失去 UI） |
| `tools` | 注册 `workbuddy_account` 查询工具（可选） |
| `attachments` | 图片消息支持（可选） |
| `slots` | 设置面板与状态胶囊 UI（可选） |

每个可选接缝独立降级：任何一个挂掉都不影响对话主链路。插件不写自身数据目录（`~/.dsh/plugins/workbuddy-native/`）之外的任何路径。

## 安装

```bash
dsh plugin --profile desktop add <本仓库克隆路径>
```

改代码后需重启 DSH（模块缓存不因热挂载失效）。

## 配置

面板（设置 → WorkBuddy 桥接（原生））内可直接修改，即时生效：站点切换（国内/国际）、传输模式（直连 / 桌面代持）、每日积分预算、单次预估上限、免费额度用完后自动停止或按原价继续。所有配置经 `lib/config.js` 逐字段校验后写入本机 JSON。

## 测试

```bash
node test/offline.mjs        # 目录 / 价格 / 请求体 / SSE / 账本 / 四道闸
node test/transports.mjs     # mock 上游真流式 + wbipc 续写 + 适配器分片协议
node test/entry.mjs          # mock 宿主全量接线 + 面板安全探针 + 凭证降级/治愈
node test/snapshot-load.mjs  # 导入期快照加载路径
```

## 已知边界

- 上游私有 API 逆向而来：限流配额按模型分档且不公开，改版即失效
- `wbipc`（桌面代持）通道是双向无认证的本地协议，属桌面端设计，本插件已尽量收窄（详见 `docs/adversarial-review.md`）
- 促销/倍率/窗口数据来自上游目录原文，插件只翻译展示、不改动判定依据（机器时间戳）

## License

[MIT](./LICENSE)。WorkBuddy、CodeBuddy、DeepSeek 为各自所有者的商标/产品，本项目与其无任何隶属关系。
