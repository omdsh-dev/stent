/**
 * The stent catalog entries, verbatim from the host patch, plus the tuple
 * builders that keep the literal data compact.
 *
 * @module @oh-my-dsh/stent-dsh/catalog-entries
 */

import type {
  CatalogDeclaration,
  CatalogEntry,
  CatalogMethod,
  CatalogParameter,
  CatalogService,
} from '#src/catalog-types'

/** Data tuple for one catalog parameter. */
type ParameterTuple = readonly [name: string, description: string]
/** Data tuple for one catalog method. */
type MethodTuple = readonly [
  signature: string,
  description: string,
  parameters: readonly ParameterTuple[],
  returns?: string,
]
/** Data tuple for one catalog service. */
type ServiceTuple = readonly [
  key: string,
  summary: string,
  description: string,
  methods: readonly CatalogMethod[],
]
/** Data tuple for one catalog type declaration. */
type DeclarationTuple = readonly [name: string, declaration: string]

/** Build a catalog method descriptor from its data tuple. */
function fromMethod(tuple: MethodTuple): CatalogMethod {
  const [signature, description, parametersList, returns] = tuple
  const parameters: readonly CatalogParameter[] = parametersList.map(
    ([paramName, paramDescription]) => ({
      name: paramName,
      description: paramDescription,
    }),
  )
  if (returns === undefined) {
    return { signature, description, parameters }
  }
  return { signature, description, parameters, returns }
}

/** Build a catalog service entry from its data tuple. */
function fromService(tuple: ServiceTuple): CatalogService {
  const [key, summary, description, methods] = tuple
  const service: CatalogService = {
    key,
    summary,
    description,
    methods,
  }
  return service
}

/** Build a catalog type declaration entry from its data tuple. */
function fromDeclaration(tuple: DeclarationTuple): CatalogDeclaration {
  const [name, declaration] = tuple
  const entry: CatalogDeclaration = {
    name,
    declaration,
  }
  return entry
}

/** The stent catalog entries (verbatim from the host patch). */
const STENT_CATALOG_ENTRIES: CatalogEntry[] = [
  fromService([
    'stent',
    'The Stent registry service.',
    'The Stent registry service. Trusted patches register handlers against target module functions at load time; transformed code publishes to a shared bridge the registry dispatches, and disposal restores the original bodies.',
    [
      fromMethod([
        'register(patch: StentPatch): PatchId',
        'Register a patch and enable its handler for the current fiber. The registration is an effect: disposing the fiber disables and removes the patch, so transformed code falls back to the original body. The effect attaches on the first registration of an id only; a later re-registration from another fiber updates metadata and handler without changing disposal ownership.',
        [['patch', 'validated patch descriptor.']],
        'the registered patch id.',
      ]),
      fromMethod([
        'list(): StentPatchInfo[]',
        'Ordered diagnostic snapshot of all registered patches.',
        [],
        'the patch infos sorted by priority then id.',
      ]),
      fromMethod([
        'disable(id: string): void',
        "Disable a patch's handler; transformed code delegates to the original body until the patch is enabled again.",
        [['id', 'the patch id.']],
      ]),
      fromMethod([
        'enable(id: string, handler: StentHandler): void',
        'Enable a previously disabled patch with a fresh handler binding.',
        [
          ['id', 'the patch id.'],
          ['handler', 'the trusted runtime handler.'],
        ],
      ]),
      fromMethod([
        'bindings(id?: PatchId): readonly StentBinding[]',
        "Snapshot of load-time bindings: the files the transformation hooks actually rewrote for one patch — the ground truth the `required` check and this package's diagnostics are built on.",
        [
          [
            'id',
            'the patch id; when omitted, every recorded binding across patches, flattened in patch-id order.',
          ],
        ],
        'the recorded binding records.',
      ]),
    ],
  ]),
  fromService([
    'stentAgent',
    'Cooperative Mod-facing Agent lifecycle API.',
    "Cooperative Mod-facing Agent lifecycle API. Listeners observe creation, disposal, and status transitions over the authoritative agent events; logged context injection goes through the Agent's own durable injection path.",
    [
      fromMethod([
        'onCreated(listener: (agent: Agent) => void): () => boolean',
        'Observe a live agent being created.',
        [['listener', 'called with the created agent.']],
        'the exact `ctx.on()` disposer removing this listener.',
      ]),
      fromMethod([
        'onDisposed(listener: (agent: Agent) => void): () => boolean',
        'Observe a live agent being disposed.',
        [['listener', 'called with the disposed agent.']],
        'the exact `ctx.on()` disposer removing this listener.',
      ]),
      fromMethod([
        'onStatus(listener: (agent: Agent, status: AgentStatus) => void): () => boolean',
        "Observe an agent's idle/running status transitions.",
        [['listener', 'called with the agent and its new status.']],
        'the exact `ctx.on()` disposer removing this listener.',
      ]),
      fromMethod([
        'inject(agent: Agent, message: UserMessage): void',
        "Inject a logged, model-visible user message into one agent's context. The message goes through `agent.inject()`, the Agent's own durable injection path: anything this API contributes to a model request is reconstructable from the session log. No provider request is assembled here.",
        [
          ['agent', 'the live agent to inject into.'],
          ['message', 'the sourced user message to append.'],
        ],
      ]),
    ],
  ]),
  fromService([
    'stentCommands',
    'Cooperative Mod-facing command registry API.',
    'Cooperative Mod-facing command registry API. Human command registration and effective descriptor listing over the authoritative command registry.',
    [
      fromMethod([
        'register(definition: CommandDefinition): () => void',
        'Register one human command through the authoritative registry.',
        [['definition', 'discovery metadata and direct UI handler.']],
        'the exact effect disposer that unregisters this definition.',
      ]),
      fromMethod([
        'list(agent: Agent): readonly CommandDescriptor[]',
        'List the effective immutable command descriptors for one agent.',
        [['agent', 'exact receiving agent and scoped-layer key.']],
        'name-sorted descriptors after scoped shadowing.',
      ]),
    ],
  ]),
  fromService([
    'stentPrompt',
    'Cooperative Mod-facing system-prompt registry API.',
    'Cooperative Mod-facing system-prompt registry API. Ordered system sections, cache-safe context contributions, tool-schema providers, and prompt variables over the authoritative prompt registry.',
    [
      fromMethod([
        'section(section: PromptSection): () => void',
        'Register an ordered system section.',
        [['section', 'the section to register.']],
        'the exact effect disposer that unregisters it.',
      ]),
      fromMethod([
        'context(context: PromptContext): () => void',
        'Register an ordered, cache-safe dynamic context contribution.',
        [['context', 'the context contribution to register.']],
        'the exact effect disposer that unregisters it.',
      ]),
      fromMethod([
        'tools(provider: (context: AssembleContext) => ToolProviderResult): () => void',
        'Register a tool-schema provider.',
        [['provider', 'evaluated for each assembly with its context.']],
        'the exact effect disposer that unregisters it.',
      ]),
      fromMethod([
        'variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void',
        'Register a prompt variable.',
        [
          ['name', 'the `[a-z][a-z0-9_]*` reference name.'],
          [
            'provider',
            'evaluated for each assembly; returning `undefined` makes a referencing section fail.',
          ],
        ],
        'the exact effect disposer that unregisters it.',
      ]),
    ],
  ]),
  fromService([
    'stentTools',
    'Cooperative Mod-facing tool registry API.',
    'Cooperative Mod-facing tool registry API. Tool registration and pre/post-execute waterfall listeners over the authoritative tool registry.',
    [
      fromMethod([
        'register(definition: ToolDefinition): () => void',
        'Register one tool through the authoritative registry.',
        [
          [
            'definition',
            'tool schema, execution, and optional finalization/presentation callbacks.',
          ],
        ],
        'the exact disposer that unregisters the tool.',
      ]),
      fromMethod([
        'onPreExecute(listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): () => boolean',
        'Observe or gate dispatch through `tools/pre-execute`.',
        [
          [
            'listener',
            'the waterfall listener; call `next()` to delegate, return without it to veto.',
          ],
        ],
        'the exact `ctx.on()` disposer removing this listener.',
      ]),
      fromMethod([
        'onPostExecute( listener: ( exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>, ) => Promise<PostToolDecision>, ): () => boolean',
        'Observe or shape a normalized dispatch outcome through `tools/post-execute`.',
        [
          [
            'listener',
            'the waterfall listener; call `next()` to accept the result unchanged.',
          ],
        ],
        'the exact `ctx.on()` disposer removing this listener.',
      ]),
    ],
  ]),
  fromDeclaration([
    'StentAfterHandler',
    'export type StentAfterHandler = (call: StentCall) => unknown;',
  ]),
  fromDeclaration([
    'StentAroundHandler',
    'export type StentAroundHandler = (call: StentCall, invoke: StentInvoke) => unknown;',
  ]),
  fromDeclaration([
    'StentBeforeHandler',
    'export type StentBeforeHandler = (call: StentCall) => void;',
  ]),
  fromDeclaration([
    'StentBinding',
    'export interface StentBinding {\n    module: string;\n    file: string;\n    nodes: number;\n}',
  ]),
  fromDeclaration([
    'StentCall',
    'export interface StentCall {\n    arguments: unknown[];\n    self: unknown;\n    moduleVersion?: string;\n    result?: unknown;\n}',
  ]),
  fromDeclaration([
    'StentHandler',
    'export type StentHandler = StentBeforeHandler | StentAfterHandler | StentAroundHandler | StentReplaceHandler;',
  ]),
  fromDeclaration(['StentInvoke', 'export type StentInvoke = () => unknown;']),
  fromDeclaration([
    'StentOperation',
    "export type StentOperation = 'before' | 'after' | 'around' | 'replace';",
  ]),
  fromDeclaration([
    'StentPatch',
    'export interface StentPatch {\n    id: PatchId;\n    target: StentTarget;\n    operation: StentOperation;\n    required?: boolean;\n    priority?: number;\n    handler: StentHandler;\n}',
  ]),
  fromDeclaration([
    'StentPatchInfo',
    'export interface StentPatchInfo {\n    id: PatchId;\n    target: StentTarget;\n    operation: StentOperation;\n    priority: number;\n    enabled: boolean;\n    bindings?: readonly StentBinding[];\n}',
  ]),
  fromDeclaration([
    'StentReplaceHandler',
    'export type StentReplaceHandler = (call: StentCall, invoke: StentInvoke) => unknown;',
  ]),
  fromDeclaration([
    'StentTarget',
    'export interface StentTarget {\n    module: string;\n    versionRange: string;\n    filePath?: string | RegExp;\n    filePaths?: string[];\n    functionQuery?: FunctionQuery;\n    astQuery?: string;\n    index?: number | null;\n}',
  ]),
  fromDeclaration(['PatchId', 'export type PatchId = string;']),
  fromDeclaration([
    'PreToolDecision',
    "export type PreToolDecision = {\n    kind: 'allow';\n} | {\n    kind: 'deny';\n    reason: string;\n} | {\n    kind: 'ask';\n    reason?: string;\n};",
  ]),
]

export { STENT_CATALOG_ENTRIES }
