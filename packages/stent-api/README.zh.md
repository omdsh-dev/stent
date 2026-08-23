# 协作式 Stent API 层

[English](README.md) | 中文

协作式 Mod API 拆分为两个包:纯 compat facade(`stent-api`)与面向宿主的模块(`stent-dsh`)。二者共同提供位于 loader 与 Mixin 子系统之上的 Stent 风格可选 API,默认宿主 composition 不挂载它们。

## 它做什么

Stent 风格扩展架构由三层组成。前两层已存在;这两个包是第三层:

| 层 | 所有者 | 契约 |
|---|---|---|
| Mod loader | Cordis Loader | 发现配置中的插件、解析注入、挂载 fiber 并销毁 effect。 |
| Mixin 子系统 | `stent` | 变换目标代码并分发受信任的底层 patch。 |
| 协作式 Mod API | `stent-api` + `stent-dsh` | 由现有宿主所有者支撑的稳定 domain-level registration 和 event。 |

Mod 仍然是普通 Cordis 插件,只声明它所消费的 Stent 模块 service 的注入。每个 facade 委托给权威 service——`ctx.tools`、`ctx.systemPrompt`、`ctx.commands`、`agent/*` 事件以及浏览器侧的 `ctx.command`/`ctx.slots`——并返回底层 effect 的精确 disposer。Facade 不保存 domain state 的平行副本,也不能绕过 policy、approval、timeout、日志、取消或权威 executor。底层 `getStent(ctx)` accessor 同样受启动能力门控:未声明依赖的代码在普通 `dsh` 下调用它会 loud failure,而不会挂载 registry。

## 包与模块

`stent-api` 是纯 Cordis peer 库(只依赖 Cordis 与 `stent`):

| Entry | Service | 平台 | 委托给 |
|---|---|---|---|
| `./compat/service` | `ctx.stentCompat` | Host | 低层 `stent` patch(缺口 adapter) |

`stent-dsh` 承载所有宿主耦合面(facade 通过真实 `@deepseek-ai/dsh-*` 类型转发给宿主,声明为 peer 依赖):

| Entry | Service | 平台 | 委托给 |
|---|---|---|---|
| `.`(Host bundle) | 挂载全部四个 Host 模块 | Host | 下方四个 entry |
| `./host/agent` | `ctx.stentAgent` | Host | `agent/*` 事件和 `agent.inject()` |
| `./host/tools` | `ctx.stentTools` | Host | `ctx.tools` 和 `tools/*` |
| `./host/prompt` | `ctx.stentPrompt` | Host | `ctx.systemPrompt` |
| `./host/commands` | `ctx.stentCommands` | Host | `ctx.commands` |
| `./browser/client` | `ctx.stentClient` | Web | `ctx.command` 和 `ctx.slots` |
| `./invariant` | invariant 伴生插件 | Host | 宿主 `invariants` service |
| `./bootstrap/profile` | `installStentBootstrap` | Host | 组合后的 profile rows → `stent` hooks |

`stent-dsh` 的 root entry 是标准 Host bundle；每个新的分层 subpath 都可以单独挂载，适合精简 composition。浏览器 entry 保留为 `./client`，因为 client-module 契约只发现这个固定 export；其实现位于 `src/browser/client`。旧的 Host 与 compat 平铺 subpath 已有意移除；请使用上方的分层入口，仓库不再提供兼容 re-export 模块。

## 安装

在权威 service 存在的位置挂载 Host bundle(或某个 subpath):

```ts
import * as stentDsh from '@oh-my-dsh/stent-dsh'
import type { Context } from 'cordis'

declare const ctx: Context
await ctx.plugin(stentDsh)
```

```yaml
# User overlay: enable the Host bundle row.
- id: stent-dsh
  disabled: false
```

Compat facade 是 peer 库,由 Mod 自行挂载(bundle patch 不添加 `stent-api` 行):

```ts
import { StentCompatService } from '@oh-my-dsh/stent-api/compat/service'
```

Mod 只声明它消费的模块:

```ts
import type { Context } from 'cordis'
import type { StentAgentService, StentPromptService } from '@oh-my-dsh/stent-dsh'

export const name = 'my-mod'
export const inject = ['stentAgent', 'stentPrompt']

export function apply(ctx: Context & { stentAgent: StentAgentService; stentPrompt: StentPromptService }): void {
  ctx.stentAgent.onStatus((agent, status) => {
    ctx.logger.info('agent %s is %s', agent.id, status)
  })
  ctx.stentPrompt.section({
    name: 'my-mod-identity',
    order: -80,
    text: 'my-mod is active',
  })
}
```

## 契约

每个 registration 都是 fiber effect:销毁贡献插件会移除贡献,与权威所有者的 disposal 语义一致(HMR-safe)。Facade 方法返回底层精确 disposer。

- **Agent API。** 生命周期观察(`onCreated`、`onDisposed`、`onStatus`)和操作局部 context injection(`inject`)的稳定子集。它不暴露具体 loop、私有队列状态或可变 session 内部;只有当权威事件本来就提供 live Agent 时,callback 才接收它。
- **Tool API。** 通过 `ctx.tools` 注册 tool 以及执行前后 listener。Stent tool 与原生宿主 tool 具有相同的 schema 和 result 义务,包括 model-visible logging 和 render intent。Waterfall listener 必须调用 `next()`,除非它有意否决。
- **Prompt API。** 通过 `ctx.systemPrompt` 注册有序 system section、可安全缓存的 context、tool-schema provider 和 prompt variable。没有插入未记录 model-visible 文本或直接组装 provider request 的捷径。
- **Command API。** 通过 `ctx.commands` 注册人类用户 command;除非权威契约启动 turn,否则 command 保持在 model turn 之外。
- **Compat API。** 低层补丁机制的协作式入口。两个面:`observe(name, listener)` 保留静态观察适配器(面向没有协作式扩展点的目标 domain;目标在模块 config 中声明,`buildCompatInstrumentations` 生成加载期 instrumentations,对外契约只暴露声明的目标名)。`registerPatch(patch)` / `unregisterPatch` / `disablePatch` / `enablePatch` 打开完整的运行时补丁面——handler 在运行时绑定到 launcher bootstrap 已安装的变换(profile 的 `config.stent.patches` 桩)——并带**排他的 id 命名空间**:已被声明的观察目标或更早的注册占用的 id 会失败即显式,且 facade 背后的低层注册表还会拒绝已被其他插件占用的 id,因此排他性跨 facade 实例成立。注册归挂载该 facade 的插件所有;`unregisterPatch` 会禁用**并移除** patch,释放 id 以开始全新的所有权周期。`serveBundle(options)` 暴露运行时浏览器 bundle 原语(`serveBrowserTransform`),bundle 重写也经协作式门面进入。所有面都校验 bridge installation capability(`isStentInstalled`),hooks 缺失时失败即显式。
- **Client API。** 通过 `ctx.command` 和 `ctx.slots` 注册 client command 和命名 UI slot。Slot registration face 刻意保持窄(`StentSlotOptions`):完整的 SlotMap 类型机制位于宿主 slot service,其声明合并只能看到每个 consumer 导入的包。`registerKeyedSlot(name, key, options, component)` 为 keyed 槽位增加**仲裁**:宿主不变式(每 key 一个属主、重复 loud)保持不变,但属主由声明的 `priority` 决定而非挂载时序——败者排队并在属主销毁时自动接管(`onGain`),更高优先级认领者接替在位者而不强制卸载它(`onLost` 通知它),同优先级保持注册序并告警。直接 `ctx.slots.register` 的用户仍得到宿主抛错。

Public surface 不导出 AST selector、模块文件路径、`StentPatch`、raw bridge handle,也不提供绕过 tool/command/prompt policy 的路径。底层 patch 仍然是 Mixin 子系统的 escape hatch,绝不是这一层契约的一部分。

## Profile bootstrap

`installStentBootstrap(rows)` 读取组合后 profile 的 `stent` 行,从 `config.stent.patches` 取得静态 patch 描述符,并在 boot `prepare` 阶段(任何目标插件模块导入之前)通过 `bootstrapStent` 安装。`checkStentRequiredPatches(rows)` 在 boot 完成后运行,当 `required` patch 未绑定任何内容时失败即显式。二者都从 `stent-dsh` 重新导出。

## 安全与信任模型

- 协作层可以比 `ctx.stent` 更广泛地授予,但不会自动提供给模型写入的临时插件:每个 facade 通过所属 service 触达真实进程能力,repository/temporary-plugin policy 显式授予模块。
- 缺失的必需模块 service 在 Cordis activation 期间失败(声明的 `inject`),可选能力用 `ctx.get()` 读取。
- Facade 不会扩大其委托 service 的权限。

## 平台支持

- **Node Host:** 四个 Host 模块与 profile bootstrap,通过权威 Host service(compat adapter 额外要求 Stent 加载期 hooks)。
- **Browser/Web:** `./client` entry 在浏览器 Cordis 树中挂载 `ctx.stentClient`;web roster 行默认禁用(opt-in)。

## Model Experience

间接地,通过它委托的权威所有者:通过本层注册的 tool、prompt section 和 command handler 以所属 registry 使其 model-visible 的完全相同方式 model-visible,session log 可重建到达 model request 的一切。

#### KV Cache effect

无;本层既不组装也不发送 provider request。

## Known Limitations and Deferred Work

- **Facade 是经过策划的子集,不是完整镜像。** 只有真实 Mod consumer 需要 domain service 本身没有承诺的兼容边界时,模块才进入协作层;其余一切以 domain service 为权威面。
- **Client slot face 是窄子集。** `ctx.stentClient.registerSlot` 接受稳定的 option 形状(`StentSlotOptions`);声明合并和 composed-props 推断保留在宿主 slot service,需要完整类型化 register 契约的 Mod 直接使用该 service。
- **Cordis service catalog 不收录模块 service。** Catalog projector 只记录位于 `src/index.ts` 或 `src/service.ts` 的 service 类;每个模块位于自己的 entry 文件,因此 `ctx.stentAgent` 等在此文档记录,而不是在生成的 catalog 中。
