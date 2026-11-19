import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client/promise"

type Content = SessionMessageAssistant["content"][number]

const changes = new WeakMap<SessionMessageAssistantTool, SessionMessageAssistantTool | undefined>()

/**
 * The files a finished Code Mode script changed, as a `patch` call of their own right after it. The timeline places
 * and opens it by the Edits setting, like a direct patch. A script moved to the background has none.
 */
export function scriptFileChanges(content: Content) {
  if (content.type !== "tool" || content.name !== "execute" || content.state.status !== "completed") return undefined

  if (changes.has(content)) return changes.get(content)

  const files = content.state.metadata?.files
  const change: SessionMessageAssistantTool | undefined =
    Array.isArray(files) && files.length > 0
      ? {
          ...content,
          id: `${content.id}:files`,
          name: "patch",
          state: { ...content.state, input: {}, metadata: { files } },
        }
      : undefined

  changes.set(content, change)

  return change
}

/** A message's parts, each finished script followed by the files it changed. */
export function withScriptFileChanges(content: readonly Content[]) {
  return content.flatMap((item) => {
    const change = scriptFileChanges(item)

    return change ? [item, change] : [item]
  })
}
