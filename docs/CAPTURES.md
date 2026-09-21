# Regénérer les captures d'écran

Note de maintenance — volontairement absente du README.

Les captures montrent la **vraie carte**, avec de **vraies données** : les
lignes du réseau TAO d'Orléans, leurs tracés, leurs arrêts, et des véhicules
photographiés en circulation. Rien n'est dessiné à la main.

## En bref

```bash
python docs/data/snapshot.py     # photographier le réseau (aux heures de service)
python docs/shots.py             # toutes les pages, clair et sombre
```

Les images vont dans `images/`, nommées `<page>-<mode>.png`.

## Les trois lignes

| Ligne | Couleur | Arrêt de référence |
|---|---|---|
| Tram A | `#E2121A` | Gare d'Orléans |
| Tram B | `#762A80` | Halmagrand |
| Bus 40 | `#24A472` | Gare d'Orléans - Quai E |

Le tram B **ne dessert pas** la gare : son terminus est Clos du Hameau et son
tracé passe au sud. Il est donc suivi depuis Halmagrand, son arrêt le plus
proche de la gare, à 373 m. Le bus 40, lui, part bien de la gare.

Couleurs, noms et types viennent du GTFS de TAO : ce sont les couleurs
officielles du réseau, pas des approximations.

## Les données

Deux moitiés, prises séparément parce qu'elles ne changent pas au même rythme.

**Ce qui ne bouge pas** — tracés, arrêts ordonnés, couleurs :

```bash
python docs/data/routes.py       # -> docs/data/stops.json
```

Télécharge le GTFS de TAO (~20 Mo, non conservé) et n'en garde que les trois
lignes. À relancer quand le réseau change, c'est-à-dire rarement.

**Ce qui bouge** — les véhicules et les prochains passages :

```bash
python docs/data/snapshot.py     # -> tram-a.json, tram-b.json, bus-40.json,
                                 #    departures.json, snapshot.json
```

Un flux temps réel ne se rejoue pas : il faut en garder une photo. C'est ce
que fait ce script, et il ne conserve que les trois lignes — un instantané du
réseau entier pèserait des mégaoctets de véhicules qu'aucune capture ne montre.

Le script **refuse de photographier un réseau vide** : les bus TAO commencent
vers 6 h, et un instantané pris la nuit donnerait des captures désertes.
`--force` passe outre.

L'instantané est daté. Rejoué tel quel, il montrerait des passages vieux de
plusieurs heures, que la carte masquerait comme passés : le harnais décale donc
tout le jeu de données pour que le premier départ tombe dans deux minutes. Les
écarts entre passages, eux, restent ceux du réseau.

## Les pages

`screenshot-harness.html` charge la carte livrée (`dist/gtfs2-live-card.js`)
avec un `hass` factice, un capteur par ligne, et intercepte les `fetch` de
positions pour servir l'instantané.

| Page | Ce qu'elle montre |
|---|---|
| `hero` | les trois lignes ensemble, vue Lignes : badges, départs fusionnés et carte |
| `selected` | le tram A choisi par son badge : départs, tracé et véhicules réduits aux siens |
| `journey` | deux trajets sur un tableau : L'Indien → Halmagrand, que la carte trouve par le tram A puis le tram B, la correspondance ouverte sur sa frise, et le bus 40 depuis la gare |
| `destinations` | l'entête départ puis arrivée : trois départs, une arrivée atteinte de deux façons, le retour rangé sous son propre départ, une alerte, une couleur forcée |
| `struck` | ce que le flux raye : une course supprimée, une qui ne s'arrête pas, des alertes sur leurs lignes ; sur un trajet, un arrêt sauté à la place de son heure |
| `boarding` | un trajet pris et quitté en route sur le tram A : des courses qui ne prennent personne à la montée, une qui ne dépose personne à la descente, puis la même montée sans aucune course qui y prenne |
| `board` | les départs en tableau (vue Lignes), durées colorées |
| `popup` | un véhicule suivi, sa bulle ouverte : terminus, prochain arrêt |
| `editor` | l'éditeur visuel, sections ouvertes |
| `pips` | les pastilles du README : chaque marque ronde, seule dans sa tuile |

Ce sont les seules pages que `shots.py` photographie, et chaque image sert au
README. Le harnais en garde d'autres (`lines`, `departures`, `map`,
`noposition`, `entete12`, `narrow`, `combos`, `paris`) comme pages de test, à
ouvrir dans un navigateur avec `?page=<nom>` ; elles ne produisent aucune
image.

La page `pips` ne garde que la pastille visée de chaque cartouche, par une
feuille injectée dans leur shadow root, et ne force **aucun** état par du
CSS : la ligne au repos reçoit `next_service_in_days`, la ligne muette pointe
vers un fichier de positions inexistant, les modes reçoivent leur
`route_route_type` comme gtfs2 le poserait. Ce qui est photographié est donc
bien ce que le code produit, et la légende ne peut pas mentir sur l'apparence
réelle. Cette page déroge au nommage : sa planche est découpée (Pillow) en une
petite image par pastille, `pip-<nom>-<mode>.png`, celles que le tableau du
README embarque — chaque découpe se centre sur l'encre de sa tuile plutôt que
sur une géométrie tenue à la main. Quatre tuiles, plus larges, gardent la puce
entière, marque au bon coin, pour les schémas de position du tableau ; leur
découpe se centre sur le fond gris de la puce, que le seuil des petites
marques ne voit pas.

Une puce de destination n'existe que dans la vue Trajets : chaque carte de la
page porte donc un trajet entre les deux bouts de son capteur, ce qui l'ouvre
sur ses destinations.

Chaque page existe en `mode=light` et `mode=dark`, et accepte `lang=` (les cinq
langues de la carte).

```bash
python docs/shots.py hero selected     # seulement ces pages
python docs/shots.py --lang en         # en anglais
python docs/shots.py --mode dark       # sombre seulement
python docs/shots.py --stock --out /tmp/stock   # comme sur un gtfs2 stock
```

`--stock` (paramètre `stock=1` de la page) joue le main de vingerha : les
capteurs perdent tout attribut que le fork ajoute (la liste est celle que
`sensor.py` d'upstream pose, plus les préfixes d'`append_keys`, vérifiée
contre ce que son `_update_attrs` produit vraiment), un capteur sans départ
perd aussi ses lignes route, agence et course et son temps réel comme chez
lui, le fichier de tracé arrive au format d'upstream (des points seuls, sans
`boards` / `alights`) sous le nom que la carte reconstruit depuis la route et
la direction, et aucun fichier leg ou timetable n'existe. Les heures
d'arrivée sont tirées des durées, comme upstream les liste. Chaque page
affiche alors ce qu'elle a dessiné (lignes, trajets, arrêts) et les erreurs
du harnais : c'est la vérification que la carte tient sans le fork. `--out`
est obligatoire, ces images ne vont jamais dans `images/`.

## Détails qui ont leur importance

**La hauteur des images n'est pas réglée à la main.** Une fenêtre trop courte
couperait la dernière carte sans que rien ne le signale. Le harnais mesure donc
ce qu'il a dessiné et l'annonce dans `document.title` ; `shots.py` lit cette
taille et photographie à cette hauteur. La largeur, elle, reste celle de
`PAGES` : la scène est une grille et s'étirerait à la fenêtre.

**Chrome, pas Edge.** Le mode headless d'Edge sort avec le code 0 sans écrire
de fichier sur cette machine. `shots.py` cherche Chrome et le dit clairement
s'il ne le trouve pas.

**Un serveur HTTP, pas `file://`.** La carte va chercher ses traductions dans
`dist/lang/` par import dynamique, ce qu'une page `file://` n'a pas le droit de
faire. `shots.py` sert donc le dépôt sur un port libre, le temps de la prise.

**Le harnais dit quand il a fini.** La carte charge sa langue, ses positions et
ses tuiles de façon asynchrone ; le préfixe `ready` dans le titre signale que
tout est en place, bulle ouverte comprise pour la page `popup`. Une page qui n'a
toujours pas ce qu'elle doit montrer au bout de trente secondes s'annonce
`late` au lieu de `ready`, et `shots.py` s'arrête sans rien écrire : une
capture à moitié faite ressemble trop à une bonne pour passer inaperçue.

**Les vraies courses.** Chaque capteur du harnais liste les `trip_id` de
l'instantané. C'est ce qui relie un passage au véhicule qui l'assure : une
ligne choisie ne garde sur la carte que les véhicules des courses de son
tableau, et avec des identifiants inventés elle n'en garderait aucun.

**Le pas de temps de la vitesse.** La bulle n'affiche une vitesse qu'après
avoir vu un véhicule à deux positions successives. La page `popup` avance donc
le véhicule le long de son tracé avant d'ouvrir la bulle.

## Provenance

Données du réseau TAO d'Orléans Métropole (Keolis), diffusées en open data :
[GTFS](https://chouette.enroute.mobi/api/v1/datas/keolis_orleans/gtfs.zip) et
[GTFS-RT](https://ara-api.enroute.mobi/tao/gtfs/vehicle-positions), référencés
sur [data.orleans-metropole.fr](https://data.orleans-metropole.fr/).
Fond de carte : styles et tuiles [VersaTiles](https://versatiles.org/), données © contributeurs OpenStreetMap.
