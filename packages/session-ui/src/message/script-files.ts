import type { SessionMessageAssistant, SessionMessageAssistantTool } from "@opencode/client/promise"

type Content = SessionMessageAssistant["content"][number]

const changes = new WeakMap<SessionMessageAssistantTool, SessionMessageAssistantTool | undefined>()

const added = new WeakSet<{ type: string }>()

/** Whether a part is the files call added after a script, which is not a call of its own in summaries. */
export function isScriptFiles(content: { type: string }) {
  return added.has(content)
}

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

  if (change) added.add(change)

  return change
}

/** A message's parts, each finished script followed by the files it changed. */
export function withScriptFileChanges(content: readonly Content[]) {
  return content.flatMap((item) => {
    const change = scriptFileChanges(item)

    return change ? [item, change] : [item]
  })
}

/**
 * The calls a group's "Used N …" summary counts: tools and shells, without the files added after a script. A group
 * holding only those files, because scripts are hidden (Quiet), counts them as the patch they show as.
 */
export function summaryCalls<T extends { type: string }>(parts: readonly T[]) {
  const calls = parts.filter((part) => part.type === "tool" || part.type === "shell")
  const own = calls.filter((part) => !isScriptFiles(part))

  return own.length > 0 ? own : calls
}
