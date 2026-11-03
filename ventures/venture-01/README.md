# Venture #1 — Mémo

Mémo est une application de révision par cartes qui existe déjà dans le dépôt privé [`fhilejean-net/M-mo`](https://github.com/fhilejean-net/M-mo). Elle possède des comptes, des données D1/R2 et huit modes d’entraînement.

Cette landing est une page de présentation **séparée** :

- elle ne copie pas l’application ;
- elle ne promet aucun revenu, aucune note, aucun résultat d’apprentissage ;
- elle ne contient ni faux témoignage ni faux chiffre ;
- elle pointe vers l’application réelle ;
- elle collecte uniquement des emails avec consentement, confirmation et désinscription.

Le produit est **gratuit**. Le manifeste `venture.json` est donc en `model: free`, sans `stripePriceId`. Le jour où une offre payante existe, il faudra créer le prix Stripe, passer le modèle à `subscription` ou `one_time`, puis ajouter le produit et ses conditions dans le dépôt de Mémo — pas seulement changer un bouton.

L’URL publique de l’application a été vérifiée le 3 novembre 2026 (HTTP 200). Si elle change, mettre à jour `venture.json`, `index.html` et la documentation avant de publier.
