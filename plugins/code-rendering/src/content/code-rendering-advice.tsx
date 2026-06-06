import type { ComponentType, ReactNode } from "react"

const codeRenderingCss = `
[data-code-rendering] [data-streamdown="code-block"] {
  margin: 0.625rem 0 !important;
  gap: 0 !important;
  position: relative !important;
  overflow: hidden !important;
  padding: 0 !important;
  border-color: var(--border) !important;
  border-radius: 10px !important;
  background: var(--background) !important;
}

[data-code-rendering] [data-streamdown="code-block-header"] {
  display: flex !important;
  height: 34px !important;
  min-height: 34px !important;
  align-items: center !important;
  padding: 0 58px 0 12px !important;
  font-size: 11px !important;
  line-height: 1 !important;
}

[data-code-rendering] [data-streamdown="code-block-header"] > span {
  margin-left: 0 !important;
}

[data-code-rendering] [data-streamdown="code-block"] > div:has(> [data-streamdown="code-block-actions"]) {
  position: absolute !important;
  top: 6px !important;
  right: 10px !important;
  z-index: 10 !important;
  display: flex !important;
  height: auto !important;
  margin-top: 0 !important;
  padding: 0 !important;
  align-items: center !important;
  justify-content: flex-end !important;
  pointer-events: none !important;
}

[data-code-rendering] [data-streamdown="code-block-actions"] {
  gap: 4px !important;
  margin-top: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 6px !important;
  background: transparent !important;
  backdrop-filter: none !important;
}

[data-code-rendering] [data-streamdown="code-block-copy-button"],
[data-code-rendering] [data-streamdown="code-block-download-button"] {
  display: inline-flex !important;
  width: 22px !important;
  height: 22px !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0 !important;
  border-radius: 5px !important;
}

[data-code-rendering] [data-streamdown="code-block-copy-button"]:hover,
[data-code-rendering] [data-streamdown="code-block-download-button"]:hover {
  background: var(--muted) !important;
}

[data-code-rendering] [data-streamdown="code-block-body"] {
  overflow-x: auto !important;
  padding: 10px 12px 12px 8px !important;
  border: 0 !important;
  border-top: 1px solid var(--border) !important;
  border-radius: 0 !important;
  background: color-mix(in oklab, var(--background) 88%, var(--foreground) 4%) !important;
  font-size: 12.5px !important;
  line-height: 1.55 !important;
}

[data-code-rendering] [data-streamdown="code-block-body"] pre {
  margin: 0 !important;
  background: transparent !important;
}

[data-code-rendering] [data-streamdown="code-block-body"] code {
  font-size: inherit !important;
  line-height: inherit !important;
}

[data-code-rendering] [data-streamdown="code-block-body"] code > span::before {
  width: 1.75ch !important;
  margin-right: 0.6rem !important;
  font-size: 12px !important;
}
`

type MessageProps = {
  content?: string
}

function CodeRenderingScope({ children }: { children: ReactNode }) {
  return (
    <div data-code-rendering="">
      <style>{codeRenderingCss}</style>
      {children}
    </div>
  )
}

export function AssistantMessageCodeRenderingAdvice<P extends MessageProps>(
  Original: ComponentType<P>,
  props: P,
) {
  return (
    <CodeRenderingScope>
      <Original {...props} />
    </CodeRenderingScope>
  )
}

export function ThinkingBlockCodeRenderingAdvice<P extends MessageProps>(
  Original: ComponentType<P>,
  props: P,
) {
  return (
    <CodeRenderingScope>
      <Original {...props} />
    </CodeRenderingScope>
  )
}
