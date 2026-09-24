import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StockReport, StockReportDay } from '../types'
import {
  fetchStockAnalysisOverview,
  fetchStockReportDay,
  runStockAnalysis,
} from '../services/stockAnalysisApi'
import './StockAnalysis.css'

// ===== 格式化 =====
const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

// yi2: 输入已是「亿元」（龙虎榜净买卖金额由服务端 yi() 转过）
const yi2 = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} 亿`

// yiAbs: 输入已是「亿元」，只显示绝对值（龙虎榜上榜金额用）
const yiAbs = (v: number | null | undefined) => (v == null ? '—' : `${Math.abs(v).toFixed(2)} 亿`)

// yuanToYi: 资金流向字段单位是「元」，展示前转「亿元」
const yuanToYi = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v / 1e8).toFixed(2)} 亿`

const num2 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(2))

const wan = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} 万股`

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sa-section">
      <h4 className="sa-section-title">{title}</h4>
      {children}
    </section>
  )
}

function KVTable({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <table className="sa-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ReportCard({ report }: { report: StockReport }) {
  const q = report.quote
  const f = report.flow
  const up = (q?.changePct ?? 0) >= 0

  return (
    <article className="sa-card">
      <header className="sa-card-head">
        <div className="sa-card-title">
          <span className="sa-name">{report.name}</span>
          <span className="sa-symbol">（{report.symbol.toUpperCase()}）</span>
          <span className="sa-date">{report.date} 收盘数据</span>
        </div>
        {q && (
          <div className="sa-card-price">
            <span className={`sa-close ${up ? 'up' : 'down'}`}>{num2(q.close)}</span>
            <span className={`sa-change ${up ? 'up' : 'down'}`}>
              {up ? '↑' : '↓'} {pct(Math.abs(q.changePct) * (up ? 1 : -1)).replace('+', '')}
            </span>
          </div>
        )}
      </header>

      {report.missing.length > 0 && (
        <p className="sa-missing">数据缺失：{report.missing.join('、')}（数据源未返回或该标的不适用）</p>
      )}

      <Section title="一、今日行情底色">
        <KVTable
          rows={[
            ['收盘 / 涨跌', q ? `${num2(q.close)} 元 / ${pct(q.changePct)}` : '—'],
            [
              '开 / 高 / 低',
              q ? `${num2(q.open)} / ${num2(q.high)} / ${num2(q.low)} 元，振幅 ${pct(q.amplitude)}` : '—',
            ],
            ['昨收', q ? `${num2(q.prevClose)} 元` : '—'],
            [
              '成交额 / 换手率',
              q ? `${q.turnoverYi != null ? `${q.turnoverYi.toFixed(2)} 亿元` : '—'} / ${q.turnoverRate != null ? `${q.turnoverRate.toFixed(2)}%` : '—'}` : '—',
            ],
            ['量比', q?.volumeRatio != null ? num2(q.volumeRatio) : '—'],
            [
              '流通市值 / 总市值',
              q
                ? `${q.marketCapFloatYi != null ? `${q.marketCapFloatYi.toFixed(2)} 亿` : '—'} / ${q.marketCapTotalYi != null ? `${q.marketCapTotalYi.toFixed(2)} 亿元` : '—'}`
                : '—',
            ],
            ['PE(TTM) / 静态 / 动态', q ? `${num2(q.peTtm)} / ${num2(q.peStatic)} / ${num2(q.peDynamic)}` : '—'],
            ['PB', q ? num2(q.pb) : '—'],
          ]}
        />
      </Section>

      {f && (
        <Section title="二、资金流向">
          <KVTable
            rows={[
              ['主力净流入', <strong className={f.main != null && f.main < 0 ? 'down' : 'up'}>{yuanToYi(f.main)}</strong>],
              ['超大单', <span className={f.super != null && f.super < 0 ? 'down' : 'up'}>{yuanToYi(f.super)}</span>],
              ['大单', <span className={f.big != null && f.big < 0 ? 'down' : 'up'}>{yuanToYi(f.big)}</span>],
              ['中单', <span className={f.mid != null && f.mid < 0 ? 'down' : 'up'}>{yuanToYi(f.mid)}</span>],
              ['小单（散户）', <span className={f.small != null && f.small < 0 ? 'down' : 'up'}>{yuanToYi(f.small)}</span>],
              ['近 5 日主力合计', <span className={f.main5d != null && f.main5d < 0 ? 'down' : 'up'}>{yuanToYi(f.main5d)}</span>],
              ['主力净占比', f.mainRatio != null ? `${(f.mainRatio * 100).toFixed(2)}%` : '—'],
            ]}
          />
          <p className="sa-source">
            <span className="sa-source-label">{f.sourceLabel}</span>
            <span className="sa-source-note">{f.methodologyNote}</span>
          </p>
        </Section>
      )}

      {report.lhb && (
        <Section title="三、龙虎榜">
          <table className="sa-table sa-grid">
            <thead>
              <tr>
                <th>上榜原因</th>
                <th>总买入</th>
                <th>总卖出</th>
                <th>净额</th>
              </tr>
            </thead>
            <tbody>
              {report.lhb.items.map((it, i) => (
                <tr key={i}>
                  <td>{it.reason}</td>
                  <td>{yiAbs(it.buyYi)}</td>
                  <td>{yiAbs(it.sellYi)}</td>
                  <td className={it.netYi >= 0 ? 'up' : 'down'}>{yi2(it.netYi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.lhb.count30d != null && (
            <p className="sa-note">近 1 月第 {report.lhb.count30d} 次上榜</p>
          )}

          {report.lhb.buySeats.length > 0 && (
            <div className="sa-seats">
              <div>
                <h5>买入前五</h5>
                <ol>
                  {report.lhb.buySeats.map((s, i) => (
                    <li key={i}>
                      <span className="sa-seat-name">{s.name}</span>
                      {s.riseProb3d != null && (
                        <span className="sa-seat-prob">3 日胜率 {(s.riseProb3d).toFixed(0)}%</span>
                      )}
                      <span className="up">+{s.amtYi.toFixed(4)} 亿</span>
                    </li>
                  ))}
                </ol>
              </div>
              {report.lhb.sellSeats.length > 0 && (
                <div>
                  <h5>卖出前五</h5>
                  <ol>
                    {report.lhb.sellSeats.map((s, i) => (
                      <li key={i}>
                        <span className="sa-seat-name">{s.name}</span>
                        <span className="down">{s.amtYi.toFixed(4)} 亿</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}

          {(report.lhb.institutional.length > 0 || report.lhb.foreign.length > 0) && (
            <div className="sa-special">
              {report.lhb.foreign.length > 0 && (
                <div className="sa-special-group">
                  <h5>
                    外资席位 <span className="sa-tag sa-tag-foreign">Foreign</span>
                  </h5>
                  <ol>
                    {report.lhb.foreign.map((s, i) => (
                      <li key={i}>
                        <span className="sa-seat-name">{s.name}</span>
                        <span className={s.netYi >= 0 ? 'up' : 'down'}>
                          {s.netYi >= 0 ? '+' : ''}{s.netYi.toFixed(4)} 亿
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              {report.lhb.institutional.length > 0 && (
                <div className="sa-special-group">
                  <h5>
                    机构专用 <span className="sa-tag sa-tag-inst">机构</span>
                  </h5>
                  <ol>
                    {report.lhb.institutional.map((s, i) => (
                      <li key={i}>
                        <span className="sa-seat-name">{s.name}</span>
                        <span className={s.netYi >= 0 ? 'up' : 'down'}>
                          {s.netYi >= 0 ? '+' : ''}{s.netYi.toFixed(4)} 亿
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}

          {report.lhb.history.length > 0 && (
            <div className="sa-history">
              <h5>近 {report.lhb.history.length} 次上榜历史</h5>
              <table className="sa-table sa-grid">
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>原因</th>
                    <th>净额</th>
                    <th>当日涨跌</th>
                  </tr>
                </thead>
                <tbody>
                  {report.lhb.history.map((h, i) => (
                    <tr key={i}>
                      <td>{h.date}</td>
                      <td className="sa-history-reason">{h.reason}</td>
                      <td className={h.netYi >= 0 ? 'up' : 'down'}>{yi2(h.netYi)}</td>
                      <td className={h.changePct != null && h.changePct >= 0 ? 'up' : 'down'}>
                        {h.changePct != null ? `${(h.changePct * 100).toFixed(2)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="sa-note">不同数据商席位口径存在差异，方向以交易所盘后正式披露为准。</p>
        </Section>
      )}

      {report.rzrq && (
        <Section title="四、融资融券（T+1 披露）">
          <KVTable
            rows={[
              ['披露日期', report.rzrq.date],
              ['融资余额', report.rzrq.rzyeYi != null ? `${report.rzrq.rzyeYi.toFixed(2)} 亿元` : '—'],
              [
                '融资净买入',
                report.rzrq.rzjmeYi != null ? (
                  <span className={report.rzrq.rzjmeYi < 0 ? 'down' : 'up'}>
                    {yi2(report.rzrq.rzjmeYi)}
                    {report.rzrq.downDays != null && report.rzrq.downDays >= 2
                      ? `（${report.rzrq.downDays} 连降）`
                      : ''}
                  </span>
                ) : (
                  '—'
                ),
              ],
              ['买入额 / 偿还额', `${yiAbs(report.rzrq.rzmreYi)} / ${yiAbs(report.rzrq.rzcheYi)}`],
              ['融券余量', report.rzrq.rqylWan != null ? `${report.rzrq.rqylWan.toFixed(2)} 万股` : '—'],
            ]}
          />
        </Section>
      )}

      {report.blockTrades && (
        <Section title="五、大宗交易">
          {report.blockTrades.length === 0 ? (
            <p className="sa-note">近期无大宗交易记录。</p>
          ) : (
            <table className="sa-table sa-grid">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>成交价</th>
                  <th>溢价</th>
                  <th>金额</th>
                  <th>买方 / 卖方</th>
                </tr>
              </thead>
              <tbody>
                {report.blockTrades.map((b, i) => (
                  <tr key={i}>
                    <td>{b.date}</td>
                    <td>{num2(b.price)}</td>
                    <td>{pct(b.premiumPct)}</td>
                    <td>{yiAbs(b.amountYi)}</td>
                    <td>
                      {b.buyer ?? '—'} / {b.seller ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {report.holders && (
        <Section title={`六、十大流通股东（${report.holders[0]?.reportDate ?? ''} 披露）`}>
          <table className="sa-table sa-grid">
            <thead>
              <tr>
                <th>股东</th>
                <th>持股</th>
                <th>占流通比例</th>
                <th>环比变动</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {report.holders.map((h, i) => (
                <tr key={i}>
                  <td className="sa-holder-name">
                    {h.name}
                    {h.type && <span className="sa-holder-type">{h.type}</span>}
                  </td>
                  <td>{h.holdNumWan.toFixed(2)} 万股</td>
                  <td>{h.ratio != null ? `${(h.ratio * 100).toFixed(2)}%` : '—'}</td>
                  <td>{h.changeWan == null ? '新进' : wan(h.changeWan)}</td>
                  <td
                    className={
                      h.state === '减仓' ? 'down' : h.state === '加仓' || h.state === '新进' ? 'up' : ''
                    }
                  >
                    {h.state}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {report.tech && (
        <Section title="七、技术指标（日K本地计算）">
          <KVTable
            rows={[
              ['RSI 6 / 12 / 24', `${num2(report.tech.rsi6)} / ${num2(report.tech.rsi12)} / ${num2(report.tech.rsi24)}`],
              ['KDJ K / D / J', `${num2(report.tech.kdjK)} / ${num2(report.tech.kdjD)} / ${num2(report.tech.kdjJ)}`],
              ['BOLL 上轨 / 中轨 / 下轨', `${num2(report.tech.bollUp)} / ${num2(report.tech.bollMid)} / ${num2(report.tech.bollLow)}`],
              ['MA5 / MA20 / MA60 / MA250', `${num2(report.tech.ma5)} / ${num2(report.tech.ma20)} / ${num2(report.tech.ma60)} / ${num2(report.tech.ma250)}`],
            ]}
          />
        </Section>
      )}

      <Section title="八、怎么看这组数据">
        <ul className="sa-insights">
          {report.insights.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      </Section>
    </article>
  )
}

export default function StockAnalysis() {
  const [dates, setDates] = useState<string[]>([])
  const [day, setDay] = useState<StockReportDay | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const ov = await fetchStockAnalysisOverview()
        if (cancelled) return
        setDates(ov.dates)
        if (ov.latest) {
          setDay(ov.latest)
          setSelected(ov.latest.date)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const pickDate = useCallback(async (date: string) => {
    setSelected(date)
    if (!date) return
    setLoading(true)
    setError('')
    try {
      setDay(await fetchStockReportDay(date))
    } catch (err) {
      setDay(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const handleRun = useCallback(async () => {
    setRunning(true)
    setError('')
    try {
      const result = await runStockAnalysis()
      setDay(result)
      setSelected(result.date)
      setDates((prev) => (prev.includes(result.date) ? prev : [result.date, ...prev]))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [])

  const summary = useMemo(() => {
    if (!day) return null
    const up = day.reports.filter((r) => (r.quote?.changePct ?? 0) >= 0).length
    return `${day.reports.length} 只跟踪标的，${up} 红 / ${day.reports.length - up} 绿`
  }, [day])

  return (
    <div className="sa-root">
      <div className="sa-toolbar">
        <div className="sa-toolbar-left">
          <h3 className="sa-title">资产股票分析</h3>
          {summary && <span className="sa-summary">{summary}</span>}
        </div>
        <div className="sa-toolbar-right">
          <select
            className="sa-date-select"
            value={selected}
            onChange={(e) => void pickDate(e.target.value)}
            disabled={loading || dates.length === 0}
          >
            {dates.length === 0 && <option value="">暂无报告</option>}
            {dates.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <button className="sa-btn-run" onClick={handleRun} disabled={running}>
            {running ? '生成中…' : '立即生成'}
          </button>
        </div>
      </div>

      {day && (
        <p className="sa-generated">
          生成时间 {new Date(day.generatedAt).toLocaleString('zh-CN')}；每个交易日 15:01 自动生成，两融为
          T+1 披露。
        </p>
      )}

      {error && <div className="sa-error">{error}</div>}

      {running && (
        <div className="sa-loading">
          正在抓取东财公开数据（行情 / 资金流 / 龙虎榜 / 两融 / 大宗 / 股东 / 技术指标），约需 10–30 秒…
        </div>
      )}

      {loading && !day && !error && <div className="sa-loading">加载中…</div>}

      {!loading && !day && !error && (
        <div className="sa-empty">
          <p>还没有分析报告。</p>
          <p>
            点击「立即生成」手动跑一次，或等交易日 15:01 自动生成（跟踪列表在「资产跟踪」页维护）。
          </p>
        </div>
      )}

      <div className="sa-list">
        {day?.reports.map((r) => (
          <ReportCard key={`${r.date}-${r.symbol}`} report={r} />
        ))}
      </div>

      <p className="sa-disclaimer">
        免责声明：以上内容基于公开数据和规则化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。
      </p>
    </div>
  )
}
