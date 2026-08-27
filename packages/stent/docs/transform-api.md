# Stent transform 层 API

> 配套文档:[transform-architecture.md](transform-architecture.md)。
> 本文档逐项说明 `packages/stent/src/transform` 中可导入的符号:签名、参数、
> 返回值、抛错条件。所有示例路径相对于 `src/transform/`。

## 0. 模块与导入

| 模块 | 职责 | 导入形态 |
|---|---|---|
| `types.ts` | 静态契约类型 | `import type { ... } from './types.ts'` |
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
| `createOrchestrion`、`CustomTransform`、`InstrumentationConfig`、`InstrumentationMatcher`、`Transformer` | `orchestrion.ts` | `config.ts`、`transform.ts`、`matcher.ts` |
| `registerStentTransform` | `transform.ts` | `matcher.ts` |
| `orderInstrumentations` | `config.ts` | `matcher.ts`(经 `orderStentInstrumentations` 暴露) |
| `detectModuleType` | `identity.ts` | `browser.ts` |

## 1. 类型契约(types.ts)

### `StentFunctionKind`

```ts
export type StentFunctionKind = 'Sync' | 'Async' | 'Callback' | 'Auto'
```

函数执行模式。随 `functionQuery` 保留在 wire 配置中;Stent 自定义 transform
(`transform: 'stent'`)路径下不驱动选择逻辑(见 `config.ts#queryFromFunction`,
选择器不读取 `kind`)。

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

6 种形状对应上游 Orchestrion 的 `FunctionQuery`:类方法(`methodName`)、类私有
方法(`privateMethodName`)、纯类(`className`,只带 `index`/`isExportAlias`)、
顶层方法(`methodName`)、函数(`functionName`)、命名表达式(`expressionName`)。
`index` 缺省或 `null` 改写全部匹配;非负整数只改写第 N 个。生成选择器时
`queryFromFunction` 只识别 methodName / privateMethodName / functionName /
expressionName 四类键——纯 `className` 变体与 `isExportAlias` 不进入 Stent 自己的
选择器构造(前者会触发 §4 的 `unsupported functionQuery shape`);所有生成的
选择器都带 `[async]` 过滤器,即名字查询只命中 **async 函数节点**。

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
| `module` | npm 包名,与解析出的模块身份匹配 |
| `versionRange` | 拥有的包版本需满足的 semver 范围 |
| `filePath` | 相对包根的单个路径或 RegExp(与 `filePaths` 二选一) |
| `filePaths` | 相对包根的路径数组,`expandPatchStub` 展开为独立 instrumentation |
| `functionQuery` | 名字驱动的函数查询 |
| `astQuery` | 原始 esquery 选择器,优先于 `functionQuery` |
| `index` | 直接匹配索引(裸 `astQuery` 用);`null`/缺省 = 全部 |

### `PatchId` / `StentOperation`

```ts
export type PatchId = string
export type StentOperation = 'before' | 'after' | 'around' | 'replace'
```

`PatchId` 会嵌入生成代码与诊断信息,须满足
`/^[A-Za-z0-9._:/+-]{1,120}$/`(`validatePatchId` 强制)。

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

静态 patch 描述符:Node 与 browser 变换入口共同的输入。`required: true` 表示
启动期必须观察到绑定;`priority` 是栈序键(缺省 0,高者先调用)。

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

一个被变换文件的绑定记录:`nodes` 是被改写的函数节点数。
`StentBindingReport` 额外携带 `patchId`,是 transform 回调计数与运行时
`recordBindings` 之间的数据形状。

## 2. 验证守卫(validation.ts)

### `validatePatchId(id: PatchId): void`

id 必须匹配 `/^[A-Za-z0-9._:/+-]{1,120}$/`,否则抛
`stent: patch id ... must be 1-120 chars of [A-Za-z0-9._:/+-]`。
被 `config.ts#patchInstrumentation` 与 `src/runtime.ts`(再导出)使用。

### `validatePatchStatic(patch: Pick<StentPatchStub, 'target' | 'operation' | 'required'>): void`

静态字段校验,失败抛 `stent: ...`:

- `target.module` 为非空字符串;
- `target.versionRange` 为非空字符串;
- `filePath` 与 `filePaths` 必须恰有其一:`filePath` 为 string/RegExp,
  `filePaths` 为非空字符串数组;两者同时存在抛错;
- `required` 若提供必须是 boolean;
- `target.index` 与 `target.functionQuery?.index` 必须是非负整数或 null;
- `operation` ∈ `['before', 'after', 'around', 'replace']`。

## 3. 常量(protocol.ts)

### `GLOBAL_BRIDGE_KEY`

```ts
export const GLOBAL_BRIDGE_KEY = '__stentBridge'
```

变换代码调用的全局桥句柄名:
`globalThis['__stentBridge'].publish(call)`。本常量同时被
`src/bridge.ts`(安装句柄)、`src/index.ts`(公开再导出)与
`transform.ts`(生成 `globalThis[...]` 引用)引用。

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

Orchestrion 配置与 Stent 桥接字段的合并形状。`stentPatchId`/`stentOperation`/
`stentPriority` 是自定义 transform 从 `state` 里读取的三元组(`transform.ts`),
`transform: 'stent'` 指定 custom transform 名。

### `expandPatchStub(patch: StentPatchStub): StentInstrumentationConfig[]`

把静态 patch 展开为一个或多个 instrumentation:

- `target.filePaths` 存在 → 每个路径一份(展开 target 一层,替换 `filePath`,共享
  patch 其余字段);
- 否则 → 单份;
- 若 `filePath` 缺失(且无 filePaths)→ 抛
  `stent: patch target.filePaths must be expanded before instrumentation (use expandPatchStub)`。

每份先经 `patchInstrumentation`:`validatePatchId` + `validatePatchStatic`,
空 `astQuery` 抛错(`stent: patch target astQuery must not be blank`),构建:

```ts
{
  channelName: patch.id,                    // 诊断通道名 = patch id
  module: { name, versionRange, filePath },
  astQuery: target.astQuery ?? queryFromFunction(patch),
  functionQuery: target.functionQuery && !target.astQuery
    ? { ...target.functionQuery, index: target.functionQuery.index ?? null }
    : { index: target.index ?? null },      // 无查询时作为 FunctionBehavior 行为包
  transform: 'stent',
  stentPatchId, stentOperation, stentPriority: patch.priority ?? 0,
}
```

`queryFromFunction`(内部)在 `target` 既无 `functionQuery` 也无 `astQuery` 时抛
`stent: patch target must carry functionQuery or astQuery`;`functionQuery` 形状
无法生成选择器时抛 `stent: unsupported functionQuery shape`(如只含 `className` 的
对象——该形状不带方法/函数/表达式名,生成器无法构造选择器)。

### `orderInstrumentations(instrumentations: readonly StentInstrumentationConfig[]): StentInstrumentationConfig[]`

按 `stentPriority` 升序稳定排序(返回新数组,不改入参)。高优先级 handler 先被
调用(包装在最外层),同优先级保持注册顺序。

## 5. matcher 操作(matcher.ts,orchestrion.ts)

### 再导出(orchestrion.ts)

```ts
export { createOrchestrion }            // create(configs, dc_module?) → InstrumentationMatcher
export type { CustomTransform, InstrumentationConfig, InstrumentationMatcher, Transformer }
```

这是对 `@apm-js-collab/code-transformer` 的唯一直接适配点,本层其余模块只用
本地名字。

### `StentMatcher` / `StentTransformer`

```ts
export type StentMatcher = InstrumentationMatcher
export type StentTransformer = Transformer
```

### `orderStentInstrumentations(instrumentations): StentInstrumentationConfig[]`

`orderInstrumentations` 在 matcher 层的别名包装。

### `createStentMatcher(instrumentations: readonly StentInstrumentationConfig[], onMatch?: (patchId: string) => void): StentMatcher`

1. `orderStentInstrumentations` 排序;
2. `createOrchestrion` 创建上游 matcher;
3. `registerStentTransform(matcher, onMatch)` 注册 `'stent'` custom transform。

`onMatch` 在**每个真正被改写的节点**触发一次,带该节点的 patch id——Node
loader 与 `createInstrumentedTransform` 把它累加为 per-file/per-patch 计数。

### `getStentTransformer(matcher, moduleName, version, filePath): StentTransformer | undefined`

`matcher.getTransformer(...)` 包装:模块身份(包名、版本、包相对路径)命中
instrumentation 时返回 transformer,否则 `undefined`。

### `transformStentSource(transformer, source, moduleType: 'esm' | 'cjs'): { code: string; map?: string }`

`transformer.transform(source, moduleType)` 包装;`map` 为 `undefined` 时省略该键。
上游 transform 在找不到注入点时**抛错**(其 miss 信号)。

### `registerStentTransform(matcher: InstrumentationMatcher, onMatch?: (patchId: string) => void): void`

`matcher.addTransform('stent', ...)`。回调从合并 state 读取
`state.stentPatchId`/`state.stentOperation`(非字符串即抛
`stent: transform config must carry stentPatchId and stentOperation strings`),
然后运行 `createStentTransform(patchId, operation)`;该函数对每个匹配节点返回
boolean(Orchestrion 的 `CustomTransform` 返回 `void`,Stent 用返回值作
"是否改写"信号,包装后触发 `onMatch`)。

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

`file:` URL 转路径后,自文件所在目录向上找最近的 `package.json`(首次解析后按
根目录缓存 name/version)。返回 `undefined` 的条件:找不到包根,或 manifest
无 `name` 字段。

### `detectModuleType(id: string): 'esm' | 'cjs'`

以 `.cjs` 结尾视为 `'cjs'`,其余视为 `'esm'`。

## 7. 序列化(wire.ts)

### `StentWireInstrumentation`

```ts
export interface StentWireInstrumentation extends Omit<StentInstrumentationConfig, 'module'> {
  module: Omit<StentInstrumentationConfig['module'], 'filePath'> & {
    filePath: string | { stentRegexp: [source: string, flags: string] }
  }
}
```

JSON 安全形态:RegExp `filePath` 以 `{ stentRegexp: [source, flags] }` 表示。

### `serializeInstrumentation(config): StentWireInstrumentation`

RegExp `filePath` → `stentRegexp`;字符串路径原样返回(类型断言透传)。

### `reviveInstrumentation(config): StentInstrumentationConfig`

对象 `filePath` → `new RegExp(source, flags)`;字符串路径原样返回。

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

### `repoSourceResolver({ packageName, packageRoot, version }): IdentityResolver`

仓库源码解析器:凡以 `packageRoot/`(自动补尾斜杠)开头的 id,映射为该包的
`{ name: packageName, version, path: relative(packageRoot, id) }`。适用于
`packages/<group>/<name>/src/...` 布局的 client 插件构建。

### `TransformOutput`

```ts
export interface TransformOutput {
  code: string
  map?: string
  bindings?: StentBindingReport[]
}
```

`bindings` 仅在被改写的模块上出现:数组元素是
`{ patchId, module: identity.name, file: identity.path, nodes }`。

### `BrowserTransform` / `WatchedBrowserTransform`

```ts
export type BrowserTransform = (code: string, id: string) => TransformOutput | null
export type WatchedBrowserTransform = (
  code: string,
  id: string,
  addWatchFile?: (file: string) => void,
) => TransformOutput | null
```

两类返回值:`null` = 模块未命中(不改写);`TransformOutput` = 改写结果。

### `BrowserTransformOptions` / `WatchedBrowserTransformOptions`

```ts
export interface BrowserTransformOptions {
  patches: readonly StentPatchStub[]
  resolve: IdentityResolver
}
export interface WatchedBrowserTransformOptions {
  patchesPath: string          // 待监视的 JSON patch stub 文件
  resolve: IdentityResolver
}
```

### `createBrowserTransform({ patches, resolve }): BrowserTransform`

`patches.flatMap(expandPatchStub)` 后委托 `createInstrumentedTransform`。
输入是公开 patch stub;`RegExp filePath` 可在此路径使用(不经过 JSON)。

### `createInstrumentedTransform(instrumentations, resolve): BrowserTransform`

从**已展开**的 instrumentation 构建 transform(loader 线程入口经
`reviveInstrumentation` 后使用此边界)。每次调用:

1. `resolve(id)` 无身份 → `null`;
2. `getStentTransformer` 无 transformer → `null`;
3. `/\.tsx?$/` 匹配 → `stripTypes(code, id)`:经 `ts.transpileModule` 编译为 JS
   (`module: ESNext`、`target: ES2022`、`moduleResolution: Bundler`、`jsx:
   ReactJSX` 自动运行时——现代 transform 的源码(无 React 导入)得到自包含的
   `react/jsx-runtime` 导入,经典运行时源码保留 `React.createElement` 调用;
   source map 不经过该步骤);
4. `transformStentSource(transformer, source, detectModuleType(id))`;
5. per-call `pending` map 统计后生成 `bindings`。

### `createWatchedBrowserTransform({ patchesPath, resolve }): WatchedBrowserTransform`

dev 热链路变体:每次调用 `addWatchFile?.(patchesPath)`、重读文件、仅内容变化时
重建底层 matcher(读-用-重建,与 loader 线程配置一致)。JSON 文件只放静态 patch
stub(`filePath` 恒为字符串);畸形条目在构建期大声失败
(`stent: watched patches file <path> ...`)。通过
`clientBundle(id, libEntry, { transform })` 接入后,patch 文件变更触发 bundle
重建并沿 client-hmr 链进入浏览器。

## 9. 端到端示例

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
// src/node/loader.ts 内部:
const instrumentations = orderStentInstrumentations(
  runtime.list().flatMap((info) => expandPatchStub(patchStubFromInfo(info))),
)
const matcher = createStentMatcher(instrumentations, (patchId) => { /* 计数 */ })
// 模块加载时:
const transformer = getStentTransformer(matcher, identity.name, identity.version, identity.path)
const { code } = transformStentSource(transformer, source, moduleType)
```

## 10. 与公开面的对应关系

| transform 导出 | 公开入口 |
|---|---|
| `createBrowserTransform`、`createWatchedBrowserTransform`、`repoSourceResolver`、`resolvePackageIdentity` 及配套类型 | `@oh-my-dsh/stent/browser` |
| `GLOBAL_BRIDGE_KEY` | `@oh-my-dsh/stent`(经 `src/index.ts` ← `src/bridge.ts` 再导出) |
| `validatePatchId`、`validatePatchStatic` | `@oh-my-dsh/stent`(经 `src/index.ts` ← `src/runtime.ts` 再导出) |
| `PatchId`、`StentBinding`、`StentBindingReport`、`StentFunctionKind`、`StentFunctionQuery`、`StentOperation`、`StentPatchStub`、`StentTarget` | `@oh-my-dsh/stent`(经 `src/index.ts` ← `src/types.ts` 类型再导出) |
| `createStentMatcher`、`getStentTransformer`、`orderStentInstrumentations`、`transformStentSource`、wire 序列化 | 仅包内(`src/node/*` 直接导入,不走公开面) |

`index.ts` 本身不是公开入口:它只汇总包内消费面,`@oh-my-dsh/stent` /
`@oh-my-dsh/stent/browser` 的导出以本表为准。`orchestrion.ts` 的第三方适配
(`createOrchestrion` 及类型)在任何公开面都不出现。
