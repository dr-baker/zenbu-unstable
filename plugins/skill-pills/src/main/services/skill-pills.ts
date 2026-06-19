import { Service } from "@zenbujs/core/runtime"

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

    this.setup("advise-slash-command-menu", () =>
      this.advise({
        moduleId: "components/composer/slash-command-menu.tsx",
        name: "SlashCommandMenu",
        type: "around",
        modulePath: "./src/content/slash-command-menu-advice.tsx",
        exportName: "SkillPillsSlashCommandMenuAdvice",
      }),
    )
  }
}
