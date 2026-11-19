# Notes de version

## 1.0.1 — 19 novembre 2026

- Les polices sont fournies avec l'application : elle ne contacte plus aucun service externe et s'affiche à l'identique sans connexion Internet. Licence des polices dans `app/static/fonts/OFL.txt`.
- Documentation : exemples d'adresse et de dossiers rendus génériques.
- Le logiciel est publié sous licence GNU GPL version 3 ou ultérieure (fichier `LICENSE`).

## 1.0.0 — 8 novembre 2026

Première version prévue pour être partagée.

- Le nom de l'atelier se règle dans la page des paramètres. Il apparaît en haut des pages, sur les étiquettes imprimées et dans le nom des fichiers exportés.
- Le port et les dossiers de données et de sauvegarde se règlent dans un fichier `.env` (modèle fourni : `.env.exemple`). Sans ce fichier, des valeurs par défaut portables s'appliquent : port 8080, dossiers `donnees` et `sauvegardes` à côté de l'application.
- Le numéro de version est affiché en bas de la page des paramètres.
- Mode d'emploi complet (`LISEZMOI.md`) : installation, mise à jour, sauvegarde et restauration, accès à distance, dépannage.

**Installations antérieures à 1.0.0.** Les dossiers de données et de sauvegarde ne sont plus écrits dans `docker-compose.yml`, ils se règlent dans le fichier `.env`. Avant de mettre à jour, créez ce fichier en y reportant les dossiers que vous utilisiez (variables `WMS_DATA_DIR` et `WMS_BACKUP_DIR`) ; sinon l'application démarrera sur un inventaire vide, sans que vos données soient perdues pour autant. Pensez aussi à redonner un nom à votre atelier dans les paramètres.

## 0.4.0 — 8 novembre 2026

- Nouvel onglet **Projets** : composez la liste des composants à sortir pour une réalisation, puis obtenez une liste de sortie classée par emplacement, avec une étape par carton.
- Quand un composant est rangé à plusieurs endroits, la sortie puise de préférence dans les cartons déjà visités pour les autres composants.
- Quantités modifiables jusqu'à la validation, qui décompte tout le stock en une fois et l'inscrit dans l'historique des articles.
- Bouton « Refaire ce projet » pour préparer une nouvelle sortie à partir d'un projet déjà sorti.
- Libellés d'onglets raccourcis sur téléphone.

## 0.3.0 — 7 novembre 2026

- Seuil de stock bas par article, signalé par un point d'exclamation rouge, avec une page **Stock bas** ; l'ajout à la liste d'achat reste manuel.
- Lien d'achat et prix unitaire ; bouton « Commander » dans la liste d'achat.
- Saisie en rafale avec « Enregistrer et continuer ».
- Historique de chaque article.
- Mode vérification d'un carton (présent, absent, correction des quantités).
- Étiquette de contenu imprimable.
- Sauvegarde quotidienne automatique, téléchargement d'une sauvegarde complète.
- Export et import CSV.

## 0.2.0 — 7 novembre 2026

- Déplacement d'un article, d'une partie de son stock ou d'un carton entier avec son contenu.
- Bouton « Acheté » dans la liste d'achat, avec la quantité reçue.
- Filtre par tag avec suggestions, et page **Tags** pour rechercher, renommer, fusionner ou supprimer des tags.

## 0.1.0 — 7 novembre 2026

- Première version : emplacements imbriqués avec photos, articles avec photo, tags et quantité exacte ou approximative, recherche instantanée tolérante aux fautes, détection des doublons à la saisie, liste d'achat, thèmes nuit bleue et crème.
