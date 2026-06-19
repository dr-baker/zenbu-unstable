import type { Extension } from "@codemirror/state"
import { RangeSetBuilder } from "@codemirror/state"
import { Decoration, EditorView, WidgetType } from "@codemirror/view"

export type PillCommandNames = {
  skillNames?: readonly string[]
  promptNames?: readonly string[]
}

export function skillPillExtension(commandNames: PillCommandNames = {}): Extension {
  const knownSkillNames = new Set(commandNames.skillNames ?? [])
  const knownPromptNames = new Set(commandNames.promptNames ?? [])
  return [
    EditorView.decorations.compute(["doc"], state => {
      const ranges = findPillRanges(state.doc.toString(), {
        skills: knownSkillNames,
        prompts: knownPromptNames,
      })
      if (ranges.length === 0) return Decoration.none

      const builder = new RangeSetBuilder<Decoration>()
      for (const range of ranges) {
        builder.add(
          range.from,
          range.to,
          Decoration.replace({
            widget: new SkillPillWidget(range.name, range.kind),
            inclusive: false,
            block: false,
          }),
        )
      }
      return builder.finish()
    }),
    EditorView.theme({
      ".cm-skill-pills-pill": {
        display: "inline-flex",
        alignItems: "center",
        gap: "0.45rem",
        maxWidth: "100%",
        margin: "0.35rem 0",
        padding: "0.28rem 0.62rem",
        border: "1px solid color-mix(in oklab, var(--border) 70%, var(--foreground) 16%)",
        borderRadius: "999px",
        background: "color-mix(in oklab, var(--accent) 82%, var(--background) 18%)",
        color: "var(--accent-foreground)",
        fontSize: "0.78rem",
        fontWeight: "600",
        lineHeight: "1.2",
        verticalAlign: "middle",
        boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04)",
      },
      ".cm-skill-pills-pill[data-kind='prompt'] .cm-skill-pills-icon": {
        fontSize: "0.72rem",
      },
      ".cm-skill-pills-icon": {
        display: "inline-flex",
        width: "1rem",
        height: "1rem",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "999px",
        background: "color-mix(in oklab, var(--accent-foreground) 12%, transparent)",
        fontSize: "0.68rem",
        lineHeight: "1",
      },
      ".cm-skill-pills-name": {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      },
    }),
  ]
}

class SkillPillWidget extends WidgetType {
  constructor(
    private readonly name: string,
    private readonly kind: PillKind,
  ) {
    super()
  }

  eq(other: SkillPillWidget): boolean {
    return other.name === this.name && other.kind === this.kind
  }

  toDOM(): HTMLElement {
    const pill = document.createElement("span")
    pill.className = "cm-skill-pills-pill"
    pill.dataset.kind = this.kind
    pill.title = `Pi ${this.kind}: ${this.name}`

    const icon = document.createElement("span")
    icon.className = "cm-skill-pills-icon"
    icon.textContent = this.kind === "prompt" ? "📖" : "✦"
    icon.setAttribute("aria-hidden", "true")

    const label = document.createElement("span")
    label.className = "cm-skill-pills-name"
    label.textContent = this.name

    pill.append(icon, label)
    return pill
  }

  ignoreEvent(): boolean {
    return false
  }
}

type PillKind = "skill" | "prompt"

type PillRange = {
  from: number
  to: number
  name: string
  kind: PillKind
}

type KnownCommandNames = {
  skills: ReadonlySet<string>
  prompts: ReadonlySet<string>
}

function findPillRanges(text: string, knownNames: KnownCommandNames): PillRange[] {
  if (!text.trim()) return []

  const xmlRanges = findXmlSkillRanges(text)
  if (xmlRanges.length > 0) return xmlRanges

  const slashRanges = findSlashCommandRanges(text, knownNames)
  if (slashRanges.length > 0) return slashRanges

  const wholeDocName = extractWholeDocumentSkillName(text)
  return wholeDocName
    ? [{ from: 0, to: text.length, name: wholeDocName, kind: "skill" }]
    : []
}

function findSlashCommandRanges(
  text: string,
  knownNames: KnownCommandNames,
): PillRange[] {
  if (knownNames.skills.size === 0 && knownNames.prompts.size === 0) return []

  const ranges: PillRange[] = []
  for (const match of text.matchAll(/(^|\s)\/([^\s/][^\s]*)/g)) {
    const rawName = match[2] ?? ""
    const kind = knownNames.skills.has(rawName)
      ? "skill"
      : knownNames.prompts.has(rawName)
        ? "prompt"
        : null
    if (!kind) continue

    const leading = match[1]?.length ?? 0
    const from = (match.index ?? 0) + leading
    ranges.push({ from, to: from + rawName.length + 1, name: rawName, kind })
  }
  return ranges
}

function extractWholeDocumentSkillName(text: string): string | null {
  const trimmed = text.trim()

  const frontmatterName = extractFrontmatterSkillName(trimmed)
  if (frontmatterName) return frontmatterName

  const instructionName = extractSkillInstructionName(trimmed)
  if (instructionName) return instructionName

  return null
}

function extractFrontmatterSkillName(text: string): string | null {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/)
  if (!match) return null

  const frontmatter = match[1] ?? ""
  const body = text.slice(match[0].length)
  const name = readYamlScalar(frontmatter, "name")
  if (!name) return null

  // Avoid turning arbitrary markdown files with `name:` frontmatter into skill
  // pills. Pi skills carry a description and usually contain explicit skill
  // trigger/use language in either the metadata or body.
  if (!readYamlScalar(frontmatter, "description")) return null
  if (!/\b(skill|trigger|use this skill|use when)\b/i.test(`${frontmatter}\n${body}`)) {
    return null
  }

  return name
}

function readYamlScalar(frontmatter: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = frontmatter.match(new RegExp(`(?:^|\\n)${escaped}:\\s*(.+)(?:\\n|$)`, "i"))
  if (!match) return null
  return cleanName(match[1] ?? "")
}

function findXmlSkillRanges(text: string): PillRange[] {
  if (/<available_skills\b/i.test(text)) return []

  const ranges: PillRange[] = []
  for (const match of text.matchAll(/<skill\b[\s\S]*?<\/skill>/gi)) {
    const block = match[0]
    const from = match.index ?? 0
    const name = extractXmlSkillName(block)
    if (!name) continue
    ranges.push({ from, to: from + block.length, name, kind: "skill" })
  }
  return ranges
}

function extractXmlSkillName(block: string): string | null {
  if (!/SKILL\.md|\bdescription\b|\blocation\b|References are relative to/i.test(block)) {
    return null
  }

  const attrName = block.match(/<skill\b[^>]*\bname=("([^"]+)"|'([^']+)'|([^\s>]+))/i)
  const name = attrName?.[2] ?? attrName?.[3] ?? attrName?.[4]
  if (name) return cleanName(name)

  const childName = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]
  return childName ? cleanName(childName) : null
}

function extractSkillInstructionName(text: string): string | null {
  const match = text.match(/<skill[_-]instructions\b[^>]*\bname=["']?([^"' >]+)["']?/i)
  return match ? cleanName(match[1] ?? "") : null
}

function cleanName(value: string): string | null {
  const cleaned = value.trim().replace(/^['"]|['"]$/g, "").trim()
  return cleaned.length > 0 ? cleaned : null
}
