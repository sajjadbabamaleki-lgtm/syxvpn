import { navigate } from '../lib/router.js';
import { Card } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';

const LINKS = [
  { path: '/admin/plans', icon: 'plus', label: 'Plans', hint: 'What customers can buy' },
  { path: '/admin/orders', icon: 'key', label: 'Orders & payments', hint: 'USDT settlement and history' },
  { path: '/admin/egresses', icon: 'globe', label: 'Egress paths', hint: 'Authorized upstream connectivity' },
  { path: '/admin/health', icon: 'activity', label: 'Health checks', hint: 'Raw ingress and egress probe results' },
  { path: '/admin/events', icon: 'alert', label: 'Events', hint: 'Operator-relevant history' },
  { path: '/admin/lab', icon: 'lab', label: 'Blackout lab', hint: 'Controlled resilience testing' },
  { path: '/admin/settings', icon: 'settings', label: 'Settings', hint: 'Session, password, control plane' },
];

export function More() {
  return (
    <div className="more-list">
      {LINKS.map((link) => (
        <Card key={link.path} className="list-card" role="button" tabIndex={0}
          onClick={() => navigate(link.path)}
          onKeyDown={(e) => { if (e.key === 'Enter') navigate(link.path); }}
        >
          <div className="more-icon"><Icon name={link.icon} size={20} /></div>
          <div className="list-main">
            <strong>{link.label}</strong>
            <span className="list-meta-inline">{link.hint}</span>
          </div>
          <Icon name="chevron" size={18} className="list-chevron" />
        </Card>
      ))}
    </div>
  );
}
