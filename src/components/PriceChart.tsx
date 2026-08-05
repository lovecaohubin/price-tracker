import { useCallback, useState, useRef } from 'react';
import { Asset } from '../types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';
import './PriceChart.css';

interface Props {
  asset: Asset;
}

function PriceChart({ asset }: Props) {
  const data = asset.priceHistory;
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  // 回调 ref：容器挂载到 DOM 后，等两个 rAF 确保布局计算完成再渲染图表
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (node) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setReady(true));
      });
    } else {
      setReady(false);
    }
  }, []);

  // 资产切换时重置 ready
  const [prevSymbol, setPrevSymbol] = useState(asset.symbol);
  if (prevSymbol !== asset.symbol) {
    setPrevSymbol(asset.symbol);
    if (ready) setReady(false);
  }

  if (!data || data.length === 0) {
    return <div className="chart-container chart-empty">暂无K线数据</div>;
  }

  // 始终渲染外层容器，仅内部条件渲染图表
  return (
    <div className="chart-container" ref={setContainerRef}>
      {ready ? (
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 12 }}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 12 }}
              tickFormatter={(v: number) => {
                if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
                return v.toFixed(v < 1 ? 4 : 1);
              }}
            />
            <Tooltip
              formatter={(value: number) => [value.toFixed(2), '价格']}
              labelFormatter={(label: string) => `日期: ${label}`}
            />
            <ReferenceLine
              y={asset.high52Week}
              stroke="#ef4444"
              strokeDasharray="5 5"
              label={{ value: '52周新高', position: 'right', fontSize: 12, fill: '#ef4444' }}
            />
            <Line
              type="monotone"
              dataKey="price"
              stroke="#6366f1"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, fill: '#6366f1' }}
            />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="chart-empty">加载中...</div>
      )}
    </div>
  );
}

export default PriceChart;
