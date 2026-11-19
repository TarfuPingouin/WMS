# Inventaire d'atelier

Une petite application web pour savoir exactement ce que contient votre atelier, en quelle quantité et où c'est rangé. Elle s'installe sur un serveur de la maison et s'utilise depuis n'importe quel navigateur, sur ordinateur comme sur téléphone.

Ce qu'elle permet :

- décrire vos emplacements sur autant de niveaux que nécessaire (pièce, meuble, carton, boîte…), avec photos ;
- ranger vos articles avec photo, tags, quantité exacte ou approximative, seuil d'alerte, lien d'achat et prix ;
- retrouver n'importe quoi en quelques lettres, même avec une faute de frappe ;
- déplacer un article, une partie de son stock ou un carton entier ;
- préparer des projets : une liste de sortie classée par emplacement, qui décompte le stock une fois validée ;
- tenir une liste d'achats, vérifier le contenu d'un carton, imprimer une étiquette de contenu ;
- sauvegarder automatiquement chaque jour, exporter et importer en CSV.

---

## 1. Ce qu'il vous faut

**Une machine Linux qui reste allumée** : un mini-PC, un vieux portable, un Raspberry Pi 4 ou 5, un NAS compatible Docker… L'application est très légère (moins de 100 Mo de mémoire).

**Docker et Docker Compose** installés sur cette machine. Suivez la documentation officielle, choisissez votre système dans la liste : https://docs.docker.com/engine/install/

Pour vérifier que tout est prêt, tapez ces deux commandes sur le serveur. Chacune doit afficher un numéro de version :

```
sudo docker --version
sudo docker compose version
```

> Dans ce document, chaque bloc gris est une commande à taper (ou copier-coller) dans le terminal du serveur, puis à valider avec la touche Entrée. Quand `sudo` demande un mot de passe, c'est celui de votre compte ; rien ne s'affiche pendant la saisie, c'est normal.

---

## 2. Première installation

### Étape 1 : copier l'archive sur le serveur

Depuis un PC Windows, ouvrez PowerShell dans le dossier où se trouve `wms.tar.gz` (en général Téléchargements) et envoyez-le en remplaçant `utilisateur` et `adresse-du-serveur` par les vôtres :

```
cd $HOME\Downloads
scp wms.tar.gz utilisateur@adresse-du-serveur:~/
```

Depuis un Mac ou un Linux, c'est la même commande `scp` dans le Terminal. Une clé USB fait aussi très bien l'affaire.

Connectez-vous ensuite au serveur :

```
ssh utilisateur@adresse-du-serveur
```

### Étape 2 : décompresser

```
mkdir -p ~/apps
tar -xf ~/wms.tar.gz -C ~/apps
cd ~/apps/wms
```

L'application se trouve maintenant dans le dossier `~/apps/wms`. Retenez-le : les mises à jour se feront au même endroit.

### Étape 3 (facultative) : régler le port et les dossiers

Sans rien faire, l'application utilise le port 8080 et range ses données dans `~/apps/wms/donnees` et ses sauvegardes dans `~/apps/wms/sauvegardes`. Cela convient dans la plupart des cas.

Pour changer ces réglages (port déjà utilisé, sauvegardes sur un autre disque…) :

```
cp .env.exemple .env
nano .env
```

Modifiez les valeurs, puis enregistrez avec Ctrl + O, Entrée, et quittez avec Ctrl + X. Chaque réglage est expliqué dans le fichier.

### Étape 4 : démarrer l'application

```
sudo docker compose up -d --build
```

La première fois, cela prend une à trois minutes. Vérifiez ensuite qu'elle tourne :

```
sudo docker compose ps
```

La ligne `wms` doit indiquer `Up` dans la colonne STATUS. L'application redémarrera toute seule avec le serveur.

### Étape 5 : ouvrir l'application

Cherchez l'adresse du serveur sur votre réseau :

```
hostname -I
```

Le premier nombre affiché (par exemple `192.168.1.50`) est l'adresse. Sur votre PC ou votre téléphone, ouvrez le navigateur à l'adresse **http://192.168.1.50:8080** en remplaçant par la vôtre (et `8080` par votre port si vous l'avez changé).

### Étape 6 : personnaliser et commencer

1. Cliquez sur l'icône de réglages en haut à droite et donnez un nom à votre atelier.
2. Ouvrez l'onglet **Emplacements** et créez vos pièces, puis les meubles, puis les cartons.
3. Ajoutez vos articles avec le bouton **Ajouter un article**. Pour remplir un carton d'un coup, utilisez **Enregistrer et continuer** : l'emplacement et les tags sont conservés d'une fiche à l'autre.

Sur ordinateur, la touche `/` place directement le curseur dans la recherche.

---

## 3. Mettre à jour

Vos données ne sont pas dans l'archive : remplacer le code n'y touche pas. Votre éventuel fichier `.env` n'est pas fourni dans l'archive non plus, il est donc conservé.

1. Copiez la nouvelle archive sur le serveur comme à l'étape 1 de l'installation, puis connectez-vous.
2. Décompressez-la **au même endroit** que la première fois :

```
tar -xf ~/wms.tar.gz -C ~/apps
```

3. Reconstruisez et relancez :

```
cd ~/apps/wms
sudo docker compose up -d --build
```

4. Supprimez l'archive, devenue inutile :

```
rm ~/wms.tar.gz
```

5. Dans le navigateur, rechargez la page en forçant (Ctrl + F5 sur PC ; sur téléphone, fermez l'onglet et rouvrez-le).

Si la base a besoin d'évoluer (nouvelles colonnes, nouvelles tables), c'est fait automatiquement au démarrage. Le numéro de version installé est affiché en bas de la page des paramètres ; les nouveautés de chaque version sont décrites dans `NOTES-DE-VERSION.md`.

---

## 4. Sauvegardes

**Automatiques.** Chaque jour, une copie complète (base et photos) est enregistrée dans le dossier de sauvegarde ; les 10 dernières sont conservées. La page des paramètres indique la date de la dernière copie. Si possible, placez ce dossier sur un autre disque que les données (réglage `WMS_BACKUP_DIR` du fichier `.env`).

**Manuelles.** Le bouton « Télécharger une sauvegarde complète » de la page des paramètres enregistre une copie sur votre ordinateur. Faites-le de temps en temps : c'est ce qui vous protège si le serveur lui-même tombe en panne.

**Restaurer une sauvegarde.** Les commandes ci-dessous supposent les dossiers par défaut ; adaptez-les si vous les avez changés dans `.env`. Remplacez `AAAA-MM-JJ` par la date de la sauvegarde voulue.

```
cd ~/apps/wms
sudo docker compose down
sudo mv donnees donnees-avant-restauration
sudo mkdir donnees
sudo apt install -y unzip
sudo unzip sauvegardes/inventaire-AAAA-MM-JJ.zip -d donnees
sudo docker compose up -d
```

Pour une sauvegarde téléchargée sur votre PC, copiez d'abord le fichier `.zip` sur le serveur avec `scp`, puis utilisez son chemin dans la commande `unzip`.

---

## 5. Accès depuis l'extérieur (facultatif)

**N'ouvrez jamais l'application sur Internet** par une redirection de port sur votre box : elle n'a pas de mot de passe (voir la section Sécurité).

Pour la consulter hors de chez vous, par exemple en magasin pour vérifier si vous avez déjà un composant, la solution la plus simple est Tailscale (https://tailscale.com), gratuit pour un usage personnel. Il relie vos appareils entre eux par un réseau privé chiffré. Une fois Tailscale installé sur le serveur et sur votre téléphone, la commande suivante donne même une adresse en HTTPS sans numéro de port, réservée à vos appareils (elle nécessite d'activer MagicDNS et les certificats HTTPS dans la console Tailscale) :

```
sudo tailscale serve --bg 8080
```

---

## 6. Sécurité

L'application n'a pas de comptes ni de mot de passe : toute personne qui peut ouvrir la page peut consulter et modifier l'inventaire. C'est un choix de simplicité pour un usage familial ou entre amis de confiance. Gardez-la sur votre réseau local ou derrière Tailscale.

---

## 7. Commandes utiles

À taper depuis le dossier de l'application (`cd ~/apps/wms`) :

```
sudo docker compose ps                # état
sudo docker compose logs --tail 50    # derniers messages, utiles en cas de problème
sudo docker compose restart           # redémarrer
sudo docker compose down              # arrêter (les données sont conservées)
sudo docker compose up -d             # démarrer
```

---

## 8. En cas de problème

**La page ne s'ouvre pas.** Vérifiez avec `sudo docker compose ps` que l'application tourne, puis lisez les messages avec `sudo docker compose logs --tail 50`. Vérifiez aussi l'adresse et le port.

**« port is already allocated » au démarrage.** Le port 8080 est déjà pris par autre chose : créez le fichier `.env` (étape 3) et choisissez un autre port, par exemple `WMS_PORT=8090`.

**« permission denied » sur une commande docker.** Ajoutez `sudo` devant la commande.

**L'ancienne version s'affiche après une mise à jour.** Forcez le rechargement de la page (Ctrl + F5).

---

## 9. Licence

Ce logiciel est libre : vous pouvez le redistribuer et le modifier selon les termes de la **GNU General Public License version 3**, ou (à votre choix) de toute version ultérieure, telle que publiée par la Free Software Foundation. Le texte complet figure dans le fichier `LICENSE`.

En résumé : vous pouvez l'utiliser, l'étudier, le modifier et le partager librement. Si vous distribuez une version modifiée, elle doit rester sous la même licence et son code source doit être fourni.

Il est fourni sans aucune garantie, dans l'espoir qu'il sera utile.

Les polices IBM Plex fournies dans `app/static/fonts` sont distribuées sous leur propre licence, la SIL Open Font License 1.1 (fichier `OFL.txt` du même dossier).
