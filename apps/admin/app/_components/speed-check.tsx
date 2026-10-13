'use client';

import { adminSpeedCheck, type AdminSpeedCheck } from '@bedo/api-client';
import { Icon } from '@bedo/ui';
import { useEffect, useState } from 'react';

const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada',
  'sa-east-1': 'South America (São Paulo)',
  'eu-west-1': 'Europe (Ireland)',
  'eu-west-2': 'Europe (London)',
  'eu-west-3': 'Europe (Paris)',
  'eu-central-1': 'Europe (Frankfurt)',
  'eu-north-1': 'Europe (Stockholm)',
  'me-central-1': 'Middle East (UAE)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
};

const regionName = (code: string | null) => (code ? (REGION_NAMES[code] ?? code) : 'unknown');

/** About how many database steps one sent message waits for (measured in Phase 14.4). */
const STEPS_PER_MESSAGE = 15;

/**
 * Phase 14.4: where the website's server runs, where the database is and how long one database step takes. When they
 * are far apart every message waits for each step, so this is the first thing to check when sending feels slow.
 */
export function SpeedCheck({ onSessionError }: { onSessionError: (error: unknown) => void }) {
  const [check, setCheck] = useState<AdminSpeedCheck | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    adminSpeedCheck()
      .then(setCheck)
      .catch((caught: unknown) => {
        onSessionError(caught);
        setFailed(true);
      });
  }, [onSessionError]);

  if (failed) return null;
  if (!check) {
    return <p className="text-sm text-ink-secondary">Checking the connection speed…</p>;
  }
  const perMessageSeconds = (check.databaseRoundTripMs * STEPS_PER_MESSAGE) / 1000;
  const far = check.sameRegion === false || check.databaseRoundTripMs > 50;
  return (
    <section
      aria-label="Speed check"
      className={`flex items-start gap-3 rounded-md border p-4 text-sm shadow-sm ${far ? 'border-danger/25 bg-danger/5' : 'border-success/30 bg-success/10'}`}
    >
      <Icon name={far ? 'warning' : 'check_circle'} size={22} className={`shrink-0 ${far ? 'text-danger' : 'text-success'}`} />
      <div className="flex flex-col gap-1.5">
        <p className="font-semibold">{far ? 'Sending is slowed by distance' : 'Server and database are close together'}</p>
        <p>
          Website server: <span className="font-medium">{regionName(check.serverRegion)}</span>. Database:{' '}
          <span className="font-medium">{regionName(check.databaseRegion)}</span>. One database step takes{' '}
          <span className="font-medium" data-testid="db-round-trip">
            {check.databaseRoundTripMs.toLocaleString()} ms
          </span>
          {far ? `, so a message waits about ${perMessageSeconds.toFixed(1)} seconds before it is sent.` : '.'}
        </p>
        {far ? (
          <p className="text-ink-secondary">
            Fix: in Netlify open this site → Cloud compute → Functions → Region → Configure → choose the database&apos;s region (
            {regionName(check.databaseRegion)}) → Save, then Deploys → Trigger deploy. Choosing a region needs Netlify Pro.
          </p>
        ) : null}
      </div>
    </section>
  );
}
