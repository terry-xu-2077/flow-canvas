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
  const url = URL.createObjectURL(png)
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
    URL.revokeObjectURL(url)
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
