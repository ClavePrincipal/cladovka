import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'noir_' });

const c = (name, help, labelNames = []) => new client.Counter({ name, help, labelNames, registers: [registry] });
export const metrics = {
  http: new client.Histogram({
    name: 'noir_http_request_duration_seconds', help: 'HTTP request duration', labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
  }),
  bets: c('noir_bets_total', 'Bets placed', ['product']),
  stake: c('noir_stake_minor_total', 'Stake amount (minor units)', ['product']),
  payout: c('noir_payout_minor_total', 'Payout amount (minor units)', ['product']),
  deposits: c('noir_deposits_minor_total', 'Successful deposits (minor units)', ['provider']),
  withdrawals: c('noir_withdrawals_minor_total', 'Paid withdrawals (minor units)', ['provider']),
  logins: c('noir_logins_total', 'Login attempts', ['kind', 'result']),
  registrations: c('noir_registrations_total', 'New players'),
  amlAlerts: c('noir_aml_alerts_total', 'AML alerts raised', ['rule']),
  errors: c('noir_errors_total', 'Unhandled server errors'),
};
