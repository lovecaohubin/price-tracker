import { useEffect, useState, useRef } from 'react';
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

  useEffect(() => {
    // 延迟渲染确保 DOM 容器已挂载，避免 getBoundingClientRect on null
    const timer = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(timer);
  }, []);

  if (!data || data.length === 0) {
    return <div className="chart-container chart-empty">暂无K线数据</div>;
  }

  if (!ready) {
    return <div className="chart-container chart-loading">加载中...</div>;
  }

  return (
    <div className="chart-container" ref={containerRef}>
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
    </div>
  );
}

export default PriceChart;
