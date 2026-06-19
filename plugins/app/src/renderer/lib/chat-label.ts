import type { Schema } from "../../main/schema"
import type { SelfDbSection as PiSchema } from "../../../.zenbu/types/deps/pi/db-sections"

type Chat = Schema["chats"][string]
type Session = PiSchema["sessions"][string]

/** Chat display label. Pi's session file owns the canonical
 * name; Zenbu mirrors it into `session.title` for cheap renderer
 * access. */
export function chatLabel(
  chat: Chat,
  sessionsById: Record<string, Session | undefined>,
): string {
  if (chat.session.kind !== "ready") return "New Chat"
  const session = sessionsById[chat.session.sessionId]
  const title = session?.title?.trim()
  if (title && title !== "Untitled") {
    return truncate(title, 40)
  }
  return "New Chat"
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026"
}

export function resolveChatLabel(
  chat: Chat,
  session: Session | undefined,
): { label: string } {
  return { label: chatLabel(chat, session ? { [session.id]: session } : {}) }
}
