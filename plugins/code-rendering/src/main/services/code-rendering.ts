import { Service } from "@zenbujs/core/runtime"

export class CodeRenderingService extends Service.create({
  key: "code-rendering",
}) {
  evaluate() {
    this.setup("advise-assistant-code-rendering", () =>
      this.advise({
        moduleId: "components/chat/messages/assistant-message.tsx",
        name: "AssistantMessage",
        type: "around",
        modulePath: "src/content/code-rendering-advice.tsx",
        exportName: "AssistantMessageCodeRenderingAdvice",
      }),
    )

    this.setup("advise-thinking-code-rendering", () =>
      this.advise({
        moduleId: "components/chat/messages/thinking-block.tsx",
        name: "ThinkingBlock",
        type: "around",
        modulePath: "src/content/code-rendering-advice.tsx",
        exportName: "ThinkingBlockCodeRenderingAdvice",
      }),
    )
  }
}
