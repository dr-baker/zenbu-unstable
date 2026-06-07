// Onboarding completion flag (localStorage). Set on any exit,
// read on mount to skip the replay. Renderer-only, so no DB
// migration; durable across launches (Electron persists it).

const ONBOARDING_DONE_KEY = "zenbu:onboarding:completed"

export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1"
  } catch {
    return false
  }
}

export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "1")
  } catch {
    // localStorage unavailable; tutorial just replays next launch.
  }
}

/** Clear the completion flag so the tutorial replays. Used by the
 * "Redo onboarding" action on the post-tutorial panel. */
export function clearOnboardingComplete(): void {
  try {
    localStorage.removeItem(ONBOARDING_DONE_KEY)
  } catch {
    // localStorage unavailable; nothing durable to clear.
  }
}
