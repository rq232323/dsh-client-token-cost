# Token Cost Plugin（DSH 插件项目）

一个 DeepSeek Harness（DSH）的**正规 host 端插件**：在 Web 页面左下角显示当前会话的 token 用量与按可配置价格（高峰/闲时）估算的花费，支持拖动、右键设置面板（改价格、高峰时段、透明度）。

## 目录结构

```
token-cost-plugin/
├── README.md                   ← 本文件
├── DSH-插件开发指南.md           ← 完整开发文档（如何写/部署/排查这类插件）
└── dsh-client-token-cost/       ← 插件源码（目录名 = npm 包名）
    ├── package.json
    └── lib/
        ├── index.js             ← host 端：Service + settings namespace + tokenCost 投影
        └── client.js            ← 浏览器端：浮层 UI + 拖动 + 右键设置面板
```

## 快速了解

- **插件形态**：dual-face（host 端 `Service` + 浏览器端 UI），属于 DSH 的「Host composition」层（第 3 类）。
- **host 端**：`TokenCostService`，注册 `token-cost` settings namespace（价格可经 `settings.yaml` 热重载）+ `tokenCost` 会话投影（折叠出花费）。
- **浏览器端**：挂在 `shell.overlay` 浮动层，读 `tokenCost` 投影实时显示；价格与高峰时段由面板写入 `settings.yaml`（全浏览器生效），位置与透明度存本浏览器 localStorage。

## 如何部署 / 改价 / 排查

详见同目录的 **`DSH-插件开发指南.md`**——它写清了本机的环境路径、部署三步、验证清单和所有坑。下次开新对话时，让 agent「读一下 `DSH-插件开发指南.md`，按里面说的做」即可复现。

## 安装

1. 把 `dsh-client-token-cost/` 目录复制到 profile 依赖树：`C:\Users\<你>\.dsh\profiles\node_modules\@deepseek-ai\dsh-client-token-cost\`；
2. 在 `C:\Users\<你>\.dsh\profiles\web\cordis.patch.yml` 注册：

   ```yaml
   - insert:
       - id: token-cost
         name: '@deepseek-ai/dsh-client-token-cost'
   ```

3. 重启 `dsh web`（如果装了 pnpm，也可用 `dsh plugin --profile web add <git 地址>` 安装）。

完整细节（含配置键、验证清单、已知坑）见 **`DSH-插件开发指南.md`**。

## 价格说明

- **v2（2026-08 起）**：每个模型分**高峰价 / 闲时价**两套（元/百万 token），按请求时刻精确计费。
- **默认不拉取官网**：价格由你手动填——右键面板编辑（高峰/闲时各 3 个价 + 高峰时段窗口），保存后写入 `settings.yaml` 的 `token-cost` 段，立即热重载、全浏览器生效、重启不丢；也可直接编辑 `settings.yaml`。若想恢复官网自动拉取，在 patch 里设 `pricingSource.enabled: true`。
- 默认价（兜底）：DeepSeek V4 Pro 缓存命中输入 `0.025`、未命中输入 `3`、输出 `6`；V4 Flash `0.02 / 1 / 2`（峰谷同价）。
- 优先级：`settings.yaml` / 右键面板 > patch `config.models` > 官网拉取（若开启）> 内置默认。
- 峰谷窗口默认**官方两段（北京时间 09:00–12:00、14:00–18:00，其余闲时）**，右键面板或 `peakWindow.segments` 可改（支持多段、可增删）。
