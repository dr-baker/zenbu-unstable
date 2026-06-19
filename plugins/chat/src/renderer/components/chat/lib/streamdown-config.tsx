import { isValidElement, type ComponentProps, type ReactNode } from "react"

function extractText(node: ReactNode): string {
  if (node == null || node === false) return ""
  if (typeof node === "string") return node
  if (typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(extractText).join("")
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return extractText(props.children)
  }
  return ""
}

/**
 * Streamdown ships with very large default heading sizes (h1 = text-3xl /
 * 30px, h2 = text-2xl / 24px, …). Against our 14px chat body that looks
 * comically oversized, and any inline `<code>` nested inside a heading
 * inherits the heading's font size, which is what made code-formatted file
 * paths in assistant replies render as giant blocks.
 *
 * We render every heading at a size close to the chat body, with weight
 * doing the visual work instead of size. See AGENTS.md ("never use the
 * small-uppercase / wide-letter-spacing pattern … use normal-case 12-13px
 * with font-medium/semibold").
 */
type HeadingProps = ComponentProps<"h1">

function makeHeading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", classes: string) {
  function Heading({ className, ...props }: HeadingProps) {
    return (
      <Tag
        {...props}
        className={`${classes} ${className ?? ""}`}
      />
    )
  }
  Heading.displayName = `ChatMd${Tag.toUpperCase()}`
  return Heading
}

const H1 = makeHeading("h1", "mt-4 mb-2 text-[15px] font-semibold text-foreground")
const H2 = makeHeading("h2", "mt-4 mb-2 text-[14px] font-semibold text-foreground")
const H3 = makeHeading("h3", "mt-3 mb-1.5 text-[13px] font-semibold text-foreground")
const H4 = makeHeading("h4", "mt-3 mb-1.5 text-[13px] font-medium text-foreground")
const H5 = makeHeading("h5", "mt-2 mb-1 text-[13px] font-medium text-foreground")
const H6 = makeHeading("h6", "mt-2 mb-1 text-[13px] font-medium text-muted-foreground")

/**
 * Streamdown plug-points. We only customize the inline `<code>` styling
 * via the dedicated `inlineCode` slot. Block code is left to streamdown's
 * default `CodeBlock` (which uses shiki). Overriding `code` here would
 * replace the entire CodeBlock with a bare <code>, which breaks block
 * rendering.
 */
function InlineCode(props: ComponentProps<"code">) {
  return (
    <code
      {...props}
      className={
        "rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground " +
        (props.className ?? "")
      }
    />
  )
}

export const streamdownProps = {
  components: {
    inlineCode: InlineCode,
    h1: H1,
    h2: H2,
    h3: H3,
    h4: H4,
    h5: H5,
    h6: H6,
  },
}

export { extractText }
