/**
 * Pi extension: the `plan` tool.
 *
 * Loaded by Pi's normal extension discovery via
 * `DefaultResourceLoader.additionalExtensionPaths`. The path is
 * contributed at app start by the plan plugin's main-process service
 * (`PlanService`) through `piRuntime.registerExtension(...)` on the
 * pi plugin.
 *
 * The LLM calls `plan({ title, markdown })` to author a structured
 * plan. The tool returns a short text confirmation to the model and
 * stashes the structured payload in `details`. The renderer reads
 * `details` from `tool_execution_end` via the chat materializer and
 * the plan plugin's advice renders an "Open Plan" card.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function planExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "plan",
    label: "Plan",
    description:
      "Author a structured plan in Markdown for the user to review before execution. " +
      "Use this when the user asks you to think through an approach, design a system, " +
      "lay out steps, or otherwise produce a document the user wants to read and refer " +
      "back to. Prefer this over inline assistant prose for anything multi-step or with " +
      "diagrams. Mermaid code fences are rendered as diagrams.",
    promptSnippet:
      "Author a plan document (title + Markdown body) the user can open in a side panel.",
    promptGuidelines: [
      "Use plan when the user asks for a design, roadmap, breakdown, or multi-step approach.",
      "Plan markdown supports GitHub-flavored Markdown and ```mermaid fenced blocks for diagrams.",
      "Keep plan titles short (one line); put the detail in markdown.",
      "Do not call plan for small tactical answers — write those inline as normal prose.",
    ],
    parameters: Type.Object({
      title: Type.String({
        description:
          "Short one-line title for the plan. Shown on the chat card and as the panel header.",
      }),
      markdown: Type.String({
        description:
          "The plan body, in GitHub-flavored Markdown. ```mermaid fenced blocks are rendered as diagrams.",
      }),
    }),
    async execute(_toolCallId, params) {
      // The model only ever sees this `content` — keep it short.
      // The renderer reads `details` to render the card and the panel.
      return {
        content: [
          {
            type: "text",
            text: `Plan recorded: ${params.title}`,
          },
        ],
        details: {
          title: params.title,
          markdown: params.markdown,
        },
      };
    },
  });
}
