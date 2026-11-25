# Wealth Board

Tableau de bord personnel de patrimoine : site statique (HTML + JS), sans build, données en JSON.

> Outil de suivi, pas un conseil en investissement.

Le dépôt ne contient que des **données d'exemple fictives**. Les vraies données se chargeront
depuis Google Drive ou un dossier local (étape f).

## Utiliser en local
```
python -m http.server 8770
```
puis ouvrir http://localhost:8770/ (l'app) et http://localhost:8770/tests/ (les tests).
Ouvrir `index.html` directement (file://) ne fonctionne pas : le navigateur bloque le chargement des JSON.

## Publier sur GitHub Pages (gratuit)
GitHub Pages est gratuit pour un dépôt **public** (un dépôt privé demande GitHub Pro).
Le dépôt ne contient que des données fictives, donc il peut être public ; vos données réelles restent sur Drive.
Dépôt : https://github.com/Heavyshield/wealth-board
1. Pousser ce dossier sur la branche `main`.
2. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)`, Save.
3. L'adresse sera https://heavyshield.github.io/wealth-board/ (utilisable sur téléphone).

## Protection des données personnelles
- `.gitignore` exclut `.claude/`, `private/`, `real-data/`, `*.local.json`, les exports bancaires
  (`*.csv`, `*.xlsx`, `*.pdf`…) et les secrets (`.env`, `*secret*`, `*.key`).
- Un hook refuse tout commit d'un `data/*.json` sans `"sample_data": true`. À activer une fois par clone :
  `git config core.hooksPath .githooks`

## Vérifier les données
```
python tests/compute_expected.py
```
Valide les 3 fichiers avec `jsonschema` et recalcule les totaux de référence ; puis ouvrir `/tests/`.

## Cours en direct
Bouton « Actualiser les cours » (et actualisation automatique au chargement, `config.json → providers.auto_refresh`).
Change (BCE) et métaux fonctionnent sans rien configurer. Pour les actions :

| Source | Couvre | Réglage |
|---|---|---|
| Votre proxy Yahoo (Cloudflare, gratuit) | Paris, Nordiques, Suisse, Londres, US, ETF | URL du proxy |
| Prix manuel (`manual_price`) | Tout | Toujours prioritaire |

Le réglage (URL du proxy) reste dans **ce navigateur** (Réglages) : jamais dans les fichiers ni sur GitHub.
À refaire sur chaque appareil (ordinateur, téléphone).

### Créer le proxy Yahoo (5 minutes, gratuit)
Yahoo bloque les appels directs depuis une page web ; ce petit relais tourne sur **votre** compte Cloudflare
(offre gratuite : 100 000 requêtes / jour) et ne répond qu'à votre site.
1. Créer un compte sur https://dash.cloudflare.com/sign-up (gratuit, pas de carte bancaire).
2. Menu **Workers & Pages** → **Create** → **Create Worker** → nom `wealth-quotes` → **Deploy**.
3. **Edit code** → remplacer tout le contenu par celui de [`tools/yahoo-proxy-worker.js`](tools/yahoo-proxy-worker.js) → **Deploy**.
4. Copier l'adresse affichée (ex. `https://wealth-quotes.<votre-sous-domaine>.workers.dev`).
5. Test : ouvrir `<adresse>/quotes?symbols=TTE.PA` dans le navigateur → doit répondre « origine non autorisée »
   (normal : seul votre site est autorisé).
6. Dans Wealth Board : **Réglages** → coller l'adresse → **Enregistrer**.

Origines autorisées par défaut : `https://heavyshield.github.io` et `http://localhost:8770`.
Pour en changer : Worker → Settings → Variables → `ALLOWED_ORIGINS` (liste séparée par des virgules).

### Mettre à jour le proxy (nouvelle version avec recherche par ISIN)
Cloudflare → Workers & Pages → `wealth-quotes` → **Edit code** → remplacer tout par le contenu actuel de
[`tools/yahoo-proxy-worker.js`](tools/yahoo-proxy-worker.js) → **Deploy**. L'adresse ne change pas.

### Compléter les tickers automatiquement
Ligne des cours → « N ligne(s) sans ticker · Compléter » : le proxy cherche la cotation Yahoo à partir de l'ISIN
(Paris en priorité, ordre réglable dans `config.json → providers.preferred_exchanges`). Vérifiez la place proposée,
décochez si besoin, ou choisissez « Autre… » pour saisir un ticker → **Appliquer**.

### Symboles
Le champ `ticker` d'une ligne sert pour toutes les sources (format Yahoo : `TTE.PA`, `VOLV-B.ST`, `EQNR.OL`,
`NOVO-B.CO`, `NESN.SW`, `CW8.PA`, `AAPL`). Ne jamais chercher de cours pour une ligne :
`"price_source": "manual"` (ou renseigner `manual_price`).

## Ajouter ou modifier des lignes
- **+ Ajouter une ligne** (au-dessus du tableau) : actions, ETF, fonds, livrets, comptes en devise, espèces, métaux
  (poids, unité, pureté : valorisés au poids fin × cours spot).
- **✎** à côté d'un nom : modifier tous les champs ou **supprimer** la ligne (elle reste dans le journal).
- **Retirer les données d'exemple** (bandeau jaune) : enlève les lignes et l'historique fictifs, garde vos lignes.
  Pensez ensuite à ajuster budget, cibles et règles dans `config.json`.

## Importer les positions Boursorama
1. Boursorama → votre compte (PEA ou CTO) → onglet **Positions** → **Exporter en CSV** (un compte par fichier).
2. Wealth Board → **Importer CSV** → choisir l'enveloppe → choisir le fichier.
3. Vérifier : colonnes reconnues, ajouts, modifications (ancien → nouveau), lignes absentes du fichier.
   Décocher ce qu'il ne faut pas appliquer → **Appliquer**. Chaque changement va dans le journal.
Le fichier est lu dans le navigateur, rien n'est envoyé. Si une colonne n'est pas reconnue, la fenêtre affiche
les en-têtes trouvés : ajoutez le nom exact dans `config.json → imports.boursorama.columns`.
Les nouvelles lignes n'ont pas de ticker : ajoutez-le (format Yahoo, ex. `TTE.PA`) pour le cours en direct.

## Sauvegarde et synchronisation (bouton « Données »)
Le badge à côté du titre indique où sont vos données : « Navigateur seulement · non sauvegardé »,
« Drive ✓ 10:42 », « Drive · 1 non envoyé(s) », « Drive · reconnecter »…
- **Google Drive** (recommandé, marche aussi sur téléphone) : un dossier « Wealth Board » avec `portfolio.json`,
  `config.json`, `history.json`. Chaque modification est envoyée automatiquement. Si un fichier a changé sur Drive
  entre-temps (Claude, autre appareil), l'application **demande** : garder la mienne / garder celle de Drive /
  voir les différences. Rien n'est écrasé en silence.
- **Dossier local** (Chrome / Edge sur ordinateur) : par exemple un dossier synchronisé par Google Drive pour ordinateur.
- **Fichiers JSON** : exporter / importer chaque fichier, toujours disponible.

### Configurer Google Drive (15 minutes, une seule fois)
L'application utilise le droit minimal `drive.file` : elle ne voit **que les fichiers qu'elle crée**, rien d'autre
de votre Drive. Le « client ID » n'est pas un secret (il est limité aux adresses autorisées) : il va dans `config.json`.
1. Aller sur https://console.cloud.google.com/ (compte Google qui a le Drive) → en haut **Sélectionner un projet** →
   **Nouveau projet** → nom `wealth-board` → **Créer**, puis sélectionner ce projet.
2. Menu ☰ → **API et services** → **Bibliothèque** → chercher **Google Drive API** → **Activer**.
3. Menu → **API et services** → **Écran de consentement OAuth** (ou « Google Auth Platform ») → **Commencer** :
   nom de l'application `Wealth Board`, e-mail d'assistance = le vôtre → type d'audience **Externe** →
   coordonnées = votre e-mail → accepter → **Créer**.
4. **Audience** (ou « Utilisateurs test ») → **Ajouter des utilisateurs** → votre adresse Gmail → **Enregistrer**.
   (L'application reste « En test » : seul vous pouvez vous connecter. C'est voulu.)
5. **Clients** (ou **Identifiants** → **Créer des identifiants** → **ID client OAuth**) → type **Application Web** →
   nom `wealth-board web` → **Origines JavaScript autorisées**, ajouter :
   - `https://heavyshield.github.io`
   - `http://localhost:8770`
   (pas d'« URI de redirection » nécessaire) → **Créer**.
6. Copier l'**ID client** (se termine par `.apps.googleusercontent.com`) dans `data/config.json` :
   `"drive": { "client_id": "…apps.googleusercontent.com", "folder_name": "Wealth Board" }`, puis commit + push.
7. Sur le site : **Données** → **Connecter Google Drive** → choisir votre compte → autoriser.
   Au premier branchement, vos données de ce navigateur sont envoyées dans le dossier « Wealth Board ».
   Sur un autre appareil (téléphone), le même bouton retrouve le dossier et charge vos données.
Une connexion Google dure environ une heure ; ensuite le badge affiche « reconnecter » (un clic).
Google peut afficher « Google n'a pas validé cette application » : c'est votre propre application en mode test,
cliquez **Continuer**.
