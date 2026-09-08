import { useEffect, useState } from 'react';
import { auth } from './lib/api.js';
import { useRoute, match, navigate } from './lib/router.js';
import { BottomNav } from './components/BottomNav.jsx';
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

const TITLES = {
  '/': 'Overview',
  '/gateways': 'Gateways',
  '/routes': 'Routes',
  '/users': 'Subscribers',
  '/more': 'More',
  '/egresses': 'Egress paths',
  '/events': 'Events',
  '/health': 'Health checks',
  '/lab': 'Blackout lab',
  '/settings': 'Settings',
};

function screenFor(path, { onSignedOut }) {
  const gateway = match('/gateways/:id', path);
  if (gateway) return { title: 'Gateway', element: <GatewayDetail id={gateway.id} /> };
  const user = match('/users/:id', path);
  if (user) return { title: 'Subscriber', element: <UserDetail id={user.id} /> };

  switch (path) {
    case '/': return { title: TITLES['/'], element: <Overview /> };
    case '/gateways': return { title: TITLES['/gateways'], element: <Gateways /> };
    case '/routes': return { title: TITLES['/routes'], element: <Routes /> };
    case '/users': return { title: TITLES['/users'], element: <Users /> };
    case '/more': return { title: TITLES['/more'], element: <More /> };
    case '/egresses': return { title: TITLES['/egresses'], element: <Egresses /> };
    case '/events': return { title: TITLES['/events'], element: <Events /> };
    case '/health': return { title: TITLES['/health'], element: <Health /> };
    case '/lab': return { title: TITLES['/lab'], element: <Lab /> };
    case '/settings': return { title: TITLES['/settings'], element: <Settings onSignedOut={onSignedOut} /> };
    default: return { title: 'Not found', element: <NotFound /> };
  }
}

function NotFound() {
  return (
    <div className="empty">
      <h3>Screen not found</h3>
      <button type="button" className="btn btn-ghost" onClick={() => navigate('/')}>Back to overview</button>
    </div>
  );
}

export function App() {
  const path = useRoute();
  const [session, setSession] = useState(auth.current);

  useEffect(() => auth.subscribe(setSession), []);
  useEffect(() => {
    // Scroll to the top on navigation; phone screens keep the previous offset otherwise.
    window.scrollTo(0, 0);
  }, [path]);

  if (!session) return <Login onSignedIn={() => setSession(auth.current)} />;

  const screen = screenFor(path, { onSignedOut: () => setSession(null) });

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="mark">J</span>
          <div>
            <strong>JORDAN</strong>
            <span className="screen-title">{screen.title}</span>
          </div>
        </div>
      </header>

      <main className="app-main" key={path}>{screen.element}</main>

      <BottomNav path={path} />
    </div>
  );
}
