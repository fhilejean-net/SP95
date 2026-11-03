# Cash Factory

Système autonome de ventures, branché à côté du jeu SP95 sans le modifier. Le cerveau est un service Node sans dépendance supplémentaire : scheduler, ledger, analytics sans cookie, emails chiffrés, Stripe, rapport quotidien, dashboard protégé et file d’approbation.

## Démarrage local

```bash
cp .env.example .env
# remplir les secrets localement, jamais dans Git
npm run factory
```

- Dashboard : <http://localhost:4100/dashboard>
- Landing Mémo : <http://localhost:4100/v/venture-01/>
- Santé : <http://localhost:4100/health>

Sans `FACTORY_DASHBOARD_PASSWORD`, le dashboard affiche la procédure de configuration. Sans identité légale, les pages `/legal/*` renvoient 503. Sans Stripe, aucun paiement n’est créé. Sans Resend/Telegram, le rapport reste sur le dashboard.

## Principes

- Niveau d’autonomie 1 par défaut : construire et mesurer, mais **jamais publier ou dépenser sans approbation**.
- Plafonds à zéro par défaut.
- « pas de donnée » plutôt qu’une estimation.
- Aucun cookie public, aucun email en clair dans les événements, aucun secret dans le code.
- Mémo est la Venture #1 existante ; elle est gratuite, donc le ledger n’invente pas de revenus.

## Commandes

```bash
npm run factory             # service + scheduler
npm run factory:tick
npm run factory:report
npm run factory:ideas
npm run factory:cli -- status
npm run factory:cli -- pause
npm run factory:cli -- resume
npm run factory:cli -- approve <id>
npm run factory:cli -- reject <id>
npm run factory:cli -- new-venture <id> "<nom>" "<description>"
npm run factory:test
```

La procédure de production, Stripe, Resend, Telegram, la conformité et la sauvegarde est dans [`MANUAL_STEPS.md`](../MANUAL_STEPS.md). L’architecture et les limites sont dans [`ARCHITECTURE.md`](../ARCHITECTURE.md). JARVIS est spécifié dans [`TODO.md`](../TODO.md), pas construit.
