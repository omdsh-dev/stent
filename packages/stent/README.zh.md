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

源码仍然分层在三个既有包内部，不新增第四个包。根入口只包含与平台无关的 runtime 和 service；Node hook 生命周期 API 从 `@oh-my-dsh/stent/loader` 导入，build-time transform 和运行时 bundle serving 从 `@oh-my-dsh/stent/browser` 导入，浏览器 Cordis entry 从 `@oh-my-dsh/stent/client` 导入。Orchestrion adapter 及其中间 instrumentation 类型属于 `packages/stent/src/transform` 内部实现，不是公开 API。`packages/stent/src/loader` 负责 Node hooks，`packages/stent/src/browser` 负责浏览器构建/运行时接缝，`packages/stent/src/hmr` 负责 HMR generation ownership，Node cache 重新变换由 `packages/stent/src/loader` 负责，`packages/stent/src/testing` 负责子进程测试夹具。`packages/stent-api/src/compat` 分开合作式 contract 与 service；宿主集成包负责 host facade、浏览器服务和 profile 组装。transform 边界、数据流和边缘语义见 `packages/stent/docs/transform-api.md` 与 `packages/stent/docs/transform-architecture.md`，因此纯 Stent service 不依赖 catalog。
## 安装和 bootstrap

```ts
import { installStentHooks } from '@oh-my-dsh/stent/loader'
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
row（例如 `config: { stent: true }`），不再在 `config.stent.patches` 下携带 patch stub。
根入口只包含 runtime 和 service；Node hooks 从 `@oh-my-dsh/stent/loader` 导入，browser build/serve API 从 `@oh-my-dsh/stent/browser` 导入。它们不会安装 Node hooks，也不能传给 `installStentHooks`。

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

宿主 integration row 负责挂载 Host facade。核心包的 browser half（`./client`，实现位于 `packages/stent/src/browser/client`）是由 browser ModuleLoader 加载的 closure-factory artifact（不是普通 Node/ESM import）；它的声明文件描述的是生成该 factory 的 source entry。browser entry 物化时它安装 `ctx.stent`，不会把 package root 变成 Loader plugin。

dynamic hooks 必须在目标模块首次求值前安装。插件在目标加载前注册时会在
首次求值中变换；若目标已经求值，同步 hook API 可用时 loader 会调度 CJS/ESM
cache 重新变换；async `module.register` fallback 则由 loader thread 处理之后的
ESM 加载，而主线程 CJS `_compile` wrapper 及其重新变换路径仍然有效。只切换
handler 的 enable/disable 会通过 live bridge 立即生效，不需要再次变换。
`registerHooks` 没有 unregister，因此 disposer 停用的是 installation state，而不是
移除进程生命周期内的 hook 函数。
## 注册 patch

```ts
import type { Context } from 'cordis'
import type { StentCall, StentService } from '@oh-my-dsh/stent'

const inject = ['stent']

function apply(ctx: Context & { stent: StentService }): void {
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

export { inject, apply }
```

注册是注册插件拥有的 fiber effect：销毁插件会禁用并移除 patch，且一个 patch id 只属于一个属主——其他插件注册已占用的 id 会失败即显式，而不是静默覆盖在位者的 hook。每次注册都会在注册 fiber 上挂载独立的销毁 effect，disposer 只在 entry 仍归该 fiber 所有时才移除它：热重载的新一代以相同属主收回其插件的 patch（所有权移交），因此旧一代的卸载变成 no-op，不会把新一代的 hook 一起注销。`ctx.stent.list()` 返回有序诊断快照，条目携带该 patch 记录的加载期绑定；`ctx.stent.bindings(id?)` 直接返回绑定记录；`ctx.stent.disable(id)` / `ctx.stent.enable(id, handler)` 可切换 patch 而不移除它，`ctx.stent.remove(id)` 则彻底移除。无法声明可选服务的插件可以调用 `getStent(ctx)`，但 accessor 仍受 `stent-dsh` 启动能力门控，普通 `dsh` 下会 loud failure；普通 DSH 插件应声明 `inject: ['stent']`。明确绕过 DSH launcher 的独立调用方应直接构造 `new StentService(ctx)`。

## 安全与信任模型

- Patch handler 是在注册时绑定的受信任代码；可执行 handler 绝不从 YAML 或模型输入反序列化。
- 变换后的代码在目标模块内拥有进程级权限。`cordis_mount` 临时插件和 repository 插件在获得显式授权前不得使用 Stent 能力。
- id 必须匹配 `[A-Za-z0-9._:/+-]{1,120}`（会嵌入诊断信息和生成的代码）。TypeScript 调用方必须传 string；底层正则守卫会对 JavaScript 非字符串做 coercion，不应依赖数字等值通过。
- file selector 是交给 matcher 的字面路径（通常约定为相对包根），不会做路径规范化：单个 `filePath` 的空值、绝对路径、空白或 `..` 可能通过静态形状守卫；`filePaths` 必须是非空 string 数组，并按项展开 instrumentation。
- 目标校验分阶段且失败即显式：静态守卫检查 module/version/file selector/index/operation 的形状，`expandPatchStub` 再检查 id 并构造 query；`required` 只由 Node 启动后的绑定检查使用，在 expansion 时从 browser/internal config 丢弃。selector 语法只在匹配模块实际变换时解析，因此畸形 selector 可能在变换期失败；格式正确但 module/file 未命中时保持原模块。当前实现允许空 `filePath` 通过静态守卫。
- selector 在一个文件中选中多个函数时默认改写全部匹配（翻转了上游"只改第一个"的默认值：`index: null`）；传入从零开始的 `index`（原始 `astQuery` 用 `target.index`，名称查询用 `functionQuery.index`）则只改写单个匹配。constructor 目标在变换期显式拒绝——移动的 constructor 体无法携带 `super()` 或 `new.target`——请改为 patch 方法或工厂函数。

## 平台支持

- **Node Host（ESM + CommonJS）：** 从 `@oh-my-dsh/stent/loader` 使用同步 `module.registerHooks` hooks（Node 22.22.3+、24.11.1+ 或更高主版本）和 CJS `_compile` 路径；同步路径直接读取主线程 matcher state。低版本或强制 async 时，`module.register` 只把 ESM 变换放在 loader thread，并通过共享 JSON 配置传递可序列化的 instrumentation；主线程仍保留 CJS `_compile` 路径。loader-thread entry 仍属于内部实现，不是公开 API。`installStentHooks()` 只允许一个 active dynamic installation，第二个 active 调用会被拒绝；disposer 停用 state，但 process-lifetime hook 函数仍保留。
- **Browser/Web：** bundle 期重写（`createWatchedBrowserTransform`（静态集合用 `createBrowserTransform`）+ `repoSourceResolver`，经 `clientBundle(id, libEntry, { transform })` 接入）重写 client 插件函数；本 package 的 client half（`./client`，实现位于 `packages/stent/src/browser/client`）在浏览器 Cordis 树中安装 bridge 并挂载 `ctx.stent`。client bundle 在该 entry 物化前回退到原函数，因此 patch 对浏览器 Stent runtime 就绪后的调用生效。web roster 的 `stent` 行默认禁用（opt-in）。

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
文件路径是字符串）。文件畸形会在 transform callback 读取时失败即显式。变换会把文件注册进打包器 watch 图；
编辑是否重建 bundle 取决于宿主是否遵守 watch hook 并接通自己的 HMR 链。静态内存
patch 集合仍可直接使用 `createBrowserTransform`。

resolver 把包自身的源码树映射到包身份；不使用上游 adapter，因为它要求 `node_modules` 边界，而仓库源码构建没有该边界。内置 installed-package resolver 直接寻找最近的 package manifest，但要求 filesystem-like id 位于已有 manifest 下，不会规范化 virtual/query-suffixed id。`.ts`/`.tsx` 源码会在变换前由 `ts.transpileModule`（含 JSX、不做 type-check）编译为 JavaScript；其他扩展名必须已经是 JavaScript。

### 运行时 bundle 服务

当目标 bundle 无法在构建期变换时（它的构建属于另一个包），`serveBrowserTransform(ctx, options)` 在运行时提供变换后的副本：它注册一条 EXACT webserver 路由（精确表胜过最长前缀，因此可压过模块宿主的 `/plugins` 路由而无冲突），通过 Loader 组合锚点（`ctx.baseUrl`）而非 Stent 自身的依赖树解析 patches 的 `module` 包，按源内容缓存逐请求应用各 patch 的重写，非 GET 回答 405、bundle 不可读回答 404，且任一选择器未重写任何内容时默认 loud 失败（500 并点名每个未绑定的 patch id）——只有 `fallback: 'raw'` 才降级为原始 bundle。组合锚点缺失或目标包不可解析会在注册时失败。`patches` 接受 patch 描述数组：数组内多个 patch 在同一文件上按与 Node 侧相同的语义叠加（升序 priority 包裹最外层）；一个 route owner 应聚合要应用到该 bundle 的全部 descriptors。独立插件各自调用 `serveBrowserTransform()` 会重复注册 exact route，通常会被 webserver 拒绝；若宿主提供 route composition，应由宿主负责聚合。路由是 fiber effect；返回的 disposer 可立即移除它。

### 测试 patches

变换 hooks 无法卸载、已变换模块保持缓存，因此每个 patch 场景都需要全新进程。`@oh-my-dsh/stent/testing` 的 `runPatchFixture({ patches, entry, args })` 让这变得机械：它派生一个子进程 bootstrap patches、导入 `entry`（其 default export 以 `args` 运行），并返回 `{ bindings, result, error, exitCode }`——抛出的错误 message 原样穿越进程边界（node-half spec 的富化错误断言无需手写 child runner），每个 patch 的加载期绑定记录让未绑定的 patch 在同一次调用中可见。

## Model Experience

None, as this package is host-side load-time transformation and patch registry machinery; patches register through code, never through model-written configuration.

#### KV Cache effect

None; the package neither assembles nor sends a provider request.

## 已知限制和待办

- **Hooks 留存到进程结束，state 不会。** `registerHooks` hooks 会组合并留存；disposer 移除该安装的 state（hooks 变为透传，跟踪的 transformer 被释放）。`installStentHooks()` 只允许一个 active dynamic installation，第二个 active 调用会被拒绝；旧 state 的 hook layer 在 dispose 后保持 inert，之后才能安装新的 state。async `module.register` fallback 通过共享配置文件让 loader thread 读取当前单个 installation 的 ESM 配置，而主线程 CJS `_compile` wrapper 与动态 CJS 重新变换仍然有效。按 pid 命名的配置文件在进程退出时删除。
- **CommonJS 与 ESM 模块在两条 hook 路径上均可重新变换。** 已经求值的模块可以在当前 installation 下重新求值：`retransformCommonJs(filename)` 清除 `require.cache` 条目（以及同一文件在 Node 内部 `loadCache` 中的条目，使两个图都观察到新的求值）和 seen 标记，`retransformEsm(url)` 驱逐模块在 Node 内部 `loadCache` 中的条目（与 vendored Loader 的 HMR 使用同一机制）——下一次 `require()`/`import()` 会以当前 state 重新运行 hooks（同步 hooks 读取主线程 state；async entry 为 ESM 重新读取共享配置）。HMR 周期通过先 dispose 旧 state 再重新求值来替换补丁，因此新模块只携带新 instrumentation；旧导出对象保持旧变换。ESM 重新 import 失败时会恢复被驱逐的条目，让之前的实例幸存，而不是让该 URL 无法求值。ESM 重变换要求 Node ≥ 22（内部模块 loader）；async `module.register` fallback 同样支持。
- **Raw AST query 必须排除生成的 scaffolding。** 诸如 `astQuery: 'FunctionExpression'` 的宽泛 selector 可能在 Orchestrion 遍历可变 AST 时命中 Stent 注入的匿名 replay closure，继续递归包装新闭包甚至超时。请使用精确的 name/祖先/函数形状谓词，并为 raw selector 测试递归行为。
- **同一函数上的多个 patch 按 priority 叠加**：instrumentation 按升序排列，高 priority 位于最外层；`before`/`around`/`replace` 进入时通常先执行，`after` 则在结果回退时后执行。一个 browser/static snapshot 的相同 priority 保持输入序；单个 active Node dynamic snapshot 按 patch id 排序。第二个 active `installStentHooks()` 调用会被拒绝，因此独立 active installation 不会嵌套。同一目标上的两个 `replace` patch 在注册时被拒绝。
- **箭头、普通函数与 generator 目标有特殊的 replay 语义。** 箭头 bridge arguments 是根据已绑定参数重建的 synthetic array：默认值会物化，rest 会展开，解构会创建局部 object/array，额外 caller 参数和原对象 identity 不会保留。结构化 `arguments` 扫描在识别到外层值时先捕获；带 `arguments` 参数的箭头会跳过。普通函数的 slice 依赖未被遮蔽的 `arguments` binding，因此普通参数或局部声明遮蔽它时不受支持；移动后的 body 也会改变非严格模式 `arguments.callee`/`arguments.caller` 的 identity。generator 对可迭代结果使用 `yield*` 委托；`after` 在迭代前观察 generator object，handler 提供的不可迭代替换值直接返回。replay 也不会保留 `super` 或 `new.target`，strict-CJS 指令需要谨慎处理。
- **Node 加载期与 browser 构建期输入不同。** Node loader 解析预编译 JavaScript；把原始 `.ts` 源码交给 Node load hook 会失败即显式。browser build transform 会对以 `.ts` 或 `.tsx` 结尾的 id 用 `ts.transpileModule`（含 JSX、不做 type-check）后再解析；`.mts` 与 `.cts` 不走这条分支。
