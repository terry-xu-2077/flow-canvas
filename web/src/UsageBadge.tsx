import { useEffect, useState } from 'react'
import { api } from './api'

interface Quota { name: string; used: number; limit: number }

/** Today's Nano Banana 2.1 allowance (one shared Flow account), shown next to the user name.
 *  Refreshes every minute and shortly after a job finishes. */
export default function UsageBadge() {
  const [quota, setQuota] = useState<Quota | null | undefined>(undefined)
  const [tip, setTip] = useState('')

  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      api.usage().then(u => {
        if (dead) return
        const main = u.image_daily.find(d => d.name.includes('2.1'))
        setQuota(main ? { name: main.name, used: main.used, limit: main.limit } : null)
        const lines = u.image_daily.map(d => `${d.name}：今日已用 ${d.used} / ${d.limit}`)
        setTip([...lines, '（所有用户共用同一个 Flow 账号，按天计算）'].join('\n'))
      }).catch(() => { if (!dead) setTip('额度暂时读取失败') })
    }
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 1500) }
    load()
    const iv = setInterval(load, 60000)
    window.addEventListener('fc-usage', soon)
    return () => { dead = true; clearInterval(iv); clearTimeout(timer); window.removeEventListener('fc-usage', soon) }
  }, [])

  if (quota === null) return null
  const pct = quota ? Math.min(100, Math.round((quota.used / Math.max(1, quota.limit)) * 100)) : 0
  const fill = quota && quota.used > 0 ? Math.max(pct, 3) : 0 // a little used should still show
  return (
    <span className={`usage${pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''}`} title={tip}>
      <span className="usage-row">
        <span className="usage-name">{quota ? quota.name.replace(/\s*\/.*$/, '') : ''}</span>
        <span className="usage-num">{quota ? `${quota.used} / ${quota.limit}` : '…'}</span>
      </span>
      <span className="usage-bar"><i style={{ width: `${fill}%` }} /></span>
    </span>
  )
}
