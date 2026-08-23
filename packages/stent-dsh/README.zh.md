# `stent-dsh`

[English](README.md) | 中文

面向 DSH 的 Cordis Stent 集成包。这是 Stent 的 host 与 browser 组装层:挂载 DSH facade、读取组合后的 profile row、在目标模块加载前安装纯 `stent` hooks,并在 boot 后校验 required patch 的绑定结果。

它与纯包刻意分开:`stent` 负责变换和 runtime state,`stent-api` 负责 cooperative compat contract,本包委托给权威 DSH service,只拥有 DSH 集成接缝。

## 提供的能力

| 层 | 职责 |
|---|---|
| Host facade | 提供 `ctx.stentAgent`、`ctx.stentTools`、`ctx.stentPrompt` 和 `ctx.stentCommands`,由权威 DSH service 承载。 |
| Browser facade | 提供 `ctx.stentClient`,为 Mod 暴露 commands 与 named UI slots 的窄 facade。 |
| Profile bootstrap | `installStentBootstrap` 在目标模块加载前读取组合后的 `stent` row 并安装 hooks;`checkStentRequiredPatches` 在 boot 后校验 required binding。 |
| Catalog adapter | DSH integration plugin 挂载时注册 Stent service API entries。 |
| Invariant companion | 暴露包级 `./invariant` function plugin;domain ownership 仍由权威 service 持有。 |

每个 facade 返回底层 service 的 disposer,注册作用域属于贡献它的 Cordis fiber。本包不维护 host domain state 的平行副本,也不绕过 host 的 policy、日志、approval、取消或执行语义。

## Host entry

根入口是 named-export Cordis plugin,没有 default export:

```ts
import * as StentDsh from '@oh-my-dsh/stent-dsh'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
await ctx.plugin(StentDsh)
```

根 plugin 会挂载四个 Host facade。只需要单个模块时,可改为导入对应的 `./host/*` entry。function-plugin namespace 保留 named exports:`name`、`inject` 和 `apply`。

## Profile bootstrap

纯 `stent` row 是 descriptor carrier,应保持 disabled:package root 是 service library,不是 Loader plugin。Stent launcher 会读取它的 `config.stent.patches`,并通过 preload 安装 hooks。DSH integration row 需要单独启用:

```yaml
- id: stent
  disabled: true
  config:
    stent:
      patches:
        - id: vendor/rewrite-greeting
          target:
            module: '@example/target-package'
            versionRange: '^1.0.0'
            filePath: 'lib/index.js'
            functionQuery: { functionName: greet, kind: Sync }
          operation: before

- id: stent-dsh
  disabled: false
```

`installStentBootstrap(rows)` 是面向同一组组合 descriptors 的 profile-bootstrap API;在当前 launcher 路径中,preload 会在目标 CLI 导入模块前完成安装。Handler 仍然是 plugin 在 runtime 注册的受信任代码。Patch descriptor 必须声明在 `config.stent.patches` 下。

`checkStentRequiredPatches(rows)` 在 boot 后运行;当 `required: true` 的 patch 没有绑定时会 loud failure。Launcher 会为组合后的 profile 调度该检查;普通 `dsh` 启动不会自动启用 Stent launch path。preload 写入的进程内启动能力和 hooks 安装相互独立;仅安装 bridge 不能激活 Stent 依赖插件。底层 `getStent(ctx)` fallback 在挂载 registry 前也检查同一能力，因此漏写 `inject: ['stent']` 的插件会 loud failure，而不会绕过启动门控。

## Browser entry

Browser facade 提供两个 package contract:

- `stent-dsh/browser/client` — 逻辑分层的 source entry;
- `stent-dsh/client` — DSH client-module infrastructure 发现的直接 closure-factory artifact。

`./client` 是必需的构建 contract,不是兼容 source shim。两个 entry 暴露同一个 browser facade。Facade 委托真实 DSH command 和 slot service,并有意缩窄 slot registration shape;需要完整 SlotMap 类型的 consumer 应直接使用权威 DSH slot service。

## Public entries

| Entry | 用途 |
|---|---|
| `stent-dsh` | 挂载全部 Host facade 并调度 required-patch 校验。 |
| `stent-dsh/host/agent` | Agent lifecycle observation 与 operation-local injection。 |
| `stent-dsh/host/tools` | Tool registration 与 execution listener。 |
| `stent-dsh/host/prompt` | Prompt section、context、variable 与 tool-schema provider。 |
| `stent-dsh/host/commands` | Human command registration。 |
| `stent-dsh/browser/client` | Browser command 与 named UI slot。 |
| `stent-dsh/bootstrap/profile` | Profile bootstrap 与 required-patch check。 |
| `stent-dsh/invariant` | Package invariant companion plugin。 |

## Runtime requirements

`stent-dsh` 将可从 registry 安装的 DSH host package 声明为 peer contract。消费侧 DSH profile 必须提供权威 service 以及匹配的 `stent` 安装。本仓库的跨包开发使用 workspace protocol;发布后的 peer 仍使用 registry semver range。

本包是 opt-in 的。默认 DSH composition 不会挂载这些 facade,browser roster row 也会保持 disabled,直到 Stent launch path 启用它们。
