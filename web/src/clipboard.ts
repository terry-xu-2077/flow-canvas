import { assetUrl } from './api'

/** Re-encode any browser-readable image as PNG (the only image type the async clipboard API accepts). */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob
  const bmp = await createImageBitmap(blob)
  const c = document.createElement('canvas')
  c.width = bmp.width; c.height = bmp.height
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('转换失败'))), 'image/png'))
}

/** Old-style copy for pages that are not a secure context (http://192.168.x.x has no navigator.clipboard):
 *  put the image into a hidden editable element, select it and run the copy command. */
async function copyViaSelection(png: Blob): Promise<void> {
  const url = await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(new Error('图片读取失败')); fr.readAsDataURL(png)
  })
  const holder = document.createElement('div')
  holder.contentEditable = 'true'
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none'
  const img = document.createElement('img')
  holder.appendChild(img)
  document.body.appendChild(holder)
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('图片加载失败')); img.src = url })
    const sel = getSelection()!
    const prev = Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i))
    const range = document.createRange()
    range.selectNode(img)
    sel.removeAllRanges(); sel.addRange(range)
    const ok = document.execCommand('copy')
    sel.removeAllRanges(); prev.forEach(r => sel.addRange(r))
    if (!ok) throw new Error('浏览器拒绝了复制')
  } finally {
    holder.remove()
  }
}

/** Copy the original picture of an asset to the system clipboard as an image. */
export async function copyAssetImage(assetId: string): Promise<void> {
  const res = await fetch(assetUrl(assetId))
  if (!res.ok) throw new Error('图片读取失败')
  const png = await toPng(await res.blob())
  if (window.isSecureContext && navigator.clipboard && 'ClipboardItem' in window) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return
    } catch { /* permission denied or unsupported: try the selection method below */ }
  }
  await copyViaSelection(png)
}

/** Pictures copied inside the app are also remembered here, so Ctrl+V works on any board even when the browser
 *  refuses to put an image on the system clipboard (plain http pages on the LAN). */
const KEY = 'fc_clip'
export interface CopiedImage { id: string; w: number; h: number }
export const rememberCopied = (items: CopiedImage[]) => localStorage.setItem(KEY, JSON.stringify(items))
export function recallCopied(): CopiedImage[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(v) ? v.filter(x => x && typeof x.id === 'string') : []
  } catch { return [] }
}

/** The picture inside a pasted HTML fragment (data: URLs only), as a File. */
export async function imageFromHtml(html: string): Promise<File | null> {
  const m = html.match(/<img[^>]+src=["'](data:image\/[a-z+]+;base64,[^"']+)["']/i)
  if (!m) return null
  const blob = await (await fetch(m[1])).blob()
  return new File([blob], 'pasted.' + (blob.type.split('/')[1] || 'png'), { type: blob.type })
}
