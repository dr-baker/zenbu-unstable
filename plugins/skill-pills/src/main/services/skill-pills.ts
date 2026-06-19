import path from "node:path"
import { Service, getPlugin } from "@zenbujs/core/runtime"

export class SkillPillsService extends Service.create({
  key: "skill-pills",
}) {
  evaluate() {
    this.setup("inject-register", () =>
      this.inject({
        name: "skill-pills/bootstrap",
        modulePath: "./src/content/register.tsx",
      }),
    )

    this.setup("advise-slash-command-menu", () => {
      const chatDir = getPlugin("chat")?.dir
      const slashCommandMenuModuleId = chatDir
        ? path.join(chatDir, "src/renderer/components/composer/slash-command-menu.tsx")
        : "components/composer/slash-command-menu.tsx"
      return this.advise({
        moduleId: slashCommandMenuModuleId,
        name: "SlashCommandMenu",
        type: "around",
        modulePath: "./src/content/slash-command-menu-advice.tsx",
        exportName: "SkillPillsSlashCommandMenuAdvice",
      })
    })
  }
}
