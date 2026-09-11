import { api } from '../lib/api.js';
import { useResource } from '../lib/useResource.js';
import { useBack } from '../lib/router.js';
import { Card, Section, Skeleton, CopyButton, StatusPill } from '../components/ui.jsx';
import { Icon } from '../components/Icon.jsx';

const SCENARIOS = [
  ['1', 'Baseline connectivity', 'The client can reach the test origin through the gateway.'],
  ['2', 'Client direct egress blocked', 'The client container has no route to the test internet except through the gateway.'],
  ['3', 'Gateway reachable', 'The gateway answers a WebSocket upgrade on its configured path.'],
  ['4', 'Gateway egress available', 'Probe traffic pinned to each egress reaches the origin.'],
  ['5', 'Gateway egress unavailable', 'The gateway stays reachable while its egress is dead — a different failure.'],
  ['6', 'Primary egress failure', 'The primary egress is stopped; the agent reports it offline.'],
  ['7', 'Backup egress recovery', 'The control plane switches the route and client traffic resumes.'],
];

const COMMAND = 'cd lab && ./run-lab.sh';

/**
 * The lab runs on an operator machine with Docker, not from the control plane.
 * This screen documents it and shows which registered gateways are lab-mode;
 * it deliberately shows no simulated results.
 */
export function Lab() {
  const back = useBack('/admin/more');
  const { data, loading } = useResource('gateways', api.gateways, { intervalMs: 60000 });
  const labGateways = (data || []).filter((g) => !g.blockPrivateRanges);

  return (
    <>
      <button type="button" className="back" onClick={back}><Icon name="back" size={18} /> More</button>

      <Card className="state-card state-idle">
        <div className="state-head">
          <span className="state-label">Resilience</span>
          <span className="state-name">Blackout lab</span>
        </div>
        <p className="state-body">
          A controlled Docker environment where the client has no direct route to the test
          internet. It verifies that traffic still flows through a gateway, and that a dead
          egress is detected and routed around. It runs on your machine — this screen does not
          execute or simulate it.
        </p>
      </Card>

      <Section title="Run it">
        <Card>
          <code className="token-box">{COMMAND}</code>
          <CopyButton value={COMMAND} label="Copy command" />
          <p className="detail-note">
            The script starts a control plane, gateway, two egresses and an isolated client,
            then asserts each scenario below and prints a pass/fail line for every one.
          </p>
        </Card>
      </Section>

      <Section title="Scenarios">
        <Card>
          <ol className="scenario-list">
            {SCENARIOS.map(([n, title, body]) => (
              <li key={n}>
                <strong>{title}</strong>
                <span>{body}</span>
              </li>
            ))}
          </ol>
        </Card>
      </Section>

      <Section title="Lab-mode gateways" hint="Gateways with private-range blocking disabled, which only makes sense for a lab">
        {loading && !data ? <Skeleton rows={2} /> : labGateways.length === 0 ? (
          <Card className="quiet">No lab-mode gateway registered on this control plane.</Card>
        ) : labGateways.map((gateway) => (
          <Card key={gateway.id} className="list-card">
            <div className="list-main">
              <div className="list-title">
                <strong>{gateway.name}</strong>
                <StatusPill status={gateway.ingress.status} label={gateway.ingress.status} />
              </div>
              <div className="list-meta">
                <span className="mono">{gateway.host}:{gateway.port}</span>
                <span className="tone-warn">private ranges reachable</span>
              </div>
            </div>
          </Card>
        ))}
      </Section>

      <Section title="What the lab does not prove">
        <Card className="quiet">
          <p>
            A lab shows that the software fails over correctly. It cannot show that a gateway
            will remain reachable during a real national disruption, and it cannot create an
            egress path that does not exist. SyxVPN only ever routes through connectivity you
            already have and are authorized to use.
          </p>
        </Card>
      </Section>
    </>
  );
}
