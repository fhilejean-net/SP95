# Skill — idle-improve

**But.** Faire avancer le jeu sans qu'on te le demande : une entrée du backlog à la fois,
vérifiée, commitée, puis la suivante — dans le même tour, tant que le travail tient debout.

**Déclencheur.** La demande en cours est terminée et rapportée. Alors tu **ne t'arrêtes pas**
pour demander « je continue ? » : tu attaques le cycle suivant. L'utilisateur peut
t'interrompre à tout moment ; c'est lui qui décide de te stopper, pas toi qui attends son feu vert.

## La boucle, c'est toi

Aucune clé API, aucun CLI externe, aucun processus de fond : c'est l'agent qui exécute le
cycle. `scripts/agent-loop.mjs` ne fait que tenir l'état durable (`docs/agent-loop.md`) et
refuser les mouvements dangereux. Un cycle :

1. **Lire l'état** — `node scripts/agent-loop.mjs`. S'il dit `running` avec un battement
   récent, un autre cycle est vivant : ne pas en démarrer un second (finir le tour et le dire).
2. **Réclamer** — `node scripts/agent-loop.mjs --start`. Refuse si l'arbre est sale : c'est
   volontaire, on ne construit pas par-dessus du travail non vérifié.
3. **Implémenter** le plus petit changement qui satisfait le « done when » de l'entrée. Marquer
   l'avancement : `node scripts/agent-loop.mjs --beat --note "suspension retouchée"` après
   chaque étape notable, sinon une session tuée passera pour morte alors que le travail est fait.
4. **Vérifier** : `npx tsc --noEmit`, `npm test`, `npm run build`. Un changement visuel demande
   aussi une capture du serveur de dev. Pas de test supprimé, pas d'assertion affaiblie.
5. **Committer** sur la branche de travail, dans le style du dépôt.
6. **Clore** — `node scripts/agent-loop.mjs --finish --commit <sha> --note "ce qui change"`.
   L'entrée est barrée dans `docs/backlog.md`, le journal reçoit une ligne, l'état repasse à
   `idle` et la prochaine entrée s'affiche. Puis retour à l'étape 1.

Si le cycle échoue deux fois sur la même cause : annuler les modifications
(`--abort --note "…"`), marquer l'entrée `--blocked --reason "…"` et le dire. Un `main` rouge
est pire qu'une entrée intacte.

## Ne jamais laisser un tour sale

Avant de terminer un tour — parce que la demande utilisateur reprend, parce que le budget de
contexte arrive au bout, ou parce que tu dois poser une question — l'arbre Git doit être propre :

- soit le cycle est fini et commité (`--finish`),
- soit les modifications sont annulées (`--abort`).

Un worktree sale bloque le cycle suivant et rend la reprise ambiguë. C'est la seule règle non
négociable de cette boucle.

## Ce qui arrête la boucle

- L'utilisateur écrit (sa demande passe avant tout).
- Deux échecs consécutifs sur la même cause.
- Plus aucune entrée éligible : écrire une ligne dans le journal et s'arrêter.
- Le changement exigerait une dépendance, un service, ou une décision de design que
  l'utilisateur n'a pas prise : poser la question, ne pas la trancher seul.

Une amélioration par cycle, jamais deux entrées mélangées dans un commit : la boucle doit
rester relisible et réversible.

## Livraison

Chaque cycle commité est poussé sur `main` (le site publié suit), sauf si l'utilisateur a dit
de ne pas pousser : c'est son dépôt et son déploiement. Ne jamais pousser un cycle dont une
vérification a échoué. Le compte-rendu reste court : une phrase par cycle dans le chat, et le
détail dans `docs/agent-loop.md`. Pas de message par appel d'outil.
