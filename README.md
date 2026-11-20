# Sollenzia — documentation complète du système

> À donner en premier à toute nouvelle conversation avec Claude (ou à un développeur) pour reprendre le projet.
> Dernière mise à jour : 20 novembre 2026 (phase 4 livrée).

---

## 0. Résumé en 30 secondes

**Sollenzia** (sollenzia.com) est une agence de vidéos courtes (clipping). Le système complet comprend :

| Morceau | Où | Rôle |
|---|---|---|
| **Site** | hébergeur web classique, dossier `www/` | pages publiques, dashboard client, workflow client, admin |
| **Bot Discord + API** | **Railway**, repo GitHub `sollenziamedia` | bot `/posted`, stockage des données, API pour le site, notifications |
| **Données** | **volume Railway** (fichiers JSON) | posts, clients, réglages, workflow, finances… |
| **Discord** | 1 serveur par client + ton serveur de notifications | les clippers postent avec `/posted` ; alertes et messages workflow |
| **Google Drive** | ton Drive | les montages à valider (lien Drive collé dans le workflow) |

Le propriétaire (toi) ne code pas : tout le code a été écrit par Claude. Les pages client sont **en anglais**, l’admin est **en français**.

---

## 1. Architecture

```
 Clippers (Discord)                Client (téléphone / PC)              Toi (admin)
   /posted /posted2                 dashboard?c=CLÉ  workflow?c=CLÉ       admin2
        │                                   │                │               │
        ▼                                   ▼                ▼               ▼
 ┌───────────────────────── Railway : bot discord.js + API Express ─────────────────────────┐
 │ src/index.js (bot)   src/api.js (API)   src/admin2.js  src/workflow.js  src/public.js    │
 │                                                                                          │
 │  Volume Railway (RAILWAY_VOLUME_MOUNT_PATH) : tous les fichiers JSON                      │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
        │ webhooks Discord (alertes, workflow)          │ Web Push (notifs téléphone)
        ▼                                               ▼
 Ton serveur Discord de notifications            Téléphone du client
```

- URL Railway de l’API : `https://sollenziamedia-production.up.railway.app`
- Le site appelle l’API en HTTPS. CORS ouvert, headers autorisés : `x-api-key`, `x-editor-token`, `Content-Type`.

---

## 2. Rôles et accès (qui voit quoi)

| Qui | Comment il accède | Ce qu’il peut faire |
|---|---|---|
| **Toi (owner)** | clé `API_SECRET` (header `x-api-key`), saisie une fois dans admin2 (stockée dans le navigateur : `sm2_auth`, recopiée dans `sm_cfg`) | tout |
| **Client** | sa **clé client** dans l’URL : `sollenzia.com/dashboard?c=CLÉ` et `/workflow?c=CLÉ` | voir SES stats, SES comptes ; workflow : ajouter des idées, valider/refuser, supprimer des idées |
| **Monteur (editor)** | lien perso `sollenzia.com/workflow?e=TOKEN` (créé dans admin2 → Équipe → Monteurs) | ajouter des vidéos, passer idée → review, envoyer une nouvelle version. **Jamais** supprimer ni valider |
| **Clipper** | Discord seulement | `/posted`, `/posted2`, `/analytics`, `/mystats`… Ne voit **jamais** ses gains |

Règles importantes :
- Les **rôles sont décidés côté serveur** (Railway), jamais par la page.
- Les pages publiques n’ont **plus aucune clé API** depuis la phase 2 : elles appellent `GET /api/public/:cléClient`, qui ne renvoie que les données de ce client (pas les tarifs, webhooks, finances, autres clients).
- Un client sans `clientSecret` est trouvé par son nom en slug (`silva-twins`). Dès qu’on modifie ce client dans admin2, cette clé est **figée** pour que son lien ne casse jamais.
- Sur le dashboard client, on montre des **comptes** (salons Discord = pages du client), **jamais les noms des clippers**.

---

## 3. Le repo Railway (`sollenziamedia`)

### 3.1 Fichiers `src/`

| Fichier | Rôle |
|---|---|
| `index.js` | démarrage du bot Discord, routage des commandes, branche `admin2.attachDiscord(client)` |
| `deploy-commands.js` | liste des commandes slash (enregistrées automatiquement si la liste change, via `commands-hash.json`) |
| `commands.js` | handlers des commandes (`/posted`, `/stats`, `/recap`…) |
| `database.js` | lecture/écriture des posts. Fichiers par mois. Chaque post a `posted_at`, `date_key` et **`logged_at`** (heure réelle du /posted, ajouté en novembre 2026) |
| `server-config.js` | config par serveur Discord : salon de logs, salons autorisés, modes, salons en pause, admins du bot |
| `cron.js`, `daily-check.js` | vérification quotidienne des posts manqués (quotas) |
| `clippers.js`, `clipper-commands.js` | « clippers » au sens bot = **comptes** avec leurs handles YouTube/TikTok/Instagram et lien de tracking (`/addclipper`) |
| `clickmagick.js` | clics valides (ClickMagick) |
| `views-tracker.js`, `youtube.js`, `yt-cron.js` | vues automatiques des vidéos (Apify / YouTube) |
| `embeds.js` | messages Discord du bot |
| `api.js` | serveur Express : routes historiques `/api/config`, `/api/posts/all`, `/api/clippers`… + montage des modules ci-dessous |
| `workflow-core.js` | **règles du workflow** (partagées serveur + page, format UMD) |
| `workflow.js` | routes du workflow, notifications Discord du workflow, Web Push, monteurs |
| `admin2.js` | API du nouvel admin, sauvegardes automatiques, opérations Discord (créer/supprimer salons, pause, notifs) |
| `alerts.js` | alertes automatiques vers Discord (toutes les 30 min) |
| `public.js` | `GET /api/public/:clé` — données publiques d’un seul client, limitées à 120 req/min/IP |
| `leaderboard-send.js` | commande `/leaderboardsend` |
| `backup.js` | `GET /api/backup` — téléchargement de tout le volume en un JSON |

### 3.2 Variables d’environnement Railway

| Variable | Rôle |
|---|---|
| `DISCORD_TOKEN`, `CLIENT_ID` | bot Discord |
| `GUILD_ID` | serveur Discord « principal » (ses posts vont dans `posts-AAAA-MM.json` sans id de serveur) |
| `API_SECRET` | **clé owner**. À changer si elle fuit (puis se reconnecter dans admin2) |
| `RAILWAY_VOLUME_MOUNT_PATH` | dossier du volume (données) |
| `ADMIN_USER_ID`, `LOG_CHANNEL_ID`, `ALLOWED_CHANNEL_IDS`, `DAILY_CHECK_HOUR` | réglages historiques du bot |
| `APIFY_TOKEN`, `APIFY_ACTOR_YOUTUBE/TIKTOK/INSTAGRAM`, `VIEWS_CRON`, `VIEWS_MAX_PER_RUN`, `VIEWS_MAX_AGE_DAYS` | suivi des vues Apify (activé client par client dans admin2). `APIFY_TOKEN` = clé **par défaut** ; un client peut avoir sa propre clé (`v2.apify.clients[id].token`) |
| `CLICKMAGICK_API_KEY` | clics |
| `WORKFLOW_DISCORD_WEBHOOK` | webhook workflow par défaut (si le client n’en a pas) |
| `WEB_PUSH_PUBLIC_KEY`, `WEB_PUSH_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | facultatif : sinon les clés VAPID sont générées dans `workflows/_vapid.json` |
| `SITE_URL` | facultatif, défaut `https://sollenzia.com` (liens dans les alertes) |
| `PORT` / `API_PORT` | port de l’API |

### 3.3 Dépendances (`package.json`)
`cors`, `discord.js`, `dotenv`, `express`, `node-cron`, `web-push`.

---

## 4. Les données (volume Railway)

Tout est en fichiers JSON dans le volume. **Rien n’est dans une base de données.**

| Fichier | Contenu |
|---|---|
| `admin-config.json` | **le cœur** : `clients`, `clientSettings`, `views` (vues par semaine), `topVideos`, `testimonials`, `accounts`, `channel_links`, `salary_rates`… + **`v2`** (tout ce que le nouvel admin ajoute) |
| `posts-AAAA-MM.json` | posts du serveur principal (`GUILD_ID`) |
| `posts-<idServeur>-AAAA-MM.json` | posts des autres serveurs |
| `posts.json` | anciens posts |
| `config-<idServeur>.json` | config du bot pour ce serveur (salons autorisés, pause, modes, admins…) |
| `clippers-<idServeur>.json` | comptes `/addclipper` |
| `analytics-<idServeur>-<semaine>.json` | `/analytics` des clippers |
| `workflows/<idClient>.json` | tableau workflow du client (cartes, `rev`) |
| `workflows/<idClient>.push.json` | téléphones abonnés aux notifs (`subs`) |
| `workflows/_editors.json` | monteurs (nom, token, clients) |
| `workflows/_vapid.json` | clés Web Push |
| `alerts-sent.json` | alertes déjà envoyées (anti-doublon) |
| `clickmagick-cache.json`, `commands-hash.json` | caches |
| `backups/config/…` | copie de `admin-config.json` **avant chaque modification** (400 dernières) |
| `backups/daily/AAAA-MM-JJ/` | **copie complète quotidienne** (jamais écrasée ; 90 jours + le 1er de chaque mois gardé pour toujours) |

### 4.1 Format d’un client (`admin-config.json → clients[]`)
```json
{ "id": "1779972456052", "name": "Silva Twins", "clientSecret": "silva-twins",
  "guildId": "155883…", "channels": [ { "id": "1491744507144835112", "name": "dmolegacy", "salary": 7.1 } ] }
```
- `id` = timestamp de création (sert aussi au nom du fichier workflow).
- `channels` = **comptes** du client = salons Discord où les clippers font `/posted`. `salary` = tarif par vidéo (ancien champ, toujours utilisé).

### 4.2 `clientSettings[idClient]`
`showPosts`, `showMonthlyViews`, `showFollowers`, `totalFollowers`, `showLikes`, `totalLikes`, `totalPostsOverride`, `totalViewsOverride` (**vues totales manuelles**, ex. 100M), `customWorkflow` (workflow à la place des stats), `workflowMode`, `workflowPlatforms`, `workflowWebhook`, `apifyViews` (désactivé par défaut).

### 4.3 `views` (vues par semaine = leaderboard du dashboard)
```json
{ "week": "2026-11-21", "entries": [ { "channelId": "<idSalon ou idClient>", "channelName": "…", "views": 3992000 } ] }
```
- Une semaine = un samedi.
- Soit **un total client** (`channelId` = id du client, ce que fait `/leaderboardsend`), soit **le détail par compte**. Jamais les deux pour la même semaine (sinon double comptage) : admin2 et `/leaderboardsend` effacent l’autre.

### 4.4 `v2` (nouvel admin)
```
v2.rev, v2.updatedAt                       compteur de modifications
v2.channels[idSalon]                       { alertHours, alerts:false, createdByBot, createdAt }
v2.people[idDiscord]                       { name }  vrai nom d'un clipper
v2.finance.currency                        "USD" par défaut
v2.finance.clients[idClient]               { startDate, cycleDays (7/14/30/31/"month"), nextPayment, lastPaidAt, revenue (ancien) }
v2.finance.revenueHistory[idClient][AAAA-MM]   prix du client pour ce mois (vaut pour les mois suivants jusqu'au prochain changement)
v2.finance.rateHistory[idSalon][AAAA-MM]       { perVideo, fixed, platforms } tarif clipper à partir de ce mois
v2.finance.rates[idSalon]                  { platforms, fixed } (ancien format, repli)
v2.finance.costs[]                         { id, label, amount, clientId|'' , recurring, from | month }
v2.finance.payouts[AAAA-MM][idDiscord]     { amount, paidAt }  paie marquée payée
v2.finance.clientPayments[idClient][]      historique "Paiement reçu"
v2.notify                                  { enabled, guildId, categoryId, inactiveHours(30), reviewLateHours(24), paymentDays(5), dormantDays(14),
                                             clients[idClient]: { webhook, channelId, types:{inactive,reviewLate,payment} } }
v2.prefs                                   { ignore[clé]: {v, at, label}, docUrl, defaultCategory[idClient], lastCategory[idClient] }
v2.trash.clients[]                         clients supprimés (récupérables)
v2.apify.clients[idClient]                 { token, setAt }  clé Apify propre au client (sinon APIFY_TOKEN)
```

### 4.5 Un post
```json
{ "id": 812, "user_id": "…", "username": "irfandoesit", "channel_id": "…", "channel_name": "dmolegacy",
  "platform": "youtube", "video_url": "…", "posted_at": "2026-11-18T08:33:41.037Z", "date_key": "2026-11-18",
  "logged_at": "2026-11-19T08:33:41.037Z" }
```
⚠️ Avec l’option `day:` de `/posted`, `posted_at` est **décalé au jour choisi** (même heure). L’activité réelle = `logged_at` (nouveaux posts) ou, pour les anciens, `known_users[user].updated_at` si l’heure exacte correspond. C’était la cause des faux « clipper inactif ».

---

## 5. Le site (`www/`)

| Page | Pour qui | Notes |
|---|---|---|
| `index.html`, `about.html`, `faq.html`, `results.html`, `system.html` | public | site vitrine |
| `dashboard.html` | client (`?c=CLÉ`) / toi (sans `?c`, vue agence avec ta clé du navigateur) | stats ; si `customWorkflow` → redirige vers `/workflow?c=CLÉ` (sauf `&analytics=1`). Ordre : chiffres (« Your page » = totaux manuels, « Our clipping » = posts) → Top videos (repliable) → graphiques → **Accounts** (jamais les clippers dès qu’un client est affiché) → Platforms → Latest videos (repliable) → More : Views by week (repliable) → témoignages. Dates lisibles (« 21 Nov »), noms de comptes sans `#`. Lien invalide → message clair |
| `workflow.html` | client / monteur / toi | tableau Ideas → To review → Changes asked → Ready to post (+ Posted) |
| `classement.html` | client (`?c=CLÉ`) | classement des comptes (clics) |
| `snapshot.html` | client (`?c=CLÉ`) | résumé partageable |
| `admin2.html` | **toi** — le nouvel admin | voir §7 |
| `admin.html` | toi — ancien admin (protégé par `.htpasswd`) | à garder en lecture seulement, puis à retirer |
| `manager.html` | toi — outil interne | lit la clé dans le navigateur |
| `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png`, `badge-96.png` | notifications push / « installer l’app » | à la racine de `www` |
| `.htaccess` | supprime `.html` des URLs, protège `admin.html` | `admin2` n’est **pas** derrière `.htpasswd` (la page ne contient aucune donnée sans la clé) |

### 5.1 Comment `workflow.html` est fabriqué
`workflow.html` est **généré** à partir de 4 morceaux (dossier `workflow-build/` livré avec ce README) :
- `workflow.src.html` (structure + CSS propre au workflow, avec des emplacements `/*__DASH_CSS__*/`, `<!--__UI_SCRIPT__-->`, `/*__CORE__*/`, `/*__MAIN__*/`)
- `main.js` (toute la logique de la page)
- `src/workflow-core.js` du repo Railway (les règles, identiques au serveur)
- le CSS + petit script UI copiés **depuis `dashboard.html`** (même style)

Pour reconstruire : `python3 build.py ../www/dashboard.html ../src/workflow-core.js ../www/workflow.html`.
Le script refuse de produire la page si une clé API ou un webhook s’y trouve.
(On peut aussi modifier directement `workflow.html` pour un petit changement, mais il faut alors reporter la modif dans les sources.)

---

## 6. Le workflow client

### 6.1 Colonnes et règles
- **Ideas** (`inspo`) → **To review** (`review`) → **Ready to post** (`ready`) → **Posted** (`posted`, liste repliable).
- **Changes asked** = colonne d’affichage : cartes en `review` avec `status: "changes"`. Pas une colonne côté serveur. Dès qu’une nouvelle version est envoyée, `status` repasse à `awaiting` → la carte revient dans To review.
- Client : réordonner, valider (review → ready), **Request changes** (message obligatoire → Changes asked), **Back to review** (ready → review, message facultatif), marquer posté / annuler, supprimer une idée.
- Monteur : idées ↔ review uniquement, envoyer des versions ; jamais supprimer ni valider.
- Owner : tout.
- Le **premier lien Drive = V1**, les suivants V2, V3…

### 6.2 Notifications
| Événement | Notification |
|---|---|
| Carte passe en review **avec** une vidéo, ou nouvelle version envoyée | **Web Push** sur le téléphone du client (1 par vidéo, `topic` = id de la carte) |
| Le client ajoute une idée, demande des modifs / refuse, supprime une idée | **Discord** (webhook du client, sinon `WORKFLOW_DISCORD_WEBHOOK`). Uniquement les actions du **client** |
| Le client valide | rien |

Web Push : le client doit autoriser les notifications (bouton cloche). Sur **iPhone**, il faut d’abord « Ajouter à l’écran d’accueil ». Messages d’aide intégrés pour Brave (`brave://settings/privacy` → services Google pour les push), Edge (demandes silencieuses), VPN/bloqueurs.

### 6.3 Google Drive
- PC : lecteur Drive intégré (`/file/d/ID/preview`).
- Téléphone (≤ 860 px) : bouton « Open video » qui ouvre Drive (`/file/d/ID/view`). Aucune vidéo ne passe par Railway (pas de bande passante facturée).
- Téléchargement : `drive.usercontent.google.com/download?id=ID&export=download&confirm=t`. Miniature : `drive.google.com/thumbnail?id=ID&sz=w600`.

### 6.4 Bulle « What’s new »
Dans `main.js`, objet `NEWS` : changer `NEWS.id` et les textes → chaque client la revoit **une fois par appareil**. Actuel : `2026-11-changes` (colonne Changes asked, Request changes, Back to review).

---

## 7. L’admin (`admin2.html`)

Connexion : clé `API_SECRET`. Enregistrement **automatique** à chaque modification (plus de « push local data »). Rechargement des données toutes les 60 s, des posts toutes les 2 min et au retour sur l’onglet.

### 7.1 Pages
- **Accueil** : chiffres du jour/mois, **À traiter** par client (comptes inactifs, reviews en retard, paiements à redemander), salons qui postent sans client. Chaque alerte : **Ignorer** (revient seulement si la situation change) ; paiement : **Paiement reçu**. Alertes ignorées consultables et réactivables.
- **Clients** → page par client, onglets :
  - **Aperçu** : chiffres, à traiter, marge du mois, liens dashboard/workflow.
  - **Comptes** : salons du client groupés **Inactifs récents / Actifs / Complètement inactifs**, clippers détectés par `/posted` (actifs = posté < 7 j), seuil d’alerte par compte, **Créer un compte** (le bot crée le salon), **Lier un salon existant**, **Liens** (Instagram / TikTok / YouTube / lien de tracking du compte — enregistrés dans la même fiche que `/addclipper`, donc visibles sur le dashboard client, le classement et ClickMagick), Renommer, **Pause/Reprendre**, Retirer (de l’admin, ou supprimer aussi sur Discord).
  - **Stats** : **Totaux affichés sur le dashboard** (vues totales manuelles, posts, abonnés, likes), posts par jour, plateformes, **vues de la semaine** (total ou détail par compte), top vidéos, témoignages.
  - **Workflow** : activer, plateformes, nom du mode, webhook + Tester, cartes en review / en retard, monteurs.
  - **Finances** : début, cycle (7/14/30/31 j ou même date chaque mois), prochain paiement + Paiement reçu, **prix par mois**, tarifs clippers par compte **par mois** (par vidéo + plateformes comptées + fixe), autres coûts, marge.
  - **Réglages** : nom, clé client (changer = les anciens liens cassent), serveur Discord, catégorie par défaut, affichage du dashboard, **Apify** (activer + **clé Apify du client**, vide = clé Railway ; bouton « Lancer maintenant »), supprimer (corbeille).
- L’admin est utilisable sur **téléphone** (barre d’onglets en bas, comptes en cartes, tableaux en cartes).
- **Équipe** : Clippers (client → comptes → clippers, statut, « aussi chez … », vrai nom) ; Monteurs (créer, clients, lien, nouveau lien, supprimer).
- **Finances** : par client, paie des clippers du mois (**Tout marquer payé**), coûts généraux, devise.
- **Réglages** : seuils d’alertes, notifications Discord (serveur, catégorie, salon par client, Tester), lien du guide épinglé, sauvegardes (télécharger, faire maintenant, historique + **Revenir à cette version**), corbeille, déconnexion.

### 7.2 Statuts des comptes
- **Actif** (vert) : dernier post avant le seuil (30 h par défaut, réglable par compte).
- **Inactif récent** (orange) : seuil dépassé → alerte.
- **Complètement inactif** (rouge) : rien depuis 14 jours (`dormantDays`) → plus d’alerte.
- En pause (`/pause` ou bouton) / jamais posté : gris.

### 7.3 Finances : comment c’est calculé
- Coût d’un compte pour un mois = (nombre de vidéos des plateformes cochées × tarif par vidéo) + fixe (attribué au clipper qui a le plus posté).
- La paie d’un clipper = somme sur tous ses comptes, tous clients confondus (un clipper peut être chez 2 clients : ses posts comptent pour le client du salon où il poste).
- Marge = prix du mois − clippers − autres coûts. Tout cela est **visible uniquement dans l’admin**.

---

## 8. Discord

### 8.1 Organisation
- **1 serveur par client** (dupliqué avec **Xenon** depuis un modèle), puis on ajoute le bot Sollenzia.
- Dans le serveur client : **1 salon = 1 compte** (page du client). Les clippers font `/posted` dans le salon de leur compte. Plusieurs clippers peuvent poster dans le même salon, et un clipper peut changer de salon : la détection suit les posts.
- **Ton serveur de notifications** : 1 salon par client, avec un webhook (sert au workflow ET aux alertes).

### 8.2 Créer un compte depuis admin2
Le bot : crée le salon dans la catégorie choisie (il hérite des permissions de la catégorie) → poste le lien du guide (Google Doc, `v2.prefs.docUrl`, défaut `https://docs.google.com/document/d/10Yg1iip60s9SyD9ytS3aa_w88Dtdj7qZVuKI4xKuFHQ/edit?tab=t.0`) et **l’épingle** → poste le message d’explication `/posted` `/posted2` → relie le salon au client. Si le serveur a une liste de salons autorisés, le salon y est ajouté ; si la majorité des salons sont en mode `tracking-only`, le nouveau aussi.

Droits nécessaires au rôle du bot : **Gérer les salons**, **Gérer les messages** (épingler) sur les serveurs clients ; + **Gérer les webhooks** sur ton serveur de notifications.

### 8.3 Commandes du bot
`/posted [link, platform, day]` · `/posted2 [platform, link1, link2, day]` · `/analytics [views]` · `/leaderboard-week` · `/daystatus` · `/recap` · `/stats` · `/mystats` · `/userstats` · `/leaderboard` · `/removepost` · `/setup` · `/setchannelmode` · `/addchannel` · `/removechannel` · `/addadmin` · `/removeadmin` · `/adminlist` · `/alertadd` · `/alertremove` · `/alertlist` · `/announcement` · `/pause` · `/unpause` · `/pauselist` · `/addclipper` · `/clipperstats` · `/removeclipper` · **`/leaderboardsend [client, views, week]`** (admin : total des vues de la semaine du client sur le site ; semaine par défaut = samedi en cours).

Limites Discord à connaître : un bot présent sur 10+ serveurs ne peut plus créer de serveurs ; vérification obligatoire à 100 serveurs (demande possible dès 75) ; les intents privilégiés demandent une validation.

### 8.4 Alertes automatiques (`alerts.js`)
Toutes les 30 min : compte inactif récent, vidéo en retard en review (client a demandé des modifs ou pas de vidéo, après 24 h), paiement à redemander (5 j avant) puis en retard. Chaque alerte part **une fois** (`alerts-sent.json`). Les alertes **ignorées** dans admin2 ne partent pas. Au tout premier lancement, les alertes en cours sont notées sans être envoyées.

---

## 9. API (référence rapide)

Owner = header `x-api-key: API_SECRET`.

| Route | Accès | Rôle |
|---|---|---|
| `GET /api/public/:clé` | public | données d’un client (posts, vues, top vidéos, témoignages, comptes) |
| `GET/POST /api/config` | owner | ancienne config complète (ancien admin) — copie de sécurité avant chaque écriture |
| `GET /api/posts/all` | owner | tous les posts |
| `GET /api/clippers`, `POST /api/clippers/upsert` | owner | comptes `/addclipper` |
| `GET /api/backup` | owner | tout le volume en JSON (`?history=1` pour inclure `backups/`) |
| `GET /api/v2/state` | owner | tout pour admin2 (config, serveurs/salons/catégories/droits du bot, dernier post réel par salon, workflows, monteurs, sauvegardes) |
| `POST /api/v2/save` | owner | `{ops:[…]}` : `client.upsert/delete/restore`, `channel.add/update/remove`, `settings.patch`, `v2.set` (sous `channels, people, finance, notify, prefs`), `views.set`, `topVideos.upsert/delete`, `testimonials.upsert/delete` |
| `GET /api/v2/history`, `GET /api/v2/history/:nom`, `POST /api/v2/history/restore` | owner | copies de la config |
| `POST /api/v2/backup-now` | owner | sauvegarde du jour |
| `POST /api/v2/discord/create-account` · `delete-channel` · `pause` · `notify-setup` | owner | opérations Discord |
| `GET /api/v2/alerts`, `POST /api/v2/alerts/test` | owner | alertes |
| `GET /api/workflow/:clé` (ou `id:<idClient>` pour monteurs) | client / monteur / owner | tableau + rôle |
| `POST /api/workflow/:clé/action` | idem | `add`, `comment` (+`cut` = nouvelle version), `move` (+`video`), `delete` |
| `POST /api/workflow/:clé/test-discord` | owner | test du webhook |
| `POST /api/workflow/:clé/push/subscribe` · `unsubscribe` · `test` | client | Web Push |
| `GET /api/workflow-editor/me` | monteur | ses clients |
| `GET/POST /api/workflow-admin/editors`, `POST /api/workflow-admin/editors/:id` | owner | monteurs (`name, clients, active, regenerate, delete`) |

---

## 10. Mettre à jour (procédure)

1. **Railway** : remplacer/ajouter les fichiers dans `src/` sur GitHub (branche suivie par Railway) → attendre **Active** dans Deployments → regarder les logs.
2. **Site** : envoyer les fichiers dans `www/` (FTP / gestionnaire de fichiers). Toujours mettre Railway en ligne **avant** le site quand une page dépend d’une nouvelle route.
3. Vérifier qu’une route existe : ouvrir l’URL dans le navigateur. `{"error":"Unauthorized"}` = la route existe ; `Cannot GET …` = ancienne version encore en ligne.
4. Ne jamais mettre `.env`, clés ou `node_modules` sur GitHub.

### Sauvegarder avant un gros changement
- admin2 → Réglages → **Télécharger une sauvegarde** (tout Railway + données du navigateur).
- GitHub : Code → Download ZIP, ou créer une branche `backup-AAAA-MM-JJ`.
- Site : télécharger tout `www/` **avec les fichiers cachés** (`.htaccess`, `.htpasswd`).
- Noter à part les **variables Railway** (pas dans GitHub ni dans la sauvegarde).

---

## 11. Sécurité — état actuel

- ✅ Plus de clé API dans les pages publiques (dashboard, classement, snapshot, manager).
- ✅ Données publiques filtrées par client, limitées en débit.
- ✅ Webhooks Discord validés (domaines discord.com/discordapp.com uniquement), endpoints Web Push en liste blanche.
- ✅ Monteurs : token perso, droits limités, lien régénérable.
- ⚠️ **À faire** : changer `API_SECRET` sur Railway (l’ancienne clé a été publique dans `dashboard.html` pendant des mois), puis se reconnecter dans admin2. Si l’ancien admin ou `manager.html` est utilisé sur un autre appareil, y remettre la nouvelle clé.
- ⚠️ Les clients sans `clientSecret` sont accessibles par leur nom (slug) : leur donner une vraie clé quand c’est possible (attention, ça change leur lien).
- ⚠️ `admin2.html` est public (sans mot de passe) mais vide sans la clé.

---

## 12. Historique des décisions (pourquoi c’est fait comme ça)

- Workflow à la place des stats pour certains clients (option par client). Plateformes choisies par client (Instagram seul pour Silva Twins).
- Discord : seulement les **actions du client** notifient (sinon trop de bruit).
- Vidéos : PC = lecteur Drive, téléphone = bouton Open video (lecteur Drive buggé sur téléphone ; pas de proxy Railway pour ne pas payer la bande passante).
- 1 notification push par vidéo (premier lien Drive = V1), lien Drive saisissable directement au passage en review.
- Données migrées sans rien perdre : nouvelles infos sous `v2`, l’ancien admin et le dashboard continuent de marcher.
- Sauvegardes datées, jamais écrasées ; suppression d’un client = corbeille.
- Les clippers ne voient jamais leurs gains ; pas d’export de paie, pas de stats de performance clippers, pas de facturation client.
- Prix client et tarifs clippers **par mois** (ils changent souvent).
- Comptes « endormis » (14 j) exclus des alertes ; alertes « Ignorer ».
- `/leaderboardsend` = total client de la semaine ; total manuel du dashboard (`totalViewsOverride`) est un chiffre séparé.
- Dashboard client : **comptes, pas clippers**.
- Apify : désactivé par défaut, activable par client (ne pas toucher au client qui l’utilise déjà).

---

## 13. Ce qui reste à faire (feuille de route)

1. **Changer `API_SECRET`** (voir §11).
2. **Apify avec une clé par client** (aujourd’hui une seule clé `APIFY_TOKEN` pour tous).
3. ✅ **Phase 4 (20/11/2026)** : comptes au lieu des clippers, nouvel ordre + blocs repliables, textes « Your page / Our clipping », dates lisibles, Apify avec clé par client, liens des comptes dans « Comptes », admin sur téléphone. Le lien client est unique : `dashboard?c=` ouvre le workflow si activé, avec un lien « Analytics » pour revenir aux stats.
   - ❌ Une refonte visuelle complète du dashboard a été proposée (maquette violette) et **refusée** : le propriétaire préfère le style actuel, sobre. Ne pas changer le look sans demande.
4. Idées possibles : vérifier qu’un lien `/posted` vient bien du compte du salon (grâce aux liens enregistrés) ; résumé « +X % vs last week » dans le style actuel ; bulles « ? » d’explication.
5. Retirer l’ancien `admin.html` une fois admin2 validé (et l’ancien « Channel links »).
7. Plus tard (pour vendre) : multi-agences (une agence = ses propres clients et données), comptes utilisateurs, abonnement (Stripe), onboarding. Idées de prix évoquées : setup + paliers 149 / 349 / 599 € par mois, prix fondateur.

---

## 14. Repères pour Claude dans une nouvelle conversation

- Demander au propriétaire : le ZIP du repo Railway (sans `node_modules` ni `.env`), le ZIP de `www/`, une sauvegarde récente (admin2 → Télécharger une sauvegarde), et ce README.
- Le propriétaire écrit en français ; répondre en français. Pages client en anglais, admin en français.
- Toujours : ne rien supprimer des données, garder la compatibilité avec l’existant, livrer les fichiers modifiés complets + où les mettre, dire si Railway doit être mis à jour ou seulement le site.
- Tester avant de livrer (copie de la sauvegarde, API lancée en local, navigateur automatisé, PC + téléphone).
- Ne jamais mettre de clé API ou de webhook dans une page publique.
