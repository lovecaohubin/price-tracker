import './Header.css';

interface Props {
  username?: string;
  onLogout?: () => void;
}

function Header({ username, onLogout }: Props) {
  return (
    <header className="header">
      <div className="header-content">
        <div className="header-row">
          <div className="logo">
            <span className="logo-icon">📈</span>
            <h1>追高跟踪</h1>
          </div>
          {username && (
            <div className="user-area">
              <span className="user-name">👤 {username}</span>
              <button className="btn-logout" onClick={onLogout}>退出</button>
            </div>
          )}
        </div>
        <p className="subtitle">实时追踪资产价格，不错过每一个新高</p>
      </div>
    </header>
  );
}

export default Header;
