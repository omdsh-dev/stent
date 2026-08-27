# Stent transform 层架构设计

> 本文档从代码层面解读 `packages/stent/src/transform` 的架构:模块职责、依赖方向、
> 编译期与运行期数据流,以及每个关键设计决策背后的原因。
> 配套文档:[transform-api.md](transform-api.md)(逐项 API 说明)。
> 下文路径未标注包前缀时,相对于 `packages/stent/`(如 `src/transform/`)。

## 1. 定位与边界

`src/transform/` 是 Stent 的**自包含变换层**:它只负责"把静态 patch 描述符变成
改写后的目标函数代码",不含 Cordis 依赖、不含运行时注册表、不含 loader 生命周期。

两个硬边界由代码和测试共同维护:

1. **对内自包含**。`tests/transform/isolation.spec.ts` 扫描 `transform/` 下每个
   `.ts` 文件,断言不存在形如 `from '../...'` 的包内相对导入。也就是说
   `transform/` 可以消费包外的模块(`node:*`、`estree`、`typescript`、
   `@apm-js-collab/code-transformer`),但**绝不能反向依赖** `src/bridge.ts`、
   `src/runtime.ts`、`src/types.ts`、`src/node/*`、`src/browser/*` 等包内模块。
2. **对外单向**。包内其他模块只通过 `transform/` 拿到变换能力:
   - `src/node/loader.ts` → `config.ts`(expandPatchStub、StentInstrumentationConfig)、
     `identity.ts`、`matcher.ts`、`wire.ts`;
   - `src/node/hook-entry.ts`(loader 线程)→ `browser.ts`(createInstrumentedTransform)、
     `identity.ts`、`wire.ts`;
   - `src/browser/index.ts` / `src/browser/serve.ts` → `browser.ts`、`identity.ts`;
   - `src/bridge.ts` → `protocol.ts`(GLOBAL_BRIDGE_KEY);
   - `src/runtime.ts` → `validation.ts`(仅再导出守卫);
   - `src/types.ts`(包公共类型)→ `transform/types.ts`(仅类型再导出)。

边界与公开面的关系:README 明确声明 Orchestrion 适配器和中间 instrumentation
类型是**内部实现细节,不是公开 API**;`packages/stent/package.json` 的 `exports`
没有 `./transform` 入口。浏览器消费者能拿到的只是 `@oh-my-dsh/stent/browser`
选择性再导出的 `createBrowserTransform`、`createWatchedBrowserTransform`、
`repoSourceResolver`、`resolvePackageIdentity` 及其类型;Node 侧则通过
`installStentHooks()` 间接消费整个变换层。`transform/index.ts` 是**源码内**的统一
导出边界:显式具名导出,只转发包内实际消费的符号;实现专用符号(Orchestrion
适配、`registerStentTransform`、`orderInstrumentations`、`detectModuleType`)
留在各自子模块,不改变包级公开面。

## 2. 模块职责

| 文件 | 角色 | 关键导出 |
|---|---|---|
| `types.ts` | 静态契约:patch stub、target、函数查询、绑定报告 | `StentPatchStub`、`StentTarget`、`StentFunctionQuery`、`StentBinding` |
| `validation.ts` | 描述符守卫,失败即抛错 | `validatePatchId`、`validatePatchStatic` |
| `config.ts` | 静态 patch → Orchestrion wire 形状(纯函数,无 IO) | `expandPatchStub`、`orderInstrumentations` |
| `orchestrion.ts` | 对 `@apm-js-collab/code-transformer` 的**唯一**直接适配边界 | `createOrchestrion` 及类型再导出 |
| `matcher.ts` | 平台无关的 matcher 操作:创建、查询、变换 | `createStentMatcher`、`getStentTransformer`、`orderStentInstrumentations`、`transformStentSource` |
| `transform.ts` | 核心 AST 重写:custom transform 的注册与实现 | `registerStentTransform` |
| `identity.ts` | 模块身份解析(最近 package.json)与模块类型探测 | `resolvePackageIdentity`、`detectModuleType` |
| `wire.ts` | RegExp `filePath` 的 JSON 序列化往返 | `serializeInstrumentation`、`reviveInstrumentation` |
| `protocol.ts` | 变换代码与运行时桥之间的全局协议名 | `GLOBAL_BRIDGE_KEY` |
| `browser.ts` | 浏览器/bundler 面:静态、instrumented、watched 三种 transform 工厂 | `createBrowserTransform`、`createWatchedBrowserTransform`、`repoSourceResolver` |
| `index.ts` | 统一导出边界:具名导出,只转发包内实际消费的符号 | 见 [transform-api.md](transform-api.md) 第 0 节清单 |

### 内部依赖图(有向无环)

```text
        供给节点(无内部依赖)                     主干链(自上而下)
        ──────────────────                    ─────────────────────

        types.ts ──type──► validation.ts ─────► config.ts ─────┬──► matcher.ts ───► browser.ts
        (契约)              (守卫)              (翻译)          │       (Facade)      (平台面)
                                                               │
        protocol.ts ──值──────────────────────► transform.ts ──┘
        (全局协议名)                             (核心 AST 重写)

        identity.ts ──值──► browser.ts (身份解析)
        orchestrion.ts ──type/值──► config.ts · transform.ts · matcher.ts (第三方唯一适配)
        wire.ts ──type──► config.ts (RegExp 序列化,主干旁支)
        types.ts ──type──► config.ts / browser.ts (契约类型)

        包内消费者(位于本图之外):src/node/loader.ts、src/node/hook-entry.ts、
        src/browser/index.ts、src/browser/serve.ts、src/bridge.ts、src/runtime.ts
```
(示意图如实标明每条边;精确依赖边见下表,与 import 语句一一对应。)

精确依赖边(与 import 语句一一对应):

| 模块 | 依赖 |
|---|---|
| `types.ts` | (无) |
| `protocol.ts` | (无) |
| `identity.ts` | `node:fs`、`node:path`、`node:url` |
| `validation.ts` | `types.ts`(type) |
| `config.ts` | `types.ts`(type)、`validation.ts`、`orchestrion.ts`(type) |
| `transform.ts` | `protocol.ts`(值)、`orchestrion.ts`(type)、`estree`(type) |
| `wire.ts` | `config.ts`(type) |
| `matcher.ts` | `config.ts`、`orchestrion.ts`(值+type)、`transform.ts` |
| `browser.ts` | `config.ts`、`identity.ts`、`matcher.ts`、`types.ts`(type)、`node:fs`、`node:path`、`typescript` |
| `index.ts` | 上述全部模块(具名再导出) |

其中 `config.ts`、`wire.ts`、`browser.ts` 都不直接引用 `transform.ts`;
`transform.ts` 不直接引用 `config.ts`;汇合点在 `matcher.ts`。
`orchestrion.ts` 是唯一与 `@apm-js-collab/code-transformer` 建立 import 边的文件
(`matcher.ts` 经由它再导出的 `createOrchestrion` 与类型工作)。

分层可以概括为四层:

- **契约层**(`types.ts`、`validation.ts`):定义 Stent 自己拥有的静态形状与守卫,
  不接触第三方。
- **翻译层**(`config.ts`):把 Stent 形状翻译成 Orchestrion 认识的 wire 配置;
  同时是 `filePaths` 展开、优先级排序、esquery 选择器生成发生的地方。
- **执行层**(`orchestrion.ts` / `matcher.ts` / `transform.ts`):创建 matcher、
  注册 custom transform、按模块选择 transformer、执行变换。
- **平台面**(`browser.ts`、`identity.ts`、`wire.ts`):为 Node loader 线程与
  browser bundler 提供入口形态,以及身份解析与跨线程序列化辅助。

## 3. 编译期数据流(patch 描述符 → 改写后的代码)

### 3.1 Node 加载路径(src/node/loader.ts)

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
  `pending` map 在单文件变换期间累积,`flushBindings` 在文件结束后一次性写入
  `runtime.recordBindings`,保证一次绑定记录恰好归属一个文件。
- 身份解析走 `identity.ts` 的"最近 package.json"方案,而不是解析 npm 布局路径,
  因此同时覆盖已安装包与 workspace 实路径(pnpm 隔离布局也可用)。
- 异步回退路径(`module.register`,Node < 22.22.3 或 < 24.11.1 时无可靠同步
  `registerHooks`,或 `STENT_FORCE_ASYNC_HOOKS` 测试缝):loader 线程的
  `hook-entry.ts` 每次加载读取主线程写入的共享 JSON 配置文件,
  `reviveInstrumentation` 还原 RegExp 后调用 `createInstrumentedTransform`,
  与同步路径共享同一套 matcher/transform 语义。

### 3.2 Browser 构建路径(src/transform/browser.ts)

```text
createBrowserTransform({ patches, resolve })
        │
        ▼
patches.flatMap(expandPatchStub)            静态 patch stub → wire 配置
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
TransformOutput { code, map?, bindings? }   bindings 来自 per-call pending 计数
```

`createWatchedBrowserTransform` 是 dev 热链路上的变体:返回的 transform 每次调用
都 `addWatchFile?.(patchesPath)`(把 patch 文件加入 bundler watch 图),按模块重读
该 JSON 文件,并只在内容变化时重建底层 matcher——即"读-用-重建"模式,与 loader
线程入口的共享配置文件一致。文件只放静态 patch stub(JSON 无法表达 RegExp,
所以文件内 `filePath` 恒为字符串),任何畸形条目都在构建期大声失败。

### 3.3 从描述符到选择器

两种目标选择方式(见 `types.ts` 的 `StentTarget`):

- `functionQuery`:名字驱动的查询。`config.ts#queryFromFunction` 把它编译成
  esquery 选择器:
  - 方法 → `ClassBody > [key.name="m"][key.type=Identifier] > [async]` 与
    `Property[key.name="m"][key.type=Identifier] > [async]`
    (`privateMethodName` 用 `PrivateIdentifier` 键类型);
  - 函数 → `FunctionDeclaration[id.name="f"][async]` 以及
    `VariableDeclarator[id.name="f"] > FunctionExpression/ArrowFunctionExpression[async]`;
  - 命名表达式 → `FunctionExpression[id.name="x"][async]`、
    `ArrowFunctionExpression[id.name="x"][async]` 及对应的 VariableDeclarator 形态。
  注意所有生成的选择器都带 `[async]` 过滤器,这是名字查询的固有语义。
- `astQuery`:原始 esquery 字符串,优先级高于 `functionQuery`
  (`patchInstrumentation` 中 `target.astQuery ?? queryFromFunction(patch)`),
  是名字查询表达不了的形状(如工厂返回的匿名箭头)的逃生口。

`index` 语义(与上游"只取第一个匹配"的默认相反):省略或 `null` 改写**全部**
匹配节点;非负整数只改写第 N 个(`target.index` 用于裸 `astQuery`,
`functionQuery.index` 用于名字查询,`isValidIndex` 校验)。

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
   │  globalThis[__stentBridge].publish(call)      src/bridge.ts publish()
   ▼
bridge listeners(Set,注册顺序)                     StentRuntime.subscribe()
   │  entry = entries.get(call.id)
   ▼
dispatch(entry, call)                              src/runtime.ts dispatch()
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

### 5.2 traced closure:名字、`.length`、`this` 的保留

原函数节点(声明/表达式/方法)保持现状——名字留在原节点,参数表留在原节点
(因此 `.length` 不变),`this` 来自调用者;只有 body 迁入内部匿名函数,由
`stentTraced` 通过 `.apply(this, stentArguments)` 重放。原体里所有名字解析最终
落回原函数作用域:这是 5.5 命名分配器存在的原因。

### 5.3 箭头函数的三处特殊处理

箭头没有自己的 `arguments`,也没有自己的 `this`:

1. **参数重建**:`const stentArguments = [p1, p2, ...rest]`(数组元素由
   `patternToExpression` 从参数模式生成——标识符、默认值、rest 展开、解构都支持,
   因为模式在注入语句运行前已完成绑定)。
2. **外层 `arguments` 捕获**:箭头 body 引用外层 `arguments` 时,
   `mapOuterArguments` 先探测(不重写),再以 `const stentOuterArguments = arguments`
   捕获(箭头自身的词法解析使该引用指向外层作用域),并把 body 里的 `arguments`
   标识符(仅词法引用,不进入嵌套普通函数)改写为捕获名。
3. **参数名为 `arguments` 时跳过**:`matchFunction` 对含名为 `arguments` 参数的
   箭头返回 `undefined` 不改写——避免猜测 body 指向哪个 `arguments`。

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
所以未改写的重放永不变成普通迭代。

### 5.5 注入名称的防遮蔽分配

`namesOf(program)` 返回按文件分配的 `unique(base)` 分配器:首次使用把**整个
Program 的所有标识符**(含属性键、标签、member 属性,刻意过度保守)收集进集合,
再为 `stentArguments`/`stentTraced`/`stentCall`/`stentOuterArguments`/`stentResult`
生成 `base` 或 `base_N`。集合存在 `WeakMap<Program, Set>` 中,同一文件内多次
匹配复用同一集合,且跨文件名称确定性一致。注释原文:过度保守的重命名是安全的,
漏掉一个变量引用则会静默改变移动后的 body 的解析结果。

### 5.6 构造函数:大声拒绝

`isConstructorTarget` 命中 `constructor` 时直接抛错。原因(代码注释):
构造函数体不能移入 traced 闭包——派生构造函数的 `super()` 在普通函数内是语法
错误,`new.target` 会静默变成 `undefined`。与其生成求值即崩的模块,不如在变换
阶段失败,提示"patch 一个方法或工厂"。

### 5.7 优先级与栈序

`orderInstrumentations` 按 `stentPriority` **升序**(缺省 0)稳定排序。
`browser/serve.ts` 注释给出消费者语义:升序优先级包装在最外层,同优先级保持
注册顺序——高优先级 handler 先被调用。loader 线程入口则强调跨安装的嵌套顺序
由**安装顺序**决定(源码链式经过各安装的 transform),不是全局合并排序。

### 5.8 RegExp filePath 的跨线程往返

JSON 不能表达 RegExp。`wire.ts#serializeInstrumentation` 把
`filePath instanceof RegExp` 变成 `{ stentRegexp: [source, flags] }`,
`reviveInstrumentation` 反向还原,其余字段原样透传。这正是 async 配置文件的
数据形态(`StentWireInstrumentation`)。

### 5.9 失败模式:从注册到请求全链路 fail-loud

- 注册期:非法 id(`validatePatchId`)、非法 target/operation(`validatePatchStatic`)
  直接抛错,不安装永不匹配的配置;
- 展开期:`filePaths` 未展开就进入 `patchInstrumentation` 抛错;
  `astQuery` 为空白串抛错;`functionQuery` 与 `astQuery` 皆无时抛错
  (经 `queryFromFunction`,见 API 文档 §4);
- 变换期:transform 配置缺 `stentPatchId`/`stentOperation` 抛错;构造函数命中
  抛错;匹配节点不是函数形状返回 `false` 不报错;
- 加载期:变换抛错包装为 `stent: failed to transform <url>`;
- 启动后:required patch 无绑定由 `checkRequiredPatches` 报出(`src/node/loader.ts`);
- 浏览器 serve:patch 未绑定或变换失败默认 500 点名 patch id,
  `fallback: 'raw'` 才降级为原样 bundle。

## 6. 不变量

1. 变换层不 import 包内 transform 以外的模块(测试强制)。
2. 契约单向:transform 拥有的静态形状(`types.ts`)被 `src/types.ts` 再导出,
   运行时契约(`StentBridgeCall` 等)由 bridge 定义,transform 只用协议常量,
   不消费任何运行时类型。
3. 第三方 `@apm-js-collab/code-transformer` 仅出现在 `orchestrion.ts`,
   `matcher.ts`、`config.ts`、`browser.ts` 都只使用本地再导出的名字。
4. 变换是纯改写:无全局状态(除 `programNames` WeakMap 与 identity 的
   manifest 缓存),多次执行同一文件得到相同结果。
5. 身份解析不依赖包管理布局或模块格式(ESM/CJS 均可),只依赖最近的
   `package.json`。
