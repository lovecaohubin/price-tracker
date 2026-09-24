import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ZtAnalysisResponse, ZtListItem } from '../types'
import { fetchZtAnalysis } from '../services/ztApi'
import { useDailyScheduler } from '../hooks/useDailyScheduler'
import './ZtAnalysisPanel.css'

type Section = 'metric' | 'industry' | 'height' | 'rank' | 'times'

const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`

const yi = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)} 亿`

const yiAbs = (v: number | null | undefined) =>
  v == null ? '—' : `${Math.abs(v).toFixed(2)} 亿`

/**
 * 涨停分析面板（首版涨停 Tab 内右侧栏）
 *
 * 数据维度：
 *   1. 涨停潮指数（metric）：总数 / 封板率 / 总封单 / 主力净额 / 平均涨幅
 *   2. 行业统计：各行业涨停股数 / 主力净流入 / 平均涨幅 Top 10
 *   3. 涨停高度分布：首板/2板/3板/4板+ 的数量 + 最高板龙头
 *   4. 个股排行：封单 / 涨幅 / 换手 / 主力净流入 Top 10
 *   5. 涨停次数 Top 10（近 30 个交易日日 K 判定）
 */
export default function ZtAnalysisPanel() {
  const [data, setData] = useState<ZtAnalysisResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [section, setSection] = useState<Section>('metric')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await fetchZtAnalysis()
      setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  // 进入页面不自动刷新；用户点击「数据更新」或每日 15:05 定时触发
  useDailyScheduler(() => void load(), 15, 5)

  const maxBoardCount = useMemo(() => {
    if (!data?.boardDistribution.length) return 0
    return data.boardDistribution.reduce((a, b) => Math.max(a, b.boardCount), 0)
  }, [data])

  // 每天 15:05 定时刷新（与 ZtListPanel 同步）
  const nextSchedule = useDailyScheduler(() => void load(), 15, 5)

  return (
    <div className="zt-anly-panel">
      <div className="zt-anly-head">
        <div className="zt-anly-head-titles">
          <h3>涨停分析</h3>
          {data && (
            <span className="zt-anly-subtitle">
              更新于 {new Date(data.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          )}
        </div>
        <div className="zt-anly-head-actions">
          {nextSchedule && (
            <span className="zt-anly-next">
              下次定时 {nextSchedule.toLocaleTimeString('zh-CN', { hour12: false })}
            </span>
          )}
          <button
            className={`zt-anly-refresh${loading ? ' is-loading' : ''}`}
            onClick={() => void load()}
            disabled={loading}
            title="手动拉取涨停分析数据"
            aria-label="数据更新"
          >
            <span className="zt-anly-icon" aria-hidden="true">⟳</span>
            <span>数据更新</span>
          </button>
        </div>
      </div>

      {/* 分段切换 */}
      <div className="zt-anly-tabs">
        {(
          [
            ['metric', '潮汐'],
            ['industry', '行业'],
            ['height', '高度'],
            ['rank', '排行'],
            ['times', '次数'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            className={`zt-anly-tab ${section === k ? 'active' : ''}`}
            onClick={() => setSection(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="zt-anly-error">{error}</div>}

      {loading && !data && <div className="zt-anly-loading">正在聚合涨停数据…</div>}

      {!loading && !data && !error && (
        <div className="zt-anly-empty">
          暂无数据，点击「数据更新」拉取今日涨停分析。
          <br />
          <span className="zt-anly-empty-hint">
            {nextSchedule
              ? `每天 15:05 自动定时刷新一次；下次 ${nextSchedule.toLocaleTimeString(
                  'zh-CN',
                  { hour12: false },
                )}`
              : '每天 15:05 自动定时刷新一次'}
          </span>
        </div>
      )}

      {data && (
        <div className="zt-anly-body">
          {section === 'metric' && <MetricSection data={data} />}
          {section === 'industry' && <IndustrySection data={data} />}
          {section === 'height' && (
            <HeightSection data={data} maxBoard={maxBoardCount} />
          )}
          {section === 'rank' && <RankSection data={data} />}
          {section === 'times' && <TimesSection data={data} />}
        </div>
      )}

      {data && (
        <p className={`zt-anly-note${data.stale ? ' is-stale' : ''}`}>
          {data.stale && <strong className="zt-anly-stale-tag">接口降级</strong>}
          数据源：{data.note}
        </p>
      )}
    </div>
  )
}

// ===== 1. 涨停潮指数 =====
function MetricSection({ data }: { data: ZtAnalysisResponse }) {
  const s = data.summary
  return (
    <div className="zt-anly-metric">
      <div className="zt-anly-grid">
        <div className="zt-anly-cell">
          <span className="zt-anly-cell-label">涨停股总数</span>
          <strong className="zt-anly-cell-value">{s.total}</strong>
          <span className="zt-anly-cell-sub">首板 {s.firstBoard} · 连板 {s.consecutive}</span>
        </div>
        <div className="zt-anly-cell">
          <span className="zt-anly-cell-label">封板率</span>
          <strong className="zt-anly-cell-value">{(s.sealedRate * 100).toFixed(1)}%</strong>
          <span className="zt-anly-cell-sub">仍封板 {s.sealed} 只</span>
        </div>
        <div className="zt-anly-cell">
          <span className="zt-anly-cell-label">总封单</span>
          <strong className="zt-anly-cell-value">{s.totalSealedAmtYi.toFixed(2)} 亿</strong>
          <span className="zt-anly-cell-sub">均值 {s.avgSealedAmtYi.toFixed(2)} 亿</span>
        </div>
        <div className="zt-anly-cell">
          <span className="zt-anly-cell-label">主力净额</span>
          <strong
            className={`zt-anly-cell-value ${s.totalMainNetYi >= 0 ? 'up' : 'down'}`}
          >
            {yi(s.totalMainNetYi)}
          </strong>
          <span className="zt-anly-cell-sub">
            平均涨幅 {pct(s.avgChangePct)}
          </span>
        </div>
      </div>

      <div className="zt-anly-intensity">
        <div className="zt-anly-intensity-row">
          <span>综合强度</span>
          <span className="zt-anly-intensity-value">{s.intensity.toFixed(2)}</span>
        </div>
        <div className="zt-anly-intensity-bar">
          <div
            className="zt-anly-intensity-fill"
            style={{
              width: `${Math.min(100, Math.max(2, s.intensity * 8))}%`,
            }}
          />
        </div>
        <p className="zt-anly-intensity-hint">
          封单权重 50% · 主力 20% · 涨幅 30%；仅作强弱刻度参考。
        </p>
      </div>
    </div>
  )
}

// ===== 2. 行业统计 =====
function IndustrySection({ data }: { data: ZtAnalysisResponse }) {
  if (!data.industries.length) {
    return <div className="zt-anly-empty">暂无行业数据</div>
  }
  const maxCount = data.industries.reduce((a, b) => Math.max(a, b.count), 0)
  return (
    <div className="zt-anly-table-wrap">
      <table className="zt-anly-table">
        <thead>
          <tr>
            <th>行业</th>
            <th>涨停数</th>
            <th>主力净额（亿）</th>
            <th>均涨幅</th>
          </tr>
        </thead>
        <tbody>
          {data.industries.map((row) => (
            <tr key={row.name}>
              <td className="zt-anly-td-name">{row.name}</td>
              <td className="zt-anly-td-count">
                <div className="zt-anly-count-bar">
                  <div
                    className="zt-anly-count-fill"
                    style={{ width: `${(row.count / maxCount) * 100}%` }}
                  />
                  <span>{row.count} 只</span>
                </div>
              </td>
              <td
                className={`zt-anly-td-net ${row.mainNetYi >= 0 ? 'up' : 'down'}`}
              >
                {yi(row.mainNetYi)}
              </td>
              <td
                className={`zt-anly-td-pct ${row.avgChangePct >= 0 ? 'up' : 'down'}`}
              >
                {pct(row.avgChangePct)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ===== 3. 涨停高度分布 =====
function HeightSection({
  data,
  maxBoard,
}: {
  data: ZtAnalysisResponse
  maxBoard: number
}) {
  if (!data.boardDistribution.length) {
    return <div className="zt-anly-empty">暂无数据</div>
  }
  const maxCount = data.boardDistribution.reduce((a, b) => Math.max(a, b.count), 0)
  return (
    <div className="zt-anly-height">
      {data.boardDistribution.map((b) => (
        <div key={b.boardCount} className="zt-anly-height-bar">
          <div className="zt-anly-height-label">
            {b.boardCount >= 5 ? `${b.boardCount}板+` : `${b.boardCount}板`}
          </div>
          <div className="zt-anly-height-track">
            <div
              className={`zt-anly-height-fill ${b.boardCount === maxBoard ? 'is-max' : ''}`}
              style={{ width: `${(b.count / maxCount) * 100}%` }}
            />
            <span className="zt-anly-height-num">{b.count}</span>
          </div>
        </div>
      ))}

      {data.maxBoard && (
        <div className="zt-anly-leader">
          <div className="zt-anly-leader-label">最高板龙头</div>
          <div className="zt-anly-leader-card">
            <strong>{data.maxBoard.name}</strong>
            <span className="zt-anly-leader-code">{data.maxBoard.code}</span>
            <span className="zt-anly-leader-board">{data.maxBoard.boardCount} 连板</span>
            <span className="zt-anly-leader-change">
              {pct(data.maxBoard.changePct)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== 4. 个股排行（3 个指标横排：封单金额 / 换手率 / 主力净流入） =====
function RankSection({ data }: { data: ZtAnalysisResponse }) {
  // 金额类统一为「亿」；换手率为百分比
  const sections: {
    title: string
    rows: ZtListItem[]
    value: (i: ZtListItem) => string
  }[] = [
    {
      title: '封单金额 Top 10（亿）',
      rows: data.topSealed,
      value: (i) => yiAbs(i.sealedAmt),
    },
    {
      title: '换手率 Top 10',
      rows: data.topTurnover,
      value: (i) => (i.turnoverRate != null ? `${i.turnoverRate.toFixed(2)}%` : '—'),
    },
    {
      title: '主力净流入 Top 10（亿）',
      rows: data.topMainNet,
      value: (i) => yi(i.mainNet),
    },
  ]
  return (
    <div className="zt-anly-rank">
      {sections.map((sec) => (
        <div key={sec.title} className="zt-anly-rank-block">
          <div className="zt-anly-rank-title">{sec.title}</div>
          {!sec.rows.length ? (
            <div className="zt-anly-empty-inline">—</div>
          ) : (
            <ol className="zt-anly-rank-list">
              {sec.rows.map((r, idx) => (
                <li key={r.symbol} className="zt-anly-rank-row">
                  <span className="zt-anly-rank-idx">{idx + 1}</span>
                  <span className="zt-anly-rank-name">{r.name}</span>
                  <span className="zt-anly-rank-val">{sec.value(r)}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  )
}

// ===== 5. 涨停次数 Top 10 =====
function TimesSection({ data }: { data: ZtAnalysisResponse }) {
  if (!data.topBoardTimes.length) {
    return <div className="zt-anly-empty">近 30 日涨停次数尚不足，暂未上榜</div>
  }
  const maxTimes = data.topBoardTimes.reduce((a, b) => Math.max(a, b.boardTimes), 0)
  return (
    <ol className="zt-anly-times">
      {data.topBoardTimes.map((r) => (
        <li key={r.symbol} className="zt-anly-times-row">
          <div className="zt-anly-times-name">
            <strong>{r.name}</strong>
            <span className="zt-anly-times-code">{r.code}</span>
            {r.industry && <span className="zt-anly-times-industry">{r.industry}</span>}
          </div>
          <div className="zt-anly-times-track">
            <div
              className="zt-anly-times-fill"
              style={{ width: `${(r.boardTimes / maxTimes) * 100}%` }}
            />
            <span className="zt-anly-times-num">{r.boardTimes} 次</span>
          </div>
          <div
            className={`zt-anly-times-today ${r.todayChangePct >= 0 ? 'up' : 'down'}`}
          >
            今日 {pct(r.todayChangePct)}
          </div>
        </li>
      ))}
    </ol>
  )
}