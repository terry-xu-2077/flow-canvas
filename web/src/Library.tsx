import { useEffect, useState } from 'react'
import { api, assetUrl, downloadUrl, type LibraryItem } from './api'

type Tab = 'generated' | 'uploaded'

/** Recycle bin: centered pop-up with everything the user generated or uploaded before: download an item or put it on the canvas again. */
export function Library({ onClose, onPlace, onPreview }: {
  onClose: () => void; onPlace: (item: LibraryItem) => void; onPreview: (asset: string) => void
}) {
  const [data, setData] = useState<{ generated: LibraryItem[]; uploaded: LibraryItem[] } | null>(null)
  const [tab, setTab] = useState<Tab>('generated')
  const [error, setError] = useState('')
  useEffect(() => { api.library().then(setData).catch(e => setError(String(e.message || e))) }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.lightbox')) onClose() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const items = data?.[tab] ?? []
  return (
    <div className="lib-back" onClick={onClose}>
      <div className="lib" onClick={e => e.stopPropagation()}>
        <div className="lib-head">
          <strong>回收站</strong>
          <div className="seg lib-tabs">
            <button className={tab === 'generated' ? 'on' : ''} onClick={() => setTab('generated')}>生成内容{data ? ` · ${data.generated.length}` : ''}</button>
            <button className={tab === 'uploaded' ? 'on' : ''} onClick={() => setTab('uploaded')}>上传内容{data ? ` · ${data.uploaded.length}` : ''}</button>
          </div>
          <span className="lib-gap" />
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        <div className="lib-note">这里的内容会不定期被清理，需要保留的请及时下载，或放回画布。</div>
        <div className="lib-body">
          {error && <div className="banner">{error}</div>}
          {!data && !error && <div className="hint">加载中…</div>}
          {data && items.length === 0 && <div className="hint">{tab === 'generated' ? '还没有生成过内容' : '还没有上传过图片'}</div>}
          <div className="lib-grid">
            {items.map(it => (
              <div key={it.asset} className="lib-item" title={it.prompt} onClick={() => onPreview(it.asset)}>
                <img src={assetUrl(it.asset, 320)} alt="" loading="lazy" draggable={false} />
                <span className="lib-size">{it.w}×{it.h}</span>
                <div className="lib-actions" onClick={e => e.stopPropagation()}>
                  <button className="primary" onClick={() => onPlace(it)}>放到画布</button>
                  <a className="btn" href={downloadUrl(it.asset)}>下载</a>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
