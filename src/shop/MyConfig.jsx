import { useState } from 'react';
import { shop } from '../lib/shopApi.js';
import { useResource } from '../lib/useResource.js';
import { navigate } from '../lib/router.js';
import {
  Card, Section, Button, Row, Skeleton, ErrorState, EmptyState, StaleBanner, CopyButton, Meter,
} from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';
import { Qr } from '../components/Qr.jsx';
import { bytes, relativeTime, absoluteTime } from '../lib/format.js';

const STATE_COPY = {
  active: null,
  expired: 'Your subscription has expired. Buy a plan to switch it back on — you keep the same link.',
  disabled: 'This subscription was disabled. Contact support if you think that is a mistake.',
  'quota-exhausted': 'You have used all of your data. Buy a plan to add more — you keep the same link.',
};

/**
 * Import links for common Xray clients.
 *
 * A URL scheme only fires if that app is installed, and app authors change them
 * between versions, so these are offered as a shortcut while copy and QR — which
 * work everywhere, including NPV Tunnel — stay the primary path.
 */
function importLinks(url) {
  const encoded = encodeURIComponent(url);
  const base64 = btoa(url).replace(/=+$/, '');
  return [
    { label: 'v2rayNG', href: `v2rayng://install-sub/${base64}` },
    { label: 'Hiddify', href: `hiddify://install-config?url=${encoded}` },
    { label: 'Streisand', href: `streisand://import/${encoded}` },
  ];
}

/**
 * One config line, on its own.
 *
 * The subscription link is the better path and stays first — it refreshes
 * itself, so a gateway that changes reaches the client without anybody doing
 * anything. But a link is fetched over the network, and the network is exactly
 * what is unreliable here: on the day the link's own domain is unreachable, a
 * config copied while it worked still connects. Apps that take a single config
 * and no subscription at all are the other half of the reason.
 */
function ConfigLine({ profile }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="config-head">
        <span className="state-label state-label-plain">{profile.label || profile.gatewayName}</span>
        <span className="config-protocol">{profile.protocol}</span>
      </div>
      <code className="token-box">{profile.uri}</code>
      <div className="action-row">
        <CopyButton value={profile.uri} label="Copy config" />
        <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide QR' : 'Show QR'}
        </Button>
      </div>
      {open && (
        <div className="qr-wrap">
          <Qr value={profile.uri} size={200} label={`QR code for ${profile.label || profile.gatewayName}`} />
        </div>
      )}
    </Card>
  );
}

/**
 * Linking this account to the support chat.
 *
 * Support is answered in Telegram, and a chat there is anonymous: the bot can
 * talk about plans, but it cannot see whether *your* subscription expired
 * until it knows which account is asking. The code is how it finds out — it
 * lasts ten minutes, works once, and is bound to the session that asked for
 * it, so it is safe to read out loud and useless to anybody else afterwards.
 *
 * Shown only when a bot is actually configured. Offering somebody a code for a
 * chat that does not exist is worse than saying nothing.
 */
function SupportChat({ bot }) {
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(null);

  const ask = async () => {
    setBusy(true);
    setFailed(null);
    try {
      setCode(await shop.linkCode());
    } catch (err) {
      setFailed(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Support chat" hint="Answered day and night; a person takes over when it cannot help">
      <Card>
        <Row label="Bot" value={`@${bot.telegram}`} />
        {code ? (
          <>
            <code className="token-box">/link {code.code}</code>
            <div className="action-row">
              <CopyButton value={`/link ${code.code}`} label="Copy" />
              <a className="btn btn-ghost" href={`https://t.me/${bot.telegram}`} target="_blank" rel="noreferrer">
                Open the chat
              </a>
            </div>
            <p className="quiet">Send that to the bot within ten minutes. It works once.</p>
          </>
        ) : (
          <>
            <p className="quiet">
              Get a code, send it to the bot as <code>/link 123456</code>, and it can answer about
              this subscription instead of guessing.
            </p>
            <div className="action-row">
              <Button onClick={ask} disabled={busy}>{busy ? 'Getting a code…' : 'Get a link code'}</Button>
            </div>
          </>
        )}
        {failed && <p className="quiet">{failed}</p>}
      </Card>
    </Section>
  );
}

export function MyConfig() {
  const { data, error, loading, stale, updatedAt, refresh } = useResource('shop:me', shop.me, { intervalMs: 30000 });
  const shopConfig = useResource('shop:config', shop.config, { intervalMs: 300000 });
  const [showQr, setShowQr] = useState(true);
  const [showConfigs, setShowConfigs] = useState(false);

  if (loading && !data) return <Skeleton rows={4} />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!data) return null;

  const subscription = data.subscription;

  if (!subscription) {
    return (
      <>
        <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />
        <EmptyState
          icon="key"
          title="No config yet"
          body="Buy a plan and your subscription link appears here straight away."
          action={<Button icon="plus" onClick={() => navigate('/')}>See plans</Button>}
        />
      </>
    );
  }

  const warning = STATE_COPY[subscription.state];
  const fraction = subscription.quotaBytes > 0
    ? Math.min(1, subscription.usedBytes / subscription.quotaBytes)
    : 0;

  return (
    <>
      <StaleBanner stale={stale} updatedAt={updatedAt} error={error} />

      <Card className={`state-card state-${subscription.active ? 'ok' : 'bad'}`}>
        <div className="state-head">
          <span className="state-label state-label-plain">{data.customer.email}</span>
          <span className="state-name">{subscription.active ? 'Active' : 'Inactive'}</span>
        </div>
        {warning && <p className="state-body">{warning}</p>}
      </Card>

      {subscription.active && (
        <Section title="Your subscription link" hint="Paste it into your VPN app, or scan the code">
          <Card>
            <code className="token-box">{subscription.subscriptionUrl}</code>
            <div className="action-row">
              <CopyButton value={subscription.subscriptionUrl} label="Copy link" />
              <Button variant="ghost" onClick={() => setShowQr((v) => !v)}>
                {showQr ? 'Hide QR' : 'Show QR'}
              </Button>
            </div>
            {showQr && (
              <div className="qr-wrap">
                <Qr value={subscription.subscriptionUrl} size={220} label="Subscription QR code" />
                <p className="detail-note">
                  In your VPN app choose &quot;add subscription from QR&quot; and scan this.
                </p>
              </div>
            )}
          </Card>

          <Card>
            <span className="metric-label">Open in an installed app</span>
            <div className="action-row link-row">
              {importLinks(subscription.subscriptionUrl).map((link) => (
                <a key={link.label} className="btn btn-ghost" href={link.href}>{link.label}</a>
              ))}
            </div>
            <p className="detail-note">
              These only work if that app is installed. For NPV Tunnel and anything else, use
              &quot;Copy link&quot; and add it as a subscription inside the app.
            </p>
          </Card>
        </Section>
      )}

      {subscription.active && subscription.profiles?.length > 0 && (
        <Section
          title="Individual configs"
          hint="For apps that take one config at a time, or for a day the link will not load"
        >
          <Card>
            <div className="action-row">
              <CopyButton
                value={subscription.profiles.map((p) => p.uri).join('\n')}
                label={`Copy all ${subscription.profiles.length}`}
              />
              <Button variant="ghost" onClick={() => setShowConfigs((v) => !v)}>
                {showConfigs ? 'Hide them' : 'Show them one by one'}
              </Button>
            </div>
            <p className="detail-note">
              These are the same servers your subscription link points at, written out. In NPV
              Tunnel, v2rayNG or any similar app, import from the clipboard or scan a QR code.
              They do not update themselves — the subscription link does.
            </p>
          </Card>
          {showConfigs && subscription.profiles.map((profile) => (
            <ConfigLine key={profile.uri} profile={profile} />
          ))}
        </Section>
      )}

      <Section title="Usage">
        <Card>
          <Row label="Used" value={bytes(subscription.usedBytes)} />
          <Row label="Included" value={subscription.quotaBytes > 0 ? bytes(subscription.quotaBytes) : 'unmetered'} />
          {subscription.quotaBytes > 0 && (
            <>
              <Row label="Left" value={bytes(subscription.remainingBytes)} />
              <Meter fraction={fraction} status={fraction > 0.9 ? 'bad' : fraction > 0.7 ? 'warn' : 'ok'} />
            </>
          )}
          <Row label="Expires" value={`${absoluteTime(subscription.expiresAt)} · ${relativeTime(subscription.expiresAt)}`} />
          <Row label="Servers available" value={subscription.profileCount} />
        </Card>
        <Button variant="ghost" icon="plus" onClick={() => navigate('/')}>
          {subscription.active ? 'Add more data or time' : 'Reactivate with a plan'}
        </Button>
      </Section>

      {subscription.active && subscription.profileCount === 0 && (
        <Card className="notice notice-warn">
          <div>
            <strong>No server is reachable right now</strong>
            <p>
              Your subscription is valid, but no gateway currently has a working path out.
              Your app will pick one up automatically as soon as one recovers.
            </p>
          </div>
        </Card>
      )}

      {shopConfig.data?.supportBot && <SupportChat bot={shopConfig.data.supportBot} />}

      <Section title="Orders">
        {data.orders.length === 0 ? (
          <Card className="quiet">No orders yet.</Card>
        ) : (
          <Card className="event-card">
            <ul className="event-list">
              {data.orders.map((order) => (
                <li key={order.id} className="event" role="button" tabIndex={0}
                  onClick={() => navigate(`/order/${order.id}`)}
                  onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/order/${order.id}`); }}
                >
                  <div className="event-main">
                    <span className="event-type">{order.status}</span>
                    <p>{order.planName} · {order.payAmountUsdt} USDT</p>
                  </div>
                  <time>{relativeTime(order.createdAt)}</time>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </Section>

      <Card className="quiet">
        <p>
          SixVPN hands your app a config; the tunnel itself runs inside a VPN client such as
          NPV Tunnel, v2rayNG or Hiddify. A browser cannot open a VPN connection.
        </p>
      </Card>
    </>
  );
}
