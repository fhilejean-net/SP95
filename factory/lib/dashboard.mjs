import { escapeHtml, formatMoney } from './util.mjs';
import { listVentures } from './ventures.mjs';
import { listApprovals, pendingApprovals } from './approvals.mjs';
import { ventureMetrics, globalMetrics } from './metrics.mjs';
import { rankedIdeas } from './ideas.mjs';
import { listReports, reportDeliveries } from './reports.mjs';
import { recentActions } from './agent.mjs';
import { deliveryConfigured, emailConfigured } from './notify.mjs';

function money(value, currency = 'EUR') {
  return value === null || value === undefined ? 'pas de donnée' : formatMoney(value, currency);
}

function count(value) {
  return value === null || value === undefined ? 'pas de donnée' : String(value);
}

function percent(value) {
  return value === null || value === undefined ? 'pas de donnée' : `${(value * 100).toFixed(1)} %`;
}

function layout(title, body, { csrf = '', flash = '' } = {}) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} — Cash Factory</title>
  <link rel="stylesheet" href="/dashboard.css">
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/dashboard">CASH<span>FACTORY</span></a>
    <nav><a href="/dashboard#approvals">Approbations</a><a href="/dashboard#ventures">Ventures</a><a href="/dashboard#reports">Rapports</a></nav>
  </header>
  <main>
    ${flash ? `<p class="flash">${escapeHtml(flash)}</p>` : ''}
    ${body}
  </main>
  <footer class="foot">Aucun chiffre n’est estimé. « pas de donnée » signifie qu’aucune source ne fournit la valeur.</footer>
</body>
</html>`;
}

export function renderLogin({ error = '' } = {}) {
  return layout('Connexion', `
    <section class="panel narrow">
      <p class="eyebrow">Poste de commande</p>
      <h1>Reprendre la main</h1>
      <p>Le dashboard est protégé par le mot de passe défini dans <code>FACTORY_DASHBOARD_PASSWORD</code>.</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      <form method="post" action="/dashboard/login" class="stack">
        <label>Mot de passe<input type="password" name="password" autocomplete="current-password" required></label>
        <button type="submit">Ouvrir le dashboard</button>
      </form>
    </section>
  `);
}

export function renderSetup() {
  return layout('Configuration requise', `
    <section class="panel narrow">
      <p class="eyebrow">Sécurité</p>
      <h1>Dashboard non configuré</h1>
      <p>Définis <code>FACTORY_DASHBOARD_PASSWORD</code> (12 caractères minimum) et <code>FACTORY_SESSION_SECRET</code> dans <code>.env</code>, puis redémarre le service.</p>
      <p>Procédure complète : <code>MANUAL_STEPS.md</code>.</p>
    </section>
  `);
}

function KPI(label, value, note = '') {
  return `<article class="kpi"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ''}</article>`;
}

export function renderDashboard({ config, session, flash = '', error = '' } = {}) {
  const ventures = listVentures();
  const global = globalMetrics();
  const ledger = global.ledger;
  const totalVisitors = ventures.some((venture) => ventureMetrics(venture.id).visitors !== null)
    ? ventures.reduce((total, venture) => total + (ventureMetrics(venture.id).visitors ?? 0), 0)
    : null;
  const totalSignups = ventures.some((venture) => ventureMetrics(venture.id).signups !== null)
    ? ventures.reduce((total, venture) => total + (ventureMetrics(venture.id).signups ?? 0), 0)
    : null;
  const pending = pendingApprovals();
  const decisions = listApprovals().filter((item) => item.status !== 'pending').slice(-12).reverse();
  const reports = listReports();
  const deliveries = Object.fromEntries(reportDeliveries().map((item) => [item.date, item]));
  const ideas = rankedIdeas().slice(0, 8);
  const actions = recentActions(20);
  const csrf = session?.csrf ?? '';
  return layout('Dashboard', `
    <section class="hero">
      <div>
        <p class="eyebrow">Venture #1 · ${escapeHtml(ventures[0]?.name ?? 'aucune')}</p>
        <h1>Le business, pas le tableau de bord.</h1>
        <p class="lede">Chaque chiffre vient du ledger, des événements ou de Stripe. Le reste est explicitement absent.</p>
      </div>
      <div class="controls">
        <form method="post" action="/dashboard/${config.paused ? 'resume' : 'pause'}">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button class="danger" type="submit">${config.paused ? 'Reprendre' : 'Tout mettre en pause'}</button>
        </form>
        <form method="post" action="/dashboard/report">
          <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
          <button type="submit">Générer le rapport</button>
        </form>
      </div>
    </section>
    ${flash ? `<p class="flash">${escapeHtml(flash)}</p>` : ''}
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <section class="panel statusline">
      <span class="dot ${config.paused ? 'off' : 'on'}"></span>
      <strong>${config.paused ? 'En pause' : 'Actif'}</strong>
      <span>Autonomie ${config.autonomyLevel}</span>
      <span>Plafond jour ${money(config.spendCapDailyCents, config.currency)}</span>
      <span>Plafond total ${money(config.spendCapTotalCents, config.currency)}</span>
      <span>Rapport ${String(config.dailyReportHour).padStart(2, '0')}:00 ${escapeHtml(config.timezone)}</span>
      <form method="post" action="/dashboard/logout">
        <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
        <button class="ghost" type="submit">Se déconnecter</button>
      </form>
    </section>

    <section class="kpis">
      ${KPI('Revenus cumulés', money(ledger.hasData ? ledger.revenue : null, config.currency), 'ledger Stripe / manuel')}
      ${KPI('Coûts cumulés', money(ledger.hasData ? ledger.expenses : null, config.currency), 'hébergement, API, publicité')}
      ${KPI('Profit net', money(ledger.hasData ? ledger.net : null, config.currency), 'revenus − coûts − remboursements')}
      ${KPI('Visiteurs', count(totalVisitors), 'uniques par jour, sans cookie')}
      ${KPI('Inscriptions', count(totalSignups), 'emails confirmés')}
      ${KPI('MRR', money(global.mrrCents, config.currency), 'abonnements actifs')}
    </section>

    <section class="panel" id="approvals">
      <div class="sectionhead"><h2>En attente de ta décision</h2><span class="badge">${pending.length}</span></div>
      ${pending.length === 0 ? '<p class="muted">Aucune approbation en attente. Le système ne publie rien et ne dépense rien sans toi.</p>' : `
        <div class="list">${pending.map((item) => `
          <article class="approval">
            <div>
              <h3>${escapeHtml(item.title)}</h3>
              <p>${escapeHtml(item.summary)}</p>
              <p class="meta">${escapeHtml(item.kind)}${item.ventureId ? ` · ${escapeHtml(item.ventureId)}` : ''} · ${escapeHtml(item.id)}</p>
            </div>
            <div class="approval-actions">
              <form method="post" action="/dashboard/approvals/${encodeURIComponent(item.id)}">
                <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
                <input type="hidden" name="decision" value="approved">
                <button type="submit">Approuver</button>
              </form>
              <form method="post" action="/dashboard/approvals/${encodeURIComponent(item.id)}">
                <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
                <input type="hidden" name="decision" value="rejected">
                <button class="ghost" type="submit">Refuser</button>
              </form>
            </div>
          </article>`).join('')}</div>`}
    </section>

    <section class="panel" id="ventures">
      <div class="sectionhead"><h2>Ventures</h2><span class="muted">${ventures.length} suivie(s)</span></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Venture</th><th>Statut</th><th>Visiteurs</th><th>Inscriptions</th><th>Paiements</th><th>MRR</th><th>Budget</th></tr></thead>
        <tbody>${ventures.map((venture) => {
          const metrics = ventureMetrics(venture.id);
          return `<tr>
            <td><strong>${escapeHtml(venture.name)}</strong><br><span class="meta">${escapeHtml(venture.id)} · ${escapeHtml(venture.kind)}</span></td>
            <td><span class="pill ${escapeHtml(venture.status)}">${escapeHtml(venture.status)}</span></td>
            <td>${count(metrics.visitors)}</td>
            <td>${count(metrics.signups)}</td>
            <td>${count(metrics.payments)}</td>
            <td>${money(metrics.mrrCents, venture.product.currency)}</td>
            <td>${money(venture.budget.moneyCents, venture.product.currency)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
    </section>

    <section class="grid2">
      <section class="panel" id="reports">
        <div class="sectionhead"><h2>Rapports</h2><span class="muted">${reports.length}</span></div>
        ${reports.length === 0 ? '<p class="muted">Aucun rapport encore généré.</p>' : `<ul class="reports">${reports.slice(0, 14).map((date) => {
          const delivery = deliveries[date];
          const state = delivery?.sent ? `envoyé via ${delivery.provider}` : delivery ? 'non envoyé' : 'non livré';
          return `<li><a href="/dashboard/reports/${encodeURIComponent(date)}">${escapeHtml(date)}</a><span class="meta">${escapeHtml(state)}</span></li>`;
        }).join('')}</ul>`}
        <p class="meta">Livraison : ${deliveryConfigured() ? 'canal configuré' : 'aucun canal — le rapport reste sur le dashboard'}</p>
      </section>
      <section class="panel">
        <div class="sectionhead"><h2>Idées classées</h2><span class="muted">${ideas.length}</span></div>
        ${ideas.length === 0 ? '<p class="muted">pas de donnée : aucune idée générée.</p>' : `<ol class="ideas">${ideas.map((idea) => `<li><div><strong>${escapeHtml(idea.title)}</strong><br><span class="meta">${escapeHtml(idea.target ?? '')}</span></div><span class="score">${idea.score}/10</span></li>`).join('')}</ol>`}
      </section>
    </section>

    <section class="grid2">
      <section class="panel">
        <div class="sectionhead"><h2>Journal</h2><span class="muted">20 dernières</span></div>
        ${actions.length === 0 ? '<p class="muted">Aucune action enregistrée.</p>' : `<ul class="log">${actions.map((item) => `<li><span class="meta">${escapeHtml(new Date(item.at).toLocaleString('fr-CH'))}</span> ${escapeHtml(item.summary)}${item.error ? ` <span class="error">${escapeHtml(item.error)}</span>` : ''}</li>`).join('')}</ul>`}
      </section>
      <section class="panel">
        <div class="sectionhead"><h2>Décisions récentes</h2><span class="muted">${decisions.length}</span></div>
        ${decisions.length === 0 ? '<p class="muted">Aucune décision.</p>' : `<ul class="log">${decisions.map((item) => `<li><strong>${escapeHtml(item.status)}</strong> · ${escapeHtml(item.title)}<br><span class="meta">${escapeHtml(item.decidedAt ?? '')}</span></li>`).join('')}</ul>`}
      </section>
    </section>
  `, { csrf });
}

export function legalConfigured() {
  return Boolean(process.env.LEGAL_OPERATOR && process.env.LEGAL_ADDRESS && process.env.LEGAL_EMAIL);
}

export function renderLegal(kind, ventureName = 'la venture', ventureId = 'venture-01') {
  if (!legalConfigured()) {
    return {
      status: 503,
      html: layout('Mentions légales non configurées', `
        <section class="panel narrow">
          <h1>Publication bloquée</h1>
          <p>Les mentions légales ne sont pas configurées. Renseigne <code>LEGAL_OPERATOR</code>, <code>LEGAL_ADDRESS</code> et <code>LEGAL_EMAIL</code> avant toute publication.</p>
        </section>`),
    };
  }
  const operator = escapeHtml(process.env.LEGAL_OPERATOR);
  const address = escapeHtml(process.env.LEGAL_ADDRESS);
  const email = escapeHtml(process.env.LEGAL_EMAIL);
  const host = escapeHtml(process.env.LEGAL_HOST ?? 'l’hébergeur configuré');
  const pages = {
    privacy: {
      title: 'Confidentialité',
      body: `
        <h1>Confidentialité</h1>
        <p><strong>Responsable :</strong> ${operator}, ${address} — <a href="mailto:${email}">${email}</a>.</p>
        <p>Cette page explique le traitement des données de ${escapeHtml(ventureName)} et du site Cash Factory.</p>
        <h2>Ce que nous collectons</h2>
        <ul><li>Mesure d’audience agrégée : événements de page, sans cookie et sans adresse IP en clair. L’empreinte visiteur est un HMAC journalier tronqué.</li>
        <li>Formulaire email : adresse email, date et source du consentement. L’adresse est chiffrée au repos et n’est utilisée que pour les nouvelles du produit ou la confirmation demandée.</li>
        <li>Paiement : Stripe traite les données de carte. Le serveur ne reçoit ni numéro de carte ni cryptogramme ; il conserve l’identifiant de paiement et le montant.</li></ul>
        <h2>Bases légales</h2>
        <p>Consentement pour les emails et la mesure agrégée ; exécution du contrat pour un achat ; intérêt légitime pour la sécurité et la prévention de la fraude.</p>
        <h2>Durées</h2>
        <p>Email : jusqu’au retrait du consentement, puis suppression sous 30 jours. Événements agrégés : 13 mois. Données de paiement : durée légale comptable applicable.</p>
        <h2>Destinataires</h2>
        <p>Selon la configuration : Stripe (paiement), Resend (email), Telegram (rapports internes), ${host} (hébergement). Aucune vente de données.</p>
        <h2>Tes droits</h2>
        <p>Accès, rectification, effacement, limitation, opposition et portabilité : écris à <a href="mailto:${email}">${email}</a>. Tu peux aussi saisir l’autorité de protection des données compétente.</p>
        <p>Le dashboard utilise un cookie de session strictement nécessaire ; les visiteurs du site public n’en reçoivent pas.</p>`,
    },
    terms: {
      title: 'Conditions',
      body: `
        <h1>Conditions d’utilisation</h1>
        <p>${escapeHtml(ventureName)} est fourni par ${operator}. L’accès au site public est gratuit ; les fonctionnalités payantes, si elles existent, sont annoncées avec leur prix avant paiement.</p>
        <p>Aucun revenu, audience ou résultat commercial n’est garanti. Les contenus sont fournis en l’état, sans conseil juridique, fiscal ou financier.</p>
        <p>Les paiements sont traités par Stripe. Les demandes de remboursement suivent la politique affichée au moment de l’achat et le droit applicable.</p>
        <p>Contact : <a href="mailto:${email}">${email}</a>.</p>`,
    },
    mentions: {
      title: 'Mentions légales',
      body: `
        <h1>Mentions légales</h1>
        <p><strong>Éditeur :</strong> ${operator}<br>${address}<br><a href="mailto:${email}">${email}</a></p>
        <p><strong>Hébergement :</strong> ${host}</p>
        <p><strong>Directeur de publication :</strong> ${operator}</p>
        <p>Les marques et contenus tiers restent la propriété de leurs titulaires.</p>`,
    },
  };
  const page = pages[kind];
  if (!page) return { status: 404, html: layout('Page introuvable', '<section class="panel narrow"><h1>Page introuvable</h1></section>') };
  return {
    status: 200,
    html: layout(page.title, `<section class="panel prose">${page.body}<p><a href="/v/${encodeURIComponent(ventureId)}/">Retour à la landing</a> · <a href="/dashboard">Dashboard</a></p></section>`),
  };
}

export function renderReport(date, content) {
  return layout(`Rapport ${date}`, `
    <section class="panel">
      <div class="sectionhead"><h1>Rapport ${escapeHtml(date)}</h1><a class="buttonlink" href="/dashboard">Retour</a></div>
      <pre class="report">${escapeHtml(content)}</pre>
    </section>`);
}

export function renderMessage(title, message) {
  return layout(title, `<section class="panel narrow"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/v/venture-01/">Retour au site</a></p></section>`);
}

export function emailStatus() {
  return { email: emailConfigured(), delivery: deliveryConfigured() };
}
