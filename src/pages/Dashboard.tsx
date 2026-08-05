import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Asset } from '../types';
import { defaultSymbols, createPlaceholder } from '../data';
import { fetchAssetData, getYesterdayTurnoverRate, saveTodayTurnoverRate } from '../services/aStockApi';
import Header from '../components/Header';
import AssetCard from '../components/AssetCard';
import AddAssetForm from '../components/AddAssetForm';
import PriceChart from '../components/PriceChart';
import '../App.css';

function Dashboard() {
  const [assets, setAssets] = useState<Asset[]>(() =>
    defaultSymbols.map(createPlaceholder)
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [filter, setFilter] = useState<'all' | 'stock' | 'etf'>('all');
  const refreshTimer = useRef<ReturnType<typeof setInterval>>();

  // 刷新所有资产数据
  const refreshAll = useCallback(async (symbols: string[], showLoading = true) => {
    if (showLoading) setLoading(true);
    if (!showLoading) setRefreshing(true);

    try {
      const results = await Promise.allSettled(
        symbols.map(s => fetchAssetData(s))
      );

      const updated: Asset[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value) {
          // 用 localStorage 中的昨日收盘换手率做环比基准
          const yesterdayRate = getYesterdayTurnoverRate(symbols[i]);
          // 保存今日换手率供明日环比
          if (r.value.turnoverRate != null) {
            saveTodayTurnoverRate(symbols[i], r.value.turnoverRate);
          }
          updated.push({
            ...createPlaceholder(symbols[i]),
            ...r.value,
            id: symbols[i],
            prevTurnoverRate: yesterdayRate,
          } as Asset);
        } else {
          updated.push({ ...assets.find(a => a.symbol === symbols[i]) || createPlaceholder(symbols[i]) });
        }
      });
      setAssets(updated);

      const now = new Date();
      setLastUpdate(now.toLocaleTimeString('zh-CN'));
    } catch (e) {
      console.error('刷新数据失败:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [assets]);

  // 初始加载
  useEffect(() => {
    refreshAll(defaultSymbols);
  }, []);

  // 每 10 秒自动刷新
  useEffect(() => {
    refreshTimer.current = setInterval(() => {
      const symbols = assets.map(a => a.symbol);
      if (symbols.length > 0) refreshAll(symbols, false);
    }, 10000);
    return () => clearInterval(refreshTimer.current);
  }, [assets, refreshAll]);

  const filteredAssets = useMemo(() => {
    if (filter === 'all') return assets;
    return assets.filter(a => a.type === filter);
  }, [assets, filter]);

  const handleDelete = (id: string) => {
    setAssets(prev => prev.filter(a => a.id !== id));
    if (selectedAsset?.id === id) setSelectedAsset(null);
  };

  const handleAdd = async (symbol: string) => {
    const exists = assets.find(a => a.symbol === symbol);
    if (exists) return;

    setShowAddForm(false);
    setAssets(prev => [...prev, createPlaceholder(symbol)]);

    // 异步加载新资产数据
    const data = await fetchAssetData(symbol);
    if (data) {
      setAssets(prev => prev.map(a =>
        a.symbol === symbol ? { ...a, ...data, id: symbol } as Asset : a
      ));
    }
  };

  const handleManualRefresh = () => {
    const symbols = assets.map(a => a.symbol);
    if (symbols.length > 0) refreshAll(symbols, false);
  };

  const totalAssets = filteredAssets.length;
  const nearHigh = filteredAssets.filter(a => a.high52Week > 0 && a.currentPrice >= a.high52Week * 0.95).length;
  const avgChange = filteredAssets.length > 0
    ? Math.round(filteredAssets.reduce((s, a) => s + a.changePercent, 0) / filteredAssets.length * 100) / 100
    : 0;

  return (
    <div className="app">
      <Header />

      <main className="main">
        <div className="stats-bar">
          <div className="stat-item">
            <span className="stat-label">跟踪资产</span>
            <span className="stat-value">{totalAssets}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">接近新高</span>
            <span className="stat-value highlight">{nearHigh}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">平均涨跌</span>
            <span className={`stat-value ${avgChange >= 0 ? 'up' : 'down'}`}>
              {avgChange >= 0 ? '+' : ''}{avgChange}%
            </span>
          </div>
        </div>

        <div className="toolbar">
          <div className="toolbar-left">
            <div className="filter-tabs">
              {(['all', 'stock'] as const).map(t => (
                <button
                  key={t}
                  className={`filter-tab ${filter === t ? 'active' : ''}`}
                  onClick={() => setFilter(t)}
                >
                  {t === 'all' ? '全部' : 'A股'}
                </button>
              ))}
            </div>
            {lastUpdate && (
              <span className="update-time">
                {refreshing ? '刷新中...' : `更新于 ${lastUpdate}`}
                <button className="btn-refresh" onClick={handleManualRefresh} title="手动刷新">↻</button>
              </span>
            )}
          </div>
          <button className="btn-add" onClick={() => setShowAddForm(true)}>
            + 添加跟踪
          </button>
        </div>

        {loading ? (
          <div className="loading-state">
            <div className="spinner" />
            <p>正在加载A股实时数据...</p>
          </div>
        ) : (
          <>
            <div className="asset-grid">
              {filteredAssets.map(asset => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  isSelected={selectedAsset?.id === asset.id}
                  onSelect={() => setSelectedAsset(
                    selectedAsset?.id === asset.id ? null : asset
                  )}
                  onDelete={() => handleDelete(asset.id)}
                />
              ))}
              {filteredAssets.length === 0 && (
                <div className="empty-state">
                  <p>暂无跟踪资产，点击"+ 添加跟踪"开始</p>
                </div>
              )}
            </div>

            {selectedAsset && (
              <div className="chart-section">
                <div className="chart-header">
                  <h2>{selectedAsset.name} ({selectedAsset.symbol}) 近30天走势</h2>
                  <button className="btn-close" onClick={() => setSelectedAsset(null)}>✕</button>
                </div>
                <PriceChart asset={selectedAsset} />
              </div>
            )}
          </>
        )}

        {showAddForm && (
          <AddAssetForm
            existingSymbols={assets.map(a => a.symbol)}
            onAdd={handleAdd}
            onClose={() => setShowAddForm(false)}
          />
        )}
      </main>
    </div>
  );
}

export default Dashboard;
