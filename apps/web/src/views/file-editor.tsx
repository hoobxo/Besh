import { useEffect, useRef } from "react"
import { basicSetup } from "codemirror"
import { Compartment, EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { indentWithTab } from "@codemirror/commands"
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { json } from "@codemirror/lang-json"
import { yaml } from "@codemirror/lang-yaml"
import { shell } from "@codemirror/legacy-modes/mode/shell"
import { nginx } from "@codemirror/legacy-modes/mode/nginx"
import { toml } from "@codemirror/legacy-modes/mode/toml"
import { properties } from "@codemirror/legacy-modes/mode/properties"
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile"
import { tags, type Tag } from "@lezer/highlight"
import type { Extension } from "@codemirror/state"
import { editorModeFor, type EditorMode } from "@/lib/text-file"

const LANGUAGES: Record<EditorMode, () => Extension | null> = {
  shell: () => StreamLanguage.define(shell),
  json: () => json(),
  yaml: () => yaml(),
  nginx: () => StreamLanguage.define(nginx),
  toml: () => StreamLanguage.define(toml),
  ini: () => StreamLanguage.define(properties),
  dockerfile: () => StreamLanguage.define(dockerFile),
  text: () => null,
}

function rule(tag: Tag | readonly Tag[], color: string, italic = false) {
  return { tag, color, ...(italic ? { fontStyle: "italic" } : {}) }
}

const highlightStyle = HighlightStyle.define([
  rule([tags.keyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword], "var(--syntax-keyword)"),
  rule([tags.string, tags.special(tags.string), tags.regexp], "var(--syntax-string)"),
  rule([tags.comment, tags.blockComment, tags.lineComment], "var(--syntax-comment)", true),
  rule([tags.number, tags.bool, tags.null, tags.integer, tags.float], "var(--syntax-number)"),
  rule([tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], "var(--syntax-function)"),
  rule([tags.variableName, tags.propertyName, tags.attributeName], "var(--syntax-variable)"),
  rule([tags.typeName, tags.className, tags.tagName, tags.heading], "var(--syntax-type)"),
  rule([tags.operator, tags.punctuation, tags.separator, tags.meta], "var(--muted-foreground)"),
])

const editorTheme = EditorView.theme({
  "&": { fontSize: "13px", color: "var(--foreground)" },
  ".cm-content, .cm-gutter": { fontFamily: "inherit" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px" },
})

const MAX_HEIGHT_HOST = "h-full"

export function FileEditor({
  path,
  value,
  readOnly,
  onSave,
  onChange,
}: {
  path: string
  value: string
  readOnly: boolean
  onSave: () => void
  onChange: (text: string) => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const editable = useRef(new Compartment())
  const handlers = useRef({ onSave, onChange })
  handlers.current = { onSave, onChange }

  useEffect(() => {
    const element = host.current
    if (!element) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => { handlers.current.onSave(); return true } },
          indentWithTab,
        ]),
        editorTheme,
        syntaxHighlighting(highlightStyle),
        LANGUAGES[editorModeFor(path)]() ?? [],
        editable.current.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
        }),
      ],
    })
    const instance = new EditorView({ state, parent: element })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
    // A different file rebuilds the view; same-file edits flow through onChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    instance.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)) })
  }, [readOnly])

  useEffect(() => {
    const instance = view.current
    if (!instance) return
    const current = instance.state.doc.toString()
    if (current === value) return
    instance.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  return <div ref={host} className={`cm-host ${MAX_HEIGHT_HOST} overflow-hidden`} />
}
