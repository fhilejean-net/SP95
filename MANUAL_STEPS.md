# Manuel — ce que seul l’opérateur peut faire

Aucune valeur secrète ne doit être collée dans le chat, dans un fichier versionné ou dans le code. Les commandes ci-dessous s’exécutent dans le dossier du projet ; les valeurs restent dans `.env` ou dans le gestionnaire de secrets de l’hébergeur.

## 0. Décider où vit la Cash Factory

Le dépôt SP95 est **public** et contient un jeu. La Cash Factory y est ajoutée sans modifier le jeu, mais elle manipule des emails, des revenus et des décisions commerciales.

**Recommandé :** déplacer le dossier `factory/`, les dossiers `config/`, `ventures/`, `ideas/`, `memory/`, `reports/` et les documents dans un **dépôt privé** avant la production. Si le dépôt reste public, ne jamais commiter `.env`, `factory/data/` ni `reports/*.md` (ils sont déjà ignorés).

Mémo (`fhilejean-net/M-mo`) reste dans son dépôt privé. La landing `ventures/venture-01/` est une page de présentation séparée ; elle ne copie pas l’application.

## 1. Installer et démarrer en local

```bash
node --version          # Node 22 ou plus récent
npm ci
cp .env.example .env
```

Générer les valeurs locales (sans les afficher dans le chat) :

```bash
openssl rand -base64 32   # FACTORY_SESSION_SECRET
openssl rand -base64 32   # FACTORY_DATA_KEY (32 octets)
openssl rand -base64 32   # FACTORY_ANALYTICS_SECRET
```

Remplir `.env` :

- `FACTORY_DASHBOARD_PASSWORD` : au moins 12 caractères, unique.
- `FACTORY_SESSION_SECRET`, `FACTORY_DATA_KEY`, `FACTORY_ANALYTICS_SECRET` : les valeurs générées.
- `FACTORY_HOST=0.0.0.0`, `PORT=4100` en local ou selon l’hébergeur.
- `FACTORY_SECURE_COOKIE=1` et `FACTORY_TRUST_PROXY=1` derrière HTTPS.
- `LEGAL_OPERATOR`, `LEGAL_ADDRESS`, `LEGAL_EMAIL`, `LEGAL_HOST` : identité réelle de l’éditeur et hébergeur. Sans ces valeurs, les pages légales répondent 503 et aucune publication n’est conforme.
- Laisser `FACTORY_DEV_OUTBOX=1` uniquement en local pour voir les emails dans `factory/data/outbox/`. Le mettre à `0` en production.

Démarrer :

```bash
npm run factory
# http://localhost:4100/dashboard
# http://localhost:4100/v/venture-01/
```

Vérifier :

```bash
curl -fsS http://localhost:4100/health
npm run factory:test
```

## 2. Héberger le service (obligatoire pour le scheduler)

Le scheduler a besoin d’un **processus Node qui tourne en continu** et d’un **disque persistant** monté sur `factory/data/` et `reports/`. Ne pas déployer sur une offre serverless sans cron externe.

Options possibles : un VPS avec systemd, Render/Railway/Fly avec volume, ou un conteneur sur un serveur. Le service écoute `PORT` et doit être derrière HTTPS.

Exemple de service systemd (adapter l’utilisateur et le chemin) :

```ini
[Unit]
Description=Cash Factory
After=network.target

[Service]
WorkingDirectory=/srv/cash-factory
ExecStart=/usr/bin/node --env-file=/srv/cash-factory/.env factory/server.mjs
Restart=always
User=cashfactory
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Derrière un reverse proxy (Caddy, Nginx), transmettre `X-Forwarded-Proto` et garder `FACTORY_TRUST_PROXY=1`. Vérifier que `factory/data/` est lisible uniquement par l’utilisateur du service (`chmod 700`).

Sauvegardes : copier `factory/data/` et `reports/` chiffrés, avec une rétention définie. Tester une restauration avant de lancer une campagne.

## 3. Stripe

1. Créer un compte Stripe et activer le mode test.
2. Créer un produit et un prix récurrent (ou ponctuel) pour chaque venture payante. Noter l’identifiant `price_...` et le mettre dans `ventures/<id>/venture.json` → `product.stripePriceId`, avec `model` `subscription` ou `one_time` et `priceCents`.
3. Dans Stripe → Developers → API keys, copier la clé secrète de test dans `.env` : `STRIPE_SECRET_KEY`. Ne jamais utiliser une clé publiable côté serveur.
4. Créer un webhook vers `https://<domaine>/api/stripe/webhook` avec les événements :
   - `checkout.session.completed`
   - `invoice.paid`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `charge.refunded`
5. Copier le secret de signature dans `STRIPE_WEBHOOK_SECRET`.
6. Tester avec Stripe CLI ou un paiement test, vérifier le ledger, le MRR, le remboursement et l’idempotence. Passer en live seulement après validation des mentions légales, CGV, TVA et politique de remboursement.

Mémo est gratuit : sa landing ne propose pas de paiement. Ne pas inventer un prix ni un bouton Stripe tant qu’une offre payante n’existe pas.

## 4. Email et rapports

### Resend

1. Créer un compte Resend, vérifier le domaine d’envoi (SPF/DKIM).
2. Créer une clé API et la mettre dans `RESEND_API_KEY`.
3. Renseigner `FACTORY_FROM_EMAIL` (adresse du domaine vérifié) et `FACTORY_REPORT_EMAIL`.
4. `FACTORY_DEV_OUTBOX=0`.
5. Tester l’inscription, le double opt-in, la désinscription et un rapport.

### Telegram (alternative)

1. Créer un bot avec BotFather, récupérer le token dans `TELEGRAM_BOT_TOKEN`.
2. Écrire au bot, récupérer le chat id dans `TELEGRAM_CHAT_ID`.
3. Vérifier qu’un rapport arrive et que le token n’apparaît jamais dans les logs.

Sans canal configuré, le rapport est généré et reste sur le dashboard ; le système ne prétend pas l’avoir envoyé.

## 5. Générateur d’idées et JARVIS (facultatif)

Pour les idées IA : `OPENAI_API_KEY`, `OPENAI_MODEL`, éventuellement `OPENAI_BASE_URL`. Sans clé, le fallback local propose les idées de départ avec la mention « Pas de preuve collectée ». Ne pas acheter de trafic avant d’avoir une preuve de douleur client.

JARVIS n’est pas construit. Voir `TODO.md` : MVP déterministe sans clé, puis version LLM avec liste blanche d’outils et confirmations. Ne pas exposer une clé LLM au navigateur.

## 6. Légal et conformité

- Renseigner l’identité de l’éditeur, l’adresse, l’email de contact et l’hébergeur dans `.env` avant toute publication.
- Faire relire les mentions légales, la politique de confidentialité et les CGV par une personne compétente dans la juridiction de l’opérateur (Suisse/UE : nLPD/RGPD, TVA, droit de rétractation).
- Vérifier les sous-traitants : Stripe, Resend, Telegram, hébergeur. Signer les DPA nécessaires.
- Définir la durée de conservation, la procédure de suppression et le contact pour les droits. Le code chiffre les emails et applique un double opt-in ; il ne remplace pas une analyse juridique.
- Ne pas lancer une venture santé, finance, juridique ou destinée aux mineurs sans validation humaine et, si nécessaire, un conseil spécialisé.
- Ajouter le snippet de suivi de Mémo dans **son** dépôt si l’on veut mesurer son trafic ; la landing actuelle ne mesure que ses propres visites.

## 7. Mise en production — checklist

- [ ] Dépôt privé ou données hors du dépôt public.
- [ ] `.env` rempli, aucun secret dans Git (`git grep -i "sk_live\\|whsec_\\|bot[0-9]"`).
- [ ] HTTPS, cookie `Secure`, `FACTORY_TRUST_PROXY=1`, firewall.
- [ ] Identité légale configurée ; pages `/legal/*` en 200.
- [ ] Dashboard accessible, mot de passe fort, session qui expire.
- [ ] Stripe test : checkout, webhook signé, ledger, MRR, remboursement, idempotence.
- [ ] Email : confirmation, désinscription, suppression, rapport.
- [ ] Plafonds à 0 tant que le propriétaire ne les a pas fixés ; autonomie 1.
- [ ] Sauvegarde et restauration testées.
- [ ] Venture #1 : landing Mémo vérifiée, URL de l’app toujours en 200, aucun faux témoignage.
- [ ] Aucune campagne, publication ou message à un tiers sans approbation explicite.

## 8. Commandes utiles

```bash
npm run factory                 # serveur + scheduler
npm run factory:tick            # un tick manuel
npm run factory:report          # rapport du jour
npm run factory:ideas           # idées (fallback local sans clé)
npm run factory:cli -- status
npm run factory:cli -- pause
npm run factory:cli -- resume
npm run factory:cli -- approve <id>
npm run factory:cli -- reject <id>
npm run factory:cli -- new-venture <id> "<nom>" "<description>"
npm run factory:test
```
