import { define } from "@opencode/plugin/effect/plugin"
import { Config } from "@opencode/schema/config"
import { Integration } from "@opencode/schema/integration"
import { Provider } from "@opencode/schema/provider"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Flag } from "../flag.js"
import { Model } from "../model.js"
import { ModelsDev } from "../models-dev.js"

// These catalog entries require inference profiles on Bedrock Runtime.
// Opus/Sonnet 4.6 and Opus 5.5 support in-region calls in eu-west-2 and must remain available.
const BEDROCK_PROFILE_ONLY_IDS = [
  "amazon.nova-2-lite-v1:0",
  "anthropic.claude-fable-5",
  "anthropic.claude-fable-5-1",
  "anthropic.claude-haiku-4-5-20251001-v1:0",
  "anthropic.claude-haiku-5-5",
  "anthropic.claude-opus-4-1-20250805-v1:0",
  "anthropic.claude-opus-4-5-20251101-v1:0",
  "anthropic.claude-opus-4-7",
  "anthropic.claude-opus-4-8",
  "anthropic.claude-opus-5",
  "anthropic.claude-sonnet-4-5-20250929-v1:0",
  "anthropic.claude-sonnet-5",
  "anthropic.claude-sonnet-5-5",
  "deepseek.r1-v1:0",
  "meta.llama4-maverick-17b-instruct-v1:0",
  "meta.llama4-scout-17b-instruct-v1:0",
  "mistral.pixtral-large-2502-v1:0",
  "writer.palmyra-x4-v1:0",
  "writer.palmyra-x5-v1:0",
]

// The provider editor keeps one shared immutable index per catalog model array.
const catalogRecommendations = new WeakMap<
  ReadonlyMap<string, Model.Info>,
  NonNullable<ModelsDev.Snapshot["withoutRecommendation"]>
>()

export function catalogWithoutRecommendation(models: ReadonlyMap<string, Model.Info>, protocol: string) {
  const fallback = catalogRecommendations.get(models)?.(protocol)
  return fallback && filterModels(fallback)
}

export const ModelsDevPlugin = define({
  id: "opencode.models.dev",
  effect: Effect.fn(function* (ctx) {
    const modelsDev = yield* ModelsDev.Service
    const bus = yield* Bus.Service
    const flags = yield* Flag.Service
    const get = flags.enabled("recommended_api").pipe(Effect.flatMap((enabled) => modelsDev.get(enabled)))
    // Filtering and definition indexes are shared across Locations. Only Model materialization
    // makes mutable copies, after provider configuration and access have been resolved.
    const loaded = { data: snapshots(yield* get) }
    yield* ctx.integration.transform((integrations) => {
      for (const provider of loaded.data) {
        if (provider.environment.length === 0) continue
        const integrationID = provider.info.id
        integrations.update(integrationID, (integration) => (integration.name = provider.info.name))
        integrations.method.update({
          integrationID,
          method: { type: "key" },
        })
        integrations.method.update({
          integrationID,
          method: {
            type: "env",
            // Every listed variable is treated as a key; plugins override providers that also list setup values.
            names: [...provider.environment],
          },
        })
      }
    })
    yield* ctx.provider.transform((providers) => {
      for (const provider of loaded.data) {
        providers.add({
          info: { ...provider.info, integrationID: Integration.ID.make(provider.info.id) },
          models: provider.models,
        })
        const record = providers.get(provider.info.id)
        if (record && provider.withoutRecommendation)
          catalogRecommendations.set(record.models, provider.withoutRecommendation)
      }
    })
    const apply = (data: readonly ModelsDev.Snapshot[]) => {
      const latest = snapshots(data)
      if (latest === loaded.data) return Effect.void
      loaded.data = latest
      return ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload()))
    }
    yield* bus.subscribe([ModelsDev.Event.Refreshed, Config.Event.Updated]).pipe(
      Stream.runForEach(() => get.pipe(Effect.flatMap(apply))),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A refresh that landed between the initial read and the subscription above published
    // Refreshed to nobody here. On a cold cache that read served the bundled snapshot, so
    // re-read now instead of waiting for the next TTL refresh.
    yield* get.pipe(Effect.flatMap(apply))
  }),
})

const prepared = new WeakMap<readonly ModelsDev.Snapshot[], readonly ModelsDev.Snapshot[]>()

function snapshots(data: readonly ModelsDev.Snapshot[]) {
  const cached = prepared.get(data)
  if (cached) return cached
  const result = data
    .filter(
      // These deprecated aliases are replaced by the canonical Azure and Google Vertex providers.
      (provider) => provider.info.id !== "azure-cognitive-services" && provider.info.id !== "google-vertex-anthropic",
    )
    .map(filterModels)
  prepared.set(data, result)
  return result
}

function filterModels(provider: ModelsDev.Snapshot): ModelsDev.Snapshot {
  const cached = filtered.get(provider)
  if (cached) return cached
  const result = {
    ...provider,
    models: provider.models.filter(
      (model) =>
        model.status !== "deprecated" &&
        // Non-chat models are kept for lookups; the Model service never offers them for sessions.
        ((model.type ?? "chat") !== "chat" || Model.supportsText(model)) &&
        !(
          provider.info.id === Provider.ID.amazonBedrock && BEDROCK_PROFILE_ONLY_IDS.includes(model.modelID ?? model.id)
        ),
    ),
  }
  filtered.set(provider, result)
  return result
}

const filtered = new WeakMap<ModelsDev.Snapshot, ModelsDev.Snapshot>()
