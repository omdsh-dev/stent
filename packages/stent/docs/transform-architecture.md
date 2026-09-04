# Stent transform 层架构设计

> 本文档从代码层面解读 `packages/stent/src/transform` 的架构:模块职责、依赖方向、
> 编译期与运行期数据流,以及每个关键设计决策背后的原因。
> 配套文档:[transform-api.md](transform-api.md)(逐项 API 说明)。
> 下文新增的仓库文件引用使用 project-root 路径(例如 `packages/stent/src/transform/types.ts`);
> import 示例仍使用源码相对路径。

## 1. 定位与边界

`packages/stent/src/transform/` 是 Stent 的**自包含变换层**:它只负责"把静态 patch 描述符变成
改写后的目标函数代码",不含 Cordis 依赖、不含运行时注册表、不含 loader 生命周期。

两个硬边界由代码和测试共同维护:

1. **对内自包含**。`packages/stent/tests/transform/isolation.test.ts` 扫描
   `packages/stent/src/transform` 下每个 `.ts` 文件,断言不存在指向父级目录的包内相对
   import。也就是说该目录可以消费包外的模块(`node:*`、`estree`、`typescript`、
   `@apm-js-collab/code-transformer`),但**绝不能反向依赖**
   `packages/stent/src/bridge.ts`、`packages/stent/src/runtime.ts`、
   `packages/stent/src/types.ts`、`packages/stent/src/loader/*`、
   `packages/stent/src/browser/*` 等包内模块。
 2. **对外单向**。包内其他模块只通过 `packages/stent/src/transform` 拿到变换能力:
   - `packages/stent/src/loader/loader.ts` → `runtime.ts`、`bridge.ts` 与 loader 内部
     的状态、hook 和 cache adapter;
   - `packages/stent/src/loader/state.ts` → `config.ts`、`identity.ts`、`matcher.ts`;
   - `packages/stent/src/loader/hook-entry.ts`(loader 线程)→ `browser.ts`(createInstrumentedTransform)、
     `identity.ts`、`wire.ts`;
   - `packages/stent/src/loader/index.ts` 是 Node public facade；异步入口和 HMR cache API 都直接由 loader 模块提供;
   - `packages/stent/src/browser/index.ts` / `packages/stent/src/browser/serve.ts` → `browser.ts`、`identity.ts`;

边界与公开面的关系:README 明确声明 Orchestrion 适配器和中间 instrumentation
类型是**内部实现细节,不是公开 API**;`packages/stent/package.json` 的 `exports`
没有 `./transform` 入口。浏览器消费者从 `@oh-my-dsh/stent/browser` 得到
`createBrowserTransform`、`createWatchedBrowserTransform`、`repoSourceResolver`、
`resolvePackageIdentity`、`serveBrowserTransform` 及其公开类型;其中 runtime bundle
serving 来自 `packages/stent/src/browser/serve.ts`,并非 `packages/stent/src/transform` 的导出。
Node 侧则通过 `installStentHooks()` 间接消费整个变换层。`packages/stent/src/transform/index.ts`
是**源码内**的统一导出边界:显式具名导出,只转发包内实际消费的符号;实现专用符号
(Orchestrion 适配、`registerStentTransform`、`orderInstrumentations`、`detectModuleType`)
留在各自子模块,不改变包级公开面。

## 2. 模块职责

| 文件 | 角色 | 关键导出 |
|---|---|---|
| `types.ts` | 静态契约:patch stub、target、函数查询、绑定报告 | `StentPatchStub`、`StentTarget`、`StentFunctionQuery`、`StentBinding` |
| `ast-types.ts` | matcher 命中函数的归一化类型与程序级名称分配器 | `MatchedFunction`、`NameAllocator` |
| `arguments.ts` | `arguments` 的结构化扫描/改写与名称集合收集 | `mapOuterArguments`、`namesOf` |
| `patterns.ts` | 函数节点归一化与参数 pattern 重建 | `isConstructorTarget`、`matchFunction`、`patternToExpression` |
| `statements.ts` | bridge/replay/generator 注入语句的 ESTree 构造器 | `createOuterArgumentsCapture`、`createArgumentsStatement`、`createTracedStatement`、`createCallStatement`、`createPublishStatement`、`createInjectedStatements` |
| `validation.ts` | 描述符守卫,失败即抛错 | `validatePatchId`、`validatePatchStatic` |
| `config.ts` | 静态 patch → Orchestrion wire 形状(纯函数,无 IO) | `expandPatchStub`、`orderInstrumentations` |
| `orchestrion.ts` | 对 `@apm-js-collab/code-transformer` 的**唯一**直接适配边界 | `createOrchestrion` 及类型再导出 |
| `matcher.ts` | 平台无关的 matcher 操作:创建、查询、变换 | `createStentMatcher`、`getStentTransformer`、`orderStentInstrumentations`、`transformStentSource` |
| `transform.ts` | 核心 AST 重写:custom transform 的注册与实现 | `registerStentTransform` |
| `identity.ts` | 模块身份解析(最近 package.json)与模块类型探测 | `resolvePackageIdentity`、`detectModuleType` |
| `wire.ts` | RegExp `filePath` 的 JSON 序列化往返 | `serializeInstrumentation`、`reviveInstrumentation` |
| `protocol.ts` | 变换代码与运行时桥之间的全局协议名 | `GLOBAL_BRIDGE_KEY` |
| `browser.ts` | 浏览器/bundler 面:静态、instrumented、watched 三种 transform 工厂 | `createInstrumentedTransform`、`createBrowserTransform`、`createWatchedBrowserTransform`、`repoSourceResolver` |
| `index.ts` | 源码内统一导出边界:具名导出,不是 package export | 见 [transform-api.md](transform-api.md) 第 0 节清单 |

### 内部依赖图(有向无环)

```text
  types.ts ──type──► validation.ts ──► config.ts ──► matcher.ts ──► browser.ts
      └──type──────────────────────► browser.ts

  ast-types.ts ──type──► arguments.ts ───────┐
       │              ├──► patterns.ts ──────┼──► transform.ts ──► matcher.ts
       │              └──► statements.ts ────┘
  patterns.ts ───────────────► statements.ts
  protocol.ts ──value────────► statements.ts
  orchestrion.ts ──type/value─► config.ts · transform.ts · matcher.ts
  config.ts ──────────────────► wire.ts
  identity.ts ──value────────────────────────────────────────────► browser.ts

  index.ts ──explicit re-exports──► the selected symbols from the modules above
  package consumers (outside this graph): packages/stent/src/loader/*,
  packages/stent/src/browser/*, packages/stent/src/bridge.ts, packages/stent/src/runtime.ts
```
(示意图如实标明每条边;精确依赖边见下表,与 import 语句一一对应。)

精确依赖边(与 import 语句一一对应):

| 模块 | 依赖 |
|---|---|
| `types.ts` | (无) |
| `protocol.ts` | (无) |
| `ast-types.ts` | `estree`(type) |
| `arguments.ts` | `ast-types.ts`(type)、`estree`(type) |
| `patterns.ts` | `ast-types.ts`(type)、`estree`(type) |
| `statements.ts` | `ast-types.ts`(type)、`patterns.ts`、`protocol.ts`、`estree`(type) |
| `identity.ts` | `node:fs`、`node:path`、`node:url` |
| `validation.ts` | `types.ts`(type) |
| `config.ts` | `types.ts`(type)、`validation.ts`、`orchestrion.ts`(type) |
| `transform.ts` | `arguments.ts`、`ast-types.ts`(type)、`orchestrion.ts`(type)、`patterns.ts`、`statements.ts` |
| `wire.ts` | `config.ts`(type) |
| `matcher.ts` | `config.ts`、`orchestrion.ts`(值+type)、`transform.ts` |
| `browser.ts` | `config.ts`、`identity.ts`、`matcher.ts`、`types.ts`(type)、`node:fs`、`node:path`、`typescript` |
| `index.ts` | 上述模块(具名再导出) |

其中 `config.ts`、`wire.ts`、`browser.ts` 都不直接引用 `transform.ts`;
`transform.ts` 不直接引用 `config.ts`;汇合点在 `matcher.ts`。
`orchestrion.ts` 是唯一与 `@apm-js-collab/code-transformer` 建立 import 边的文件
(`matcher.ts` 经由它再导出的 `createOrchestrion` 与类型工作)。

分层可以概括为五层:

- **契约层**(`types.ts`、`validation.ts`):定义 Stent 自己拥有的静态形状与守卫,
  不接触第三方。
- **翻译层**(`config.ts`):把 Stent 形状翻译成 Orchestrion 认识的 wire 配置;
  同时是 `filePaths` 展开、优先级排序、esquery 选择器生成发生的地方。
- **AST 辅助层**(`ast-types.ts`、`arguments.ts`、`patterns.ts`、`statements.ts`):
  归一化命中函数、处理参数 pattern/`arguments` 名称,构造注入用的 ESTree 节点。
- **执行层**(`orchestrion.ts` / `matcher.ts` / `transform.ts`):创建 matcher、
  注册 custom transform、按模块选择 transformer、执行变换。
- **平台面**(`browser.ts`、`identity.ts`、`wire.ts`):为 Node loader 线程与
  browser bundler 提供入口形态,以及身份解析与跨线程序列化辅助。

## 3. 编译期数据流(patch 描述符 → 改写后的代码)

### 3.1 Node 加载路径(`packages/stent/src/loader/loader.ts`)

Node 侧只有一个 loader 协调模块。`loader.ts` 管理安装、变更订阅、状态释放和公开 re-transform；`state.ts` 管理 matcher 快照与动态重变换队列；`sync.ts`、`async.ts` 分别适配同步 hooks 与 loader thread；`reload.ts` 集中处理 CJS/ESM cache eviction；`hook-entry.ts` 是异步 loader thread 的唯一实现。`src/loader/index.ts` 是 Node public facade，异步入口和 HMR cache API 都直接由 loader 模块提供。

这些 adapter 通过 `types.ts` 的 `LoaderHost` 读取状态、patch snapshot 和 binding recorder，不直接访问 `runtime`。因此 runtime 仍是 patch 数据平面，Node 私有 API、`Module.prototype._compile`、`module.register` 和跨线程 wire 都被限制在 loader 目录内。

`loader.ts` 仍然只允许一个 active dynamic installation；process-lifetime hook 函数在 disposer 后保留，但通过 central loader 的状态读取器观察到空的 active state。

```text
插件 ctx.stent.register()                    runtime.register()
        │                                           │ onPatchChange
        ▼                                           ▼
patchStubFromInfo(runtime.list())  ──►  expandPatchStub()     逐文件展开 filePaths
                                           │
                                           ▼
                                orderStentInstrumentations()   按 stentPriority 升序
                                           │
                                           ▼
                                 createStentMatcher()          创建 Orchestrion matcher
                                           │                    + registerStentTransform()
                                           ▼
                              ┌────────────┴────────────┐      ← 模块加载时
                              │      resolve() hook      │        resolvePackageIdentity(url)
                              │  getStentTransformer()   │        ──► transformer 缓存
                              └────────────┬────────────┘
                                           ▼
                              load() hook / _compile 包装        transformStentSource()
                                           │
                                           ▼
                                flushBindings()              onMatch 计数 → 每个文件
                                           │                    attribution
                                           ▼
                             runtime.recordBindings()        → bindings / required 检查
```

要点:

- `expandPatchStub` 处理 `target.filePaths`(数组)与 `target.filePath`(单个)两种
  形态:数组展开成多个 instrumentation,各带各自的 `filePath`;`filePath` 为
  `RegExp` 时保持不变,直到 `wire.ts` 序列化。
- `onMatch` 回调在 `createStentMatcher(instrumentations, onMatch)` 处传入,
  由 `registerStentTransform` 把"该节点确实被改写"翻译成一次计数;loader 一侧的
  `pending` map 在单文件变换期间累积,`flushBindings` 在文件结束后写入
  `runtime.recordBindings`;每次重新变换都可能追加记录,这里不做全局去重。
- 身份解析走 `identity.ts` 的"最近 package.json"方案,而不是解析 npm 布局路径,
  因此同时覆盖已安装包与 workspace 实路径(pnpm 隔离布局也可用)。manifest 的
  name/version 按根目录进程级缓存;无名、损坏或不可读 manifest 返回 `undefined`,
  缺少 string version 时返回空字符串;任意已存在的 string(即使不是有效 semver)
  都会原样保留。
- `installStentHooks()` 只允许一个 active dynamic installation;第二个 active 调用在
  `loader.ts` 直接抛错。同步 `registerHooks` 与 `_compile` 路径直接读取主线程的
  matcher/state,不经过共享 JSON 文件;disposer 只停用 state,process-lifetime hook
  函数仍保留。
- 异步回退路径(`module.register`,Node 22 低于 22.22.3、Node 23、Node 24 低于
  24.11.1,或 `STENT_FORCE_ASYNC_HOOKS` 测试缝)只把 ESM load-hook 变换放在
  loader thread:它每次加载读取主线程写入的共享 JSON,`reviveInstrumentation` 还原
  RegExp 后调用 `createInstrumentedTransform`。CJS 仍由主线程 `_compile` wrapper
  处理,已有 CJS 在动态刷新时也走 re-transform;两条路径共享 matcher/transform 语义。

### 3.2 Browser 构建路径(`packages/stent/src/transform/browser.ts`)

```text
createBrowserTransform({ patches, resolve })
        │
        ▼
patches.flatMap(expandPatchStub)            静态 patch stub → wire 配置(required 先校验后丢弃)
        │
        ▼
createInstrumentedTransform(instrumentations, resolve)
        │
        ├── createStentMatcher(...)         matcher + custom transform
        ▼
transform(code, id)                         bundler 每次调用
        │
        ├── resolve(id) ── 未匹配 ──► null
        ├── getStentTransformer(...) ────► undefined ──► null
        ├── /\.tsx?$/ ──► stripTypes(code) 先经 ts.transpileModule 编译为 JS
        │                                  (解析器只读 JS;ESNext/ES2022/Bundler,
        │                                   jsx: ReactJSX 自动运行时)
        ├── transformStentSource(...)      执行 AST 重写
        ▼
TransformOutput { code, map?, bindings? }   bindings 仅来自本次成功 rewrite 的 pending 计数
```

Browser 这条路径运行在 Node-capable 的打包器侧,不是把 Node APIs 带进浏览器运行时。
仅 id 以 `.ts`/`.tsx` 结尾时调用 `ts.transpileModule`(emit only,含 JSX);`.mts`/`.cts`
与其他扩展名直接交给 Orchestrion,中间 source map 不与后续 map 链接。

`createWatchedBrowserTransform` 是 browser build 变体:返回的 transform 每次调用都
`addWatchFile?.(patchesPath)`、同步重读 JSON,并只在内容变化时重建底层 matcher——即
"读-用-重建"模式。JSON 不能表达 RegExp,所以序列化 descriptor 中的 path 值必须是
string;`filePaths: string[]` 仍会按 public expansion 支持,而 RegExp `filePath` 不能放进
文件。外层只检查数组与 object target,其余静态/query 错误在 matcher 重建时
由 `createBrowserTransform` 抛出。bundle 是否随编辑重建取决于宿主打包器是否遵守
watch hook 并接通自己的 HMR 链。

### 3.3 从描述符到选择器

两种目标选择方式(见 `types.ts` 的 `StentTarget`):

- `functionQuery`:名字驱动的查询。`config.ts#queryFromFunction` 只处理
  `methodName`、`privateMethodName`、`functionName`、`expressionName`,把结果编译成
  esquery 选择器:`methodName`/`privateMethodName` 匹配 class/object method/property
  value;`functionName` 匹配 FunctionDeclaration 和 VariableDeclarator 下的
  FunctionExpression/ArrowFunctionExpression;`expressionName` 还匹配命名的
  FunctionExpression/ArrowFunctionExpression 及其 VariableDeclarator 形状。当前
  没有 AssignmentExpression 形态。它不会用 `className` 缩小范围,只含 `className` 的形状不支持;
  名称未经转义直接插入,`isExportAlias` 也不会被当前显式 `astQuery` 解析。
  所有生成 selector 中的 `[async]` 是属性存在性测试,plain 与 async 函数节点都带
  `async` 属性,所以不是 async-only 过滤;`kind` 作为兼容 metadata 保留,不驱动
  Stent custom transform 的选择或 dispatch。
- `astQuery`:原始 esquery 字符串,优先级高于 `functionQuery`
  (`patchInstrumentation` 中 `target.astQuery ?? queryFromFunction(patch)`),
  是名字查询表达不了的形状(如工厂返回的匿名箭头或需要显式 local-name/祖先范围)的
  逃生口;selector 仍必须最终命中可变换的函数/方法/属性节点,不能只命中 class 节点。
  原始 selector 的语法通常要到匹配模块实际变换时才解析。由于 traversal 会在改写后的
  AST 上继续工作,过宽的 raw selector(例如裸 `FunctionExpression`)可能再次命中
  新生成的 replay closure,造成递归改写或超时;应使用精确的 name/祖先/函数形状谓词
  排除 Stent scaffolding。

`index` 语义(与上游"只取第一个匹配"的默认相反)是 public stub expansion 的保证:
`expandPatchStub` 将省略值归一化为 `null`,所以省略或 `null` 改写**全部**匹配;
直接手写低层 `StentInstrumentationConfig` 时须显式给 `functionQuery.index: null`,
否则上游对缺省值只取首个。非负整数只改写第 N 个(`target.index` 用于裸
`astQuery`,`functionQuery.index` 用于名字查询);选择方式确定后另一字段即使通过
静态校验也会被忽略。

## 4. 运行期数据流(改写后的函数被调用时)

改写后的函数体(以普通 async 函数为例)形如:

```js
// 注入的语句(名字由 per-program 分配器保证不遮蔽文件内标识符)
const stentArguments = Array.prototype.slice.call(arguments)   // 箭头函数则按参数模式重建
const stentTraced = () => (function () { /* 原函数体 */ }).apply(this, stentArguments)
const stentCall = { id, operation, arguments: stentArguments, self: this, traced: stentTraced }
return globalThis['__stentBridge']
  ? globalThis['__stentBridge'].publish(stentCall)
  : stentTraced()
```

调用链:

```text
改写后的函数
   │  globalThis[__stentBridge].publish(call)      packages/stent/src/bridge.ts publish()
   ▼
bridge listeners(Set,listener 注册顺序)                     StentRuntime.subscribe()
   │  entry = entries.get(call.id)
   ▼
dispatch(entry, call)                              packages/stent/src/runtime-dispatch.ts dispatch()
   │  按 operation 选择调用约定:
   │   before:  observe(record); invoke()
   │   after:   invoke(); observe(record)(thenable 则 then 后)
   │   around /
   │   replace: handler(record, invoke)
   ▼
handler(受信任代码)                                结果返回给改写后的函数
```

设计要点:

- **无桥也要安全**。`globalThis[GLOBAL_BRIDGE_KEY]` 不存在(或没有监听器)时,
  `publish` 直接走 `call.traced()`,变换后的代码在 bootstrap 之前、浏览器 entry
  挂载之前都只是"原样执行"。代价是补丁只对桥存在之后的调用生效。
- **bridge 不携带 Cordis**。`StentBridgeCall` 只带 `id`、`operation`、`arguments`、
  `self`、`traced`,是 transform → runtime 之间唯一契约,由 `protocol.ts` 的
  `GLOBAL_BRIDGE_KEY = '__stentBridge'` 协调。

## 5. 核心设计决策

### 5.1 为什么不用 Orchestrion 内置 trace transform

内置 transform 把原函数体包进其 tracing 闭包内**总是执行**,`around`/`replace`
的"否决原函数体"无法表达。Stent 因此注册自定义 transform `'stent'`
(`registerStentTransform` 的 `matcher.addTransform('stent', ...)`,`config.ts`
产出 `transform: 'stent'`),由 transform 直接向 bridge 发布调用,运行时按
`operation` 决定是否执行原体。

### 5.2 traced closure:名字、`.length`、普通 `this` 的保留

原函数节点(声明/表达式/方法)保持现状——名字留在原节点,参数表留在原节点
(因此声明的 `.length` 不变)。普通调用时,先用未被遮蔽的 `arguments` 生成浅数组,
`stentTraced` 再通过 `.apply(this, stentArguments)` 转发 receiver;body 迁入内部匿名
函数,由 5.5 的名称分配器保护注入变量。因而 `arguments.callee`/`arguments.caller`
等非严格模式 introspection 观察到的函数 identity 会改变;普通参数或局部声明遮蔽
`arguments` 也不受支持。这个移动还有明确边界:以 `new` 调用普通函数时
`new.target` 不会保留,方法体中的 `super` 不能安全地移入普通闭包,而严格 CJS
函数的 `'use strict'` 指令会随 body 移动,可能改变外层 wrapper 的 receiver 语义。
当前实现只显式拒绝 constructor target,不会自动扫描这些普通函数/方法限制。

### 5.3 箭头函数的三处特殊处理

箭头没有自己的 `arguments`,也没有自己的 `this`:

1. **参数重建**:`const stentArguments = [p1, p2, ...rest]`(数组元素由
   `patternToExpression` 从已绑定的参数模式生成——标识符、默认值、rest、解构都
   支持)。这是供 bridge handler 使用的 synthetic array:默认值会物化,rest 会展开,
   object/array 解构会创建局部的部分副本,额外 caller 参数与原对象 identity 不保留;
   computed destructuring key 还会在重建时再次求值。
2. **外层 `arguments` 捕获**:箭头 body 引用外层 `arguments` 时,
   `mapOuterArguments` 先探测(不重写),再以 `const stentOuterArguments = arguments`
   捕获并把可见的 `arguments` 标识符改写为捕获名。该 helper 是结构化启发式扫描,
   不是完整 lexical-scope resolver:它跳过 `Property`/`MethodDefinition` 的全部 key (computed 或非 computed)与非
   computed member property,不识别局部声明的真实绑定,computed property/method key 也完全不扫描。
3. **参数名为 `arguments` 时跳过**:`matchFunction` 对含名为 `arguments` 参数的
   箭头返回 `undefined` 不改写——避免猜测 body 指向哪个 `arguments`;含该参数的
   嵌套箭头也是扫描边界。

### 5.4 生成器与异步生成器:yield* 委托

生成器函数不能简单 `return` 重放器,否则迭代语义丢失。transform 生成:

```js
const stentResult = bridge.publish(stentCall)
if (stentResult != null && typeof stentResult[Symbol.iterator] === 'function') {
  return yield* stentResult
}
return stentResult
```

`publish` 返回的不可迭代值(handler 未接管时的 traced 生成器是迭代器;handler
供应的替换值若不是迭代器)直接返回。异步生成器同时接受
`Symbol.asyncIterator`(同步 `||` 异步检查)。无桥路径同样经过这个委托逻辑,
所以未改写的重放永不变成普通迭代。`after` 在 generator 创建后、开始迭代前观察
generator object,无法在各次 `yield` 之间插入。

### 5.5 注入名称的防遮蔽分配

`namesOf(program)` 返回按文件分配的 `unique(base)` 分配器:首次使用把**整个
Program 的所有标识符**(含属性键、标签、member 属性,刻意过度保守)收集进集合,
再为 `stentArguments`/`stentTraced`/`stentCall`/`stentOuterArguments`/`stentResult`
生成 `base` 或 `base_N`。集合存在 `WeakMap<Program, Set>` 中,同一文件内多次
匹配复用同一集合,且跨文件名称确定性一致。注释原文:过度保守的重命名是安全的,
漏掉一个变量引用则会静默改变移动后的 body 的解析结果。

### 5.6 构造函数:大声拒绝

`isConstructorTarget` 命中 class `constructor` 时直接抛错。派生构造函数的 `super()` 在
普通函数内是语法错误,`new.target` 也无法经 `.apply()` 重放。注意这是明确的
constructor guard,不是通用语义分析:普通函数用 `new` 或任何方法体包含 `super`
的目标仍可能产生上述限制,应在 patch 前避开或先补充专门支持。

### 5.7 优先级与栈序

`orderInstrumentations` 按 `stentPriority` **升序**(缺省 0)返回新数组,原因是后续
包装让高优先级位于最外层。`before`/`around`/`replace` 进入时通常先进入高优先级
层,`after` 则在结果回退时先离开低层、后执行高层。browser 静态数组的相同
priority 保持输入序;Node 动态 snapshot 由 runtime 按 patch id 排序。公开 API 同时
只允许一个 active dynamic installation,所以不存在可观察的跨安装嵌套顺序。

### 5.8 RegExp filePath 的跨线程往返

JSON 不能表达 RegExp。`wire.ts#serializeInstrumentation` 把
`filePath instanceof RegExp` 变成 `{ stentRegexp: [source, flags] }`,
`reviveInstrumentation` 反向还原,其余字段原样透传。这正是 async 配置文件的
数据形态(`StentWireInstrumentation`);helper 本身不读写 JSON,也不校验 marker。
非法 source/flags 或缺失 marker 可能在读取/构造时抛错;同一个内存 matcher 中带
`g`/`y` 的 RegExp 仍可能因上游 `.test` 的 `lastIndex` 带状态,但 wire 只传
source/flags 并 revive 新的 RegExp,所以跨 JSON 往返不会保留该 `lastIndex`。

### 5.9 失败模式:按阶段 fail-loud,但 miss 有明确返回值

- 静态期:`validatePatchId` 检查 id;`validatePatchStatic` 只检查
  module/version/file selector/required/index/operation 的形状,不检查 query 语法、
  semver grammar、priority 或 handler;
- 展开期:`expandPatchStub` 展开 `filePaths`,检查空白 `astQuery`,并为缺失 query 或
  不支持的 name-query shape 抛错;原始 esquery 语法可能要到实际变换时才解析;
- 选择期:resolver 无身份或 module/version/file 未命中时 browser transform 返回
  `null`;找到 transformer 但 selector 没有候选注入点时上游通常抛错,而不是返回
  `null`;若 selector 命中候选节点但 `index` 越界,则返回未改写 output 且通常没有
  `bindings`,不会抛同一错误,Node required 检查可在启动后报告这种 miss。
- 变换期:transform 配置缺 `stentPatchId`/`stentOperation` 抛错;constructor 命中
  抛错;匹配节点不是函数形状则返回 `false`,因此可能没有 `bindings`;
- 加载期:同步 CJS/ESM hook 与 async 路径的 CJS `_compile` wrapper 会把变换错误包装为
  `stent: failed to transform <url>`;async loader-thread 的 ESM `hook-entry.ts` 不
  包装,parser/selector 等原始错误会向上游传播。
- 启动后:required patch 无绑定由 `checkRequiredPatches` 报出
  (`packages/stent/src/loader/loader.ts`);browser transform 本身不执行 required 检查;
- 浏览器 serve:patch 未绑定或变换失败默认 500 点名 patch id,
  `fallback: 'raw'` 才降级为原样 bundle。

## 6. 不变量

1. 变换层不 import 包内 transform 以外的模块(测试强制)。
2. 契约单向:transform 拥有的静态形状(`types.ts`)被 `packages/stent/src/types.ts` 再导出,
   运行时契约(`StentBridgeCall` 等)由 bridge 定义,transform 只用协议常量,
   不消费任何运行时类型。
3. 第三方 `@apm-js-collab/code-transformer` 仅出现在 `orchestrion.ts`,
   `matcher.ts`、`config.ts`、`browser.ts` 都只使用本地再导出的名字。
4. 变换主体只做 AST 改写;可观察状态限于 `arguments.ts` 的
   `programNames` WeakMap、`identity.ts` 的 manifest 缓存与各 adapter 的 matcher cache。
   相同输入通常得到相同代码,但同一内存 matcher 中带 `g`/`y` 的 RegExp file matcher 受上游 `lastIndex`
   语义影响;wire 往返只保留 source/flags 并重置该状态,watched adapter 也会按原始文件内容重建。
5. 身份解析不依赖包管理布局或模块格式(ESM/CJS 均可),只依赖最近的
   `package.json`。
