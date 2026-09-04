# Stent transform 层 API

> 配套文档:[transform-architecture.md](transform-architecture.md)。
> 本文档逐项说明 `packages/stent/src/transform` 中可导入的符号:签名、参数、
> 返回值、抛错条件。文件引用使用 project-root 路径;源码 import 示例仍相对于
> `packages/stent/src/transform/`。

## 0. 模块与导入

| 模块 | 职责 | 导入形态 |
|---|---|---|
| `types.ts` | 静态契约类型 | `import type { ... } from './types.ts'` |
| `ast-types.ts` | 命中函数/名称分配内部类型 | `import type { ... } from './ast-types.ts'` |
| `arguments.ts` | `arguments` 扫描与名称分配 | `import { mapOuterArguments } from './arguments.ts'` |
| `patterns.ts` | 函数/参数 pattern AST 辅助 | `import { matchFunction } from './patterns.ts'` |
| `statements.ts` | 注入语句 AST 构造 | `import { createCallStatement } from './statements.ts'` |
| `validation.ts` | 描述符守卫 | `import { validatePatchId } from './validation.ts'` |
| `config.ts` | patch → instrumentation 翻译 | `import { expandPatchStub } from './config.ts'` |
| `orchestrion.ts` | 第三方适配边界 | `import { createOrchestrion } from './orchestrion.ts'` |
| `matcher.ts` | matcher 操作 | `import { createStentMatcher } from './matcher.ts'` |
| `transform.ts` | 自定义变换注册 | `import { registerStentTransform } from './transform.ts'` |
| `identity.ts` | 身份解析 | `import { resolvePackageIdentity } from './identity.ts'` |
| `wire.ts` | RegExp 序列化 | `import { serializeInstrumentation } from './wire.ts'` |
| `protocol.ts` | 全局协议常量 | `import { GLOBAL_BRIDGE_KEY } from './protocol.ts'` |
| `browser.ts` | 浏览器 transform 工厂 | `import { createBrowserTransform } from './browser.ts'` |
| `index.ts` | 统一导出边界(具名导出,只含包内实际使用的符号) | `import { createStentMatcher } from './index.ts'` |

注意:本层属于包内实现细节,不是 `@oh-my-dsh/stent` 的公开导出面;`package.json`
未暴露 `./transform` 子路径。包内代码引用本层时使用显式 `.ts` 扩展名。

`index.ts` 不用 `export *`,而是按**包内实际消费面**逐符号具名导出。清单的判定
规则:transform 之外任何包内模块(loader、hook-entry、browser 入口、serve、
bridge、runtime、包公共类型面)直接 import/export 的符号才进入统一导出;纯内部
依赖的符号留在各自子模块。

| 模块 | 从 `index.ts` 可导入 |
|---|---|
| `browser.ts` | `createBrowserTransform`、`createInstrumentedTransform`、`createWatchedBrowserTransform`、`repoSourceResolver`、`BrowserTransform`、`BrowserTransformOptions`、`IdentityResolver`、`ModuleIdentity`、`RepoSourceResolverOptions`、`TransformOutput`、`WatchedBrowserTransform`、`WatchedBrowserTransformOptions` |
| `config.ts` | `expandPatchStub`、`StentInstrumentationConfig` |
| `identity.ts` | `resolvePackageIdentity`、`PackageIdentity` |
| `matcher.ts` | `createStentMatcher`、`getStentTransformer`、`orderStentInstrumentations`、`transformStentSource`、`StentMatcher`、`StentTransformer` |
| `protocol.ts` | `GLOBAL_BRIDGE_KEY` |
| `validation.ts` | `validatePatchId`、`validatePatchStatic` |
| `types.ts` | `PatchId`、`StentBinding`、`StentBindingReport`、`StentFunctionKind`、`StentFunctionQuery`、`StentOperation`、`StentPatchStub`、`StentTarget` |
| `wire.ts` | `reviveInstrumentation`、`serializeInstrumentation`、`StentWireInstrumentation` |

**不从 `index.ts` 导出**(实现专用,按需从子模块直接导入):

| 符号 | 所在模块 | 内部使用者 |
|---|---|---|
| `createOrchestrion`、`InstrumentationConfig`、`InstrumentationMatcher`、`Transformer` | `orchestrion.ts` | `config.ts`、`transform.ts`、`matcher.ts` |
| `registerStentTransform` | `transform.ts` | `matcher.ts` |
| `orderInstrumentations` | `config.ts` | `matcher.ts`(经 `orderStentInstrumentations` 暴露) |
| `detectModuleType` | `identity.ts` | `browser.ts` |

## 1. 类型契约(types.ts)

### `StentFunctionKind`

```ts
export type StentFunctionKind = 'Sync' | 'Async' | 'Callback' | 'Auto'
```

名字查询的函数执行模式 metadata。name-query config 会在 expansion 后保留四种
上游模式以兼容其类型;若 `target.astQuery` 存在,`config.ts` 只传 `{ index }`,不携带
`kind`。即使存在,Stent 自定义 transform (`transform: 'stent'`) 也不由 `kind` 驱动选择
逻辑(选择器不读取它),而依据匹配 AST 的实际 flags 与 patch operation。

### `StentFunctionQuery`

```ts
export type StentFunctionQuery =
  | { className: string; methodName: string; kind: StentFunctionKind; index?: number | null; isExportAlias?: boolean }
  | { className: string; privateMethodName: string; kind: StentFunctionKind; index?: number | null }
  | { className: string; index?: number | null; isExportAlias?: boolean }
  | { methodName: string; kind: StentFunctionKind; index?: number | null }
  | { functionName: string; kind: StentFunctionKind; index?: number | null; isExportAlias?: boolean }
  | { expressionName: string; kind: StentFunctionKind; index?: number | null; isExportAlias?: boolean }
```

6 种形状镜像上游 Orchestrion 的 `FunctionQuery` 联合类型,但 Stent 自己的选择器
构造只实现 `methodName`、`privateMethodName`、`functionName`、`expressionName` 四个键。
具体生成的 selector 形状是: `methodName`/`privateMethodName` 匹配 class/object 的
method/property value;`functionName` 匹配 `FunctionDeclaration` 以及以该 name 初始化的
`FunctionExpression`/`ArrowFunctionExpression`;`expressionName` 匹配命名的
`FunctionExpression`/`ArrowFunctionExpression` 及同样的 `VariableDeclarator` 形状。
当前没有 `AssignmentExpression` 形态的 selector,所以 `x = function () {}` 不会被
这两个 name query 自动选中。
带 `className` 的组合查询不会按类名缩小范围,纯 `className` 查询会触发 §4 的
`unsupported functionQuery shape`;`isExportAlias` 也不会被当前生成的显式 `astQuery`
解析。需要类/别名精确匹配时,`astQuery` 必须直接选中可变换的函数、方法或属性
节点,不能只选 `ClassDeclaration`/`ClassExpression`。
`index` 缺省或 `null` 改写全部匹配;非负整数只改写第 N 个。这里的“缺省 = 全部”是
public stub 经 `expandPatchStub` 归一化后的保证;直接构造低层
`StentInstrumentationConfig` 时应显式设置 `functionQuery.index: null` 才能请求全部
匹配,否则上游默认首个匹配。`astQuery` 分支只读取 `target.index`。
所有名字选择器都带 `[async]` 属性选择器;ESTree 函数节点同时拥有 `async: false`
和 `async: true` 属性,所以它不是 async-only 过滤器,`kind` 也不会改变选择结果。

### `StentTarget`

```ts
export interface StentTarget {
  module: string
  versionRange: string
  filePath?: string | RegExp
  filePaths?: string[]
  functionQuery?: StentFunctionQuery
  astQuery?: string
  index?: number | null
}
```

| 字段 | 说明 |
|---|---|
| `module` | npm 包名,与解析出的模块身份匹配(非空 string) |
| `versionRange` | 拥有的包版本需满足的 semver 范围(这里只检查非空,不解析 grammar) |
| `filePath` | 交给 matcher 的字面 string/RegExp 路径(调用约定通常相对包根);不做相对化/规范化/traversal 检查,空 string/绝对路径/`..`/空白均可能通过(与 `filePaths` 二选一) |
| `filePaths` | 非空 string 路径数组(通常相对包根,不做规范化/traversal 检查),`expandPatchStub` 每项展开为独立 instrumentation,重复项保留 |
| `functionQuery` | 名字驱动的函数查询;当前只支持四个 name 字段,详见上文 |
| `astQuery` | 原始 esquery 选择器,优先于 `functionQuery`;语法可能延迟到变换期解析。它必须最终选中函数/方法/属性节点,且 selector 应排除 Stent 注入的 replay closure;过宽的 `FunctionExpression` 等 selector 可能在同一次可变 AST 遍历中再次命中生成闭包,导致递归改写或超时 |
| `index` | 裸 `astQuery` 的直接匹配索引;`null`/缺省(经 public stub expansion 归一化) = 全部,名字查询使用 `functionQuery.index`;选择方式确定后另一字段即使通过静态校验也会被忽略 |

### `PatchId` / `StentOperation`

```ts
export type PatchId = string
export type StentOperation = 'before' | 'after' | 'around' | 'replace'
```

`PatchId` 会嵌入生成代码与诊断信息,须满足
`/^[A-Za-z0-9._:/+-]{1,120}$/`(`validatePatchId` 强制)。

`StentOperation` 决定 runtime dispatch: `before` 先让 handler 改 arguments 再 invoke,
`after` 先等待 thenable 结果 settlement,再把 settled value 交给 handler;handler 可返回
任意 replacement,不必返回 Promise,也可修改 `call.result` 并返回 `undefined`。
`around` 与 `replace` 都由 handler 决定是否调用 `invoke`。对 thenable 原调用,dispatch
仍返回一个承接 handler 结果的 Promise。生成的 call object 也带 operation,但 dispatch
以 runtime entry 的 operation 为准。

### `StentPatchStub`

```ts
export interface StentPatchStub {
  id: PatchId
  target: StentTarget
  operation: StentOperation
  required?: boolean
  priority?: number
}
```

静态 patch 描述符:Node 与 browser 变换入口共同的输入。`required: true` 会在 public stub 校验时检查,但 `expandPatchStub` 不把它写入
`StentInstrumentationConfig`;它只由 Node runtime 的 required 检查使用,browser transform
不执行该检查。
`priority` 缺省为 0,配置按升序排列,所以高优先级包裹在外层;进入 handler 时通常
先执行,但 `after` 在结果回退时后执行。相同 priority 在同一个静态数组中保持输入序,
具体 Node 动态快照的相同 priority 顺序由 runtime 的 patch id 排序决定。

### `StentBinding` / `StentBindingReport`

```ts
export interface StentBinding {
  module: string
  file: string
  nodes: number
}
export interface StentBindingReport extends StentBinding {
  patchId: PatchId
}
```

一个被变换文件的绑定记录:`nodes` 是成功改写的函数节点数,由 `onMatch` 每次改写累加。
`StentBindingReport` 额外携带 `patchId`,是 transform 回调计数与运行时
`recordBindings` 之间的数据形状。browser 输出只在本次调用确实改写节点时附带
`bindings`;Node 的运行时记录会在重新变换时继续追加,不应当作全局去重集合。

## 2. 验证守卫(validation.ts)

### `validatePatchId(id: PatchId): void`

id 必须匹配 `/^[A-Za-z0-9._:/+-]{1,120}$/`,否则抛
`stent: patch id ... must be 1-120 chars of [A-Za-z0-9._:/+-]`。TypeScript 类型要求
string,但守卫本身调用 `RegExp.test` 而不先检查 typeof,所以直接从 JavaScript 传入的
非字符串可能被强制转换而通过(例如 `123`);后续要求字符串 metadata 的阶段仍可能失败。
`expandPatchStub` 调用该守卫;`packages/stent/src/runtime.ts` 也再导出它。低层
`patchInstrumentation` 假定调用方已完成校验,不会自行校验 id。

### `validatePatchStatic(patch: Pick<StentPatchStub, 'target' | 'operation' | 'required'>): void`

静态字段校验,失败抛 `stent: ...`:

- `target.module` 为非空字符串;
- `target.versionRange` 为非空字符串(不解析 semver 语法);
- `filePath` 与 `filePaths` 必须恰有其一:`filePath` 为 string/RegExp,
  `filePaths` 为非空字符串数组;两者同时存在抛错。这里的 path 是交给 matcher
  的字面值,调用约定通常是相对包根路径,但守卫不做相对化、规范化或 traversal
  安全检查;绝对路径、`..`、空白路径和单个空字符串不会因这些形状检查而被拒绝。
- `required` 若提供必须是 boolean;
- `target.index` 与 `target.functionQuery?.index` 必须是非负整数或 null;
- `operation` ∈ `['before', 'after', 'around', 'replace']`。

这是静态字段的部分守卫,不检查 patch id、priority、handler、query 是否存在或形状
是否可生成,也不解析 `astQuery`。`expandPatchStub` 会另行调用 `validatePatchId` 并
构造 query;原始 selector 的语法通常到匹配模块实际变换时才由 Orchestrion 解析。

## 3. 常量(protocol.ts)

### `GLOBAL_BRIDGE_KEY`

```ts
const GLOBAL_BRIDGE_KEY = '__stentBridge'
export { GLOBAL_BRIDGE_KEY }
```

变换代码调用的全局桥句柄名:
`globalThis['__stentBridge'].publish(call)`。本常量同时被
`packages/stent/src/bridge.ts`(安装句柄)、`packages/stent/src/index.ts`(公开再导出)与
`packages/stent/src/transform/transform.ts`(生成 `globalThis[...]` 引用)引用。

## 4. 配置翻译(config.ts)

### `StentInstrumentationConfig`

```ts
export type StentInstrumentationConfig = InstrumentationConfig & {
  stentPatchId: string
  stentOperation: string
  stentPriority: number
  transform: 'stent'
  astQuery: string
}
```

Orchestrion 配置与 Stent 桥接字段的合并形状,仅供包内适配器使用。`stentPatchId`/
`stentOperation` 是自定义 transform 从 `state` 里读取的宽泛 string;正常入口会先
校验 patch,但直接构造该内部类型可以绕过校验。`stentPriority` 来自 patch(缺省 0),
`transform: 'stent'` 指定 custom transform 名。

### `expandPatchStub(patch: StentPatchStub): StentInstrumentationConfig[]`

把静态 patch 展开为一个或多个 instrumentation:

- `target.filePaths` 存在 → 每个路径一份(展开 target 一层,替换 `filePath`,共享
  patch 其余字段);
- 否则 → 单份;
- 若 `filePath` 缺失(且无 filePaths)→ 抛
  `stent: patch target.filePaths must be expanded before instrumentation (use expandPatchStub)`。

每份先由 `expandPatchStub` 调用 `validatePatchId` 与 `validatePatchStatic`,再交给
`patchInstrumentation` 构建;空 `astQuery` 在构建时抛错(`stent: patch target astQuery
must not be blank`),结果形状为:

```ts
{
  channelName: patch.id,                    // 诊断通道名 = patch id
  module: { name, versionRange, filePath },
  astQuery: target.astQuery ?? queryFromFunction(patch),
  functionQuery: target.functionQuery && !target.astQuery
    ? { ...target.functionQuery, index: target.functionQuery.index ?? null }
    : { index: target.index ?? null },      // astQuery 时只传裸查询 index
  transform: 'stent',
  stentPatchId, stentOperation, stentPriority: patch.priority ?? 0,
}
```

`queryFromFunction`(内部)在 `target` 既无 `functionQuery` 也无 `astQuery` 时抛
`stent: patch target must carry functionQuery or astQuery`;只识别 methodName /
privateMethodName / functionName / expressionName,名称未经 esquery 转义直接插值。
`className` 不会缩小 method selector,纯 `className` 形状抛
`stent: unsupported functionQuery shape`;`isExportAlias` 因显式 `astQuery` 优先而
不生效。若要精确处理类中函数或别名,raw `astQuery` 必须选中函数/方法/属性节点,
不能只选 class 节点。生成的 `[async]` 是属性存在性测试,plain 与 async 函数都会匹配。
原始 selector 会直接交给上游的可变 AST traversal。不要使用会同时匹配 Stent 生成的
匿名 replay `FunctionExpression`/其他注入节点的宽泛 query(例如裸
`FunctionExpression`);它可能在同一次遍历中反复改写新闭包。请用精确的 name、祖先
或函数形状谓词排除生成 scaffolding,并为 raw query 添加递归/超时测试。

### `orderInstrumentations(instrumentations: readonly StentInstrumentationConfig[]): StentInstrumentationConfig[]`

按 `stentPriority` 升序排序(返回新数组,不改入参)。升序是因为后续包装会让高优先级
位于最外层:在 `before`/`around`/`replace` 进入时通常先执行,而 `after` 在回退
结果时后执行。单个静态数组的相同 priority 保持输入序;单个 active Node 动态快照由
runtime 按 patch id 排序,不存在可观察的跨 active-installation 嵌套。

## 5. matcher 操作(matcher.ts,orchestrion.ts)

### 再导出(orchestrion.ts)

```ts
export { createOrchestrion }            // create(configs, dc_module?) → InstrumentationMatcher
export type { InstrumentationConfig, InstrumentationMatcher, Transformer }
```

这是对 `@apm-js-collab/code-transformer` 的唯一直接适配点,本层其余模块只用
本地名字。`StentMatcher`/`StentTransformer` 保留上游的 `addTransform`、
`getTransformer`、`transform` 与 `free` 方法。当前 Node loader 在 snapshot 刷新/卸载时
只释放它跟踪的 selected transformer(主要是 ESM 路径),不调用 `matcher.free()`; browser
与 watched factory 没有显式 disposer,旧 matcher 在不再被引用后交给 GC。直接使用这些
低层符号的调用方才应按上游 API 自行管理生命周期。

### `StentMatcher` / `StentTransformer`

```ts
export type StentMatcher = InstrumentationMatcher
export type StentTransformer = Transformer
```

### `orderStentInstrumentations(instrumentations): StentInstrumentationConfig[]`

`orderInstrumentations` 在 matcher 层的别名包装,同样返回新数组,不改变入参。

### `createStentMatcher(instrumentations: readonly StentInstrumentationConfig[], onMatch?: (patchId: string) => void): StentMatcher`

1. 对传入配置复制并由 `orderStentInstrumentations` 升序排序;
2. `createOrchestrion` 创建上游 matcher;
3. `registerStentTransform(matcher, onMatch)` 注册 `'stent'` custom transform。

`onMatch` 只在**每个真正被改写的节点**上触发一次,带该节点的 patch id——Node
loader 与 `createInstrumentedTransform` 把它累加为 per-file/per-patch 计数。matcher
及其返回的 transformer 的生命周期由 adapter 语境决定;直接使用低层符号的调用方可按
上游 API 调用 `free()`。当前 Node/browser adapter 的实际释放行为见上文,不要从
Node matcher cache 中单独释放仍会复用的 transformer。

### `getStentTransformer(matcher, moduleName, version, filePath): StentTransformer | undefined`

`matcher.getTransformer(...)` 包装:模块身份(包名、版本、包相对路径)命中
instrumentation 时返回上游 transformer,否则 `undefined`;直接低层调用方须自行安排
其释放,而 adapter 返回的对象由 adapter 的 matcher cache 持有。

### `transformStentSource(transformer, source, moduleType: 'esm' | 'cjs'): { code: string; map?: string }`

`transformer.transform(source, moduleType)` 包装;`map` 为 `undefined` 时省略该键。
调用期间的上游 parser、selector 或注入失败会原样抛出;找不到注入点不是这里的
`null` 信号。

### `registerStentTransform(matcher: InstrumentationMatcher, onMatch?: (patchId: string) => void): void`

`matcher.addTransform('stent', ...)`。回调从合并 state 读取
`state.stentPatchId`/`state.stentOperation`(非字符串即抛
`stent: transform config must carry stentPatchId and stentOperation strings`),
然后调用 `transformMatchedFunction(patchId, operation, node, parent, ancestry)`;
该内部函数返回是否改写,成功时包装器才触发 `onMatch`。上游的 custom transform
签名本身返回 `void`,Stent 的 boolean 只用于内部计数;注册本身不遍历 AST,
metadata/constructor 等错误只会在后续 `transformer.transform()` 命中节点时发生。

### AST/ESTree 辅助模块(`ast-types.ts`、`arguments.ts`、`patterns.ts`、`statements.ts`)

这些符号主要供 `transform.ts` 使用,不是 package public API:

- `MatchedFunction` 把 `FunctionDeclaration`、`FunctionExpression`、
  `ArrowFunctionExpression` 的 node/body/params/async/generator/arrow 归一化;
  `NameAllocator.unique(base)` 在同一 Program 的标识符集合中返回 `base` 或
  `base_N`,并保留每个结果。
- `mapOuterArguments(node, name?)` 结构化扫描 `arguments` 标识符。普通函数与
  带 `arguments` 参数的箭头是边界,`Property`/`MethodDefinition` 的全部 key
  (computed 或非 computed)以及非 computed member property 都会跳过;传 `name`
  时就地改写命中的标识符。这不是完整的 lexical-scope resolver,不会可靠处理
  局部声明;computed property/method key 也完全不会被扫描。
- `namesOf(program)` 为一个 Program 提供复用的 allocator;所有注入名字共享其
  集合,避免遮蔽文件内标识符。
- `isConstructorTarget(node, parent)` 只检测 constructor 形状;
  `matchFunction(node)` 解包 method/property 的 `value`,不支持的 node 或参数
  绑定 `arguments` 的箭头返回 `undefined`,但它自身不拒绝 constructor。
- `patternToExpression(pattern)` 为箭头生成 synthetic arguments array 的元素。
  支持 identifier、default、rest、object/array pattern;解构结果是局部部分副本,
  computed destructuring key 会再次求值,因此副作用 key 需要调用方避免。
- `statements.ts` 的 `createOuterArgumentsCapture`、`createArgumentsStatement`、
  `createTracedStatement`、`createCallStatement`、`createPublishStatement`、
  `createInjectedStatements` 按顺序构造 AST:普通函数使用
  `Array.prototype.slice.call(arguments)`,箭头使用 pattern array;traced closure
  用匿名 async/generator function 的 `.apply(this, args)` 重放 body;call builder
  不校验自由形式的 `operation`。普通函数的 body 被移入内层 closure,因此
  `arguments.callee`/`arguments.caller` 等非严格模式 introspection 观察到的
  identity 可能改变;普通参数或局部声明若遮蔽 `arguments` 也不受支持。
  `globalThis[GLOBAL_BRIDGE_KEY]` 为 falsy 时走
  traced fallback,truthy 但形状错误的 bridge 仍会抛错;生成代码依赖未被遮蔽的
  `arguments`、`Array`、`Symbol` 与 `globalThis`。
- generator 的 publish builder 对非 null 且可迭代结果生成 `yield*`(异步 generator
  同时检查 sync/async iterator),否则直接 return 结果。`after` 因此在 generator
  开始迭代前观察 generator object,不能在 yield 之间拦截。

## 6. 身份解析(identity.ts)

### `PackageIdentity`

```ts
export interface PackageIdentity {
  name: string      // npm 包名
  version: string   // 包版本
  path: string      // 相对包根路径(正斜杠)
}
```

### `resolvePackageIdentity(urlOrPath: string): PackageIdentity | undefined`

`file:` URL 会先转成本地路径,再自文件所在目录向上找最近的 `package.json`。
manifest 的 name/version 按根目录做进程级缓存(包含失败读取);无根目录、不可读/损坏
manifest 或缺少字符串 `name` 时返回 `undefined`;缺少 string `version` 时返回空字符串,
已有的任何 string version(即使不是有效 semver)则原样保留。
无效的 `file:` URL 转换可能抛错;普通相对字符串也会被实现接受,但调用方应提供
文件系统路径。

### `detectModuleType(id: string): 'esm' | 'cjs'`

只有 id 字面量以 `.cjs` 结尾时返回 `'cjs'`;`.mjs`、`.js`、`.cts` 以及带 query
后缀的 id 都回退为 `'esm'`。Node loader 以 loader context 的 format 为准,因此
browser/build resolver 应传入与该启发式相容的 id。

## 7. 序列化(wire.ts)

### `StentWireInstrumentation`

```ts
export interface StentWireInstrumentation extends Omit<StentInstrumentationConfig, 'module'> {
  module: Omit<StentInstrumentationConfig['module'], 'filePath'> & {
    filePath: string | { stentRegexp: [source: string, flags: string] }
  }
}
```

JSON 安全形态:RegExp `filePath` 以 `{ stentRegexp: [source, flags] }` 表示。这只是
内存对象形状,helper 不负责 `JSON.stringify`/`JSON.parse`;字符串路径原样透传。
输入被视为可信的内部配置,不会执行 schema 校验;同一个内存 matcher 中带 `g`/`y` flag
的 RegExp 仍可能因上游 `.test` 的 `lastIndex` 而具有状态性,但 wire 只传 source/flags,
`reviveInstrumentation` 创建新 RegExp,所以跨 JSON 往返会重置且不保留 `lastIndex`。

### `serializeInstrumentation(config): StentWireInstrumentation`

RegExp `filePath` → `stentRegexp`;字符串路径原样返回(只在 RegExp 情况做浅复制),
不会执行 JSON 序列化。

### `reviveInstrumentation(config): StentInstrumentationConfig`

对象 `filePath` → `new RegExp(source, flags)`;字符串路径原样返回。输入不做 marker
schema 校验,因此缺失/为 null 的 marker 或非法 source/flags 会在读取属性或构造
RegExp 时抛错。

## 8. 浏览器 transform(browser.ts)

### `ModuleIdentity` / `IdentityResolver`

```ts
export interface ModuleIdentity {
  name: string
  version: string
  path: string            // 相对包根路径
}
export type IdentityResolver = (id: string) => ModuleIdentity | undefined
```

`IdentityResolver` 把 bundler 模块 id 映射为包身份;返回 `undefined` 跳过该模块。
resolver 的具体规范化由调用方负责,本层的 `repoSourceResolver` 只做原始前缀判断。

### `repoSourceResolver({ packageName, packageRoot, version }): IdentityResolver`

仓库源码解析器:凡以 `packageRoot/`(自动补尾斜杠)开头的 id,映射为该包的
`{ name: packageName, version, path: relative(packageRoot, id) }`。它只做原始
字符串前缀匹配,不处理 virtual id、URL query 或其他 bundler 标记;适用于仓库源码
布局的 client 插件构建。

### `TransformOutput`

```ts
export interface TransformOutput {
  code: string
  map?: string
  bindings?: StentBindingReport[]
}
```

`bindings` 仅在本次调用确实有节点被 Stent 改写时出现;数组元素是
`{ patchId, module: identity.name, file: identity.path, nodes }`,其中 `nodes` 是成功
改写节点数。

### `BrowserTransform` / `WatchedBrowserTransform`

```ts
export type BrowserTransform = (code: string, id: string) => TransformOutput | null
export type WatchedBrowserTransform = (
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null
```

`null` = resolver 或 module/file/version 没有 instrumentation,所以不改写;
`TransformOutput` = 找到 transformer 后的结果。找到 transformer 但 selector 在源代码中
没有可注入点时,上游通常抛 `Failed to find injection points`;若匹配到不支持的 AST
形状而没有实际改写,输出可能省略 `bindings`;若 selector 找到候选节点但给定
`index` 超出范围,同样会返回未改写的 output(通常无 `bindings`),不会因此抛
`Failed to find injection points`;Node 侧最终可由 required binding 检查发现该 miss。

### `BrowserTransformOptions` / `WatchedBrowserTransformOptions`

```ts
export interface BrowserTransformOptions {
  patches: readonly StentPatchStub[]
  resolve: IdentityResolver
}
export interface WatchedBrowserTransformOptions {
  patchesPath: string          // 待监视的 JSON patch stub 文件,相对/绝对均可
  resolve: IdentityResolver
}
```

### `createBrowserTransform({ patches, resolve }): BrowserTransform`

先执行 `patches.flatMap(expandPatchStub)` 再委托 `createInstrumentedTransform`。
输入是公开 patch stub;`RegExp filePath` 可在这里使用(不经过 JSON),而静态字段或
name-query 不能生成 selector 的错误会在工厂创建时抛出。`required` 会被 public stub
校验,但在 expansion 时丢弃;browser factory 不执行 Node 的 required 检查。

### `createInstrumentedTransform(instrumentations, resolve): BrowserTransform`

从**已展开**且可信的 instrumentation 构建 transform(loader 线程入口经
`reviveInstrumentation` 后使用此边界)。每次调用:

1. `resolve(id)` 无身份 → `null`;
2. `getStentTransformer` 无 transformer → `null`;
3. id 以 `.ts`/`.tsx` 结尾 → `stripTypes(code, id)`:经 `ts.transpileModule` 编译为 JS
   (只 emit、不 type-check;module: ESNext、target: ES2022、moduleResolution: Bundler、
   jsx: ReactJSX,会处理 JSX 与 TypeScript 语法;`.mts`/`.cts` 不在此分支;
   transformer map 不会链接回原始 TS);
4. `transformStentSource(transformer, source, detectModuleType(id))`;
5. per-call `pending` map 统计真正改写的节点后生成 `bindings`。

解析、selector、注入或 custom transform 错误会在 transform callback 调用期间抛出,
不会转换为 `null`;过宽的 raw `astQuery` 还可能再次命中生成的 replay
`FunctionExpression`,造成递归改写或超时,所以必须排除注入 scaffolding。

### `createWatchedBrowserTransform({ patchesPath, resolve }): WatchedBrowserTransform`

这是 browser dev 构建用的变体:每次 transform 调用都会
`addWatchFile?.(patchesPath)`、同步重读文件;首次调用或内容变化时才重建底层 matcher,
因此文件只放静态 patch stub;JSON 不能表达 RegExp,所以
序列化 descriptor 中的 path 值必须是 string,但 `filePaths: string[]`
仍会在重建时展开支持。外层只检查数组和 object target,其余字段交给重建时的
`createBrowserTransform`。是否触发 bundle rebuild 取决于宿主打包器是否遵守
`addWatchFile` 并接通自己的 watcher/HMR 链。

### `serveBrowserTransform(ctx, options): () => void`(`packages/stent/src/browser/serve.ts`)

当目标 bundle 不能在构建期经过 bundler transform 时,通过 `@oh-my-dsh/stent/browser`
注册一个 exact webserver route,按请求读取并变换 bundle。`options` 至少包含
`route`、`patches`、可选 `fallback: 'error' | 'raw'`;所有 patch 必须带同一个具体
string `filePath` 并指向同一 module/file,不能用 `filePaths` 或 RegExp。目标包经
`ctx.baseUrl` 的 Loader composition anchor 解析,不是 Stent 自身依赖树;matcher 在
注册时创建,输出按源内容缓存。默认任一 patch 没有 binding 或变换抛错即返回 500,
`fallback: 'raw'` 才返回原 bundle。路由属于当前 fiber,返回 disposer 可立即移除它;
仅 GET/HEAD 被服务,其他方法 405,目标 bundle 不可读 404。每次调用只注册一条 exact
route;要让多个插件 patch 同一 bundle,必须由一个 route owner 聚合 descriptors,
否则独立调用会因重复 route 注册被 webserver 拒绝。

### Browser 静态构建

```ts
import {
  createBrowserTransform,
  repoSourceResolver,
} from './transform/browser.ts'

const transform = createBrowserTransform({
  patches: [
    {
      id: 'my-vendor/rewrite-greeting',
      target: {
        module: '@example/target-package',
        versionRange: '^1.0.0',
        filePaths: ['src/chat.ts', 'src/chat2.ts'],
        functionQuery: { functionName: 'greet', kind: 'Sync' },
      },
      operation: 'before',
    },
  ],
  resolve: repoSourceResolver({
    packageName: '@example/target-package',
    packageRoot: '/repo/packages/group/target-package',
    version: '1.2.3',
  }),
})

const out = transform(code, '/repo/packages/group/target-package/src/chat.ts')
// out?.bindings → [{ patchId: 'my-vendor/rewrite-greeting', module: ..., file: 'src/chat.ts', nodes }]
```

### watcher 变体

```ts
const watched = createWatchedBrowserTransform({
  patchesPath: '/repo/packages/group/target-package/stent.patches.json',
  resolve: repoSourceResolver({ packageName: '...', packageRoot: '...', version: '...' }),
})
// clientBundle(id, libEntry, { transform: watched })
```

### Node loader 的等价链路(源码阅读)

```ts
// packages/stent/src/loader/loader.ts 内部:
const instrumentations = orderStentInstrumentations(
  runtime.list().flatMap((info) => expandPatchStub(patchStubFromInfo(info))),
)
const matcher = createStentMatcher(instrumentations, (patchId) => { /* 计数 */ })
// 模块加载时:
const transformer = getStentTransformer(matcher, identity.name, identity.version, identity.path)
const { code } = transformStentSource(transformer, source, moduleType)
```

## 10. 与公开面的对应关系

| Browser entry symbols | 公开入口 |
|---|---|
| `createBrowserTransform`、`createWatchedBrowserTransform`、`repoSourceResolver`、`resolvePackageIdentity`、`serveBrowserTransform` 及配套类型 | `@oh-my-dsh/stent/browser` |
| `GLOBAL_BRIDGE_KEY` | `@oh-my-dsh/stent`(经 `packages/stent/src/index.ts` ← `packages/stent/src/bridge.ts` 再导出) |
| `validatePatchId`、`validatePatchStatic` | `@oh-my-dsh/stent`(经 `packages/stent/src/index.ts` ← `packages/stent/src/runtime.ts` 再导出) |
| `PatchId`、`StentBinding`、`StentBindingReport`、`StentFunctionKind`、`StentFunctionQuery`、`StentOperation`、`StentPatchStub`、`StentTarget` | `@oh-my-dsh/stent`(经 `packages/stent/src/index.ts` ← `packages/stent/src/types.ts` 类型再导出) |
| `createInstrumentedTransform` | 仅包内(`packages/stent/src/loader/hook-entry.ts` 使用,不走公开面) |
| `createStentMatcher`、`getStentTransformer`、`orderStentInstrumentations`、`transformStentSource`、wire 序列化 | 仅包内(`packages/stent/src/loader/*` 直接导入,不走公开面) |

`index.ts` 本身不是公开入口:它只汇总包内消费面,`@oh-my-dsh/stent` /
`@oh-my-dsh/stent/browser` 的导出以本表为准。`orchestrion.ts` 的第三方适配
(`createOrchestrion` 及类型)在任何公开面都不出现。
