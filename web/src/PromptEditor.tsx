/* Prompt editor with <Picture N> chips and an @ menu (same idea and tag format as the CloudGen ComfyUI editor).
 * The stored value is always the raw text; chips are only how it is shown. */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { assetUrl } from './api'

export interface RefInfo { key: string; assetId: string; w: number; h: number; note?: string }

const CARET = '​'
const TOKEN = /<Picture\s+(\d+)>/gi

function makeChip(index: number, ref?: RefInfo) {
  const chip = document.createElement('span')
  chip.className = `pchip${ref ? '' : ' missing'}`
  chip.contentEditable = 'false'
  chip.dataset.raw = `<Picture ${index}>`
  if (ref) {
    const img = document.createElement('img')
    img.src = assetUrl(ref.assetId, 96)
    img.alt = ''
    img.draggable = false
    chip.append(img)
  } else {
    const ic = document.createElement('span')
    ic.className = 'ic'
    ic.textContent = '▧'
    chip.append(ic)
  }
  const label = document.createElement('span')
  label.textContent = `图${index}`
  chip.append(label)
  chip.title = ref ? `第 ${index} 张参考图` : `没有第 ${index} 张参考图：把画布上的图片连线到本卡片`
  return chip
}

function appendText(el: Node, text: string) {
  text.split('\n').forEach((part, i) => {
    if (i) el.appendChild(document.createElement('br'))
    if (part) el.appendChild(document.createTextNode(part))
  })
}

function renderRich(el: HTMLElement, raw: string, refs: (RefInfo | undefined)[]) {
  el.replaceChildren()
  let last = 0
  for (const m of raw.matchAll(TOKEN)) {
    appendText(el, raw.slice(last, m.index))
    const n = Number(m[1])
    el.appendChild(makeChip(n, refs[n - 1]))
    last = (m.index ?? 0) + m[0].length
  }
  appendText(el, raw.slice(last))
}

function serialize(root: Node): string {
  let out = ''
  const walk = (parent: Node) => {
    parent.childNodes.forEach(c => {
      if (c.nodeType === Node.TEXT_NODE) { out += (c.nodeValue ?? '').replaceAll(CARET, ''); return }
      if (c.nodeType !== Node.ELEMENT_NODE) return
      const e = c as HTMLElement
      if (e.dataset?.raw != null) { out += e.dataset.raw; return }
      if (e.tagName === 'BR') { out += '\n'; return }
      const block = /^(DIV|P|LI)$/.test(e.tagName)
      if (block && out && !out.endsWith('\n')) out += '\n'
      if (!(block && e.childNodes.length === 1 && (e.firstChild as HTMLElement).tagName === 'BR')) walk(e)
    })
  }
  walk(root)
  return out
}

interface Menu { q: string; active: number; x: number; y: number; chip: HTMLElement | null }

export default function PromptEditor(props: {
  value: string; refs: (RefInfo | undefined)[]; onChange: (v: string) => void; onSubmit: () => void
}) {
  const { value, refs, onChange, onSubmit } = props
  const el = useRef<HTMLDivElement>(null)
  const emitted = useRef(value)         // last value this editor produced itself
  const rangeRef = useRef<Range | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const refsKey = refs.map(r => r?.assetId ?? '-').join(',')
  const shownKey = useRef('')

  const items = refs.flatMap((r, i) => (r ? [{ ...r, index: i + 1 }] : []))
    .filter(r => !menu?.q || `图${r.index}${r.note ?? ''}picture${r.index}`.toLowerCase().includes(menu.q))

  // Re-render the editor content when the value changes from outside, the references change, or the view mode flips.
  useEffect(() => {
    const node = el.current
    if (!node) return
    const key = refsKey
    const typing = document.activeElement === node && value === emitted.current && shownKey.current === key
    if (typing) return
    shownKey.current = key
    renderRich(node, value, refs)
  }, [value, refsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const read = () => serialize(el.current!)
  const emit = () => { const v = read(); emitted.current = v; onChange(v) }

  const insertNodes = (range: Range, nodes: Node[]) => {
    range.deleteContents()
    const marker = document.createTextNode(CARET)
    const frag = document.createDocumentFragment()
    nodes.forEach(n => frag.appendChild(n))
    frag.appendChild(marker)
    range.insertNode(frag)
    const sel = getSelection()!
    const r = document.createRange()
    r.setStart(marker, marker.length)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
    el.current?.focus({ preventScroll: true })
    emit()
  }

  const caretHit = () => {
    const sel = getSelection()
    if (!sel?.rangeCount || !sel.isCollapsed || !el.current) return null
    const r = sel.getRangeAt(0)
    let n: Node = r.startContainer
    let off = r.startOffset
    if (!el.current.contains(n)) return null
    if (n.nodeType !== Node.TEXT_NODE) {
      const prev = n.childNodes[off - 1]
      if (prev?.nodeType !== Node.TEXT_NODE) return null
      n = prev
      off = (prev as Text).length
    }
    const full = (n.nodeValue ?? '').slice(0, off)
    const m = full.replaceAll(CARET, '').match(/[@＠]([^\s@＠]{0,12})$/)
    if (!m) return null
    const at = Math.max(full.lastIndexOf('@'), full.lastIndexOf('＠'))
    const range = document.createRange()
    range.setStart(n, at)
    range.setEnd(n, off)
    return { range, q: m[1].toLowerCase() }
  }

  const place = (rect: DOMRect | undefined) => {
    const box = el.current!.getBoundingClientRect()
    const r = rect && (rect.width || rect.height) ? rect : box
    const w = 280
    return {
      x: Math.max(8, Math.min(r.left, innerWidth - w - 8)),
      y: r.bottom + 6 + 300 > innerHeight ? Math.max(8, r.top - 306) : r.bottom + 6,
    }
  }

  const onInput = (e: React.FormEvent) => {
    emit()
    if ((e.nativeEvent as InputEvent).isComposing) return
    const hit = caretHit()
    if (hit) {
      rangeRef.current = hit.range
      setMenu(m => ({ q: hit.q, active: m?.chip ? 0 : Math.min(m?.active ?? 0, 99), chip: null, ...place(hit.range.getBoundingClientRect()) }))
    } else if (menu && !menu.chip) setMenu(null)
  }

  const choose = (index: number) => {
    const chip = makeChip(index, refs[index - 1])
    if (menu?.chip) { menu.chip.replaceWith(chip); emit() }
    else if (rangeRef.current) insertNodes(rangeRef.current, [chip])
    setMenu(null)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (menu && !e.nativeEvent.isComposing) {
      const n = items.length
      if (e.key === 'ArrowDown' && n) setMenu({ ...menu, active: (menu.active + 1) % n })
      else if (e.key === 'ArrowUp' && n) setMenu({ ...menu, active: (menu.active - 1 + n) % n })
      else if ((e.key === 'Enter' || e.key === 'Tab') && n) choose(items[Math.min(menu.active, n - 1)].index)
      else if (e.key === 'Escape') setMenu(null)
      else return
      e.preventDefault()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSubmit() }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const text = e.clipboardData.getData('text/plain')
    const sel = getSelection()
    if (!sel?.rangeCount) return
    const tmp = document.createElement('div')
    renderRich(tmp, text, refs)
    insertNodes(sel.getRangeAt(0), [...tmp.childNodes])
  }

  const onCopy = (e: React.ClipboardEvent) => {
    const sel = getSelection()
    if (!sel?.rangeCount || sel.isCollapsed) return
    const text = serialize(sel.getRangeAt(0).cloneContents())
    if (!text) return
    e.preventDefault()
    e.clipboardData.setData('text/plain', text)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const chip = (e.target as HTMLElement).closest?.('.pchip') as HTMLElement | null
    if (chip && el.current?.contains(chip)) {
      e.preventDefault()
      setMenu({ q: '', active: 0, chip, ...place(chip.getBoundingClientRect()) })
    }
  }

  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest?.('.at-menu') && !el.current?.contains(t)) setMenu(null)
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [menu])

  const onBlur = () => {
    emit()
    setTimeout(() => {
      const node = el.current
      if (!node || document.activeElement === node) return
      setMenu(null)
      shownKey.current = refsKey
      renderRich(node, emitted.current, refs)
    }, 120)
  }

  const present = refs.filter(Boolean).length

  return (
    <div className="pe-wrap nodrag nowheel nopan">
      <div
        ref={el} className="pe" contentEditable suppressContentEditableWarning spellCheck={false}
        data-placeholder="描述你想生成的画面…（@ 引用参考图，Ctrl+Enter 生成）"
        onInput={onInput} onKeyDown={onKeyDown} onKeyUp={e => e.stopPropagation()} onPaste={onPaste} onCopy={onCopy}
        onPointerDown={onPointerDown} onBlur={onBlur}
      />
      {menu && createPortal(
        <div className="at-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}>
          <div className="at-head"><b>{menu.chip ? '替换引用' : '引用参考'}</b><span>↑↓ 选择 · Enter 插入 · Esc 关闭</span></div>
          {items.map((r, i) => (
            <div key={r.index} className={`at-row${i === Math.min(menu.active, items.length - 1) ? ' on' : ''}`}
                 onMouseEnter={() => setMenu(m => (m ? { ...m, active: i } : m))} onPointerDown={() => choose(r.index)}>
              <div className="at-thumb"><img src={assetUrl(r.assetId, 96)} alt="" /></div>
              <div className="at-info"><b>图 {r.index}<span className="at-tag">参考图</span></b>
                <small>{r.note ?? `${r.w} × ${r.h}`}</small></div>
            </div>
          ))}
          {!items.length && (
            <div className="at-empty">
              {present ? '没有匹配的参考图' : '还没有参考图。把画布上图片右侧的圆点连线到本卡片，再用 @ 引用'}
            </div>
          )}
        </div>, document.body)}
    </div>
  )
}
