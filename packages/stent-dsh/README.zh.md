# `stent-dsh`

[English](README.md) | 中文

面向 DSH 的 Cordis Stent 集成包。这是 Stent 的 host 与 browser 组装层:挂载 DSH facade、读取组合后的 profile row 作为 activation marker、在目标模块加载前安装 dynamic `stent` hooks,并在 boot 后校验 required patch 的绑定结果。

它与纯包刻意分开:`stent` 负责变换和 runtime state,`stent-api` 负责 cooperative compat contract,本包委托给权威 DSH service,只拥有 DSH 集成接缝。

## 提供的能力

| 层 | 职责 |
|---|---|
| Host facade | 提供 `ctx.stentAgent`、`ctx.stentTools`、`ctx.stentPrompt` 和 `ctx.stentCommands`,由权威 DSH service 承载。 |
| Browser facade | 提供 `ctx.stentClient`,为 Mod 暴露 commands 与 named UI slots 的窄 facade。 |
| Profile bootstrap | `installStentBootstrap` 为不使用 launcher 的 embedder 调用 `installStentHooks()`；`checkStentRequiredPatches` 在 boot 后校验 live required binding。 |
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

Launcher 会通过 generated overlay 启用 Stent-dependent row，但 row 只携带
activation metadata。Plugin code 通过 `ctx.stent.register()` 注册 target metadata
和 handler；YAML 不再提供 patch descriptor。需要 opt-in 时可保持 plugin row
disabled：

```yaml
- id: dynamic-plugin
  disabled: true
  config:
    stent: true

- id: stent-dsh
  disabled: false
```

`installStentBootstrap(rows)` 是不使用 launcher preload 的 embedder 兼容入口，
安装 `installStentHooks()`。Launcher 路径由 preload 在目标 CLI 导入前完成安装。
`checkStentRequiredPatches(rows)` 在 boot 后检查 live runtime registry 的 required
entries。preload 的进程内启动能力与 hooks 安装相互独立；仅安装 bridge 不能激活
Stent 依赖插件。底层 `getStent(ctx)` fallback 也检查同一能力，因此漏写
`inject: ['stent']` 的插件会 loud failure，而不会绕过启动门控。

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

本包是 opt-in 的。默认 DSH composition 不会挂载这些 facade,browser roster row
也会保持 disabled。通过 `stent-dsh` 启动 host profile 时,launcher 会自动启用
host integration row，以及带 activation marker 的 Stent-dependent plugin row。
