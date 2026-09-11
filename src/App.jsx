import { useEffect, useState } from 'react';
import { auth } from './lib/api.js';
import { customer, shop } from './lib/shopApi.js';
import { useRoute, match, navigate } from './lib/router.js';
import { Icon } from './components/Icon.jsx';
import { Logo } from './components/Logo.jsx';

// Customer app — the two screens almost everyone uses.
import { Auth } from './shop/Auth.jsx';
import { Store } from './shop/Store.jsx';
import { Order } from './shop/Order.jsx';
import { MyConfig } from './shop/MyConfig.jsx';

// Operator console, kept behind /admin.
import { Login } from './views/Login.jsx';
import { Overview } from './views/Overview.jsx';
import { Gateways } from './views/Gateways.jsx';
import { GatewayDetail } from './views/GatewayDetail.jsx';
import { Routes } from './views/Routes.jsx';
import { Users } from './views/Users.jsx';
import { UserDetail } from './views/UserDetail.jsx';
import { More } from './views/More.jsx';
import { Egresses } from './views/Egresses.jsx';
import { Events } from './views/Events.jsx';
import { Health } from './views/Health.jsx';
import { Lab } from './views/Lab.jsx';
import { Settings } from './views/Settings.jsx';
import { Plans } from './views/Plans.jsx';
import { Orders } from './views/Orders.jsx';

const CUSTOMER_NAV = [
  { path: '/', label: 'Store', icon: 'plus' },
  { path: '/account', label: 'My config', icon: 'key' },
];

const ADMIN_NAV = [
  { path: '/admin', label: 'Overview', icon: 'overview' },
  { path: '/admin/gateways', label: 'Gateways', icon: 'gateway' },
  { path: '/admin/routes', label: 'Routes', icon: 'route' },
  { path: '/admin/users', label: 'Users', icon: 'users' },
  { path: '/admin/more', label: 'More', icon: 'more' },
];

const ADMIN_MORE = ['/admin/more', '/admin/egresses', '/admin/events', '/admin/health',
  '/admin/lab', '/admin/settings', '/admin/plans', '/admin/orders'];

function Nav({ items, path }) {
  const isActive = (item) => {
    if (item.path === '/' || item.path === '/admin') return path === item.path;
    if (item.path === '/admin/more') return ADMIN_MORE.some((p) => path.startsWith(p));
    return path.startsWith(item.path);
  };
  return (
    <nav className="bottom-nav" aria-label="Primary" style={{ gridTemplateColumns: `repeat(${items.length}, 1fr)` }}>
      {items.map((item) => {
        const active = isActive(item);
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

function adminScreen(path, { onSignedOut }) {
  const gateway = match('/admin/gateways/:id', path);
  if (gateway) return { title: 'Gateway', element: <GatewayDetail id={gateway.id} /> };
  const user = match('/admin/users/:id', path);
  if (user) return { title: 'Subscriber', element: <UserDetail id={user.id} /> };

  switch (path) {
    case '/admin': return { title: 'Overview', element: <Overview /> };
    case '/admin/gateways': return { title: 'Gateways', element: <Gateways /> };
    case '/admin/routes': return { title: 'Routes', element: <Routes /> };
    case '/admin/users': return { title: 'Subscribers', element: <Users /> };
    case '/admin/more': return { title: 'More', element: <More /> };
    case '/admin/egresses': return { title: 'Egress paths', element: <Egresses /> };
    case '/admin/events': return { title: 'Events', element: <Events /> };
    case '/admin/health': return { title: 'Health checks', element: <Health /> };
    case '/admin/lab': return { title: 'Blackout lab', element: <Lab /> };
    case '/admin/plans': return { title: 'Plans', element: <Plans /> };
    case '/admin/orders': return { title: 'Orders', element: <Orders /> };
    case '/admin/settings': return { title: 'Settings', element: <Settings onSignedOut={onSignedOut} /> };
    default: return { title: 'Not found', element: <NotFound to="/admin" /> };
  }
}

function NotFound({ to }) {
  return (
    <div className="empty">
      <h3>Screen not found</h3>
      <button type="button" className="btn btn-ghost" onClick={() => navigate(to)}>Go back</button>
    </div>
  );
}

/** Operator console: same shell, different navigation, separate session. */
function AdminApp({ path }) {
  const [session, setSession] = useState(auth.current);
  useEffect(() => auth.subscribe(setSession), []);

  if (!session) return <Login onSignedIn={() => setSession(auth.current)} />;
  const screen = adminScreen(path, { onSignedOut: () => setSession(null) });

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Logo size={22} className="mark-logo" />
          <div>
            <strong>SixVPN</strong>
            <span className="screen-title">{screen.title}</span>
          </div>
        </div>
        <button type="button" className="header-link" onClick={() => navigate('/')}>Store</button>
      </header>
      <main className="app-main" key={path}>{screen.element}</main>
      <Nav items={ADMIN_NAV} path={path} />
    </div>
  );
}

/** Customer app: plans, payment, and the config itself. */
function CustomerApp({ path }) {
  const [session, setSession] = useState(customer.current);
  useEffect(() => customer.subscribe(setSession), []);

  const order = match('/order/:id', path);
  const needsAccount = path === '/account' || path === '/signin' || Boolean(order);

  if (!session && needsAccount) {
    return <Auth onDone={() => {
      setSession(customer.current);
      if (path === '/signin') navigate('/');
    }} />;
  }

  let screen;
  if (order) screen = { title: 'Payment', element: <Order id={order.id} /> };
  else if (path === '/account') screen = { title: 'My config', element: <MyConfig /> };
  else if (path === '/') screen = { title: 'Plans', element: <Store /> };
  else screen = { title: 'Not found', element: <NotFound to="/" /> };

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <Logo size={22} className="mark-logo" />
          <div>
            <strong>SixVPN</strong>
            <span className="screen-title">{screen.title}</span>
          </div>
        </div>
        {session ? (
          <button
            type="button"
            className="header-link"
            onClick={async () => { await shop.signOut(); setSession(null); navigate('/'); }}
          >
            Sign out
          </button>
        ) : (
          <button type="button" className="header-link" onClick={() => navigate('/signin')}>Sign in</button>
        )}
      </header>
      <main className="app-main" key={path}>{screen.element}</main>
      <Nav items={CUSTOMER_NAV} path={path} />
    </div>
  );
}

export function App() {
  const path = useRoute();
  useEffect(() => { window.scrollTo(0, 0); }, [path]);
  return path.startsWith('/admin') ? <AdminApp path={path} /> : <CustomerApp path={path} />;
}
