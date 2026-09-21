// 持有建议 · 模型验证（资产跟踪页）
//
// 复用「数据分析 · 模型验证」那套表格与卡片样式（TradeAnalysis.css），
// 同一类回测表格不重复维护一份。
// 与那个验证的差别：这个检验的是「每只标的自己的持有档位」是否有效，
// 前瞻收益取标的自身的后续真实涨跌（见 services/holdAdviceBacktest.ts 的说明）。

import { useState } from 'react';
import { fetchMarketSnapshot } from '../services/market';
import {
  runHoldAdviceBacktest,
  HoldBacktestResult,
  HoldBacktestTarget,
  HoldBucketStat,
} from '../services/holdAdviceBacktest';
import './TradeAnalysis.css';
import './HoldAdviceBacktest.css';

const fmtPct = (v: number | null, digits = 2) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);

const fmtPctSigned = (v: number | null, digits = 2) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(digits)}%`;

const pnlClass = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

// 回测表格：核心指标是「跌超 1%」概率——档位越弱该概率越高，才算真的能识别风险
const BucketTable = ({ list }: { list: HoldBucketStat[] }) => (
  <table className="bt-table">
    <thead>
      <tr>
        <th>分组</th>
        <th>样本</th>
        <th title="标的自身次日涨跌的平均值">平均次日</th>
        <th title="次日上涨的概率">上涨概率</th>
        <th title="次日跌超 1% 的概率，持有决策要规避的尾部风险">跌超1%</th>
        <th title="其后 3 个交易日的累计涨跌">平均3日</th>
        <th title="其后 5 个交易日的累计涨跌">平均5日</th>
      </tr>
    </thead>
    <tbody>
      {list.map(b => (
        <tr key={b.label}>
          <td>{b.label}</td>
          <td>{b.samples}</td>
          <td className={pnlClass(b.avgNext1)}>{fmtPctSigned(b.avgNext1)}</td>
          <td>{fmtPct(b.upRate, 1)}</td>
          <td className={b.dangerRate >= 0.12 ? 'down' : ''}>{fmtPct(b.dangerRate, 1)}</td>
          <td className={pnlClass(b.avgNext3)}>{fmtPctSigned(b.avgNext3)}</td>
          <td className={pnlClass(b.avgNext5)}>{fmtPctSigned(b.avgNext5)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

interface Props {
  targets: HoldBacktestTarget[];
}

function HoldAdviceBacktest({ targets }: Props) {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<HoldBacktestResult | null>(null);
  const [error, setError] = useState('');
  // 指数数据降级（用的是本地缓存）时必须让用户知道，否则会以为验证的是实时数据
  const [degraded, setDegraded] = useState('');

  const run = async () => {
    setRunning(true);
    setError('');
    setDegraded('');
    try {
      // 回测要覆盖 300 根日 K 的区间，页面上的 60 天快照不够用，这里单独取长历史
      const snap = await fetchMarketSnapshot(400);
      const r = await runHoldAdviceBacktest(targets, snap.history);
      setResult(r);
      if (snap.stale) setDegraded(snap.note ?? '大盘接口不可用，回测使用本地缓存的上证指数数据');
      if (!r) {
        setError('可用样本不足（每只标的至少 10 条、合计至少 30 条），请先确认日 K 与大盘数据能正常获取');
      }
    } catch (e) {
      setResult(null);
      setError(e instanceof Error ? e.message : '回测失败');
    } finally {
      setRunning(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // 展开即验证：用户点「开始验证」的目的就是看结果，不需要再点一次
    if (next && !result && !running) void run();
  };

  return (
    <div className="backtest-section hab-section">
      <div className="backtest-head">
        <h2>模型验证 · 持有建议</h2>
        <span className="backtest-sub">
          {result
            ? `${result.perAsset.length} 只标的、${result.samples} 条样本（${result.from} ~ ${result.to}）逐日滚动回测` +
              (result.suppressed ? `，另有 ${result.suppressed} 条因置信度不足未给出建议、未计入` : '')
            : `${targets.length} 只跟踪标的，用近 300 个交易日的日 K 逐日滚动检验档位是否有效`}
        </span>
        <div className="hab-actions">
          {open && (
            <button className="hab-btn primary" onClick={run} disabled={running}>
              {running ? '验证中…' : '重新运行'}
            </button>
          )}
          <button className="hab-btn" onClick={toggle} disabled={running}>
            {open ? '收起' : running ? '验证中…' : '开始验证'}
          </button>
        </div>
      </div>

      {degraded && (
        <div className="market-degraded">
          <span>{degraded}</span>
          <button onClick={run}>重试</button>
        </div>
      )}

      {result?.klineStale && result.klineStale.length > 0 && (
        <div className="market-degraded">
          <span>
            以下标的的日 K 取自服务端本地缓存（非交易日 / 接口降级），最新若干根可能与下个工作日的实时数据不一致：
            {result.klineStale.join('、')}
          </span>
          <button onClick={run}>重试</button>
        </div>
      )}

      {open && running && (
        <p className="backtest-note">正在重放各标的近 300 个交易日的日 K，逐日调用评分模型…</p>
      )}

      {open && error && (
        <div className="analysis-error">
          <span>{error}</span>
        </div>
      )}

      {open && !running && !result && !error && (
        <p className="backtest-note">
          回测逐日重放：第 t 天只用截至当天的数据（收盘价、250 日最高价、近 30 日走势、当日涨跌幅与换手率）
          打分，再看之后 1/3/5 个交易日的真实涨跌，全程不使用未来数据。
        </p>
      )}

      {open && result && (
        <>
          <p className="backtest-note">
            检验的是「评分越高，后续表现是否真的更好」。
            {result.monotonic.ok ? (
              <>
                本次样本里<b>单调成立</b>：{result.monotonic.detail}。
              </>
            ) : (
              <>
                本次样本里<b>没观察到单调关系</b>（{result.monotonic.detail}）——
                这种情况下档位只能当<b>风险刻度</b>用，不能当方向信号。
              </>
            )}
            两点必须说明的近似：历史最高价用 300 日窗口近似（线上用的是 2000 年以来真实最高），
            所以「创历史新高加分 / 距历史最高 &gt;30% 打折」在回测里偏保守；
            指数历史对不上的交易日按「大盘缺失」处理，与线上接口失败时的降级一致。
          </p>

          <div className="backtest-grid">
            <div className="backtest-card">
              <h3>各档位（全部标的合并）</h3>
              <BucketTable list={result.buckets} />
            </div>
            <div className="backtest-card">
              <h3>评分五分位（全部标的合并）</h3>
              <BucketTable list={result.quintiles} />
            </div>
          </div>

          <div className="backtest-corr">
            <span className="corr-title">与前瞻涨跌的相关系数（皮尔逊）</span>
            {result.correlations.map(c => (
              <span className="corr-item" key={c.label}>
                <em>{c.label}</em>
                <b>1日 {c.n1 == null ? '—' : c.n1.toFixed(3)}</b>
                <b>3日 {c.n3 == null ? '—' : c.n3.toFixed(3)}</b>
                <b>5日 {c.n5 == null ? '—' : c.n5.toFixed(3)}</b>
              </span>
            ))}
          </div>

          <div className="backtest-card hab-per-asset">
            <h3>逐标的样本</h3>
            <table className="bt-table">
              <thead>
                <tr>
                  <th>标的</th>
                  <th title="参与统计的有效样本数（模型给出建议的交易日）">样本</th>
                  <th title="因子覆盖不足、模型没表态的交易日">未表态</th>
                  <th>平均次日</th>
                  <th>跌超1%</th>
                  <th>档位分布</th>
                </tr>
              </thead>
              <tbody>
                {result.perAsset.map(a => (
                  <tr key={a.symbol}>
                    <td>
                      {a.name}
                      <span className="hab-symbol">{a.symbol}</span>
                    </td>
                    <td>{a.samples}</td>
                    <td>{a.suppressed}</td>
                    <td className={pnlClass(a.overall.avgNext1)}>{fmtPctSigned(a.overall.avgNext1)}</td>
                    <td className={a.overall.dangerRate >= 0.12 ? 'down' : ''}>
                      {fmtPct(a.overall.dangerRate, 1)}
                    </td>
                    <td className="hab-dist">
                      {a.buckets.map(b => `${b.label} ${b.samples}`).join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.skipped.length > 0 && (
            <p className="backtest-note hab-skipped">
              未纳入统计：
              {result.skipped.map(s => `${s.name}（${s.reason}）`).join('；')}
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default HoldAdviceBacktest;
