import { useTicker, type Polled } from '../api';
import { timeAgo } from '../format';
import { CheckList, groupHealth } from '../health';
import { Panel, Skeleton, StateCard } from '../ui';
import type { CheckGroup, Report } from '../types';

/** One project's health checks, with the fix instructions for anything that isn't ok. */
export default function Health({ group, status }: { group?: CheckGroup; status: Polled<Report> }) {
  useTicker();

  if (!status.data && status.error) {
    return (
      <StateCard art="state-offline" title="Can't reach the status API">
        <p className="muted">{status.error}</p>
        <p className="muted small">
          On the server run <code>pm2 logs status --lines 50</code>.
        </p>
      </StateCard>
    );
  }

  if (!status.data) {
    return (
      <div className="panel" aria-busy="true">
        <Skeleton width={180} height={18} />
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={44} />
        ))}
      </div>
    );
  }

  if (!group) {
    return <StateCard art="state-ok" title="No health checks for this project" compact />;
  }

  const h = groupHealth(group);
  return (
    <Panel
      icon="section-health"
      title="Health checks"
      subtitle={`${h.passing} of ${h.counted} passing · checked ${timeAgo(status.data.generatedAt)}`}
      className="panel-flush"
      actions={
        <button type="button" className="btn btn-sm" onClick={() => status.reload('refresh=1')} disabled={status.loading}>
          <span className={status.loading ? 'spin' : ''} aria-hidden="true">
            ↻
          </span>{' '}
          {status.loading ? 'Checking…' : 'Check now'}
        </button>
      }
    >
      <CheckList checks={group.checks} />
    </Panel>
  );
}
