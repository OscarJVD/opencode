import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { withScriptFileChanges } from "./script-files"

const files = [{ file: "src/app.ts", status: "modified", additions: 1, deletions: 1, patch: "@@" }]

const script = (
  status: "completed" | "running",
  metadata: { toolCalls?: []; files?: typeof files },
): SessionMessageAssistantTool =>
  status === "completed"
    ? {
        type: "tool",
        id: "call_1",
        name: "execute",
        time: { created: 1 },
        state: { status, input: { code: "" }, metadata, content: [{ type: "text", text: "" }] },
      }
    : {
        type: "tool",
        id: "call_1",
        name: "execute",
        time: { created: 1 },
        state: { status, input: { code: "" }, metadata },
      }

describe("withScriptFileChanges", () => {
  test("follows a finished script with a patch call holding its files", () => {
    const [execute, change] = withScriptFileChanges([script("completed", { toolCalls: [], files })])
    expect(execute?.type === "tool" && execute.name).toBe("execute")
    expect(change).toMatchObject({ type: "tool", id: "call_1:files", name: "patch", state: { metadata: { files } } })
  })

  test("adds nothing for a script without files or still running", () => {
    expect(withScriptFileChanges([script("completed", { toolCalls: [] })])).toHaveLength(1)
    expect(withScriptFileChanges([script("running", { files })])).toHaveLength(1)
  })

  test("returns the same patch call each time, so rows keep their identity", () => {
    const content = [script("completed", { files })]
    expect(withScriptFileChanges(content)[1]).toBe(withScriptFileChanges(content)[1])
  })
})
