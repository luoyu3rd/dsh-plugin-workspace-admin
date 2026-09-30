/**
 * dsh-plugin-workspace-admin — mount model-facing workspace administration tools
 * over the DeepSeek Harness workspace registry.
 *
 * The plugin owns no state: every tool is a thin, validated projection of
 * `ctx.workspaceRegistry`, so the sidebar UI, the Remote `ctx.remote.workspace`
 * namespace, and this plugin all mutate the same durable registry.
 *
 * Declared dependency-free on purpose. The only import is a relative one, so no
 * bare specifier (and therefore no profile `node_modules`) is needed to load it;
 * that is what lets a profile patch layer mount it from an absolute path.
 *
 * @module dsh-plugin-workspace-admin
 */
import { workspaceTools } from './src/workspace-tools.js'

/** Plugin name reported to the Cordis Loader. */
export const name = 'workspace-admin'

/**
 * Required services; the Loader waits for all of them before calling `apply`.
 * `workspaceRegistry` performs the mutations, `tools` receives the model-facing
 * definitions, and `sessionQuery` plus `sessionPersistence` resolve the sessions
 * a workspace owns.
 */
export const inject = ['tools', 'workspaceRegistry', 'sessionQuery', 'sessionPersistence']

/**
 * Register the workspace tools.
 * @param ctx - plugin context with `tools`, `workspaceRegistry`, `sessionQuery`,
 * and `sessionPersistence`.
 */
export function apply(ctx) {
  for (const definition of workspaceTools(ctx)) ctx.tools.register(definition)
}
