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

  return (
    <div className="chart-container">
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
