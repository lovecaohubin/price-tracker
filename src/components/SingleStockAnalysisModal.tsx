import { useCallback, useEffect, useState } from 'react'
import type { SingleStockAnalysisResponse } from '../types'
import { fetchSingleStockAnalysis } from '../services/stockAnalysisApi'
import './SingleStockAnalysisModal.css'

interface Props {
  symbol: string | null
  name: string
  onClose: () => void
}

// ===== 格式化 =====
const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

const yi = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)} 亿`

const yiAbs = (v: number | null | undefined) =>
  v == null ? '—' : `${Math.abs(v / 1e8).toFixed(2)} 亿`

const num2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))

const numPct = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(2)}%`)

/**
 * 单只股票按需分析弹窗
 *  - 由「资产跟踪」页每张 AssetCard 上的「股票分析」按钮触发
 *  - 内容限定：今日行情底色 / 资金流向
 */
export default function SingleStockAnalysisModal({ symbol, name, onClose }: Props) {
  const [data, setData] = useState<SingleStockAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    if (!symbol) return
    setLoading(true)
    setError('')
    setData(null)
    try {
      const r = await fetchSingleStockAnalysis(symbol)
      setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [symbol])

  useEffect(() => {
    if (symbol) load()
  }, [symbol, load])

  useEffect(() => {
    if (!symbol) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [symbol, onClose])

  if (!symbol) return null

  return (
    <div className="ssa-mask" onClick={onClose}>
      <div
        className="ssa-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${name} 股票分析`}
      >
        <div className="ssa-head">
          <div>
            <h3>
              {data?.name ?? name} <span className="ssa-symbol">{symbol}</span>
              <span className="ssa-tag">股票分析</span>
            </h3>
            <span className="ssa-sub">
              {data
                ? `按需生成于 ${new Date(data.fetchedAt).toLocaleTimeString('zh-CN')}`
                : '按需分析'}
              ；仅含今日行情 / 资金流向
            </span>
          </div>
          <button className="ssa-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="ssa-body">
          {loading && <div className="ssa-loading">正在抓取东财数据（约 1-3 秒）…</div>}

          {data && data.missing.length > 0 && (
            <div className="ssa-warn">
              以下板块拉取失败：{data.missing.join('、')}（已降级为空）
            </div>
          )}

          {error && <div className="ssa-error">{error}</div>}

          {data && (
            <>
              {/* 一、今日行情底色 */}
              <section className="ssa-section">
                <h4>
                  <span className="ssa-num">一</span>
                  今日行情底色
                </h4>
                {data.quote ? (
                  <div className="ssa-quote-grid">
                    <div className="ssa-quote-main">
                      <span className="ssa-quote-close">
                        {num2(data.quote.close)}
                      </span>
                      <span
                        className={`ssa-quote-change ${(data.quote.changePct ?? 0) >= 0 ? 'up' : 'down'}`}
                      >
                        {pct(data.quote.changePct)}
                      </span>
                    </div>
                    <div className="ssa-quote-ohlc">
                      <span>开 {num2(data.quote.open)}</span>
                      <span>高 {num2(data.quote.high)}</span>
                      <span>低 {num2(data.quote.low)}</span>
                      <span>昨收 {num2(data.quote.prevClose)}</span>
                    </div>
                    <div className="ssa-quote-metrics">
                      <div>
                        <label>成交额</label>
                        <strong>{data.quote.turnoverYi != null ? `${data.quote.turnoverYi.toFixed(2)} 亿` : '—'}</strong>
                      </div>
                      <div>
                        <label>换手率</label>
                        <strong>{numPct(data.quote.turnoverRate)}</strong>
                      </div>
                      <div>
                        <label>量比</label>
                        <strong>{num2(data.quote.volumeRatio)}</strong>
                      </div>
                      <div>
                        <label>振幅</label>
                        <strong>{numPct(data.quote.amplitude != null ? data.quote.amplitude * 100 : null)}</strong>
                      </div>
                      <div>
                        <label>PE-TTM</label>
                        <strong>{num2(data.quote.peTtm)}</strong>
                      </div>
                      <div>
                        <label>PB</label>
                        <strong>{num2(data.quote.pb)}</strong>
                      </div>
                      <div>
                        <label>总市值</label>
                        <strong>{data.quote.marketCapTotalYi != null ? `${data.quote.marketCapTotalYi.toFixed(2)} 亿` : '—'}</strong>
                      </div>
                      <div>
                        <label>流通市值</label>
                        <strong>{data.quote.marketCapFloatYi != null ? `${data.quote.marketCapFloatYi.toFixed(2)} 亿` : '—'}</strong>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="ssa-empty">行情底色暂无数据</div>
                )}
                {data.quote && (
                  <p className="ssa-source">{data.sources.quote}</p>
                )}
              </section>

              {/* 二、资金流向 */}
              <section className="ssa-section">
                <h4>
                  <span className="ssa-num">二</span>
                  资金流向
                </h4>
                {data.flow ? (
                  <div className="ssa-flow">
                    <div className="ssa-flow-row ssa-flow-main">
                      <span>主力净流入</span>
                      <strong
                        className={(data.flow.main ?? 0) >= 0 ? 'up' : 'down'}
                      >
                        {yi(data.flow.main)}
                      </strong>
                      {data.flow.mainRatio != null && (
                        <span className="ssa-flow-sub">
                          主力净占比 {pct(data.flow.mainRatio)}
                        </span>
                      )}
                    </div>
                    <div className="ssa-flow-grid">
                      <div>
                        <label>超大单</label>
                        <strong className={(data.flow.super ?? 0) >= 0 ? 'up' : 'down'}>
                          {yi(data.flow.super)}
                        </strong>
                      </div>
                      <div>
                        <label>大单</label>
                        <strong className={(data.flow.big ?? 0) >= 0 ? 'up' : 'down'}>
                          {yi(data.flow.big)}
                        </strong>
                      </div>
                      <div>
                        <label>中单</label>
                        <strong className={(data.flow.mid ?? 0) >= 0 ? 'up' : 'down'}>
                          {yi(data.flow.mid)}
                        </strong>
                      </div>
                      <div>
                        <label>小单</label>
                        <strong className={(data.flow.small ?? 0) >= 0 ? 'up' : 'down'}>
                          {yi(data.flow.small)}
                        </strong>
                      </div>
                    </div>
                    <div className="ssa-flow-row">
                      <span>近 5 日主力合计</span>
                      <strong className={(data.flow.main5d ?? 0) >= 0 ? 'up' : 'down'}>
                        {yi(data.flow.main5d)}
                      </strong>
                    </div>
                    <p className="ssa-source">
                      {data.sources.flow}
                      <br />
                      {data.flow.methodologyNote}
                    </p>
                  </div>
                ) : (
                  <div className="ssa-empty">资金流向暂无数据</div>
                )}
              </section>

              {/* 四、融资融券（T+1 披露）：按需已移除 */}

              <p className="ssa-note">{data.note}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}