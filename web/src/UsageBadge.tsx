import { useEffect, useState } from 'react'
import { api, type GptQuota, type GptWindow } from './api'

interface Quota { name: string; used: number; limit: number }

const frac = (w: GptWindow) => (w.limit ? Math.min(1, w.used / w.limit) : 0)
const level = (f: number) => (f >= 0.9 ? 'hot' : f >= 0.7 ? 'warm' : '')
const wait = (s: number | null) => (s ? (s >= 5400 ? `约 ${Math.round(s / 3600)} 小时` : `约 ${Math.max(1, Math.round(s / 60))} 分钟`) : '')

function gptTip(q: GptQuota): string {
  const line = (label: string, w: GptWindow) =>
    `${label}：已生成 ${w.used} / ${w.limit || '不限'}${w.limit && w.resets_in ? `（${wait(w.resets_in)}后恢复 1 张）` : ''}`
  return [line('最近 1 小时', q.hour), line('最近 24 小时', q.day),
    '（OpenAI 没有公布 Plus 的生图额度，这是聚合API为避免被锁定自行设置的上限）'].join('\n')
}

/** Today's Nano Banana 2.1 allowance (one shared Flow account) and, when the ChatGPT model is set up, its hourly and
 *  daily image quota in a second pill of the same height; both sit next to the user name.
 *  Refreshes every minute and shortly after a job finishes. */
export default function UsageBadge() {
  const [quota, setQuota] = useState<Quota | null | undefined>(undefined)
  const [gpt, setGpt] = useState<GptQuota | null>(null)
  const [tip, setTip] = useState('')

  useEffect(() => {
    let dead = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      api.usage().then(u => {
        if (dead) return
        const main = u.image_daily.find(d => d.name.includes('2.1'))
        setQuota(main ? { name: main.name, used: main.used, limit: main.limit } : null)
        setGpt(u.gpt ?? null)
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

  if (quota === null && !gpt) return null
  const pct = quota ? Math.min(100, Math.round((quota.used / Math.max(1, quota.limit)) * 100)) : 0
  const fill = quota && quota.used > 0 ? Math.max(pct, 3) : 0 // a little used should still show
  return (
    <span className="usage combo">
      {quota !== null && (
        <span className={`usage-seg${pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''}`} title={tip}>
          <span className="usage-row"><span className="usage-name">{quota ? quota.name.replace(/\s*\/.*$/, '') : '…'}</span></span>
          <span className="usage-bar"><i style={{ width: `${fill}%` }} /></span>
        </span>
      )}
      {gpt && <GptUsage q={gpt} />}
    </span>
  )
}

/** ChatGPT image quota: the bar is split in two, last hour on the left and last 24 hours on the right; the numbers are in the tooltip. */
function GptUsage({ q }: { q: GptQuota }) {
  const seg = (w: GptWindow) => {
    const f = frac(w)
    return <b className={level(f)}><i style={{ width: `${w.used > 0 ? Math.max(f * 100, 4) : 0}%` }} /></b>
  }
  return (
    <span className="usage-seg" title={gptTip(q)}>
      <span className="usage-row"><span className="usage-name">GPT Image</span></span>
      <span className="usage-bar split">{seg(q.hour)}{seg(q.day)}</span>
    </span>
  )
}
