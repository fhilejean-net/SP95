# TODO — Cash Factory

## Priorité 1 — Orchestrateur, ledger, rapport quotidien

- [x] Scheduler dans le processus Node : tick chaque minute, pause/reprise, état durable.
- [x] Ledger en centimes, idempotence Stripe, revenus/coûts/remboursements/profit net.
- [x] Rapport quotidien Markdown dans `reports/`, historique dashboard, livraison Telegram ou Resend.
- [x] Métriques visiteurs/inscriptions/conversions/MRR/churn avec « pas de donnée » explicite.
- [x] Journal d’audit JSONL et mémoire dans `memory/learnings.md`.
- [x] Plafonds journalier et total, valeur 0 par défaut, garde `assertSpendAllowed`.
- [x] Kill switch dashboard + CLI.
- [ ] Brancher un vrai canal de livraison et vérifier un envoi réel (clés dans `.env`).
- [ ] Choisir un hébergeur Node avec disque persistant et déployer (voir `MANUAL_STEPS.md`).

## Priorité 2 — Template de ventures

- [x] `ventures/_template/` : manifeste, landing, formulaire, styles, pages légales dynamiques.
- [x] `new-venture <id> "<nom>"` copie et rend le template ; statut `draft` par défaut.
- [x] Validation des manifestes, landing privée tant que la venture est `draft` ou `killed`.
- [ ] Ajouter un parcours de test automatisé qui crée une venture temporaire et vérifie sa landing.

## Priorité 3 — Générateur d’idées

- [x] Scoring explicite sur 6 critères pondérés, preuve obligatoire (y compris « Pas de preuve collectée »).
- [x] Génération hebdomadaire configurable, fallback local, source LLM facultative.
- [x] Classement dans `/ideas/ideas.json` et affichage dashboard.
- [ ] Récolter de vraies preuves (entretiens, offres, précommandes) avant de promouvoir une idée.

## Priorité 4 — Dashboard et approbations

- [x] `/dashboard` protégé par mot de passe, session signée, CSRF, limitation de tentatives.
- [x] Vue revenus/coûts/profit, ventures, jalons, MRR, inscriptions, idées, journal, rapports.
- [x] Approbation/refus en un clic, pause/reprise, génération de rapport.
- [ ] Ajouter la suppression RGPD d’un email depuis le dashboard avec journal d’audit.
- [ ] Ajouter un export CSV du ledger et des inscriptions (protégé, jamais dans Git).

## Priorité 5 — JARVIS (à ne pas construire maintenant)

### Décision

**Faisable, oui.** Recommandation : commencer par un MVP déterministe, sans LLM, branché sur les API déjà présentes. Il répond aux questions de pilotage et propose les actions, mais ne peut exécuter que les opérations autorisées et confirmées.

### MVP (2 à 4 jours)

- [ ] `POST /api/jarvis/command` authentifié, rate-limité, avec intentions fermées : `status`, `report`, `pause`, `resume`, `approve`, `reject`, `ideas`, `ventures`.
- [ ] Panneau chat dans `/dashboard` (texte), sans exécution implicite.
- [ ] Chaque action destructrice ou publique : carte de confirmation avec payload et bouton Approuver/Refuser.
- [ ] Journal d’audit identique à celui du scheduler.
- [ ] Réponses strictement issues des données ; « pas de donnée » si absent.
- [ ] Tests : intention inconnue, injection de commande, CSRF, action refusée, action approuvée.

### Version complète (2 à 4 semaines)

- [ ] LLM en *tool calling* avec liste blanche, schémas JSON, plafonds de tokens et de dépense.
- [ ] Mémoire des décisions et RAG sur `memory/learnings.md`, rapports et ventures.
- [ ] Voix optionnelle : Web Speech API (gratuit, navigateur) ou STT/TTS fournisseur ; toujours derrière confirmation.
- [ ] Bot Telegram pour consulter/approuver, avec authentification du chat et boutons signés.
- [ ] Résumé proactif quotidien et alertes de jalon.
- [ ] Tests d’injection de prompt, de contournement d’approbation et de rejeu.
- [ ] Coûts : hébergement du même service Node ; clé LLM à la charge de l’opérateur ; pas de coût fixe annoncé sans contrat de fournisseur.

### Ce qu’il faut fournir

- Une clé LLM (OpenAI ou compatible) uniquement pour la version complète.
- Le même hébergement que la Cash Factory, avec disque persistant.
- Un canal de notification (Telegram ou Resend) pour les confirmations.
- Une politique claire : JARVIS propose, l’opérateur autorise ; aucune publication ni dépense sans confirmation.

## Blocages actuels

- Aucun SaaS dans SP95 : Mémo est dans un dépôt privé séparé. La Venture #1 est donc une landing externe, pas une copie du produit.
- Aucune clé Stripe, Resend, Telegram ou LLM dans le worktree. Le système fonctionne en lecture/landing, pas en encaissement réel.
- Aucune identité légale (`LEGAL_OPERATOR`, adresse, email) : les pages légales renvoient 503.
- Le dépôt SP95 est public : ne pas y mettre de données clients ni de rapports financiers.

## Vérification

```bash
npm run factory:test        # 11 tests noyau + HTTP
npx tsc --noEmit            # jeu SP95 inchangé
npm test                    # tests du jeu
npm run build               # build du jeu
```
