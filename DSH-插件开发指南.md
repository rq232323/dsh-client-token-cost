# DSH 插件开发指南（双面插件：host 端 Service + 浏览器端 UI）

> 一句话定位：本指南教你写一个**正规的 host 端 Cordis 插件**——像 `timer`、`include` 那样，有真实的 `Service` 逻辑、有自己的 `Config` 配置，会出现在 Web 设置面板的「插件」清单里；如果还要在页面上显示东西，就再给它加一个浏览器端（client half）。

---

## 1. 先判断：你要做的是三种"插件"里的哪一种

DSH 有**三个层次**的扩展机制，动手前先对号入座：

| 层次 | 是什么 | 落盘位置 | 生命周期 | 何时用 |
|------|--------|----------|----------|--------|
| **① 动态 Cordis 插件** | 运行时临时扩展，`cordis_define`/`cordis_run`/`cordis_stop`/`cordis_undefine` 管理 | 只在进程内存 | 重启即消失，以会话为界 | 临时实验、一次性接口 |
| **② Agent 预设** | 会话级 composition，一个 preset 只覆盖挂载它的 agent 的工具/提示词 | `~/.dsh/.agent-presets/<id>/` | 持久，会话级 | 给某个会话换工具集/人设 |
| **③ Host composition（本指南）** | 进程级、跨会话共享的插件/服务 | 通过 `cordis.patch.yml` 挂载 | 持久，重启仍在 | 全局服务、全局 UI、持久化/路由/注册表 |

本指南覆盖的是 **③**：一个 **dual-face（双面）插件**——
- **host 端**：node 里跑的 `Service`，注册进 host composition，出现在设置→插件的清单里；
- **浏览器端**（可选）：`window.__ModuleLoader__.load` 注册的 bundle，往页面 slot 里挂 UI。

---

## 2. 本机环境关键路径（写死了，新对话直接照抄）

| 项 | 值 |
|----|----|
| DSH home | `C:\Users\23586\.dsh` |
| web profile 目录 | `C:\Users\23586\.dsh\profiles\web\` |
| 用户 patch 层（**注册插件在这里**） | `C:\Users\23586\.dsh\profiles\web\cordis.patch.yml` |
| profile root config | `C:\Users\23586\.dsh\profiles\web\cordis.yml` |
| profile 依赖树（**部署插件包到这里**） | `C:\Users\23586\.dsh\profiles\node_modules\` |
| 全局 dsh 安装 | `C:\Users\23586\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\` |
| 随部署附带的 agent 预设 | `...\@deepseek-ai\dsh\config\agent-presets\` |
| 用户自定义 agent 预设 | `C:\Users\23586\.dsh\.agent-presets\` |
| 服务端口 / URL | `3080` / `http://127.0.0.1:3080` |
| 启动命令 | `dsh web`（默认监听 `127.0.0.1:3080`） |
| 默认模型 | `deepseek-v4-pro`（provider `deepseek-official`） |

注意：**本机没有 pnpm**，所以不能用 `dsh plugin --profile web add <pkg>` 这条正规安装命令，只能**手动部署**（见第 6 节）。

---

## 3. 目录结构（一个双面插件的完整骨架）

```
dsh-<你的名字>/
├── package.json          # 关键：exports、dsh.client 声明、依赖
└── lib/
    ├── index.js          # host 端入口（Service 类 或 apply 函数）
    ├── client.js         # 浏览器端 bundle（可选，需要 UI 才写）
    └── invariant.js      # 可选：诊断用 invariant companion
```

### 3.1 `package.json` 模板

```json
{
  "name": "@deepseek-ai/dsh-<你的名字>",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-layout"
      ]
    }
  },
  "license": "MIT",
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "zod": "^3.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "react": "^18.2.0"
  }
}
```

字段说明：
- `exports["."]` → host 端入口；`exports["./client"]` → 浏览器端 bundle；`exports["./package.json"]` 必须保留（`dsh-client-modules` 扫描时要读它）。
- `dsh.client.platform: "web"` + `exports["./client"]` 是让 host 端的 `dsh-client-modules` 把这个包扫进 `window.__DSH_BOOT__` 图、把 client bundle 通过 `/plugins/<id>/client.js` 提供给浏览器的**两个必要条件**。
- `dsh.client.inject` 声明浏览器端依赖哪些**其它 client 包**（控制加载顺序），不是 cordis 服务名。

---

## 4. host 端写法（核心，`lib/index.js`）

### 4.1 两种形态

**形态 A：函数插件**（简单，适合只注册投影/只做副作用）

```js
// lib/index.js
import { z } from "zod";

const myProjection = {
  key: "myKey",          // 投影 key，全局唯一
  schema: z.object({ n: z.number() }),   // zod schema，校验 view 输出
  init: () => ({ n: 0 }),
  apply(state, event) { /* 纯同步折叠 */ },
  view(state) { return { n: state.n }; },
  stateVersion: 1
};

const inject = ["sessionProjections"];
function apply(ctx) {
  ctx.sessionProjections.register(myProjection);
}
export { apply, inject };
```

**形态 B：Service 类**（正规，像 `timer`/`include`，带 `Config`）

```js
// lib/index.js
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";   // 注意：Config 用 schemastery 的 z
import { z as zod } from "zod";              // 投影 schema 用 zod

var MyService = class extends Service {
  static Config = z.object({
    someOption: z.string().required(),
    aNumber: z.number().required()
  });
  static inject = ["sessionProjections"];

  constructor(ctx, config) {
    super(ctx, "myService");   // 服务名，ctx.<name> 这样访问
    this.config = config;
    // 在构造里注册投影（闭包捕获 config，价格等可配置）
    ctx.sessionProjections.register(makeProjection(config));
  }
};
export default MyService;
```

### 4.2 两种形态如何被挂载

- 函数插件（形态 A）：`cordis.patch.yml` 里 `insert` 一行，`name` 指向包名即可。
- Service 类（形态 B）：同样 `insert` 一行。Loader 会自动用 `Config` schema 校验你在 patch 里写的 `config`，然后 `new MyService(ctx, config)`。

### 4.3 session projection 的硬性契约（照抄 `dsh-session-stats` / `dsh-token-meter`）

`ProjectionDefinition` = `{ key, schema, init(), apply(state, event), view(state), stateVersion }`：

- `key`：全局唯一的投影名，客户端用 `useProjection(key)` 读它。
- `schema`：**zod** schema，宿主在值离开前用它 `parse(view(state))`，校验失败会大声报错。
- `init()`：返回初始 state，必须是**纯 JSON**。
- `apply(state, event)`：**必须同步、必须纯**。对不关心的事件，**必须返回同一个 state 引用**（框架用 `Object.is` 判变，这是性能闸门）。
- `view(state)`：返回 `schema` 能校验的 wire 值。
- `stateVersion`：非负整数。state 形状或折叠语义一变就要 bump，否则旧缓存会被错误地继续叠加。

注册方式：`ctx.sessionProjections.register(definition)`，返回 disposer。注册挂在调用方 fiber 上，插件卸载时 key 自动消失（客户端读作能力缺失）。

**投影的数据流**：host 端注册后，框架对每个已提交会话事件主动 drive 每个 unit 的 `apply`；值通过两个载体送到浏览器——history 尾页的 `projections` 块 + `session/projection` 推送帧，规则是"seq 高者胜"。客户端**不做任何折叠**，host 是唯一计算点。

### 4.4 已有的、可复用的服务

| 服务/投影 | 来源 | 用途 |
|-----------|------|------|
| `ctx.tokenMeter` | `dsh-token-meter` | token 测量服务，`measure(session)` / `estimateMessage(msg)` |
| `tokenUsage` 投影 | `dsh-token-meter` | 4 个计费桶：`uncachedInputTokens` / `outputTokens` / `cacheReadTokens` / `cacheWriteTokens` |
| `sessionStats` 投影 | `dsh-session-stats` | 轮数/步数/耗时统计 |
| `ctx.sessionProjections` | `dsh-session-projection` | 投影注册表（本指南的核心 seam） |

---

## 5. 浏览器端写法（`lib/client.js`）

浏览器端 bundle 是**打包产物格式**，不是普通 ESM。它的入口是 `window.__ModuleLoader__.load(...)`：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-<你的名字>",   // 必须和包名一致
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // 组件：挂到 shell.overlay，读投影数据
    function MyWidget(props) {
      // 见 5.2：shell.overlay 是 root scope，只能用 useSessions 读投影
      const value = props.useSessions((s) => {
        const cur = s.byId[s.current];
        return cur ? cur.projectionValues?.myKey : void 0;
      });
      if (value === void 0) return null;
      return react_jsx_runtime.jsx("div", { children: String(value.n) });
    }

    const inject = ["slots"];   // cordis 服务名（不是包名）
    function apply(ctx) {
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({
        name: "shell.overlay",
        id: "my-widget",        // list slot 必须给唯一 id
        order: 0
      }, MyWidget));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

### 5.1 `require` 能拿到什么（重要）

浏览器端 factory 里的 `require(spec)` 只能解析：
- **seed words**：`react`、`react/jsx-runtime`（shell 注入的平台词）；
- 其它**已注册的 client 包**（通过 `dsh.client.inject` 声明加载顺序的那些）。

不能 require node 模块、不能跨包 import 任意值。所以 bundle 要自包含，或只依赖 inject 声明过的兄弟 client 包。

### 5.2 挂载点 `shell.overlay`（全屏浮动层）

- 由 `dsh-client-ui-layout` 声明，`kind: 'list'`、`scope: 'root'`。
- 层本身**点击穿透**，你的 entry 需要交互时自行 `pointer-events: auto`。
- **关键坑**：`shell.overlay` 是 `root` scope，组件收到的标准 props 是 **`GlobalStandardProps`**（只有 `useSessions`、`useWorkspaces`），**拿不到 `useProjection`**（那是 session scope 的 hook）。
- 所以在浮层里读投影，要走 `useSessions(s => s.byId[s.current]?.projectionValues?.[key])`（`projectionValues` 是 `SessionSummary` 上实时更新的投影快照）。
- 想要 `useProjection`，得把组件挂到 **session scope** 的 slot（比如 `details` 列或 conversation 内部的 slot），而不是 `shell.overlay`。

### 5.3 组件 props 一览

| slot scope | 标准 props | 何时有 `useProjection` |
|-----------|-----------|----------------------|
| `root` | `useSessions`, `useWorkspaces` | ❌ |
| `session` | `useSession`, `sessionId`, `useProjection` | ✅ |
| `session-maybe` | 同上但 `sessionId` 可能 undefined | ✅ |

---

## 6. 部署三步（本机手动部署，因为没 pnpm）

### 第 1 步：把包复制进 profile 依赖树

```
C:\Users\23586\.dsh\profiles\node_modules\@deepseek-ai\dsh-<你的名字>\
    ├── package.json
    └── lib\index.js  (+ client.js)
```

### 第 2 步：在 web profile 的 patch 层注册 entry

编辑 `C:\Users\23586\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: my-widget
      name: '@deepseek-ai/dsh-<你的名字>'
      # config:  # 若 host 端是带 Config 的 Service，这里写配置
      #   someOption: '...'
```

这个 `insert` 让 cordis Loader 把该包挂为 host composition 的一个 entry。挂载后它会**自动出现在设置→插件→「插件清单」tab**（只读列表：名字、启用状态、配置快照、源码、诊断）。

### 第 3 步：重启服务

```
先结束 3080 端口的 node 进程，再双击桌面快捷方式（或运行 dsh web）
```

---

## 7. 验证清单

1. **出现在插件清单**：设置 → 插件 → 列表里能看到你的插件名（模块名）。
2. **投影有值**：打开会话后浮层/组件能读到数据。
3. **插件卸载干净**：从 `cordis.patch.yml` 删掉 insert 行 + 删掉 node_modules 里的包目录，重启即彻底移除。

---

## 8. 已知的坑（务必看）

1. **「插件配置」tab 有 host allowlist 限制**：设置面板的插件页有两个 tab——「插件清单」（只读，任何 host entry 都出现）和「插件配置」（可编辑卡片）。后者要求插件注册 settings namespace **且** 该 namespace 在 `dsh-host-apiproxy` 的 allowlist 里；**树外插件（手动放 node_modules 的）默认进不去「插件配置」**，除非改 apiproxy 核心代码。所以树外插件能做"清单可见"，做不了"设置面板里直接改参数"。
2. **投影 apply 必须纯 + 同引用**：`apply` 对无关事件返回同一 state 引用是硬要求，违反会拖垮性能甚至出错。
3. **投影 schema 用 zod，Service Config 用 schemastery**：两个 `z` 不是一回事，别混。
4. **浏览器端 `require` 有限制**：只能 seed words + inject 声明过的兄弟包。
5. **手动放 node_modules 是临时方案**：将来若装了 pnpm 或跑 `pnpm install`，可能被清理；正规安装是 `dsh plugin --profile web add <pkg>`。
6. **invariant companion 可选**：纯展示插件可以省略 `invariant.js`；需要诊断的才写，格式是 `apply(ctx) => ctx.invariants.register(packageName, install)`。

---

## 9. 附：DeepSeek V4 Pro 官方定价（供计费类插件参考）

每百万 token，人民币：

| 桶 | tokenUsage 字段 | 单价（元 / 1M） |
|----|----------------|----------------|
| 缓存命中输入 | `cacheReadTokens` | 0.025 |
| 缓存未命中输入 | `uncachedInputTokens` | 3 |
| 缓存写入 | `cacheWriteTokens` | 按未命中价 3（写入那次请求是 miss） |
| 输出 | `outputTokens` | 6 |

花费公式：
```
cost = ( (uncachedInputTokens + cacheWriteTokens) * 3
       + cacheReadTokens * 0.025
       + outputTokens * 6 ) / 1e6
```

> 价格会变，建议做成插件 `Config` 里的可配置项，而不是写死在投影里。

---

## 10. 快速参考：一个最小可用的"带计费投影 + 浮层"双面插件

完整实现见同目录源码 `dsh-client-token-cost/`（host 端 `lib/index.js` 注册 `tokenCost` 投影，浏览器端 `lib/client.js` 在左下角渲染）。这份代码就是本指南的落地示例。

---

## 11. v2 更新：峰谷计价 + 官网价格自动拉取（2026-08 起）

v2 之后价格不再是单一数字，注意以下变化：

### 11.1 价格模型

- 每个模型有**两套价**：`peak`（高峰价）与 `offPeak`（闲时价），单位仍是 元/百万 token。
- 折叠按**请求发生时刻**（事件自带 `time`，epoch ms）分桶计费：高峰时段的用量按高峰价、闲时按闲时价，跨时段会话的总花费是精确的。
- 峰谷窗口在 `peakWindow` 配置：`{ enabled, timezone, segments: [{start, end}, ...] }`，**支持多段**。默认即官方 2026-08 峰谷公告的北京时间两段：`09:00–12:00` 与 `14:00–18:00`，其余为闲时（时段边界为"开始含、结束不含"）。旧写法 `{ start, end }` 自动迁移为单段；`segments: []` 表示无高峰时段（全部按闲时价）。改 `cordis.patch.yml` 或 `settings.yaml`（或右键面板）即可，存盘即热重载。

### 11.2 价格来源与优先级（低 → 高）

1. 内置默认价（`DEFAULT_MODELS`，当前 peak==offPeak）；
2. **官网自动拉取（默认关闭，可选）**：`pricingSource.enabled: true` 开启后，host 端启动时 + 每 `refreshMinutes`（默认 360 分钟）抓取官方定价页（`pricingSource.url`，默认 `api-docs.deepseek.com/zh-cn/quick_start/pricing`），解析 HTML 后合并进价格表并自动重定价；**解析失败/断网时保持旧价并告警**，不会误算；
3. `cordis.patch.yml` 的 `config.models`（显式字段覆盖拉取结果）；
4. `settings.yaml` 的 `token-cost` 段（热重载，覆盖以上所有）——**右键面板保存的价格和高峰时段就写在这里**；
5. （已废弃）旧版浏览器 localStorage 价格覆盖不再使用，统一走第 4 层。

面板 → settings.yaml 的通路：host 挂了一条同源 POST 路由 `/dsh-token-cost/settings`（dshmarket 同款 `webServer.register` 模式）。因为 apiproxy 的 settings allowlist 不含 `token-cost`，客户端直接写命名空间会被 `settings-not-exposed` 拒绝，所以由 host 在自身侧调用 `settings.update/replace` 落盘并触发热重载重定价——**不需要改 apiproxy 核心**。

### 11.3 v2 新增配置键（全部可选，缺省即用默认）

```yaml
- insert:
    - id: token-cost
      name: '@deepseek-ai/dsh-client-token-cost'
      config:
        pricingSource:                # 官网自动拉取：默认关闭，需要才开
          url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
          enabled: false              # ← 改为 true 才拉取
          refreshMinutes: 360
          timeoutMs: 20000
        peakWindow:                   # 默认即官方两段（09:00-12:00 / 14:00-18:00，北京时）
          enabled: true
          timezone: 'Asia/Shanghai'
          segments:
            - { start: '09:00', end: '12:00' }
            - { start: '14:00', end: '18:00' }
        aliases:                      # 官网页面模型名 → 插件模型名（仅拉取用）
          deepseek-v4-pro: ['deepseek-chat', 'deepseek-v4-pro']
          deepseek-v4-flash: ['deepseek-reasoner', 'deepseek-v4-flash']
        models:                       # 显式覆盖（最高优先级，格式同 settings.yaml）
          deepseek-v4-pro:
            peak: { hitInput: 0.025, missInput: 3, output: 6 }
            offPeak: { hitInput: 0.025, missInput: 3, output: 6 }
```

兼容旧写法：`models` 里只写扁平字段（`{ hitInput, missInput, output }`）会自动迁移为两时段同价。

### 11.4 验证与坑

- 右键面板：每个模型组可折叠（面板头部有"展开全部/收起全部"），高峰价/闲时价子组也可折叠；"高峰时段"组可改启用、**多段时间（可增删）**、时区。保存后写入 `settings.yaml` 的 `token-cost` 段（含 `peakWindow`），立即热重载重定价，全浏览器生效、重启不丢。
- 左下角浮层注脚显示：`高峰 09:00–12:00, 14:00–18:00 · 高峰时段 · 右键设置`。
- 保存失败会在面板里红字提示（如路由没挂上、JSON 校验失败、`settings-conflict` 等）。
- 拉取（若开启）日志：`token-cost: pricing refreshed from <url>` 或 `pricing fetch failed (…); keeping previous prices`；强制刷新可调用 `ctx.tokenCost.refreshPricing()`。
- ⚠️ 官网页面改版会破坏解析（解析器按"高峰/闲时两个小节 + deepseek-* 模型行"的文本结构提取）；抓取失败不会崩，只是停在旧价。不依赖拉取时（默认）完全不受影响。
