import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// 不启用 StrictMode：Recharts 2.x 的 Tooltip 内部依赖已废弃的 findDOMNode，
// StrictMode 的双挂载会让它拿到 null 容器，抛出
// "Cannot read properties of null (reading 'getBoundingClientRect')"
ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
