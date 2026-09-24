import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ZtListItem, ZtDetailResponse } from '../types'
import { fetchZtList, fetchZtDetail } from '../services/ztApi'
import { useDailyScheduler } from '../hooks/useDailyScheduler'
import './ZtListPanel.css'

// ===== 格式化 =====
const pct = (v: number | null | undefined) => {
  if (v == null) return '—'
  const sign = v >= 0 ? '+' : ''
  return `${sign}${(v * 100).toFixed(2)}%`
}
const yuan2yi = (yuan: number | null | undefined) => {
  if (yuan == null) return '—'
  const sign = yuan >= 0 ? '+' : ''
  return `${sign}${(yuan / 1e8).toFixed(2)} 亿`
}
const wanShou = (hands: number | null | undefined) => {
  if (hands == null) return '—'
  // 1 手 = 100 股
  const wan = (hands * 100) / 1e4
  if (wan >= 10000) return `${(wan / 10000).toFixed(2)} 亿股`
  return `${wan.toFixed(0)} 万股`
}
const yuanYiAbs = (yuan: number | null | undefined) => {
  if (yuan == null) return '—'
  return `${Math.abs(yuan / 1e8).toFixed(2)} 亿`
}

type Tab = 'first' | 'all'

interface Props {
  /** 是否渲染"详情"区域（默认 true） */
  showDetail?: boolean
}

export default function ZtListPanel({ showDetail = true }: Props) {
  const [list, setList] = useState<ZtListItem[]>([])
  const [firstBoard, setFirstBoard] = useState<ZtListItem[]>([])
  const [fetchedAt, setFetchedAt] = useState('')
  const [tradeDate, setTradeDate] = useState('')
  const [note, setNote] = useState('')
  const [stale, setStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('first')

  const [selected, setSelected] = useState<ZtListItem | null>(null)
  const [detail, setDetail] = useState<ZtDetailResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  // 拉列表
  const loadList = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchZtList()
      setList(r.items)
      setFirstBoard(r.firstBoard)
      setFetchedAt(r.fetchedAt)
      setTradeDate(r.tradeDate)
      setNote(r.note)
      setStale(r.stale ?? false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 每天 15:05 定时刷新
  const nextSchedule = useDailyScheduler(() => void loadList(), 15, 5)

  useEffect(() => {
    // 进入页面不自动刷新；用户点击「数据更新」或每日 15:05 定时触发
  }, [])

  // 切换 tab 时清空选中
  useEffect(() => {
    setSelected(null)
    setDetail(null)
    setDetailError('')
  }, [tab])

  // 拉详情
  const handleSelect = useCallback(
    async (item: ZtListItem) => {
      setSelected(item)
      setDetail(null)
      setDetailError('')
      setDetailLoading(true)
      try {
        const r = await fetchZtDetail(item.symbol)
        setDetail(r)
      } catch (e) {
        setDetailError(e instanceof Error ? e.message : String(e))
      } finally {
        setDetailLoading(false)
      }
    },
    [],
  )

  const handleCloseDetail = useCallback(() => {
    setSelected(null)
    setDetail(null)
    setDetailError('')
  }, [])

  const currentList = tab === 'first' ? firstBoard : list
  const sortedItems = useMemo(() => {
    // 首板按封单金额降序，连板放后面
    return [...currentList].sort((a, b) => {
      if (tab === 'first') {
        return (b.sealedAmt ?? 0) - (a.sealedAmt ?? 0)
      }
      // "全部" tab：先按首板/连板分组，再按封单金额降序
      if (a.isFirstBoard !== b.isFirstBoard) return a.isFirstBoard ? -1 : 1
      return (b.sealedAmt ?? 0) - (a.sealedAmt ?? 0)
    })
  }, [currentList, tab])

  const summary = useMemo(() => {
    if (!list.length) return null
    const firstUp = firstBoard.length
    const all = list.length
    const totalSealed = list.reduce((a, b) => a + (b.sealedAmt ?? 0), 0)
    const totalMain = list.reduce((a, b) => a + (b.mainNet ?? 0), 0)
    return {
      firstUp,
      totalSealedYi: totalSealed / 1e8,
      totalMainYi: totalMain / 1e8,
      all,
    }
  }, [list, firstBoard])

  const fetchedTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })
    : ''

  return (
    <aside className="zt-panel">
      <div className="zt-head">
        <div className="zt-head-titles">
          <h3>首版涨停</h3>
          {fetchedTime && (
            <span className="zt-subtitle">更新 {fetchedTime}</span>
          )}
        </div>
        <button
          className={`zt-btn-refresh${loading ? ' is-loading' : ''}`}
          onClick={() => void loadList()}
          disabled={loading}
          title="手动拉取今日涨停股池数据"
        >
          <span className="zt-btn-icon" aria-hidden="true">⟳</span>
          <span>数据更新</span>
          {loading && <span className="zt-btn-loading-dot" />}
        </button>
      </div>

      {nextSchedule && (
        <div className="zt-next-tick">
          下次定时 {nextSchedule.toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      )}

      <div className="zt-tabs">
        <button
          className={`zt-tab ${tab === 'first' ? 'active' : ''}`}
          onClick={() => setTab('first')}
        >
          首板<span className="zt-count">{firstBoard.length}</span>
        </button>
        <button
          className={`zt-tab ${tab === 'all' ? 'active' : ''}`}
          onClick={() => setTab('all')}
        >
          全部涨停<span className="zt-count">{list.length}</span>
        </button>
      </div>

      {summary && (
        <div className="zt-summary">
          <span>
            <strong>{summary.firstUp}</strong> 只首板
          </span>
          <span>
            <strong>{summary.all}</strong> 只涨停
          </span>
          <span>
            封单合计 <strong>{summary.totalSealedYi.toFixed(2)} 亿</strong>
          </span>
          <span>
            主力净流入 <strong className={summary.totalMainYi >= 0 ? 'zt-stat-first' : ''}>
              {summary.totalMainYi >= 0 ? '+' : ''}{summary.totalMainYi.toFixed(1)} 亿
            </strong>
          </span>
        </div>
      )}

      {loading && !list.length && <div className="zt-loading">加载涨停股池…</div>}
      {error && <div className="zt-error">{error}</div>}
      {!loading && !error && !sortedItems.length && (
        !fetchedAt ? (
          <div className="zt-empty">
            暂无数据，点击顶部「数据更新」拉取今日涨停股池。
            <br />
            <span className="zt-empty-hint">
              每天 15:05 自动定时刷新一次；上次刷新：{fetchedTime || '—'}
            </span>
          </div>
        ) : stale ? (
          <div className="zt-empty">
            接口暂不可用（涨停股池拉取失败），请稍后重试。
            <br />
            <span className="zt-empty-hint">网络层常见原因：东财 CDN 临时限流 / 本地出口被连接重置。</span>
          </div>
        ) : (
          <div className="zt-empty">
            今日暂无{tab === 'first' ? '首板涨停' : '涨停'}股票（盘后或非交易日）。
          </div>
        )
      )}

      <div className="zt-table-wrap">
        <table className="zt-table">
          <thead>
            <tr>
              <th className="zt-th-name">名称</th>
              <th className="zt-th-code">代码</th>
              <th className="zt-th-board">板数</th>
              <th className="zt-th-price">价格</th>
              <th className="zt-th-change">涨幅</th>
              <th className="zt-th-industry">行业</th>
              <th className="zt-th-volume">成交量</th>
              <th className="zt-th-main">主力净额</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((it) => (
              <ZtRow
                key={it.symbol}
                item={it}
                active={selected?.symbol === it.symbol}
                onClick={() => void handleSelect(it)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {showDetail && selected && (
        <div className="zt-detail">
          <div className="zt-detail-head">
            <div>
              <div className="zt-detail-name">
                {selected.name}
                <span className="zt-board-badge" style={{ marginLeft: 6 }}>
                  {selected.isFirstBoard ? '首板' : `${selected.boardCount} 连板`}
                </span>
              </div>
              <div className="zt-detail-meta">
                {selected.symbol.toUpperCase()} · {selected.price.toFixed(2)} 元 ·{' '}
                {pct(selected.changePct)}
              </div>
            </div>
            <button className="zt-detail-close" onClick={handleCloseDetail} title="关闭详情">
              ✕
            </button>
          </div>

          {detailLoading && <div className="zt-detail-loading">加载详情中…</div>}
          {detailError && <div className="zt-detail-error">{detailError}</div>}

          {detail && <ZtDetailBody detail={detail} />}
        </div>
      )}

      {note && <div className="zt-note">{note}</div>}
    </aside>
  )
}

// ===== 表格行 =====
function ZtRow({
  item,
  active,
  onClick,
}: {
  item: ZtListItem
  active: boolean
  onClick: () => void
}) {
  const isUp = item.changePct >= 0
  return (
    <tr
      className={`zt-row ${active ? 'is-active' : ''}`}
      onClick={onClick}
    >
      <td className="zt-td-name">
        <span className="zt-name">{item.name}</span>
      </td>
      <td className="zt-td-code">{item.code}</td>
      <td className="zt-td-board">
        <span
          className={`zt-board-badge ${item.isFirstBoard ? '' : 'is-consecutive'}`}
          title={item.isFirstBoard ? '本次连板的首板' : `连续 ${item.boardCount} 个涨停`}
        >
          {item.isFirstBoard ? '首板' : `${item.boardCount} 连板`}
        </span>
      </td>
      <td className={`zt-td-price ${isUp ? 'up' : 'down'}`}>
        {item.price.toFixed(2)}
      </td>
      <td className={`zt-td-change ${isUp ? 'up' : 'down'}`}>
        {pct(item.changePct)}
      </td>
      <td className="zt-td-industry">{item.industry ?? '—'}</td>
      <td className="zt-td-volume">{wanShou(item.volumeHands)}</td>
      <td
        className={`zt-td-main ${item.mainNet == null ? 'is-na' : item.mainNet >= 0 ? 'up' : 'down'}`}
      >
        {item.mainNet == null ? '—' : yuan2yi(item.mainNet)}
      </td>
    </tr>
  )
}

// ===== 详情正文 =====
function ZtDetailBody({ detail }: { detail: ZtDetailResponse }) {
  const { item, sources } = detail

  return (
    <>
      {/* 当日资金流向 */}
      <section className="zt-detail-section">
        <h5>
          资金流向
          <span className="zt-detail-empty" style={{ fontWeight: 400 }}>
            {sources.flow}
          </span>
        </h5>
        <ul>
          <li className="zt-seat">
            <span className="zt-seat-name">主力净流入</span>
            <span
              className={`zt-net ${item.flow.main == null ? '' : item.flow.main >= 0 ? 'up' : 'down'}`}
            >
              {yuan2yi(item.flow.main)}
            </span>
          </li>
          <li className="zt-seat">
            <span className="zt-seat-name">超大单</span>
            <span
              className={`zt-net ${item.flow.super == null ? '' : item.flow.super >= 0 ? 'up' : 'down'}`}
            >
              {yuan2yi(item.flow.super)}
            </span>
          </li>
          <li className="zt-seat">
            <span className="zt-seat-name">大单</span>
            <span
              className={`zt-net ${item.flow.big == null ? '' : item.flow.big >= 0 ? 'up' : 'down'}`}
            >
              {yuan2yi(item.flow.big)}
            </span>
          </li>
          <li className="zt-seat">
            <span className="zt-seat-name">中单</span>
            <span
              className={`zt-net ${item.flow.mid == null ? '' : item.flow.mid >= 0 ? 'up' : 'down'}`}
            >
              {yuan2yi(item.flow.mid)}
            </span>
          </li>
          <li className="zt-seat">
            <span className="zt-seat-name">小单（散户）</span>
            <span
              className={`zt-net ${item.flow.small == null ? '' : item.flow.small >= 0 ? 'up' : 'down'}`}
            >
              {yuan2yi(item.flow.small)}
            </span>
          </li>
        </ul>
      </section>

      {/* 龙虎榜 */}
      <section className="zt-detail-section">
        <h5>
          龙虎榜
          <span className="zt-detail-empty" style={{ fontWeight: 400 }}>
            {item.lhb ? `近 30 日第 ${item.lhb.count30d ?? '?'} 次` : '当日未上榜'}
          </span>
        </h5>
        {item.lhb ? (
          <>
            <p className="zt-reason">上榜原因：{item.lhb.reason || '—'}</p>
            <ul>
              {item.lhb.buySeats.length > 0 && (
                <li className="zt-seat" style={{ paddingBottom: 4 }}>
                  <strong style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    买入前五
                  </strong>
                </li>
              )}
              {item.lhb.buySeats.map((s, i) => (
                <li key={`b-${i}`} className="zt-seat">
                  <span className="zt-seat-name">{s.name}</span>
                  {s.riseProb3d != null && (
                    <span className="zt-seat-prob">3 日胜率 {s.riseProb3d.toFixed(0)}%</span>
                  )}
                  <span className="zt-net up">+{s.netYi.toFixed(4)} 亿</span>
                </li>
              ))}
              {item.lhb.sellSeats.length > 0 && (
                <li className="zt-seat" style={{ paddingTop: 4, paddingBottom: 4 }}>
                  <strong style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    卖出前五
                  </strong>
                </li>
              )}
              {item.lhb.sellSeats.map((s, i) => (
                <li key={`s-${i}`} className="zt-seat">
                  <span className="zt-seat-name">{s.name}</span>
                  <span className="zt-net down">{s.netYi.toFixed(4)} 亿</span>
                </li>
              ))}
            </ul>
            {(item.lhb.institutional.length > 0 || item.lhb.foreign.length > 0) && (
              <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px dashed #eef0f5' }}>
                {item.lhb.institutional.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <strong style={{ fontSize: 10.5, color: '#1e40af' }}>机构专用：</strong>
                    {item.lhb.institutional.map((s, i) => (
                      <span
                        key={`i-${i}`}
                        style={{
                          display: 'inline-block',
                          marginRight: 8,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {s.name}{' '}
                        <span
                          className={`zt-net ${s.netYi >= 0 ? 'up' : 'down'}`}
                          style={{ fontSize: 10.5 }}
                        >
                          {s.netYi >= 0 ? '+' : ''}
                          {s.netYi.toFixed(4)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
                {item.lhb.foreign.length > 0 && (
                  <div>
                    <strong style={{ fontSize: 10.5, color: '#92400e' }}>外资席位：</strong>
                    {item.lhb.foreign.map((s, i) => (
                      <span
                        key={`f-${i}`}
                        style={{
                          display: 'inline-block',
                          marginRight: 8,
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {s.name}{' '}
                        <span
                          className={`zt-net ${s.netYi >= 0 ? 'up' : 'down'}`}
                          style={{ fontSize: 10.5 }}
                        >
                          {s.netYi >= 0 ? '+' : ''}
                          {s.netYi.toFixed(4)}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            <p className="zt-detail-source">不同数据商席位口径存在差异，方向以交易所盘后披露为准。</p>
          </>
        ) : (
          <p className="zt-detail-empty">
            当日未上龙虎榜（仅异常波动、严重异常波动、涨跌幅偏离值达 ±7% 等情形会上榜）。
          </p>
        )}
      </section>

      {/* 融资融券 */}
      <section className="zt-detail-section">
        <h5>
          融资融券
          <span className="zt-detail-empty" style={{ fontWeight: 400 }}>
            {item.rzrq ? `披露日 ${item.rzrq.date}（T+1）` : '—'}
          </span>
        </h5>
        {item.rzrq ? (
          <ul>
            <li className="zt-seat">
              <span className="zt-seat-name">融资余额</span>
              <span>{item.rzrq.rzyeYi != null ? `${item.rzrq.rzyeYi.toFixed(2)} 亿` : '—'}</span>
            </li>
            <li className="zt-seat">
              <span className="zt-seat-name">融资净买入</span>
              <span
                className={`zt-net ${item.rzrq.rzjmeYi == null ? '' : item.rzrq.rzjmeYi >= 0 ? 'up' : 'down'}`}
              >
                {item.rzrq.rzjmeYi == null
                  ? '—'
                  : yuan2yi(item.rzrq.rzjmeYi * 1e8).replace('+', '')}
                {item.rzrq.downDays >= 2 ? `（连降 ${item.rzrq.downDays} 日）` : ''}
              </span>
            </li>
            <li className="zt-seat">
              <span className="zt-seat-name">融券余量</span>
              <span>
                {item.rzrq.rqylWan != null ? `${item.rzrq.rqylWan.toFixed(2)} 万股` : '—'}
              </span>
            </li>
          </ul>
        ) : (
          <p className="zt-detail-empty">暂无两融数据（可能未纳入融资融券标的）。</p>
        )}
      </section>

      {/* 大宗交易 */}
      <section className="zt-detail-section">
        <h5>
          大宗交易
          <span className="zt-detail-empty" style={{ fontWeight: 400 }}>
            近 {item.blockTrades.length} 条
          </span>
        </h5>
        {item.blockTrades.length > 0 ? (
          <ul>
            {item.blockTrades.map((b, i) => (
              <li key={i} className="zt-seat">
                <span className="zt-seat-name">
                  {b.date} {b.price.toFixed(2)} 元
                  {b.premiumPct != null && (
                    <span style={{ color: 'var(--text-3)', marginLeft: 4 }}>
                      溢价 {pct(b.premiumPct)}
                    </span>
                  )}
                </span>
                <span>{yuanYiAbs(b.amountYi * 1e8)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="zt-detail-empty">近期无大宗交易记录。</p>
        )}
      </section>

      <p className="zt-detail-source">
        数据源：{sources.flow}；龙虎榜：{sources.lhb}；两融：{sources.rzrq}；大宗：{sources.blockTrades}
        。仅事实呈现，不预测涨跌。
      </p>
    </>
  )
}