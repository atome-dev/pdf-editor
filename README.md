# Éditeur PDF

Application 100 % côté navigateur (HTML/CSS/JS) : aucun fichier n'est envoyé à un serveur, tout se passe en local dans l'onglet.

## Lancer en local

Un vrai serveur HTTP est nécessaire (pdf.js est chargé en module ES, ce qui ne fonctionne pas en ouvrant `index.html` directement en `file://`).

```bash
cd /data/www/atome-dev/pdf-editor
python3 -m http.server 8000
```

Puis ouvrir <http://localhost:8000>.

Alternatives : extension VS Code "Live Server", ou `npx serve`.

## Déploiement

Hébergement statique uniquement (Cloudflare Pages, Netlify, etc.) — voir le fichier `_headers` à la racine pour les en-têtes de sécurité, appliqués automatiquement par ces plateformes.
