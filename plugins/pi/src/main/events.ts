export type Events = {
  /** Session completed (not currently viewed); triggers notification toast */
  agentCompletedUnviewed: {
    sessionId: string
    chatId: string | null
    label: string
  }
}
