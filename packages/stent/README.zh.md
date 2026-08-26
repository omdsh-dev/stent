# `stent`

[English](README.md) | 中文

基于 Orchestrion-JS 的 Stent/Mixin 风格扩展层，服务于受信任的 Cordis 插件。service 是 opt-in：默认宿主 composition 不会挂载它，patch 通过受信任代码注册。

## 它能做什么

受信任的插件 A 可以**在不修改 B 源码**的情况下，通过针对 B 的模块、文件和函数注册 Stent patch，改变 B 的某个函数的行为：

| 操作 | Handler 可以做什么 |
|---|---|
| `before` | 在原函数体执行前改写调用参数。 |
| `after` | 观察或替换成功结果（包括异步结果在 settlement 之后）。 |
| `around` | 决定原函数体是否执行，并可替换其结果（调用 `invoke()` 委托）。 |
| `replace` | 完全接管调用；只有 handler 调用 `invoke()` 时才执行原函数体。 |

源码仍然分层在三个既有包内部，不新增第四个包。根入口只包含与平台无关的 runtime 和 service；Node hook 生命周期 API 从 `@oh-my-dsh/stent/node` 导入，build-time transform 和运行时 bundle serving 从 `@oh-my-dsh/stent/browser` 导入，浏览器 Cordis entry 从 `@oh-my-dsh/stent/client` 导入。Orchestrion adapter 及其中间 instrumentation 类型属于 `stent/src/transform` 内部实现，不是公开 API。`src/node` 负责 Node hooks，`src/browser` 负责浏览器构建/运行时接缝，`src/hmr` 负责 HMR generation ownership 与 Node cache 重新变换，`src/testing` 负责子进程测试夹具。`stent-api/src/compat` 分开合作式 contract 与 service；宿主集成包负责 host facade、浏览器服务和 profile 组装，因此纯 Stent service 不依赖 catalog。


## 安装和 bootstrap

```ts
import { installStentHooks } from '@oh-my-dsh/stent/node'
import { StentService } from '@oh-my-dsh/stent'
import type { Context } from 'cordis'

declare const ctx: Context
// DSH launcher 使用空 matcher；插件之后通过 ctx.stent.register 注册
// metadata 和 handler。
const disposeHooks = installStentHooks()
await ctx.plugin(StentService)
disposeHooks()
```

`installStentHooks` 只有一个 Node 安装路径：`installStentHooks()`，且必须在目标模块导入前执行。
dynamic mode 订阅进程内 runtime registry；插件代码注册或移除 patch metadata 时
会重建 matcher，handler 留在内存中，绝不序列化。目标模块若已加载，Node loader
会在支持时调度 CJS/ESM cache 重新变换。Profile YAML 只负责标记 Stent 依赖的
row（例如 `config: { stent: true }`），不再在 `config.stent.patches` 下携带
根入口只包含 runtime 和 service；Node hooks 从 `@oh-my-dsh/stent/node` 导入，browser build/serve API 从 `@oh-my-dsh/stent/browser` 导入。它们不会安装 Node hooks，也不能传给 `installStentHooks`。

启动路径和 hooks 安装是两个不同的概念。`stent-dsh` preload 会在 bootstrap hooks 前写入启动标记；普通 `dsh` 启动不会获得该标记。`StentService` 将它作为 Cordis 的可用性检查，因此声明 `inject: ['stent']` 的插件即使通过其他路径安装了底层 bridge，在普通 `dsh` 下也会保持 pending。browser client entry 会写入等价的 Stent 客户端激活标记。`getStent(ctx)` 在复用或挂载 registry 前也会检查同一启动能力；漏写 `inject: ['stent']` 的 DSH 插件不能通过该 accessor 静默绕过门控，而会 loud failure。明确管理独立生命周期的底层调用方仍可直接构造 `new StentService(ctx)`。

patch 可以设置 `required: true`：boot 后 `checkRequiredPatches()` 从 live
runtime registry 读取 required entries；若某个 required patch 没有任何绑定就
loud failure。宿主会自动运行该检查。一个 patch id 覆盖多种启动形态可用
RegExp `filePath` 或 `filePaths` 数组；加载期绑定按被变换的文件记录，可通过
`ctx.stent.bindings(id?)` 和 `list()` 查看。

```yaml
# Profile YAML 只作为 activation marker，不是 patch descriptor 来源。
- id: dynamic-plugin
  disabled: true
  config:
    stent: true

- id: stent-dsh
  disabled: false
```

宿主 integration row 负责挂载 Host facade。核心包的 browser half（`./client`，实现位于 `src/browser/client`）是由 browser ModuleLoader 加载的 closure-factory artifact（不是普通 Node/ESM import）；它的声明文件描述的是生成该 factory 的 source entry。browser entry 物化时它安装 `ctx.stent`，不会把 package root 变成 Loader plugin。

dynamic hooks 必须在目标模块首次求值前安装。插件在目标加载前注册时会在
首次求值中变换；若目标已经求值，Node 同步 hook API 可用时 loader 会调度
CJS/ESM cache 重新变换。只切换 handler 的 enable/disable 会通过 live bridge
立即生效，不需要再次变换。`registerHooks` 没有 unregister，因此 disposer
停用的是 installation state，而不是移除进程生命周期内的 hook 函数。


## 注册 patch

```ts
import type { Context } from 'cordis'
import type { StentCall, StentService } from '@oh-my-dsh/stent'

export const inject = ['stent']

export function apply(ctx: Context & { stent: StentService }): void {
  ctx.stent.register({
    id: 'my-vendor/rewrite-greeting',
    target: {
      module: '@example/target-package',
      versionRange: '^1.0.0',
      filePath: 'lib/index.js',
      functionQuery: { functionName: 'greet', kind: 'Sync' },
    },
    operation: 'before',
    handler(call: StentCall) {
      call.arguments[0] = String(call.arguments[0]).toUpperCase()
    },
  })
}
```

注册是注册插件拥有的 fiber effect：销毁插件会禁用并移除 patch，且一个 patch id 只属于一个属主——其他插件注册已占用的 id 会失败即显式，而不是静默覆盖在位者的 hook。每次注册都会在注册 fiber 上挂载独立的销毁 effect，disposer 只在 entry 仍归该 fiber 所有时才移除它：热重载的新一代以相同属主收回其插件的 patch（所有权移交），因此旧一代的卸载变成 no-op，不会把新一代的 hook 一起注销。`ctx.stent.list()` 返回有序诊断快照，条目携带该 patch 记录的加载期绑定；`ctx.stent.bindings(id?)` 直接返回绑定记录；`ctx.stent.disable(id)` / `ctx.stent.enable(id, handler)` 可切换 patch 而不移除它，`ctx.stent.remove(id)` 则彻底移除。无法声明可选服务的插件可以调用 `getStent(ctx)`，但 accessor 仍受 `stent-dsh` 启动能力门控，普通 `dsh` 下会 loud failure；普通 DSH 插件应声明 `inject: ['stent']`。明确绕过 DSH launcher 的独立调用方应直接构造 `new StentService(ctx)`。

## 安全与信任模型

- Patch handler 是在注册时绑定的受信任代码；可执行 handler 绝不从 YAML 或模型输入反序列化。
- 变换后的代码在目标模块内拥有进程级权限。`cordis_mount` 临时插件和 repository 插件在获得显式授权前不得使用 Stent 能力。
- id 必须匹配 `[A-Za-z0-9._:/+-]{1,120}`（会嵌入诊断信息和生成的代码）。
- 目标校验是失败即显式的：畸形目标（错误的 id、module、version range、file、operation、selector 或 index）在注册时抛出，而不是安装一个永不匹配的配置。格式正确但匹配不到任何内容的目标——安装版本不同、文件布局不同——会让模块保持未变换（静默）；matcher 只改写其 selector 选中的内容。
- selector 在一个文件中选中多个函数时默认改写全部匹配（翻转了上游"只改第一个"的默认值：`index: null`）；传入从零开始的 `index`（原始 `astQuery` 用 `target.index`，名称查询用 `functionQuery.index`）则只改写单个匹配。constructor 目标在变换期显式拒绝——移动的 constructor 体无法携带 `super()` 或 `new.target`——请改为 patch 方法或工厂函数。

## 平台支持

- **Node Host（ESM + CommonJS）：** 从 `@oh-my-dsh/stent/node` 使用同步 `module.registerHooks`（Node ≥ 22.22.3 / ≥ 24.11.1）和 CJS `_compile` 路径。模块身份从最近的 `package.json` 解析，因此同时支持已安装 package、workspace realpath 以及 pnpm isolated `node_modules` 布局；loader-thread entry 仍属于内部实现，不是公开 API；entry 只注册一次并在每次加载时读取共享配置，因此重新变换、销毁与并发安装在两条路径上行为一致。
- **Browser/Web：** bundle 期重写（`createWatchedBrowserTransform`（静态集合用 `createBrowserTransform`）+ `repoSourceResolver`，经 `clientBundle(id, libEntry, { transform })` 接入）重写 client 插件函数；本 package 的 client half（`./client`，实现位于 `src/browser/client`）在浏览器 Cordis 树中安装 bridge 并挂载 `ctx.stent`。client bundle 在该 entry 物化前回退到原函数，因此 patch 对浏览器 Stent runtime 就绪后的调用生效。web roster 的 `stent` 行默认禁用（opt-in）。

## Browser 构建用法

宿主构建接缝（`clientBundle`）由 profile 选择的宿主版本提供；本包只提供 transform。宿主集成把 transform 接入自己的 bundle 步骤：

```ts ignore-check
import { createWatchedBrowserTransform, repoSourceResolver } from '@oh-my-dsh/stent/browser'

const stent = createWatchedBrowserTransform({
  patchesPath: new URL('./stent.patches.json', import.meta.url).pathname,
  resolve: repoSourceResolver({
    packageName: '@example/client-my-plugin',
    packageRoot: new URL('..', import.meta.url).pathname,
    version: '0.0.1',
  }),
})
```

patches 文件是一个用于 browser build instrumentation 的静态 patch stub JSON
数组（Node DSH launcher 不读取它；JSON 无法表达 `RegExp` `filePath`，因此
文件路径是字符串）。文件畸形会在构建期失败即显式。变换会把文件注册进
打包器 watch 图，因此在 `tsdown --watch`（`pnpm run dev:web`）下编辑它会
重建 bundle；静态内存 patch 集合仍可直接使用 `createBrowserTransform`。

resolver 把包自身的源码树映射到包身份；不使用上游 adapter，因为它要求 `node_modules` 边界，而仓库源码构建没有该边界。TypeScript 源码会在变换前剥离类型注解（transformer 解析编译后的 JavaScript）。

### 运行时 bundle 服务

当目标 bundle 无法在构建期变换时（它的构建属于另一个包），`serveBrowserTransform(ctx, options)` 在运行时提供变换后的副本：它注册一条 EXACT webserver 路由（精确表胜过最长前缀，因此可压过模块宿主的 `/plugins` 路由而无冲突），通过 Loader 组合锚点（`ctx.baseUrl`）而非 Stent 自身的依赖树解析 patches 的 `module` 包，按源内容缓存逐请求应用各 patch 的重写，非 GET 回答 405、bundle 不可读回答 404，且任一选择器未重写任何内容时默认 loud 失败（500 并点名每个未绑定的 patch id）——只有 `fallback: 'raw'` 才降级为原始 bundle。组合锚点缺失或目标包不可解析会在注册时失败。`patches` 接受 patch 描述数组：多个 patch 在同一文件上按与 Node 侧相同的语义叠加（升序 priority 包裹最外层），因此多个插件可以增强同一 bundle 而无须拥有它——路由保持单一属主，重写叠加。路由是 fiber effect；返回的 disposer 可立即移除它。

### 测试 patches

变换 hooks 无法卸载、已变换模块保持缓存，因此每个 patch 场景都需要全新进程。`@oh-my-dsh/stent/testing` 的 `runPatchFixture({ patches, entry, args })` 让这变得机械：它派生一个子进程 bootstrap patches、导入 `entry`（其 default export 以 `args` 运行），并返回 `{ bindings, result, error, exitCode }`——抛出的错误 message 原样穿越进程边界（node-half spec 的富化错误断言无需手写 child runner），每个 patch 的加载期绑定记录让未绑定的 patch 在同一次调用中可见。

## Model Experience

None, as this package is host-side load-time transformation and patch registry machinery; patches register through code, never through model-written configuration.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## 已知限制和待办

- **Hooks 留存到进程结束，state 不会。** `registerHooks` hooks 会组合并留存；disposer 移除该安装的 state（hooks 变为透传，缓存 transformer 被释放）。每次安装捕获自己的 state 并通过自己的 matcher 变换，因此并发安装彼此隔离；共享的 CommonJS `_compile` wrapper 按安装序链式经过每个活跃安装（与同步 hook 链一致），先安装被 dispose 后，后安装不受影响。异步 `module.register` fallback 通过共享配置文件达到相同语义：唯一的 loader-thread entry 在每次加载时读取当前安装栈，因此被 dispose 的安装在下次求值时停止变换 ESM。按 pid 命名的配置文件在进程退出时删除。
- **CommonJS 与 ESM 模块在两条 hook 路径上均可重新变换。** 已经求值的模块可以在当前安装栈下重新求值：`retransformCommonJs(filename)` 清除 `require.cache` 条目（以及同一文件在 Node 内部 `loadCache` 中的条目，使两个图都观察到新的求值）和 seen 标记，`retransformEsm(url)` 驱逐模块在 Node 内部 `loadCache` 中的条目（与 vendored Loader 的 HMR 使用同一机制）——下一次 `require()`/`import()` 会以当前安装栈重新运行 hooks（同步 hooks 读取主线程栈；async entry 读取共享配置）。HMR 周期通过先 dispose 旧安装再重新求值来替换补丁，因此新模块只携带新 instrumentation；旧导出对象保持旧变换。ESM 重新 import 失败时会恢复被驱逐的条目，让之前的实例幸存，而不是让该 URL 无法求值。ESM 重变换要求 Node ≥ 22（内部模块 loader）；async `module.register` fallback 同样支持，因为 loader 线程在重新 import 时会重新读取配置。
- **同一函数上的多个 patch 按 priority 叠加**：instrumentation 按升序应用，高 priority 的 handler 先执行（最外层）；相等 priority 保持安装序（后安装的 instrumentation 包裹最外层，因此其 handler 先运行）。跨安装时，每条 hook 路径上嵌套都按安装序——后安装的包裹最外层，与 priority 无关——因为同步 hooks、CJS `_compile` wrapper 与异步 loader-thread entry 都按安装逐个链式变换。同一目标上的两个 `replace` patch 在注册时被拒绝。
- **箭头目标支持所有参数 pattern**（标识符、rest、默认值和解构——pattern 会在注入语句执行前绑定名字），读取外层 `arguments` 对象的函数体通过先捕获来保留。参数字面命名为 `arguments`（会遮蔽该捕获）的箭头会被跳过。generator 函数通过委托变换：traced generator 在无 handler 与 `before`/`around` 委托路径上以 `yield*` 委托，因此迭代语义得以保留；handler 提供的非可迭代替换值会直接返回。`after` 在迭代前观察 generator 对象（该操作无法在 yield 之间拦截）。
- **Node 加载期变换要求预编译 JavaScript。** loader 解析编译后的 JS；把原始 `.ts` 源码交给 Node load hook 会失败即显式。浏览器构建路径会在变换前剥离 TypeScript 注解（含 JSX）。
