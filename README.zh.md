# RFC:dsh-external-stent — 仓库目的、架构与决策记录

[English](README.md) | 中文

- 状态:**活文档**(每节记录决策及其历史)
- 范围:本独立 Stent 扩展仓库
- 上游锚点:deepseek-harness 快照 `7b9644f2`(0812)/ `9f9e2782a4`(0813)、fork tip `65bcaf9902`(`feat-stent`)

本文解释这个仓库**为什么**长成现在的样子。下面每一处非常规安排都来自提交历史中一次具体的事故;各节按仓库演化顺序组织,而不是按文件布局。

---

## 1. 目的:外部化的 Stent 扩展,而非 fork

deepseek-harness 是私有 monorepo。Stent/Mixin 扩展层在其中以三个实现包
存在,但消费者无法从 registry 安装它们。本仓库外部化这三个包,并发布
`@oh-my-dsh/stent-pack` carrier,使消费者能通过官方插件通道安装完整 bundle:

```
dsh plugin --profile <p> add @oh-my-dsh/stent-pack
```

**边界(硬规则):** 工作区包含恰好三个完整实现包——`stent`(纯转换服务)、
`stent-api`(纯 compat facade)、`stent-dsh`(DSH 面 facade、invariant、
profile bootstrap)。根包 `@oh-my-dsh/stent-pack` 是单独发布的 carrier,不是第四个实现包。
官方 `@deepseek-ai/dsh-tool-cordis` 保持为上游依赖,不在此重新发布。

## 2. Host 集成:由 launcher 提供接线

三个包通过编译后的 launcher 安装 hooks 并挂载 facade。`src/stent-dsh.ts`
编译为 `lib/stent-dsh.js`，`src/stent-dsh-preload.ts` 编译为
`lib/stent-dsh-preload.js`；launcher 在官方 CLI 加载前注入这个编译后的
preload，不需要 host patch checkout。preload 还会记录进程内的
`stent-dsh` 启动能力，因此即使其他路径安装了底层 hooks，普通 `dsh` 下
Stent 依赖插件仍不可用。`getStent(ctx)` 也使用同一能力门控：漏写
`inject: ['stent']` 的插件在普通 `dsh` 下无法通过 accessor 挂载 registry，
而会 loud failure。

官方通道已经覆盖的内容被刻意排除:安装 trio(`dsh plugin add`)、bundle 行名册与依赖、catalog 生成、trio-in-workspace 的 invariant/gate 豁免、以及全部文档(`README*`、`docs/`、`.agents/`)。剩下的是任何通道都提供不了的:launcher bootstrap(`apps/cli/src/profile-boot.ts` 在任何目标导入之前调用 `installStentBootstrap`、boot 后调用 `checkStentRequiredPatches`)、`clientBundle` 源码 transform 构建接缝(`packages/client/tsdown.client.ts`)、编译进官方 `tool-cordis` 包的 catalog 条目、它们的测试、以及 pnpm 策略接缝。

### 2.1 disabled opt-in 行

web-app bundle 层把 `stent` / `stent-dsh` 行插入为 **disabled opt-in**:纯 `stent` 包是没有插件 `apply` 的库,enabled 的行每次 boot 都失败("invalid plugin")。profile 通过启用这些行 opt-in;bundle 层每次 boot 都应用,因此既有的 profile 无需编辑即被覆盖。

### 2.2 TSX 死胡同(已记录并撤销)

`dsh` 的 source 启动(`node --import tsx/esm apps/cli/src/bin.ts`)一度看起来需要 `TSX_TSCONFIG_PATH` 或 register preload:`FiberState`(const enum,只在 `vendor/cordis/src` 存在)解析失败。两个 workaround 都曾发布,后来**全部撤销**——真正原因是 shell 里一个指向旧 staging checkout 的过期 `TSX_TSCONFIG_PATH`。干净环境下 tsx 自动发现入口的 tsconfig(继承 base)并把别名解析到 `src`。官方脚本原样运行;patch 中不存在相关接缝。

## 3. 安装模型:npm bundle

可发布的根 bundle `@oh-my-dsh/stent-pack` 声明三个已发布的 npm 实现包：

```
@oh-my-dsh/stent@^0.1.1
@oh-my-dsh/stent-api@^0.1.1
@oh-my-dsh/stent-dsh@^0.1.1
```

同一个 tag workflow 会在这三个包之后发布根 carrier,确保它的 semver 依赖已经存在于 npm。

这样安装只需一个 npm 包:

```sh
dsh plugin --profile web add @oh-my-dsh/stent-pack
```

安装时由 pnpm 解析这些 npm semver 依赖;启动时 `stent-dsh` 调用 DSH 的 module-fallback healer,把 bundle 的依赖闭包映射到 `$DSH_HOME/profiles/node_modules`,使 Profile 和 preload 解析到同一套 trio 副本。

- host 源码安装在 `apps/cli/package.json` 中声明 bundle;先执行 harness workspace 的 `pnpm install` 和 `pnpm run pack:build`,再通过插件通道安装已发布的 npm bundle(把 `@oh-my-dsh/stent-pack` 并入 `dsh.profile.bundles`)、启用 `stent-dsh` 行——启动一律走编译后的 `lib/stent-dsh.js`。
- 消费侧构建使用根目录显式的 `pack:build` 脚本;trio 与 launcher 在打包前分别由各包自己的 tsdown 命令构建,不需要安装期 `prepare`。

### 3.1 pnpm 11 供应链接缝

npm bundle 不需要在 Profile 中设置 `blockExoticSubdeps: false`,也不需要 Git prepare allowlist 或 `dangerouslyAllowAllBuilds`。workspace 仍允许原生 `esbuild` 构建,并排除快速发布的 DSH rc 序列的 minimum-release-age 检查:

- 本 workspace 的 `allowBuilds: esbuild`;
- `minimumReleaseAgeExclude: ['@deepseek-ai/dsh-*']`——dsh-* rc 序列总在 24h 窗口内发布,仅写包名豁免所有版本。

## 4. Registry 依赖策略

dsh-* host 包以快速 rc 序列发布;本仓库通过 registry 范围跟踪它们,每条教训都来自一次真实事故。

### 4.1 dsh-compact 陷阱

`@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` 依赖 `@deepseek-ai/dsh-compact`,后者**从未发布**(上游发布该 runtime 之后删除了这个包)。`0.1.0-rc.x` 系列去掉了该依赖;已端到端验证可安装。

### 4.2 缺失的 rc.5

上游代码版本是 `0.1.0-rc.5`,但 registry 从 `rc.3` 直接跳到 `rc.6`——rc.5 从未发布。因此范围写作 `^0.1.0-rc.0`(解析最新发布的 rc,且 `rc.0` 使未来的稳定版也在范围内)。peer 使用相同范围,host workspace 的 rc.5 满足它——host 安装复用 workspace 包而非 registry 副本。

### 4.3 真实 host 类型,而非本地契约

trio 一度声明 `host-contracts.ts` facade 加一个全局 `@deepseek-ai/cordis` Events 注入。它破坏了 host 各包的类型检查,已删除,改为直接导入真实 `@deepseek-ai/dsh-*` 类型(声明为 peer + devDeps)——与上游形状一致。`ctx.slots` 的类型来自 `dsh-client-runtime` 的声明,与上游相同。

### 4.4 已发布 lib 的运行时 peer

在 `autoInstallPeers: false` 下,已发布 `dsh-*` lib 的加载期导入(`dsh-scope`、`dsh-llm`、`dsh-timeout`、`dsh-typert-protocol`)必须显式列入 devDependencies——每一个都是在测试加载时报 "Cannot find package" 后补上的。

## 5. 浏览器 client 格式:closure factory

web shell 以 classic script 加载 `/plugins/<id>/client.js`,值导入通过 loader 模块表(factory 内的同步 `require`)解析。纯 ESM 产物在那里完全加载不起来。因此 trio 的两个浏览器半边都发布为 closure factory:

```js
window.__ModuleLoader__.load({ id: "@oh-my-dsh/stent", factory: (require) => { ...; return module.exports; } })
```

`@deepseek-ai/cordis` 保持 external(平台 seed),其余全部内联。先改的是 `stent`;随后 `stent-dsh`(同样的缺口,在 ex-setting 安装暴露第一个之后修复)。上游从不察觉——其 monorepo 通过共享的 `clientBundle()` 预设构建两者。

### 5.1 ex-setting 的三条教训(同一契约,外部仓库)

姊妹仓库 `omdsh-dev/ex-setting` 三次撞上同一契约:

1. 它的 `dsh.client` manifest 必须**嵌套**(`"dsh": { "client": ... }`),而非顶层 `dshClient` 字段——client-modules 扫描的是嵌套形式;
2. 消费侧构建必须用 **prepare 配置**,而不是只改本地配置,否则 git 安装仍在供应旧产物;
3. 跨 bundle 值导入不能指望 disabled 行的 factory——ex-setting 内联/避开模块表回答不了的东西,并把静态样式改为直接安装,而不是经由 Stent publish(transform 无法匹配 closure 产物内部)。

## 6. 测试策略

上游套件通过 tsconfig paths 解析 `src`;本仓库只有 registry 的 `lib` 产物,这驱动了下述演化。

- **serve.spec** 使用测试内置的 `node:http` 适配器提供 host `webServer` 服务,保留 exact/prefix 路由和真实 HTTP 响应覆盖,不再依赖 DSH host-webserver 测试包。
- **hmr-e2e-runner** 通过翻转 `cordis.yml` 里行的 `disabled` 标志驱动 config HMR:vendor fork 的 `hmr.registerConfig` 与 include `internal/update` 是 fork 私有,**任何** registry 版本都没有(对照最新 1.0.16/1.0.6 验证过)。
- **client spec** 最初 fake `CommandUiRuntime`/`SlotRegistry`,因为 runtime rc.1 依赖树装不了且 bundle 是 closure factory。rc.6 可装后真实原因只剩 factory 格式,于是 spec 通过测试模块加载器(`packages/stent-dsh/tests/browser/module-loader.ts`)挂载**真实服务**:happy-dom 提供 `window`;`__ModuleLoader__` sink 在 helper 模块顶层安装;平台 seed(`cordis`、`ui-slots`、`react`)以 ESM namespace 预载(factory 的 `require` 是同步的,node 无法 require ESM);渲染专用的重型包 `ui-primitives` 用 stub;`materialize()` 以模块表 require 执行 factory(递归进入其他已注册 bundle、记忆化、`stripClientSuffix` 归一化 `pkg/client`)。Loader `baseUrl` 与 fixture URL 钉死为文件路径,因为 happy-dom 的 `location` 是 `http://localhost:3000`。

## 7. Lint 检查

每个包从自己的包根目录运行 Oxlint，使用固定的 DSH 工具链（`oxlint` 与 `oxlint-tsgolint`）和选定的 TypeScript 类型感知规则；根包与子包配置共享一份纳入版本控制的基线。warning 视为失败。生成的 `lib/` 产物、JavaScript fixture launcher 和构建配置不属于本 TypeScript lint 面。

Oxfmt 是本 workspace 的统一格式化器，共享策略写在 `.oxfmtrc.json`：两空格缩进、单引号、无分号、尾随逗号和 120 列宽。每个包分别拥有自己的 `fmt` 与 `fmt:check` 命令；根 carrier 的 `pack:fmt:check` 负责编排根包和全部实现包的检查。生成的 `lib/` 产物、fixture 目录、JavaScript launcher fixture 和构建配置不属于格式化范围。

根 carrier 只负责自身的 `src/` launcher 和 `tests/` 根集成测试。根包的 `lint`、`lint:fix`、`test`、`build` 与 `knip` 命令不会扫描实现包文件，也不提供 `pack:lint:fix`。三个实现包分别声明自己的工具链，并提供只作用于本包的独立 `lint`、`lint:fix`、`test`、`build` 与 `knip` 命令；类型检查由各包带类型感知的 lint 命令提供，不再单独提供 `typecheck` 脚本。根目录的 `pack:*` 脚本只负责编排：保持根包检查与各包命令分开，并通过 `pnpm --filter` 调用后者。

## 8. 时间线(节选)

| 提交 | 决策 |
|---|---|
| `1e04b1a`..`2a42254` | 外部化:独立 Stent bundle、自包含模板 |
| `4018661`、`8ffaac4` | 移植上游三包拆分 + 全量 host patch;HMR e2e |
| `d9228c4`、`40600d4` | 官方插件通道安装;source-host 安装脚本 |
| `1ba7077`、`3331b80` | web-app bundle 组合行;行改为 disabled opt-in |
| `7b8e913`、`3fd3106` | patch rebase:0812 baseline → 0813 baseline |
| `9158f5d` | 删除 `host-contracts.ts`;真实 `@deepseek-ai/dsh-*` 类型 |
| `30ed5ff`、`b58c643` | registry 依赖策略(rc.5 peer、可安装套件) |
| `58fbe75`、`33955ef` | 两个浏览器半边改为 closure factory |
| `aa58a52` | 公开发布(与上游对齐) |
| `62ced22` | 撤销 TSX workaround(环境误诊) |
| `3fd1a56` | happy-dom + ModuleLoader materializer;测试挂真实浏览器服务 |

## 9. 后续工作

- 若 registry 将来发布 node 可导入的构建(纯 ESM 或 `src` 半边),测试模块加载器可删除,spec 直接 import 包。
- 上游把 `createSnapshotStore` 移出 `dsh-client-runtime` 会缩小 seed 表。
- 上游发布 `hmr.registerConfig` / `internal/update` 后,HMR runner 可重新镜像 in-tree 的 config 流程。
