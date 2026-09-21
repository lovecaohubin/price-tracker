import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Asset } from '../types';
import { defaultSymbols, createPlaceholder } from '../data';
import { fetchAssetData, fetchQuotes } from '../services/aStockApi';
import { fetchMarketSnapshot, MarketSnapshot } from '../services/market';
import { buildHoldAdvice, HoldAdvice } from '../services/holdAdvice';
import Header from '../components/Header';
import AssetCard from '../components/AssetCard';
import AddAssetForm from '../components/AddAssetForm';
import PriceChart from '../components/PriceChart';
import TradeAnalysis from '../components/TradeAnalysis';
import HoldAdviceBacktest from '../components/HoldAdviceBacktest';
import '../App.css';

// localStorage 持久化键
const STORAGE_KEY_TRACKED = 'price-tracker:tracked-symbols';
const STORAGE_KEY_SEED = 'price-tracker:seed-version';
const STORAGE_KEY_SHARES = 'price-tracker:shares';
// 修改 defaultSymbols 后递增此值，旧浏览器会自动重置为新默认列表
const SEED_VERSION = 2;

// 从 localStorage 读取已跟踪的代码列表；种子版本变更时重置为新默认值
function loadTrackedSymbols(): string[] {
  try {
    if (localStorage.getItem(STORAGE_KEY_SEED) !== String(SEED_VERSION)) {
      localStorage.setItem(STORAGE_KEY_TRACKED, JSON.stringify(defaultSymbols));
      localStorage.setItem(STORAGE_KEY_SEED, String(SEED_VERSION));
      return defaultSymbols;
    }
    const raw = localStorage.getItem(STORAGE_KEY_TRACKED);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.every(s => typeof s === 'string')) {
        return arr;
      }
    }
  } catch {}
  return defaultSymbols;
}

function persistTrackedSymbols(symbols: string[]) {
  try { localStorage.setItem(STORAGE_KEY_TRACKED, JSON.stringify(symbols)); } catch {}
}

// 持仓股数：按代码存储，与行情数据解耦，刷新行情不会丢失
function loadShares(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SHARES);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
        }
        return out;
      }
    }
  } catch {}
  return {};
}

function persistShares(shares: Record<string, number>) {
  try { localStorage.setItem(STORAGE_KEY_SHARES, JSON.stringify(shares)); } catch {}
}

function Dashboard() {
  const [assets, setAssets] = useState<Asset[]>(() =>
    loadTrackedSymbols().map(createPlaceholder)
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [activeSection, setActiveSection] = useState<'assets' | 'analysis'>('assets');
  // 持仓股数：代码 -> 股数（独立于行情，避免刷新时被覆盖）
  const [shares, setShares] = useState<Record<string, number>>(() => loadShares());
  // 大盘快照：持有建议的「环境因子」，接口不可用时降级为仅个股因子
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketNote, setMarketNote] = useState('');
  const refreshTimer = useRef<ReturnType<typeof setInterval>>();

  // 用 ref 持有最新资产列表，避免 refreshAll 依赖 assets 导致定时器被反复重建
  const assetsRef = useRef<Asset[]>(assets);
  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  // 并发锁：定时刷新与手动刷新叠加会让请求翻倍，挤占浏览器连接导致 fetch 失败
  const inFlight = useRef(false);

  // 刷新所有资产数据：行情一次批量拉取，K 线走本地/服务端缓存
  const refreshAll = useCallback(async (symbols: string[], showLoading = true) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (showLoading) setLoading(true);
    else setRefreshing(true);

    try {
      // 多个资产合并成 1 次行情请求，而不是每个资产各发一次
      const quotes = await fetchQuotes(symbols);
      const results = await Promise.allSettled(
        symbols.map(s => fetchAssetData(s, quotes.get(s)))
      );

      const updated: Asset[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          updated.push({
            ...createPlaceholder(symbols[i]),
            ...r.value,
            id: symbols[i],
          } as Asset);
        } else {
          const prev = assetsRef.current.find(a => a.symbol === symbols[i]);
          updated.push({ ...(prev || createPlaceholder(symbols[i])) });
        }
      });
      setAssets(updated);

      const now = new Date();
      setLastUpdate(now.toLocaleTimeString('zh-CN'));
    } catch (e) {
      console.error('刷新数据失败:', e);
    } finally {
      inFlight.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    refreshAll(defaultSymbols);
  }, [refreshAll]);

  // 大盘快照：服务端已缓存 60 秒，失败不阻塞行情，只把持有建议降级为「仅个股因子」
  const loadMarket = useCallback(async () => {
    try {
      const snap = await fetchMarketSnapshot(60);
      setMarket(snap);
      setMarketNote(snap.stale ? snap.note ?? '大盘接口不可用，持有建议使用本地缓存数据' : '');
    } catch (e) {
      setMarket(null);
      setMarketNote(
        e instanceof Error
          ? `大盘行情不可用（${e.message}），持有建议已降级为仅个股因子`
          : '大盘行情不可用，持有建议已降级为仅个股因子',
      );
    }
  }, []);

  useEffect(() => { loadMarket(); }, [loadMarket]);

  // 每 10 秒自动刷新（仅交易时段 09:00-15:00，且仅在资产跟踪板块可见时）
  useEffect(() => {
    refreshTimer.current = setInterval(() => {
      if (activeSection !== 'assets') return;
      const now = new Date();
      const hour = now.getHours();
      if (hour < 9 || hour >= 15) return;
      const symbols = assetsRef.current.map(a => a.symbol);
      if (symbols.length > 0) refreshAll(symbols, false);
    }, 10000);
    return () => clearInterval(refreshTimer.current);
  }, [refreshAll, activeSection]);

  // 取刷新后的最新数据，避免图表停留在点击那一刻的旧快照
  const selectedLive = selectedAsset
    ? assets.find(a => a.id === selectedAsset.id) || selectedAsset
    : null;

  // 逐资产持有建议：占位资产（现价缺失）不计算，避免给出看似精确的假结论
  const adviceMap = useMemo(() => {
    const map = new Map<string, HoldAdvice>();
    for (const a of assets) {
      if (a.currentPrice > 0) map.set(a.id, buildHoldAdvice(a, market));
    }
    return map;
  }, [assets, market]);

  const handleDelete = (id: string) => {
    setAssets(prev => prev.filter(a => a.id !== id));
    if (selectedAsset?.id === id) setSelectedAsset(null);
    // 同步持久化：用 ref 读取最新列表避免闭包 stale
    persistTrackedSymbols(assetsRef.current.filter(a => a.id !== id).map(a => a.symbol));
  };

  const handleAdd = async (symbol: string) => {
    const exists = assets.find(a => a.symbol === symbol);
    if (exists) return;

    setShowAddForm(false);
    setAssets(prev => [...prev, createPlaceholder(symbol)]);
    persistTrackedSymbols([...assetsRef.current.map(a => a.symbol), symbol]);

    // 异步加载新资产数据
    const data = await fetchAssetData(symbol);
    if (data) {
      setAssets(prev => prev.map(a =>
        a.symbol === symbol ? { ...a, ...data, id: symbol } as Asset : a
      ));
    }
  };

  // 录入某只股票的持仓股数；置空或 0 视为清空
  const handleSharesChange = useCallback((symbol: string, value: number) => {
    setShares(prev => {
      const next = { ...prev };
      if (value > 0) next[symbol] = value;
      else delete next[symbol];
      persistShares(next);
      return next;
    });
  }, []);

  const handleManualRefresh = () => {
    const symbols = assets.map(a => a.symbol);
    if (symbols.length > 0) refreshAll(symbols, false);
    // 大盘是持有建议的环境因子，手动刷新时一并更新
    loadMarket();
  };

  return (
    <div className="app">
      <Header />

      <main className="main">
        <div className="section-tabs">
          <div className="tabs-group">
            <button
              className={`section-tab ${activeSection === 'assets' ? 'active' : ''}`}
              onClick={() => setActiveSection('assets')}
            >
              资产跟踪
            </button>
            <button
              className={`section-tab ${activeSection === 'analysis' ? 'active' : ''}`}
              onClick={() => setActiveSection('analysis')}
            >
              数据分析
            </button>
          </div>
          <div className="tabs-tools">
            {lastUpdate && (
              <span className={`update-time${refreshing ? ' is-refreshing' : ''}`}>
                <span className="update-dot" aria-hidden="true" />
                <span className="update-label">{refreshing ? '刷新中' : '更新于'}</span>
                <span className="update-value">{refreshing ? '···' : lastUpdate}</span>
                <button
                  className="btn-refresh"
                  onClick={handleManualRefresh}
                  title="手动刷新"
                  aria-label="手动刷新行情"
                  disabled={refreshing}
                >
                  <svg
                    viewBox="0 0 24 24"
                    width="18"
                    height="18"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M20.5 11A8.5 8.5 0 0 0 6.2 5.8L3.5 8.4" />
                    <path d="M3.5 3.8v4.6h4.6" />
                    <path d="M3.5 13a8.5 8.5 0 0 0 14.3 5.2l2.7-2.6" />
                    <path d="M20.5 20.2v-4.6h-4.6" />
                  </svg>
                </button>
              </span>
            )}
            <button className="btn-add" onClick={() => setShowAddForm(true)}>
              + 添加跟踪
            </button>
          </div>
        </div>

        {activeSection === 'analysis' ? (
          <TradeAnalysis />
        ) : (
          <>
            {marketNote && !loading && (
              <div className="advice-note">
                <span>{marketNote}</span>
                <button onClick={loadMarket}>重试</button>
              </div>
            )}

            {loading ? (
              <div className="loading-state">
                <div className="spinner" />
                <p>正在加载实时行情...</p>
              </div>
            ) : (
              <>
                <div className="asset-grid">
                  {assets.map(asset => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      advice={adviceMap.get(asset.id) ?? null}
                      isSelected={selectedAsset?.id === asset.id}
                      shares={shares[asset.symbol] ?? 0}
                      onSharesChange={v => handleSharesChange(asset.symbol, v)}
                      onSelect={() => setSelectedAsset(
                        selectedAsset?.id === asset.id ? null : asset
                      )}
                      onDelete={() => handleDelete(asset.id)}
                    />
                  ))}
                  {assets.length === 0 && (
                    <div className="empty-state">
                      <p>暂无跟踪资产，点击"+ 添加跟踪"开始</p>
                    </div>
                  )}
                </div>

                {selectedLive && (
                  <div className="chart-section">
                    <div className="chart-header">
                      <h2>{selectedLive.name} ({selectedLive.symbol}) 近30天走势</h2>
                      <button className="btn-close" onClick={() => setSelectedAsset(null)}>✕</button>
                    </div>
                    <PriceChart key={selectedLive.id} asset={selectedLive} />
                  </div>
                )}

                {/* 卡片上的档位是否可信，由这套逐日滚动回测回答；默认收起，点开才拉历史数据 */}
                <HoldAdviceBacktest targets={assets} />
              </>
            )}

            {showAddForm && (
              <AddAssetForm
                existingSymbols={assets.map(a => a.symbol)}
                onAdd={handleAdd}
                onClose={() => setShowAddForm(false)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default Dashboard;
