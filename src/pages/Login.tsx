import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './Login.css';

function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!username.trim() || !password.trim()) {
      setError('请输入用户名和密码');
      return;
    }

    setLoading(true);
    // 模拟网络延迟
    setTimeout(() => {
      const success = login(username, password);
      if (success) {
        navigate('/dashboard');
      } else {
        setError('用户名或密码错误');
      }
      setLoading(false);
    }, 600);
  };

  return (
    <div className="login-page">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo">📈</div>
          <h1>A股资产追高跟踪</h1>
          <p>登录以查看你的资产面板</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>用户名</label>
            <input
              type="text"
              placeholder="请输入用户名"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className={error ? 'error' : ''}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label>密码</label>
            <input
              type="password"
              placeholder="请输入密码"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className={error ? 'error' : ''}
            />
            {error && <p className="error-msg">{error}</p>}
          </div>

          <button type="submit" className="btn-login" disabled={loading}>
            {loading ? '登录中...' : '登 录'}
          </button>
        </form>

        <div className="login-hint">
          体验账号：<code>admin</code> / <code>123456</code>
        </div>
      </div>
    </div>
  );
}

export default Login;
