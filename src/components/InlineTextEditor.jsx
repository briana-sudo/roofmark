// ============================================================================
// InlineTextEditor.jsx — Phase 2 sub-step 18k (May 12 2026)
//
// Absolutely-positioned single-line text input that overlays the canvas
// at a specified screen-space anchor. Used by:
//   - Technical Drawing callout tool (text-entry after tip+tail placement)
//   - Future: linear dim textOverride editor (18e.2 — not in 18k scope)
//   - Future: angular dim textOverride editor (18k.2 — not in 18k scope)
//
// Keyboard contract per 18k spec D10:
//   Enter         → onCommit(currentValue)
//   Escape        → onCancel()
//   Tab           → onCommit(currentValue) + native focus advance
//   click-outside → onCommit(currentValue)
//
// Auto-focuses on mount. Input is contained in a small positioned div so
// the keyboard handler can attach at the input level; the click-outside
// listener attaches at the document level and ignores events inside the
// container.
//
// Pure presentational + local state. Parent owns visibility (mount /
// unmount) and the onCommit / onCancel handlers.
// ============================================================================

import { useEffect, useRef, useState } from 'react'

export default function InlineTextEditor({
  x,
  y,
  initialValue,
  placeholder,
  onCommit,
  onCancel,
  autoFocus = true,
  maxLength = 80,
}) {
  const [value, setValue] = useState(
    typeof initialValue === 'string' ? initialValue : ''
  )
  const inputRef = useRef(null)
  const containerRef = useRef(null)
  // Stable ref to the latest value + handlers so the document
  // mousedown listener doesn't need to re-attach on every keystroke.
  const valueRef = useRef(value)
  valueRef.current = value
  const handlersRef = useRef({ onCommit, onCancel })
  handlersRef.current = { onCommit, onCancel }

  // Auto-focus on mount.
  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [autoFocus])

  // Click-outside commits the current value. We listen on the document's
  // mousedown so the listener fires before the click target's handlers,
  // matching standard popover behavior.
  useEffect(() => {
    const onDocMouseDown = (e) => {
      const c = containerRef.current
      if (!c) return
      if (c.contains(e.target)) return
      const fn = handlersRef.current.onCommit
      if (typeof fn === 'function') fn(valueRef.current)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const onKeyDown = (e) => {
    // Stop bubbling so global App-level shortcuts (A/C/L/S/P/etc.)
    // don't fire while the operator is typing in the editor.
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const fn = handlersRef.current.onCommit
      if (typeof fn === 'function') fn(value)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const fn = handlersRef.current.onCancel
      if (typeof fn === 'function') fn()
      return
    }
    if (e.key === 'Tab') {
      // Don't preventDefault — let the browser advance focus naturally.
      // Commit first so the value is persisted before the input unmounts.
      const fn = handlersRef.current.onCommit
      if (typeof fn === 'function') fn(value)
      // Don't stopPropagation — global handlers should not respond to
      // bare Tab anyway.
      return
    }
    // Any other key (printable, arrows, backspace, etc.) — let it
    // through to the input but stop bubbling so the App-level shortcut
    // listener doesn't see 'a' / 'c' / 'l' / 's' while typing.
    e.stopPropagation()
  }

  const onChange = (e) => {
    setValue(e.target.value)
  }

  return (
    <div
      ref={containerRef}
      className="inline-text-editor"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 900,
      }}
      data-testid="inline-text-editor"
    >
      <input
        ref={inputRef}
        type="text"
        className="inline-text-editor-input"
        value={value}
        placeholder={placeholder || ''}
        maxLength={maxLength}
        onChange={onChange}
        onKeyDown={onKeyDown}
        data-testid="inline-text-editor-input"
      />
    </div>
  )
}
