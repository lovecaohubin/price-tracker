# A股资产追高跟踪 (A-Share Price Tracker)

## 项目概述
一个用于跟踪股票和加密货币价格新高的 Web 应用，帮助用户实时掌握资产是否接近或突破历史高点。

## 技术栈
- **前端框架**: React 18 + TypeScript
- **构建工具**: Vite 5
- **图表库**: Recharts 2
- **样式**: 纯 CSS（无第三方 UI 库）

## 项目结构
```
src/
├── main.tsx              # 入口文件
├── App.tsx               # 主应用组件（状态管理、筛选、排序）
├── App.css               # 主应用样式
├── index.css             # 全局样式
├── types.ts              # TypeScript 类型定义
├── data.ts               # 模拟数据和数据生成逻辑
├── vite-env.d.ts         # Vite 类型声明
└── components/
    ├── Header.tsx        # 顶部导航栏
    ├── AssetCard.tsx     # 资产卡片（价格、新高信息、进度条）
    ├── AddAssetForm.tsx  # 添加资产弹窗
    ├── PriceChart.tsx    # 价格走势折线图
    └── *.css             # 对应组件的样式文件
```

## 核心功能
1. **资产仪表盘**: 卡片式展示所有跟踪资产
2. **新高追踪**: 实时显示当前价格与52周新高/历史最高的差距
3. **进度条可视化**: 直观展示价格距新高的百分比
4. **分类筛选**: 按股票/加密货币切换视图
5. **添加/删除资产**: 从可选列表中添加新资产或移除已有资产
6. **价格走势图**: 点击资产卡片查看近30天价格折线图
7. **持有建议**: 每张资产卡片给出「强势持有 / 持有 / 观望 / 减仓 / 回避」档位与一句话动作（`services/holdAdvice.ts`）
8. **持有建议的模型验证**: 资产跟踪页底部可展开的逐日滚动回测面板，检验档位是否真的对应更好的后续表现（`components/HoldAdviceBacktest.tsx`）

## 建议模型
两个互补模型，都不预测涨跌，只做强弱与风险刻度：
- `services/positionAdvice.ts`：账户级「次日仓位区间」，输入大盘 + 账户盈亏 + 杠杆，在「数据分析」表格逐行展示并回测。
- `services/holdAdvice.ts`：标的级「持有建议」，输入标的的价格位置（距 52 周新高 / 历史最高）、均线趋势、量价与换手、大盘环境；按因子权重覆盖率给出置信度，覆盖不足时不出建议。
- `services/holdAdviceBacktest.ts`：持有建议的 point-in-time 验证。第 t 天只用截至当天的数据构造 Asset 快照打分，再看之后 1/3/5 个交易日的真实涨跌；输出各档位/五分位统计、相关系数与单调性判定。纯计算部分为 `computeHoldBacktest()`，可离线复算。

## 行情与缓存策略
- 大盘指数历史（`/api/market`）落盘 `data/marketHistory.json`，接口失败时降级读本地并在响应里标记 `stale`，前端金色提示条明示。
- 个股 K 线（`/api/kline`）落盘 `data/klineHistory.json`，按 `symbol_period` 索引。非交易日 / 接口限流时同样降级读本地，响应头 `X-Kline-Cache: STALE` 标识，前端把 stale 标透传给持有建议回测面板并显示降级提示。

## 开发命令
```bash
npm run dev      # 启动开发服务器
npm run build    # 构建生产版本
npm run preview  # 预览生产构建
```

## 数据说明
当前使用模拟数据（`data.ts`），后续可接入真实 API（如 Alpha Vantage、CoinGecko 等）替换。
