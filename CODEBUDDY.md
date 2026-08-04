# 追高跟踪 (Price Tracker)

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

## 开发命令
```bash
npm run dev      # 启动开发服务器
npm run build    # 构建生产版本
npm run preview  # 预览生产构建
```

## 数据说明
当前使用模拟数据（`data.ts`），后续可接入真实 API（如 Alpha Vantage、CoinGecko 等）替换。
