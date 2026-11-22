import type { ModelInfo } from './api'

/** Quality tiers a card offers for this model at this size ('' = the platform's default). Users without credit-model access only
 *  get the pairs listed in `combos`; everyone else gets every tier the model has. */
export function qualityOptions(model: Pick<ModelInfo, 'qualities' | 'combos'> | undefined, size: string): string[] {
  if (!model) return []
  if (model.combos) {
    const list = model.combos.filter(c => c[0] === size).map(c => c[1])
    return list.length > 1 || (list.length === 1 && list[0] !== '') ? list : []
  }
  return model.qualities?.length ? ['', ...model.qualities] : []
}

/** The saved quality if it is still offered, else the first offered one ('' when the model has no quality option). */
export function pickQuality(model: Pick<ModelInfo, 'qualities' | 'combos'> | undefined, size: string, saved?: string): string {
  const opts = qualityOptions(model, size)
  const want = saved ?? ''
  return opts.includes(want) ? want : (model?.combos ? (opts[0] ?? '') : '')
}

export const QUALITY_ZH: Record<string, string> = {
  '': '默认', auto: '自动', low: '低', std: '标准', medium: '中', high: '高', xhigh: '超高', max: '极致', pro: '专业',
}
