import { useEffect, useState } from 'react'
import { api, type CloudBalance } from './api'

const fmt = (v: number | string | null) => (typeof v === 'number' ? v.toLocaleString('zh-CN') : v == null || v === '?' ? '—' : String(v))

function tip(b: CloudBalance): string {
  const lines = [`${b.name}：${b.ok ? `${fmt(b.balance)} 积分` : b.error || '未读到'}`]
  if (b.expire) lines.push(`到期 ${b.expire}`)
  for (const [k, v] of Object.entries(b.detail)) if (v !== '' && v != null) lines.push(`${k} ${typeof v === 'number' ? v.toLocaleString('zh-CN') : v}`)
  if (b.unlimited.length) {
    lines.push('无限低速生成：')
    for (const u of b.unlimited) lines.push(`  ${u.name}${u.condition ? `（${u.condition}）` : ''} 还剩 ${u.days} 天`)
  }
  return lines.join('\n')
}

/** Credits left on 小云雀 / LibTV / Lovart (from terry2api), shown next to the Flow quota; hidden when the cloud service is off.
 *  Refreshes every two minutes and shortly after a video finishes. */
export default function CloudBadge() {
  const [items, setItems] = useState<CloudBalance[]>([])
  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      api.videoBalances().then(r => { if (!dead) setItems(r.enabled ? r.items : []) }).catch(() => {})
    }
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 4000) }
    load()
    const iv = setInterval(load, 120000)
    window.addEventListener('fc-usage', soon)
    return () => { dead = true; clearInterval(iv); clearTimeout(timer); window.removeEventListener('fc-usage', soon) }
  }, [])
  if (!items.length) return null
  return (
    <span className="cloud-credits">
      {items.map(b => (
        <span key={b.provider} className={`cc-pill${b.ok ? '' : ' bad'}`} title={tip(b)}>
          <span className="cc-name">{b.name}</span>
          <span className="cc-num">{b.ok ? fmt(b.balance) : '—'}</span>
          {b.unlimited.length > 0 && <span className="cc-inf" title="有无限低速生成">∞</span>}
        </span>
      ))}
    </span>
  )
}
