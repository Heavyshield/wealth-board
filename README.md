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
- **Ouvrir** (Données) : « Depuis Google Drive » ou « Fichier local… ».
  - Téléphone : Google Drive apparaît dans le sélecteur → `wealth-board.json`.
  - Ordinateur : le site ne peut pas lire Drive sans connexion Google ; le bouton ouvre la recherche Drive pour
    télécharger le fichier, puis « Fichier local… » (ou prenez-le directement dans le lecteur Google Drive pour ordinateur).
- **Modifier** dans le tableau (✎, + Ajouter une ligne, Importer CSV, Éditeur de données). Le badge indique « Modifié · à enregistrer ».
- **Enregistrer** : « Sur Google Drive » ou « Fichier local (télécharger) ».
  - Téléphone : menu de partage → « Enregistrer dans Drive » → dossier Wealth Board ; supprimez ensuite l'ancienne copie.
  - Ordinateur : le fichier est téléchargé et Drive s'ouvre : clic droit sur l'ancien `wealth-board.json` →
    Gérer les versions → Importer une nouvelle version (un seul fichier, Drive garde l'historique).
- Ce navigateur garde une copie pour s'ouvrir vite. Si Claude ou un autre appareil a modifié le fichier sur Drive,
  rouvrez-le. Ouvrir un fichier plus ancien que celui affiché, ou par-dessus des modifications non enregistrées,
  demande confirmation.
- Premier enregistrement : partez des données d'exemple ou de votre import, puis « Enregistrer sur Drive ».

### Connexion Google Drive sur ordinateur (optionnelle)
Avec la connexion, « Ouvrir » prend directement le `wealth-board.json` le plus récent de votre Drive (et propose de
mettre à la corbeille les anciennes copies créées depuis le téléphone), « Enregistrer » le remplace sur place
(Drive garde l'ancienne version dans son historique). Si le fichier a changé sur Drive depuis l'ouverture, le site
demande avant d'écraser. Le téléphone n'en a pas besoin.

Réglage unique (15 min) :
1. https://console.cloud.google.com/ → **Nouveau projet** `wealth-board` → le sélectionner.
2. **API et services → Bibliothèque** → **Google Drive API** → **Activer**.
3. **Écran de consentement OAuth** (« Google Auth Platform ») → **Commencer** : nom `Wealth Board`, votre e-mail,
   audience **Externe** → **Créer**. Puis **Audience → Utilisateurs test → Ajouter** : votre adresse Gmail.
4. **Clients → Créer un client** → **Application Web** → **Origines JavaScript autorisées** :
   `https://heavyshield.github.io` et `http://localhost:8770` → **Créer**.
5. Copier l'ID client (`….apps.googleusercontent.com`) dans `data/config.json` → `"drive": { "client_id": "…" }`
   → commit + push. Ce n'est pas un secret (il ne marche que depuis ces deux adresses).
6. Site → **Données** → **Se connecter à Google Drive**. Google affiche « application non validée » (c'est la vôtre,
   en mode test) → **Continuer**. Il demande l'accès à Google Drive : le site ne lit et n'écrit que `wealth-board.json`.
   (Accès Drive complet nécessaire : un fichier enregistré depuis le téléphone n'est pas visible avec l'accès minimal.)
   La connexion dure environ une heure, puis il suffit de recliquer.

## Éditeur de données (ajouter des lignes en JSON)
Données → **Éditeur de données** :
- **Ajouter des lignes** : collez `{ "holdings": [ … ] }` (par ex. des lignes préparées par Claude). Une ligne avec un
  `id` existant est mise à jour, sinon ajoutée. On peut ajouter des enveloppes dans le même collage (`"envelopes": [ … ]`).
- **Fichier complet** : tout le `wealth-board.json`, modifiable directement.
- **Vérifier** affiche le résumé et les erreurs ; rien n'est appliqué tant qu'il reste une erreur. Chaque changement va dans le journal.
- Chaque ligne a une date `as_of`. Montant inconnu : `"quantity": null` → affiché « à compléter », jamais compté.

## Vos vraies données
Elles ne sont **jamais** dans le dépôt GitHub : seulement dans `wealth-board.json` sur votre Drive et dans le dossier
`private/` de votre ordinateur (ignoré par git). Premier démarrage : Données → Ouvrir → `private/wealth-board.json`,
puis Importer CSV (PEA Boursorama), Compléter les tickers, et Enregistrer sur Drive.

## Relevés, export pour Claude, journal
- **Enregistrer le relevé du jour** (carte « Évolution du patrimoine ») : ajoute la valeur du jour et sa répartition
  à l'historique (un relevé par jour, remplaçable). Puis enregistrez sur Drive.
- **Copier pour Claude** (en-tête) : copie un résumé (synthèse, répartition, à revoir, dernières modifications +
  toutes les lignes en JSON) à coller dans une conversation avec Claude. Données personnelles : ne le collez pas ailleurs.
- **Journal des modifications** (sous le tableau) : chaque changement, par vous ou par Claude, avec avant → après.

