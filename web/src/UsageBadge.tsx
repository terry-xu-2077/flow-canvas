import { useEffect, useState } from 'react'
import { api } from './api'
import { BoltIcon } from './icons'

/** Flow account credits, shown next to the user name. Refreshes every minute and shortly after a job finishes. */
export default function UsageBadge() {
  const [credits, setCredits] = useState<number | null | undefined>(undefined)
  const [tip, setTip] = useState('')

  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      api.usage().then(u => {
        if (dead) return
        setCredits(u.credits)
        const daily = u.image_daily.map(d => `${d.name}：今日 ${d.used}/${d.limit}`).join('\n')
        setTip(`Flow 总额度：${u.credits ?? '未知'} 积分（所有用户共用）${daily ? `\n${daily}` : ''}`)
      }).catch(() => { if (!dead) setTip('额度暂时读取失败') })
    }
    const soon = () => { clearTimeout(timer); timer = setTimeout(load, 1500) }
    load()
    const iv = setInterval(load, 60000)
    window.addEventListener('fc-usage', soon)
    return () => { dead = true; clearInterval(iv); clearTimeout(timer); window.removeEventListener('fc-usage', soon) }
  }, [])

  return (
    <span className="usage" title={tip}>
      <BoltIcon />{credits === undefined ? '…' : credits === null ? '—' : credits.toLocaleString()}
    </span>
  )
}
