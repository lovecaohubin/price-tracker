import { useState, useRef, useEffect } from 'react';
import { Asset } from '../types';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';
import './PriceChart.css';

interface Props {
  asset: Asset;
}

const CHART_HEIGHT = 300;

function PriceChart({ asset }: Props) {
  const data = asset.priceHistory;
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: CHART_HEIGHT });

  // 用 ResizeObserver 自行测量容器尺寸，避免 Recharts ResponsiveContainer 内部 getBoundingClientRect 报错
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [asset.symbol]);

  if (!data || data.length === 0) {
    return <div className="chart-container chart-empty">暂无K线数据</div>;
  }

  return (
    <div className="chart-container" ref={containerRef}>
      {size.width > 0 ? (
        <LineChart
          width={size.width}
          height={CHART_HEIGHT}
          data={data}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
        >
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
            // 关闭动画：Tooltip 动画期间会访问尚未挂载的容器 DOM，导致 getBoundingClientRect 空指针
            isAnimationActive={false}
            wrapperStyle={{ outline: 'none' }}
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
      ) : (
        <div className="chart-empty">加载中...</div>
      )}
    </div>
  );
}

export default PriceChart;
