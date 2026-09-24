import { useEffect, useRef, useState } from 'react';
import { Asset } from '../types';
import { HoldAdvice } from '../services/holdAdvice';
import './AssetCard.css';

function getTurnoverLevel(rate: number): string {
  if (rate >= 20) return 'hot';
  if (rate >= 15) return 'high';
  if (rate >= 7) return 'warn';
  if (rate >= 3) return 'mid';
  return '';
}

interface Props {
  asset: Asset;
  advice: HoldAdvice | null;             // 该资产的持有建议（现价未加载时为 null）
  isSelected: boolean;
  shares: number;                        // 持仓股数
  onSharesChange: (shares: number) => void;
  onSelect: () => void;
  onDelete: () => void;
  /** 股票类型才有的"股票分析"按钮回调（A 股）；其它资产不显示 */
  onAnalyze?: () => void;
}

// 悬浮说明：档位 + 评分 + 置信度 + 动作 + 逐项依据
function adviceTip(advice: HoldAdvice): string {
  const conf = `置信度${advice.confidenceLabel}（因子覆盖 ${Math.round(advice.coverage * 100)}%）`;
  if (!advice.adviceAvailable) return `${conf}\n${advice.action}`;
  return (
    `${advice.levelLabel} · ${advice.score} 分 · ${conf}\n${advice.action}\n` +
    advice.reasons.map(r => `${r.delta > 0 ? '+' : ''}${r.delta} ${r.text}`).join('\n')
  );
}

function AssetCard({ asset, advice, isSelected, shares, onSharesChange, onSelect, onDelete, onAnalyze }: Props) {
  const safe52W = asset.high52Week || 1;
  const safeATH = asset.allTimeHigh || 1;
  const gap52W = ((safe52W - asset.currentPrice) / safe52W) * 100;
  const gapATH = ((safeATH - asset.currentPrice) / safeATH) * 100;
  const isNearHigh = gapATH <= 5;
  const isAtHigh = gapATH <= 0.5;

  // 股价统一保留两位小数（千位用逗号，<1 元保留四位）
  // 使用 minimumFractionDigits 保证末尾 0 不被丢弃（如 24.60、5.27）
  const formatPrice = (p: number) => {
    if (p < 1) return p.toFixed(4);
    return p.toLocaleString('zh-CN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  // 金额统一以「元」为单位展示，不做万/亿换算
  const formatAmount = (v: number) =>
    `${v.toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 元`;

  // 股数用本地草稿保证输入过程流畅；只在外部值真正变化时回填
  const [sharesDraft, setSharesDraft] = useState(() => (shares > 0 ? String(shares) : ''));
  const lastShares = useRef(shares);
  useEffect(() => {
    if (shares !== lastShares.current) {
      lastShares.current = shares;
      setSharesDraft(shares > 0 ? String(shares) : '');
    }
  }, [shares]);

  const handleSharesInput = (raw: string) => {
    setSharesDraft(raw);
    const n = Number(raw);
    const next = raw.trim() === '' || !Number.isFinite(n) || n < 0 ? 0 : Math.floor(n);
    lastShares.current = next;
    onSharesChange(next);
  };

  // 金额 = 股数 × 股价（现价缺失时不计）
  const positionAmount = shares > 0 && asset.currentPrice > 0 ? shares * asset.currentPrice : 0;

  return (
    <div
      className={`asset-card ${isSelected ? 'selected' : ''} ${isAtHigh ? 'at-high' : ''} ${isNearHigh ? 'near-high' : ''}`}
      onClick={onSelect}
    >
      <div className="card-top">
        <div className="asset-info">
          <span className={`type-badge ${asset.type}`}>
            {asset.type === 'stock' ? 'A' : 'E'}
          </span>
          <div className="asset-name-row">
            <span className="asset-name">{asset.name}</span>
            <span className="asset-symbol">{asset.symbol}</span>
          </div>
        </div>
        <div className="card-top-right">
          {/* 仅 A 股显示「股票分析」按钮（按需分析当日行情/资金/两融） */}
          {onAnalyze && asset.type === 'stock' && (
            <button
              className="btn-analyze"
              onClick={(e) => { e.stopPropagation(); onAnalyze() }}
              title="股票分析：行情底色 / 资金流向 / 融资融券"
            >
              股票分析
            </button>
          )}
          <button
            className="btn-delete"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            title="删除"
          >✕</button>
        </div>
      </div>

      {/* 名称下方：股数（可录入）+ 金额（= 股数 × 股价） */}
      <div className="card-shares" onClick={e => e.stopPropagation()}>
        <label className="shares-field">
          <span>股数</span>
          <input
            type="number"
            min="0"
            step="100"
            inputMode="numeric"
            placeholder="0"
            value={sharesDraft}
            onChange={e => handleSharesInput(e.target.value)}
            title="输入持仓股数，金额 = 股数 × 当前股价"
          />
        </label>
        <span className="shares-amount">
          <span>金额</span>
          {positionAmount > 0
            ? <strong>{formatAmount(positionAmount)}</strong>
            : <span className="amount-empty">—</span>}
        </span>
      </div>

      <div className="card-price">
        <span className="current-price">{formatPrice(asset.currentPrice)}</span>
        <span className={`change-badge ${asset.changePercent >= 0 ? 'up' : 'down'}`}>
          {asset.changePercent >= 0 ? '↑' : '↓'} {Math.abs(asset.changePercent).toFixed(2)}%
        </span>
        <span className={`turnover-badge ${getTurnoverLevel(asset.turnoverRate)}`}>换手 {asset.turnoverRate.toFixed(2)}%</span>
      </div>

      <div className="card-highs">
        <div className="high-one-row">
          <span className="high-item"><label>52周新高</label> {formatPrice(asset.high52Week)}</span>
          <span className="high-item"><label>历史最高</label> {formatPrice(asset.allTimeHigh)}</span>
          <span className="high-item"><label>历史最低</label> {formatPrice(asset.lowSince2000)}</span>
        </div>
      </div>

      <div className="progress-section">
        <div className="progress-bar-bg">
          <div
            className={`progress-bar-fill ${isAtHigh ? 'full' : isNearHigh ? 'warn' : ''}`}
            style={{ width: `${Math.max(0, Math.min(100, (asset.currentPrice / safe52W) * 100))}%` }}
          />
        </div>
        <span className={`progress-text ${isNearHigh ? 'warn' : ''}`}>
          {isAtHigh ? '🚀 创历史新高！' : `距52周新高 ${gap52W.toFixed(1)}%`}
        </span>
      </div>

      {/* 持有建议：档位 + 一句话动作，悬浮查看评分依据 */}
      {advice && (
        <div
          className={`card-advice ${advice.adviceAvailable ? advice.level : 'na'}`}
          title={adviceTip(advice)}
        >
          <span className="advice-badge">
            {advice.adviceAvailable ? `${advice.levelLabel} · ${advice.score}` : '数据不足'}
          </span>
          <span className="advice-action">{advice.action}</span>
        </div>
      )}
    </div>
  );
}

export default AssetCard;
