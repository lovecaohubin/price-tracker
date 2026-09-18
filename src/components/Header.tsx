import './Header.css';

function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <div className="logo">
          <span className="logo-icon">📈</span>
          <h1>A股资产追高跟踪</h1>
        </div>
        <p className="subtitle">实时追踪资产价格，不错过每一个新高</p>
      </div>
    </header>
  );
}

export default Header;
