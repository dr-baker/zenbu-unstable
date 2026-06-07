import { Service } from "@zenbujs/core/runtime";
import { shellEnv } from "shell-env";

// Launched from the Dock, Electron's process.env has a stripped PATH
// (no Homebrew/nvm/etc). Resolve the login shell's env once and share
// it so spawned shells behave like a real terminal.
export class ShellEnvService extends Service.create({
  key: "shellEnv",
}) {
  private resolved: NodeJS.ProcessEnv | null = null;
  private pending: Promise<NodeJS.ProcessEnv> | null = null;

  evaluate() {
    // warm the cache; don't block startup on it
    this.pending = this.resolve();
    void this.pending.catch(() => {});
  }

  async getEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.resolved) return this.resolved;
    if (this.pending) return this.pending;
    return this.resolve();
  }

  private async resolve(): Promise<NodeJS.ProcessEnv> {
    try {
      const env = await shellEnv();
      // dotfile values win, keep Electron-only vars the shell didn't set
      this.resolved = { ...process.env, ...env };
    } catch (err) {
      console.warn("[shell-env] resolve failed, using process.env:", err);
      this.resolved = { ...process.env };
    }
    this.pending = null;
    this.applyToProcessEnv(this.resolved);
    return this.resolved;
  }

  private applyToProcessEnv(env: NodeJS.ProcessEnv) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
  }
}
