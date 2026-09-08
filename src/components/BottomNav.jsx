import { Icon } from './Icon.jsx';
import { navigate } from '../lib/router.js';

const ITEMS = [
  { path: '/', label: 'Overview', icon: 'overview' },
  { path: '/gateways', label: 'Gateways', icon: 'gateway' },
  { path: '/routes', label: 'Routes', icon: 'route' },
  { path: '/users', label: 'Users', icon: 'users' },
  { path: '/more', label: 'More', icon: 'more' },
];

const MORE_PATHS = ['/more', '/egresses', '/events', '/health', '/lab', '/settings'];

function isActive(item, path) {
  if (item.path === '/') return path === '/';
  if (item.path === '/more') return MORE_PATHS.some((p) => path.startsWith(p));
  return path.startsWith(item.path);
}

export function BottomNav({ path }) {
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {ITEMS.map((item) => {
        const active = isActive(item, path);
        return (
          <button
            key={item.path}
            type="button"
            className={active ? 'nav-item nav-item-active' : 'nav-item'}
            onClick={() => navigate(item.path)}
            aria-current={active ? 'page' : undefined}
          >
            <Icon name={item.icon} size={21} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
