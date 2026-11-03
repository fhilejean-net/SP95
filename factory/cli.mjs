#!/usr/bin/env node
import process from 'node:process';
import { startScheduler, runEvaluation, runIdeas, runReport, runTick, setPaused } from './lib/agent.mjs';
import { loadFactoryConfig } from './lib/config.mjs';
import { listVentures, createVenture, getVenture } from './lib/ventures.mjs';
import { applyApproval, decideApproval, pendingApprovals } from './lib/approvals.mjs';
import { globalMetrics } from './lib/metrics.mjs';
import { startServer } from './server.mjs';
import { formatMoney } from './lib/util.mjs';

const [command = 'help', ...args] = process.argv.slice(2);

function print(value) {
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  if (command === 'serve') {
    const { server, port, host } = await startServer();
    startScheduler();
    console.log(`Cash Factory sur http://${host}:${port}`);
    const stop = () => server.close(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }
  if (command === 'tick') {
    print(await runTick());
    return;
  }
  if (command === 'report') {
    print(await runReport({ force: args.includes('--force') }));
    return;
  }
  if (command === 'ideas') {
    print(await runIdeas({ force: args.includes('--force') }));
    return;
  }
  if (command === 'evaluate') {
    print(await runEvaluation());
    return;
  }
  if (command === 'pause' || command === 'resume') {
    print(setPaused(command === 'pause'));
    return;
  }
  if (command === 'approve' || command === 'reject') {
    const id = args[0];
    if (!id) throw new Error('Identifiant d’approbation manquant');
    const decision = command === 'approve' ? 'approved' : 'rejected';
    decideApproval(id, decision, 'owner', 'Décision CLI');
    print(decision === 'approved' ? applyApproval(id) : { id, status: 'rejected' });
    return;
  }
  if (command === 'new-venture') {
    const [id, name, ...rest] = args;
    if (!id || !name) throw new Error('Usage : new-venture <id> "<nom>" ["description"]');
    const description = rest.join(' ') || `${name} — venture à tester.`;
    print(createVenture({ id, name, description }));
    return;
  }
  if (command === 'status') {
    const config = loadFactoryConfig();
    const metrics = globalMetrics();
    print({
      paused: config.paused,
      autonomyLevel: config.autonomyLevel,
      currency: config.currency,
      spendCapDailyCents: config.spendCapDailyCents,
      spendCapTotalCents: config.spendCapTotalCents,
      ventures: listVentures().map((venture) => ({ id: venture.id, name: venture.name, status: venture.status })),
      ledger: {
        hasData: metrics.ledger.hasData,
        revenue: metrics.ledger.hasData ? formatMoney(metrics.ledger.revenue, config.currency) : 'pas de donnée',
        expenses: metrics.ledger.hasData ? formatMoney(metrics.ledger.expenses, config.currency) : 'pas de donnée',
        net: metrics.ledger.hasData ? formatMoney(metrics.ledger.net, config.currency) : 'pas de donnée',
      },
      pendingApprovals: pendingApprovals().map((item) => ({ id: item.id, title: item.title })),
    });
    return;
  }
  if (command === 'venture') {
    print(getVenture(args[0]));
    return;
  }
  print(`Commandes : serve, tick, report [--force], ideas [--force], evaluate, pause, resume, approve <id>, reject <id>, new-venture <id> "<nom>" ["description"], status, venture <id>`);
}

main().catch((error) => {
  console.error(`Erreur : ${error.message}`);
  process.exitCode = 1;
});
