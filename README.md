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

## Vos données sur Google Drive (bouton « Données »)
Toutes vos données (lignes, réglages, historique) tiennent dans **un seul fichier : `wealth-board.json`**,
rangé dans votre Google Drive (par ex. un dossier « Wealth Board »). Drive est la référence ; aucune connexion
Google n'est demandée par le site.
- **Ouvrir** : Données → « 1. Ouvrir depuis Drive… » → sur téléphone, choisir Google Drive dans le sélecteur
  → `wealth-board.json`.
- **Modifier** dans le tableau (✎, + Ajouter une ligne, Importer CSV…). Le badge passe à « Modifié · à enregistrer sur Drive ».
- **Enregistrer** : Données → « 2. Enregistrer sur Drive ».
  - Téléphone : menu de partage → « Enregistrer dans Drive » → dossier Wealth Board. Drive garde alors deux
    fichiers du même nom : supprimez l'ancien pour n'en garder qu'un.
  - Ordinateur : le fichier est téléchargé ; déposez-le dans le dossier Drive (Google Drive pour ordinateur ou
    drive.google.com → Gérer les versions) en remplaçant l'ancien.
- Ce navigateur garde une copie pour s'ouvrir vite. Si Claude ou un autre appareil a modifié le fichier sur Drive,
  rouvrez-le. Ouvrir un fichier plus ancien que celui affiché, ou par-dessus des modifications non enregistrées,
  demande confirmation.
- Premier enregistrement : partez des données d'exemple ou de votre import, puis « Enregistrer sur Drive ».

