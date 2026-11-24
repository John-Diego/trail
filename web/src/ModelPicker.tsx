import { useEffect, useRef, useState } from 'react'
import { EFFORTS, MODELS } from '../../shared/types.ts'
import { useStore } from './store.ts'

function Menu<T extends { id: string; label: string; hint?: string }>({ label, value, options, onPick }: { label: string; value: string; options: readonly T[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const current = options.find((o) => o.id === value) ?? options[0]
  return (
    <div className="menu" ref={ref}>
      <button className="menu-button" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="menu-label">{label}</span> {current.label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="menu-list" role="listbox">
          {options.map((o) => (
            <button key={o.id} role="option" aria-selected={o.id === value} className={o.id === value ? 'on' : ''} onClick={() => (onPick(o.id), setOpen(false))}>
              <span>{o.label}</span>
              {o.hint && <span className="hint">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Model and effort used for every Claude request. Shown in the top bar and next to the chat box. */
export function ModelPicker() {
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  return (
    <div className="model-picker">
      <Menu label="Model" value={settings.model} options={MODELS} onPick={(model) => setSettings({ model })} />
      <Menu label="Effort" value={settings.effort} options={EFFORTS} onPick={(effort) => setSettings({ effort })} />
    </div>
  )
}

export function cycle(kind: 'model' | 'effort'): void {
  const { settings, setSettings } = useStore.getState()
  const list = kind === 'model' ? MODELS : EFFORTS
  const i = list.findIndex((o) => o.id === settings[kind])
  setSettings({ [kind]: list[(i + 1) % list.length].id })
}

export function settingsLabel(model: string, effort: string): string {
  const m = MODELS.find((o) => o.id === model)?.label ?? model
  const e = EFFORTS.find((o) => o.id === effort)?.label ?? effort
  return `${m} · ${e}`
}
