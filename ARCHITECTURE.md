# Cash Factory — architecture

## Ce que le dépôt contient réellement

L’audit du 3 novembre 2026 a trouvé **le jeu SP95** : Vite + TypeScript + Three.js + Rapier, public sur GitHub Pages, sans page SaaS, sans Stripe, sans abonnement et sans compte client. Il n’y a **aucune page SaaS à conserver dans ce worktree**.

Le compte GitHub connecté contient aussi **Mémo** (`fhilejean-net/M-mo`), un dépôt **privé** : application de révision par cartes, comptes, D1/R2, huit modes. Son URL publique répond en 200. C’est le produit existant le plus proche de la demande ; il est donc traité comme **Venture #1 externe**. Le code de Mémo n’a pas été copié ici.

Conséquence assumée : Mémo est **gratuit** et ne possède pas encore de paiement. Le ledger, le MRR et les revenus affichent « pas de donnée » jusqu’à un encaissement réel. Aucun chiffre n’est simulé.

## Vue d’ensemble

```
                    ┌──────────────────────────────────────────┐
                    │  Scheduler (factory/server.mjs)          │
                    │  tick chaque minute                      │
                    └──────────────┬───────────────────────────┘
                                   │
       ┌───────────────────────────┼─────────────────────────────┐
       │                           │                             │
┌──────▼───────┐          ┌────────▼────────┐          ┌─────────▼────────┐
│ Agent        │          │ Mesure          │          │ Décision         │
│ rapport      │          │ events sans     │          │ règles + jalons  │
│ idées        │          │ cookie, ledger, │          │ + budget         │
│ évaluation   │          │ inscriptions,   │          │                  │
│ audit JSONL  │          │ Stripe          │          │ approbations     │
└──────┬───────┘          └────────┬────────┘          └─────────┬────────┘
       │                           │                             │
       └───────────────────────────┼─────────────────────────────┘
                                   │
                     ┌─────────────▼─────────────┐
                     │ JSON atomique + JSONL     │
                     │ factory/data/ (hors Git)  │
                     └─────────────┬─────────────┘
                                   │
       ┌───────────────────────────┼─────────────────────────────┐
       │                           │                             │
┌──────▼───────┐          ┌────────▼────────┐          ┌─────────▼────────┐
│ Dashboard    │          │ Landing + API   │          │ Stripe webhook   │
│ protégé      │          │ publique        │          │ + Resend/Telegram│
└──────────────┘          └─────────────────┘          └──────────────────┘
```

Un seul processus Node, aucune dépendance nouvelle. Le fichier `factory/server.mjs` sert les landings, l’API, le dashboard et le webhook. Le scheduler tourne dans le même processus ; un déploiement doit donc être un service Node avec disque persistant, pas une fonction serverless.

## Arborescence

```
factory/
  server.mjs             HTTP, landings, API, dashboard, webhook
  cli.mjs                tick, rapport, idées, approbations, nouvelles ventures
  lib/
    agent.mjs            boucle observe → décide → journalise
    approvals.mjs        file d’approbation et exécution des changements de statut
    auth.mjs             mot de passe, session signée, CSRF
    config.mjs           chargement/validation de config/factory.json
    dashboard.mjs        rendu HTML du poste de commande et des pages légales
    events.mjs           mesure agrégée sans cookie
    ideas.mjs            scoring et génération hebdomadaire
    ledger.mjs           revenus, coûts, remboursements, profit net
    metrics.mjs          agrégats par venture
    notify.mjs           Telegram, Resend, outbox local
    reports.mjs          rapport quotidien et historique
    rules.mjs            jalons, scale, pivot, kill, plafonds
    signups.mjs          emails chiffrés + double opt-in
    storage.mjs          JSON atomique, verrou court, JSONL
    stripe.mjs           checkout et vérification de signature
  public/                CSS dashboard, tracking, formulaire
  templates/             (les landings vivent dans ventures/_template)
  test/                  tests noyau et HTTP
config/factory.json      autonomie, plafonds, heure du rapport, base URL
config/rules.json        jalons et seuils par défaut
ventures/_template/      modèle copiable pour une nouvelle venture
ventures/venture-01/     Mémo, landing et manifeste
ideas/ideas.json         idées notées (contenu, pas de donnée client)
memory/learnings.md      mémoire opérationnelle
reports/                 rapports générés, ignorés par Git
```

## Données

Tout est en **centimes entiers** et en **UTC** pour les horodatages ; la timezone ne sert qu’à décider la date locale du rapport et des jalons. Les montants sont dans la devise de `config/factory.json` (EUR par défaut). Une entrée de ledger est idempotente sur `(source, externalId)`.

- `ledger.json` : revenus, coûts, remboursements. Le profit net est `revenus − coûts − remboursements`.
- `events/YYYY-MM-DD.jsonl` : `{ventureId, type, path, referrerOrigin, visitor, at}`. Pas d’IP brute, pas de user-agent, pas de cookie. `visitor` est un HMAC tronqué, salé par jour.
- `signups/<venture>.json` : email **chiffré** AES-256-GCM, hash d’email, consentement, confirmation, token de désinscription hashé. La clé vient de `FACTORY_DATA_KEY`.
- `subscriptions.json` : état et MRR connus via Stripe. Pas de carte, pas de client Stripe complet.
- `approvals.json` : file d’approbation avec payload et décision.
- `actions.jsonl` : journal d’audit de chaque action du scheduler.
- `runtime.json` : dernier rapport, dernière évaluation, dernière semaine d’idées.
- `reports/YYYY-MM-DD.md` : rapport lisible, historique sur le dashboard.

## Boucle

Chaque minute, `factory/lib/agent.mjs` :

1. **Observe** les événements, inscriptions, ledger et abonnements.
2. **Décide** : rapport quotidien à l’heure configurée, idées le jour configuré, évaluation des jalons une fois par jour.
3. **Agit** : écrit le rapport, génère les idées, crée une approbation pour un pivot/arrêt/scale. Au niveau 2 seulement, les changements de statut prévus peuvent être auto-approuvés ; les dépenses et publications restent soumises aux règles et plafonds.
4. **Journalise** dans `actions.jsonl` et, pour le rapport, dans son en-tête.

Une venture active est évaluée sur ses jalons. Sans traction (visiteurs sous le seuil, zéro inscription, zéro paiement) après l’échéance : **kill**. Avec un peu de traction mais le jalon manqué : **pivot** (matérialisé par une pause réversible). Avec un MRR au-dessus du seuil : **scale**. Le niveau 1 ne fait rien d’irréversible sans approbation.

## Autonomie et approbations

- **Niveau 0** : propose seulement ; aucune publication, aucune dépense.
- **Niveau 1 (défaut)** : construit et mesure ; toute action publique ou dépense attend une approbation dans `/dashboard` ou via `npm run factory:cli -- approve <id>`.
- **Niveau 2** : peut publier et dépenser dans les plafonds fixés. `spendCapDailyCents` et `spendCapTotalCents` valent **0 par défaut**, ce qui bloque toute dépense. Un plafond n’est jamais contourné par le code.

Le dashboard ne déclenche pas un déploiement ni un paiement : il approuve une décision et exécute uniquement les changements de statut connus. Une publication réelle (déploiement, campagne, message à un tiers) reste une action manuelle documentée dans `MANUAL_STEPS.md`. C’est volontaire : le système ne prétend pas avoir publié ce qu’il n’a pas publié.

## Sécurité et conformité

- Secrets uniquement dans `.env` (ignoré) ou le gestionnaire de secrets de l’hébergeur. `.env.example` ne contient aucune valeur.
- Dashboard : mot de passe (12 caractères minimum) comparé à temps constant, session HMAC signée, cookie `HttpOnly`/`SameSite=Lax`, CSRF sur chaque formulaire, limitation des tentatives.
- Webhook Stripe : corps brut, HMAC SHA-256, tolérance de 5 minutes, idempotence par `event.id`.
- Emails : double opt-in, consentement explicite, désinscription, chiffrement au repos, pas d’email dans les événements analytics.
- Analytics : première partie, agrégée, sans cookie ; la page publique ne reçoit pas de cookie. Les pages légales sont bloquées (503) tant que l’identité de l’éditeur n’est pas configurée.
- Aucun scraping, achat d’avis, spam, fausse preuve, crypto, jeu d’argent ou MLM. Les idées touchant la santé, la finance, le juridique ou les mineurs sont marquées `regulated` et ne peuvent pas être lancées sans validation humaine.
- Le dépôt SP95 est **public** : ne jamais y commiter `.env`, `factory/data/`, `reports/*.md` ni les exports d’emails. Pour une exploitation sérieuse, déplacer la Cash Factory dans un dépôt privé.

## Limites de cette version

- Le stockage JSON convient à un opérateur et à un volume faible. Migrer vers PostgreSQL avant plusieurs milliers d’événements par jour ou plusieurs writers.
- Le scheduler dépend du processus Node. Sans service supervisé, aucun rapport n’est généré : le cron système est une alternative documentée.
- Aucun paiement n’est actif tant que Stripe n’est pas configuré. Mémo est gratuit ; sa landing collecte des emails, pas des revenus.
- Le churn n’est calculé que lorsque des abonnements Stripe existent ; sinon « pas de donnée ».
- JARVIS n’est pas construit. Sa conception et ses coûts sont dans `TODO.md`.

## JARVIS (décision d’architecture, pas implémentation)

Faisable. Le MVP recommandé est un **routeur d’intentions déterministe** au-dessus des API existantes (`status`, `report`, `pause`, `resume`, `approve`, `reject`, `ideas`) avec un panneau de chat et des boutons de confirmation. Il ne nécessite **aucune clé LLM** et ne peut pas exécuter une action non prévue.

La version complète ajoute un LLM en *tool calling* avec liste blanche d’outils, jetons de confirmation, plafonds, journal d’audit et protection contre les injections de prompt ; la voix (Web Speech API ou STT/TTS fournisseur) reste une interface, pas une autorisation. Les coûts dépendent du modèle et de l’usage ; il n’existe pas de chiffre unique honnête sans volume. L’hébergement peut être le même service Node que la Cash Factory. Voir `TODO.md` pour le découpage.
