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
| Twelve Data (plan gratuit) | Actions US uniquement, 8 symboles / minute | Clé API |
| Prix manuel (`manual_price`) | Tout | Toujours prioritaire |

Les réglages (URL, clé) restent dans **ce navigateur** (Réglages) : jamais dans les fichiers ni sur GitHub.
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

### Symboles
Le champ `ticker` d'une ligne sert pour toutes les sources (format Yahoo : `TTE.PA`, `VOLV-B.ST`, `EQNR.OL`,
`NOVO-B.CO`, `NESN.SW`, `CW8.PA`, `AAPL`). Si une source attend un autre symbole :
`"symbols": { "twelvedata": "AAPL" }`. Forcer une source : `"price_source": "quote:twelvedata"` ;
ne jamais chercher de cours : `"price_source": "manual"`.

## Configuration Google Drive
À venir (étape f).
