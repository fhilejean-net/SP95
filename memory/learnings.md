# Learnings — Cash Factory

- **2026-11-03 — Le dépôt SP95 n’est pas un SaaS.** C’est un jeu de conduite public (Vite + TypeScript + Three.js + Rapier). Aucun Stripe, aucune page d’abonnement, aucun compte client n’y existe. Ne jamais traiter son trafic comme celui d’un produit payant.
- **2026-11-03 — Mémo est un produit séparé.** Le compte GitHub `fhilejean-net` contient `M-mo`, un dépôt privé : application de révision par cartes, comptes D1/R2, huit modes. L’URL publique répond en 200. Le dépôt n’a pas été copié ici ; la landing de Venture #1 le présente et pointe vers l’application.
- **2026-11-03 — Pas de paiement, donc pas de revenu.** Mémo est gratuit et ne contient pas d’intégration Stripe. Le ledger et le rapport doivent afficher « pas de donnée » jusqu’à ce qu’un paiement réel soit encaissé.
- **2026-11-03 — Le repo SP95 est public.** Les secrets, emails, exports clients et rapports financiers ne doivent jamais y être commités. Ils vivent dans `factory/data/` et `reports/`, ignorés par Git, ou dans un dépôt privé.
- **2026-11-03 — Le niveau 1 est le défaut.** Construire, mesurer et proposer ; jamais publier, dépenser ou envoyer à des tiers sans approbation. Les plafonds commencent à zéro.
- **2026-11-03 — Une landing ne prouve pas un marché.** Une visite, une inscription ou un clic n’est pas un revenu. Les scores d’idées sont des hypothèses, pas des preuves ; la mention « pas de preuve collectée » doit rester visible.
