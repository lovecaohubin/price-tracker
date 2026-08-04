import { useState, useMemo } from 'react';
import { Asset, SortField, SortDirection } from './types';
import { defaultAssets, createNewAsset, availableAssets } from './data';
import Header from './components/Header';
import AssetCard from './components/AssetCard';
import AddAssetForm from './components/AddAssetForm';
import PriceChart from './components/PriceChart';
import './App.css';

function App() {
  const [assets, setAssets] = useState<Asset[]>(defaultAssets);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<Asset | null>(null);
  const [sortField, setSortField] = useState<SortField>('changePercent');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [filter, setFilter] = useState<'all' | 'stock' | 'crypto'>('all');

  // 排序和筛选
  const filteredAssets = useMemo(() => {
    let result = [...assets];
    if (filter !== 'all') {
      result = result.filter(a => a.type === filter);
    }
    result.sort((a, b) => {
      const valA = a[sortField];
      const valB = b[sortField];
      if (typeof valA === 'string' && typeof valB === 'string') {
        return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      }
      return sortDirection === 'asc' ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
    });
    return result;
  }, [assets, filter, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleDelete = (id: string) => {
    setAssets(prev => prev.filter(a => a.id !== id));
    if (selectedAsset?.id === id) setSelectedAsset(null);
  };

  const handleAdd = (symbol: string) => {
    const info = availableAssets.find(a => a.symbol === symbol);
    if (!info) return;
    const newAsset = createNewAsset(info.name, info.symbol, info.type, info.basePrice);
    setAssets(prev => [...prev, newAsset]);
    setShowAddForm(false);
  };

  const totalAssets = filteredAssets.length;
  const nearHigh = filteredAssets.filter(a => a.currentPrice >= a.high52Week * 0.95).length;
  const avgChange = filteredAssets.length > 0
    ? Math.round(filteredAssets.reduce((s, a) => s + a.changePercent, 0) / filteredAssets.length * 100) / 100
    : 0;

  return (
    <div className="app">
      <Header />

      <main className="main">
        {/* 概览统计 */}
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

        {/* 工具栏 */}
        <div className="toolbar">
          <div className="filter-tabs">
            {(['all', 'stock', 'crypto'] as const).map(t => (
              <button
                key={t}
                className={`filter-tab ${filter === t ? 'active' : ''}`}
                onClick={() => setFilter(t)}
              >
                {t === 'all' ? '全部' : t === 'stock' ? '股票' : '加密货币'}
              </button>
            ))}
          </div>
          <button className="btn-add" onClick={() => setShowAddForm(true)}>
            + 添加跟踪
          </button>
        </div>

        {/* 资产列表 */}
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

        {/* 价格走势图 */}
        {selectedAsset && (
          <div className="chart-section">
            <div className="chart-header">
              <h2>{selectedAsset.name} ({selectedAsset.symbol}) 近30天走势</h2>
              <button className="btn-close" onClick={() => setSelectedAsset(null)}>✕</button>
            </div>
            <PriceChart asset={selectedAsset} />
          </div>
        )}

        {/* 添加资产弹窗 */}
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

export default App;
