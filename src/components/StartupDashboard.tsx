export default function StartupDashboard() {
  return (
    <div className="startup-dashboard" tabIndex={-1}>
      <div className="startup-inner">
        <div className="startup-logo">ai-review</div>
        <div className="startup-tagline">review what the agent changed</div>
        <div className="startup-menu">
          <div className="startup-menu-row">
            <kbd>Space</kbd>
            <span>command palette</span>
          </div>
          <div className="startup-menu-row">
            <kbd>o</kbd>
            <kbd>p</kbd>
            <span>open repository</span>
          </div>
          <div className="startup-menu-row">
            <kbd>o</kbd>
            <kbd>r</kbd>
            <span>recent repositories</span>
          </div>
          <div className="startup-menu-row">
            <kbd>:</kbd>
            <span>command line</span>
          </div>
        </div>
      </div>
    </div>
  );
}
