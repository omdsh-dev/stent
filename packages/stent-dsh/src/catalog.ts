/**
 * The catalog adapter belongs to the DSH integration layer: the pure Stent
 * package has no dependency on the host's tool-cordis catalog.
 *
 * @module @oh-my-dsh/stent-dsh/catalog
 */

/** The stent catalog entries (verbatim from the host patch). */
export const STENT_CATALOG_ENTRIES = [
  {
    key: 'stent',
    summary: 'The Stent registry service.',
    description:
      'The Stent registry service. Trusted patches register handlers against target module functions at load time; transformed code publishes to a shared bridge the registry dispatches, and disposal restores the original bodies.',
    methods: [
      {
        signature: 'register(patch: StentPatch): PatchId',
        description:
          'Register a patch and enable its handler for the current fiber. The registration is an effect: disposing the fiber disables and removes the patch, so transformed code falls back to the original body. The effect attaches on the first registration of an id only; a later re-registration from another fiber updates metadata and handler without changing disposal ownership.',
        parameters: [
          { name: 'patch', description: 'validated patch descriptor.' },
        ],
        returns: 'the registered patch id.',
      },
      {
        signature: 'list(): StentPatchInfo[]',
        description: 'Ordered diagnostic snapshot of all registered patches.',
        parameters: [],
        returns: 'the patch infos sorted by priority then id.',
      },
      {
        signature: 'disable(id: string): void',
        description:
          "Disable a patch's handler; transformed code delegates to the original body until the patch is enabled again.",
        parameters: [{ name: 'id', description: 'the patch id.' }],
      },
      {
        signature: 'enable(id: string, handler: StentHandler): void',
        description:
          'Enable a previously disabled patch with a fresh handler binding.',
        parameters: [
          { name: 'id', description: 'the patch id.' },
          { name: 'handler', description: 'the trusted runtime handler.' },
        ],
      },
      {
        signature: 'bindings(id?: PatchId): readonly StentBinding[]',
        description:
          "Snapshot of load-time bindings: the files the transformation hooks actually rewrote for one patch — the ground truth the `required` check and this package's diagnostics are built on.",
        parameters: [
          {
            name: 'id',
            description:
              'the patch id; when omitted, every recorded binding across patches, flattened in patch-id order.',
          },
        ],
        returns: 'the recorded binding records.',
      },
    ],
  },
  {
    key: 'stentAgent',
    summary: 'Cooperative Mod-facing Agent lifecycle API.',
    description:
      "Cooperative Mod-facing Agent lifecycle API. Listeners observe creation, disposal, and status transitions over the authoritative agent events; logged context injection goes through the Agent's own durable injection path.",
    methods: [
      {
        signature: 'onCreated(listener: (agent: Agent) => void): () => boolean',
        description: 'Observe a live agent being created.',
        parameters: [
          { name: 'listener', description: 'called with the created agent.' },
        ],
        returns: 'the exact `ctx.on()` disposer removing this listener.',
      },
      {
        signature:
          'onDisposed(listener: (agent: Agent) => void): () => boolean',
        description: 'Observe a live agent being disposed.',
        parameters: [
          { name: 'listener', description: 'called with the disposed agent.' },
        ],
        returns: 'the exact `ctx.on()` disposer removing this listener.',
      },
      {
        signature:
          'onStatus(listener: (agent: Agent, status: AgentStatus) => void): () => boolean',
        description: "Observe an agent's idle/running status transitions.",
        parameters: [
          {
            name: 'listener',
            description: 'called with the agent and its new status.',
          },
        ],
        returns: 'the exact `ctx.on()` disposer removing this listener.',
      },
      {
        signature: 'inject(agent: Agent, message: UserMessage): void',
        description:
          "Inject a logged, model-visible user message into one agent's context. The message goes through `agent.inject()`, the Agent's own durable injection path: anything this API contributes to a model request is reconstructable from the session log. No provider request is assembled here.",
        parameters: [
          { name: 'agent', description: 'the live agent to inject into.' },
          {
            name: 'message',
            description: 'the sourced user message to append.',
          },
        ],
      },
    ],
  },
  {
    key: 'stentCommands',
    summary: 'Cooperative Mod-facing command registry API.',
    description:
      'Cooperative Mod-facing command registry API. Human command registration and effective descriptor listing over the authoritative command registry.',
    methods: [
      {
        signature: 'register(definition: CommandDefinition): () => void',
        description:
          'Register one human command through the authoritative registry.',
        parameters: [
          {
            name: 'definition',
            description: 'discovery metadata and direct UI handler.',
          },
        ],
        returns: 'the exact effect disposer that unregisters this definition.',
      },
      {
        signature: 'list(agent: Agent): readonly CommandDescriptor[]',
        description:
          'List the effective immutable command descriptors for one agent.',
        parameters: [
          {
            name: 'agent',
            description: 'exact receiving agent and scoped-layer key.',
          },
        ],
        returns: 'name-sorted descriptors after scoped shadowing.',
      },
    ],
  },
  {
    key: 'stentPrompt',
    summary: 'Cooperative Mod-facing system-prompt registry API.',
    description:
      'Cooperative Mod-facing system-prompt registry API. Ordered system sections, cache-safe context contributions, tool-schema providers, and prompt variables over the authoritative prompt registry.',
    methods: [
      {
        signature: 'section(section: PromptSection): () => void',
        description: 'Register an ordered system section.',
        parameters: [
          { name: 'section', description: 'the section to register.' },
        ],
        returns: 'the exact effect disposer that unregisters it.',
      },
      {
        signature: 'context(context: PromptContext): () => void',
        description:
          'Register an ordered, cache-safe dynamic context contribution.',
        parameters: [
          {
            name: 'context',
            description: 'the context contribution to register.',
          },
        ],
        returns: 'the exact effect disposer that unregisters it.',
      },
      {
        signature:
          'tools(provider: (context: AssembleContext) => ToolProviderResult): () => void',
        description: 'Register a tool-schema provider.',
        parameters: [
          {
            name: 'provider',
            description: 'evaluated for each assembly with its context.',
          },
        ],
        returns: 'the exact effect disposer that unregisters it.',
      },
      {
        signature:
          'variable(name: string, provider: (context: AssembleContext) => string | undefined): () => void',
        description: 'Register a prompt variable.',
        parameters: [
          {
            name: 'name',
            description: 'the `[a-z][a-z0-9_]*` reference name.',
          },
          {
            name: 'provider',
            description:
              'evaluated for each assembly; returning `undefined` makes a referencing section fail.',
          },
        ],
        returns: 'the exact effect disposer that unregisters it.',
      },
    ],
  },
  {
    key: 'stentTools',
    summary: 'Cooperative Mod-facing tool registry API.',
    description:
      'Cooperative Mod-facing tool registry API. Tool registration and pre/post-execute waterfall listeners over the authoritative tool registry.',
    methods: [
      {
        signature: 'register(definition: ToolDefinition): () => void',
        description: 'Register one tool through the authoritative registry.',
        parameters: [
          {
            name: 'definition',
            description:
              'tool schema, execution, and optional finalization/presentation callbacks.',
          },
        ],
        returns: 'the exact disposer that unregisters the tool.',
      },
      {
        signature:
          'onPreExecute(listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>): () => boolean',
        description: 'Observe or gate dispatch through `tools/pre-execute`.',
        parameters: [
          {
            name: 'listener',
            description:
              'the waterfall listener; call `next()` to delegate, return without it to veto.',
          },
        ],
        returns: 'the exact `ctx.on()` disposer removing this listener.',
      },
      {
        signature:
          'onPostExecute( listener: ( exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>, ) => Promise<PostToolDecision>, ): () => boolean',
        description:
          'Observe or shape a normalized dispatch outcome through `tools/post-execute`.',
        parameters: [
          {
            name: 'listener',
            description:
              'the waterfall listener; call `next()` to accept the result unchanged.',
          },
        ],
        returns: 'the exact `ctx.on()` disposer removing this listener.',
      },
    ],
  },
  {
    name: 'StentAfterHandler',
    declaration:
      'export type StentAfterHandler = (call: StentCall) => unknown;',
  },
  {
    name: 'StentAroundHandler',
    declaration:
      'export type StentAroundHandler = (call: StentCall, invoke: StentInvoke) => unknown;',
  },
  {
    name: 'StentBeforeHandler',
    declaration: 'export type StentBeforeHandler = (call: StentCall) => void;',
  },
  {
    name: 'StentBinding',
    declaration:
      'export interface StentBinding {\n    module: string;\n    file: string;\n    nodes: number;\n}',
  },
  {
    name: 'StentCall',
    declaration:
      'export interface StentCall {\n    arguments: unknown[];\n    self: unknown;\n    moduleVersion?: string;\n    result?: unknown;\n}',
  },
  {
    name: 'StentHandler',
    declaration:
      'export type StentHandler = StentBeforeHandler | StentAfterHandler | StentAroundHandler | StentReplaceHandler;',
  },
  {
    name: 'StentInvoke',
    declaration: 'export type StentInvoke = () => unknown;',
  },
  {
    name: 'StentOperation',
    declaration:
      "export type StentOperation = 'before' | 'after' | 'around' | 'replace';",
  },
  {
    name: 'StentPatch',
    declaration:
      'export interface StentPatch {\n    id: PatchId;\n    target: StentTarget;\n    operation: StentOperation;\n    required?: boolean;\n    priority?: number;\n    handler: StentHandler;\n}',
  },
  {
    name: 'StentPatchInfo',
    declaration:
      'export interface StentPatchInfo {\n    id: PatchId;\n    target: StentTarget;\n    operation: StentOperation;\n    priority: number;\n    enabled: boolean;\n    bindings?: readonly StentBinding[];\n}',
  },
  {
    name: 'StentReplaceHandler',
    declaration:
      'export type StentReplaceHandler = (call: StentCall, invoke: StentInvoke) => unknown;',
  },
  {
    name: 'StentTarget',
    declaration:
      'export interface StentTarget {\n    module: string;\n    versionRange: string;\n    filePath?: string | RegExp;\n    filePaths?: string[];\n    functionQuery?: FunctionQuery;\n    astQuery?: string;\n    index?: number | null;\n}',
  },
  {
    name: 'PatchId',
    declaration: 'export type PatchId = string;',
  },
  {
    name: 'PreToolDecision',
    declaration:
      "export type PreToolDecision = {\n    kind: 'allow';\n} | {\n    kind: 'deny';\n    reason: string;\n} | {\n    kind: 'ask';\n    reason?: string;\n};",
  },
]

interface ApiCatalogModule {
  SERVICE_API?: Array<{ key: string }>
}

/** Push the stent entries into the official catalog once (idempotent). */
export async function registerCatalogEntries(): Promise<void> {
  try {
    // Variable specifier: the official package is host-provided only, never
    // a trio dependency, so the import stays out of the type graph.
    const spec = '@deepseek-ai/dsh-tool-cordis/src/api-catalog.ts'
    const catalog = (await import(spec)) as unknown as ApiCatalogModule
    const list = catalog.SERVICE_API
    if (list === undefined) {
      return
    }
    for (const entry of STENT_CATALOG_ENTRIES as Array<{ key: string }>) {
      if (!list.some((existing) => existing.key === entry.key)) {
        list.push(entry)
      }
    }
  } catch {
    // Built host (no tsx, no ./src/* resolution): the inspect report still
    // lists the live stent services, just without signatures.
  }
}
