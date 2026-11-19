import { define } from "@opencode/plugin/effect/plugin"
import { Event } from "@opencode/schema/config"
import { Integration } from "@opencode/schema/integration"
import { Provider } from "@opencode/schema/provider"
import { Effect, Stream } from "effect"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Credential } from "../credential.js"
import { Flag } from "../flag.js"
import { Model } from "../model.js"
import { ModelsDev } from "../models-dev.js"
import { vertexCatalog } from "./provider/google-vertex.js"

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

export const ModelsDevPlugin = define({
  id: "opencode.models.dev",
  effect: Effect.fn(function* (ctx) {
    const modelsDev = yield* ModelsDev.Service
    const bus = yield* Bus.Service
    const flags = yield* Flag.Service
    const config = yield* Config.Service
    const recommendedVertex = vertexCatalog(ctx.integration)
    const get = Effect.gen(function* () {
      const data = (yield* modelsDev.get()).filter(
        // These deprecated aliases are replaced by the canonical Azure and Google Vertex providers.
        (provider) => provider.info.id !== "azure-cognitive-services" && provider.info.id !== "google-vertex-anthropic",
      )
      const entries = yield* config.entries()
      if (!flags.resolve(entries).recommended_api.enabled) return data.map(filtered)
      const vertex = yield* recommendedVertex(
        data.find((provider) => provider.info.id === Provider.ID.googleVertex),
        entries,
      )
      return data.map((provider) =>
        filtered((provider.info.id === Provider.ID.googleVertex ? vertex : provider.recommend?.()) ?? provider),
      )
    })
    const loaded = { data: yield* get }
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
      }
    })
    const apply = (data: ModelsDev.Snapshot[]) => {
      if (data.length === loaded.data.length && data.every((provider, index) => provider === loaded.data[index]))
        return Effect.void
      loaded.data = data
      return ctx.integration.reload().pipe(Effect.andThen(ctx.provider.reload()))
    }
    yield* bus
      .subscribe([ModelsDev.Event.Refreshed, Event.Updated, Credential.Event.Updated, Credential.Event.Switched])
      .pipe(
        Stream.runForEach(() => get.pipe(Effect.flatMap(apply))),
        Effect.forkScoped({ startImmediately: true }),
      )
    // A refresh that landed between the initial read and the subscription above published
    // Refreshed to nobody here. Re-read now instead of waiting for the next TTL refresh.
    yield* get.pipe(Effect.flatMap(apply))
  }),
})

const filteredProviders = new WeakMap<ModelsDev.Snapshot, ModelsDev.Snapshot>()

function filtered(provider: ModelsDev.Snapshot): ModelsDev.Snapshot {
  const cached = filteredProviders.get(provider)
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
  filteredProviders.set(provider, result)
  return result
}
