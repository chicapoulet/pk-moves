import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
// vidéo coupée à 8 s max et réencodée en 480p (≈ 400 Ko) : 210 moves × 10 comptes tiennent dans le 1 Go gratuit
const MAX_CLIP = 8;
const MEDIABUNNY = 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.4/dist/bundles/mediabunny.min.mjs';
const SEEN_KEY = 'pk-seen';
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

let me = null;        // { id, username }
let moves = [];       // [{ id, name }] dans l'ordre de la liste
let mine = new Map(); // move_id -> ma ligne v_validations
let routeToken = 0;
let filter = 'all', search = ''; // gardés entre deux affichages de "Mes moves" (et des profils)
let postFilter = 'all';          // pareil pour "Posts"

// ───────────── Outils ─────────────
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(c => c != null && c !== false && c !== ''));
  return el;
}

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  chat: '<path d="M4 4.5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9.5L5 20v-3.5H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/>',
  logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l-5-5 5-5M5 12h11"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
  play: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 9 5 3-5 3z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
};
function icon(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('class', 'ic');
  s.innerHTML = ICONS[name];
  return s;
}

const pct = (done, total) => (total ? Math.round((done * 100) / total) : 0);
// où ranger un move : à faire (pas posté, ou non valide) / en attente / validé (par au moins 1 autre, comme le classement)
const stage = v => (!v || v.invalid ? 'todo' : v.ok_count ? 'done' : 'wait');
const isDone = id => stage(mine.get(id)) === 'done';
const sortRank = rows => [...rows].sort((a, b) => b.done - a.done || a.username.localeCompare(b.username));

async function q(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function msg(e) {
  const m = e?.message || String(e);
  if (/Invalid login/i.test(m)) return 'Nom ou mot de passe incorrect.';
  if (/already (been )?registered|Database error (saving new|updating) user|users_email_partial_key|profiles_username_key/i.test(m)) return 'Ce nom est déjà pris.';
  if (/Password should/i.test(m)) return 'Mot de passe : 6 caractères minimum.';
  if (/exceeded the maximum/i.test(m)) return 'Vidéo trop lourde : garde un passage plus court.';
  if (/unsupported or unrecognizable/i.test(m)) return 'Vidéo illisible : choisis-en une autre.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Pas de connexion au serveur.';
  return m;
}

let toastTimer;
function toast(text, bad = false) {
  (sheet.open ? sheet : document.body).append(toastEl); // sinon caché derrière la fenêtre modale
  toastEl.textContent = text;
  toastEl.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), 3500);
}

async function busy(btn, fn) {
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  try { await fn(); } catch (e) { toast(msg(e), true); }
  finally { if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
}

const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
function ago(iso) {
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]])
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  return "à l'instant";
}

function status(v) {
  if (!v) return { key: 'todo', label: 'À faire', mark: '○' };
  if (v.invalid) return { key: 'ko', label: 'Non valide', mark: '✕' }; // 2 refus, jusqu'à ce qu'il soit reposté
  if (v.ok_count) return { key: 'ok', label: v.video_path ? 'Validé' : 'Validé sans vidéo', mark: '✓' };
  if (v.ko_count) return { key: 'warn', label: 'Potentiellement refusé', mark: '!' };
  if (!v.video_path) return { key: 'warn', label: 'Sans vidéo', mark: '◐' };
  return { key: 'wait', label: 'En attente', mark: '◔' };
}

// ───────────── Petits blocs d'interface ─────────────
const chip = s => h('span', { class: 'chip ' + s.key }, s.mark + ' ' + s.label);
const ring = p => h('div', { class: 'ring', style: `--p:${p}`, role: 'img', 'aria-label': `${p} % validé` }, h('b', {}, p + '%'));
const bar = p => h('span', { class: 'bar', 'aria-hidden': 'true' }, h('span', { style: `width:${p}%` }));
const empty = text => h('p', { class: 'empty' }, text);
const list = items => h('ul', { class: 'list' }, items);
const section = (title, content) => h('section', {}, h('h2', { class: 'section-title' }, title), content);
function avatar(name = '?', path = null, cls = '') {
  if (path) return h('img', { class: 'avatar ' + cls, src: sb.storage.from('avatars').getPublicUrl(path).data.publicUrl, alt: '', loading: 'lazy' });
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) * 37 % 360;
  return h('span', { class: 'avatar ' + cls, style: `--h:${hue}`, 'aria-hidden': 'true' }, name[0].toUpperCase());
}

// #t=0.1 : montre la 1re image sur iPhone
const videoEl = url => h('video', { src: url + '#t=0.1', controls: true, playsinline: true, preload: 'metadata', class: 'video' });
const errorState = e => h('div', { class: 'error', role: 'alert' }, h('p', {}, msg(e)), h('button', { class: 'btn', onclick: route }, 'Réessayer'));
const skeleton = () => h('div', { 'aria-busy': 'true', 'aria-label': 'Chargement' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skel' })));

function segmented(label, options, current, onPick) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([k, text]) => h('button', { 'aria-pressed': String(current === k), onclick: e => {
      el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      onPick(k);
    } }, text)));
  return el;
}

function moveRow(m, map = mine, onOpen = openMove) {
  const v = map.get(m.id);
  return h('li', {}, h('button', { class: 'row', onclick: () => onOpen(m, v) },
    h('span', { class: 'num' }, m.id),
    h('span', { class: 'grow' }, m.name),
    v && chip(status(v))));
}

function validationRow(v) {
  return h('li', {}, h('button', { class: 'row', onclick: () => openValidation(v) },
    avatar(v.username, v.avatar_path),
    h('span', { class: 'grow' }, h('strong', {}, v.move_name),
      h('small', { class: 'muted' }, v.username + ' · ' + ago(v.created_at) + (v.video_path ? ' · 📹' : ''))),
    chip(status(v))));
}

function memberRow(r, pos, toReview) {
  const p = pct(r.done, r.total);
  return h('li', { class: r.user_id === me.id ? 'me' : '' }, h('a', { class: 'row', href: '#user/' + r.user_id },
    toReview && h('span', { class: 'pastille', role: 'img', 'aria-label': 'A un move sans avis' }),
    pos != null && h('span', { class: 'pos' }, ['🥇', '🥈', '🥉'][pos] || pos + 1),
    avatar(r.username, r.avatar_path),
    h('span', { class: 'grow' }, h('strong', {}, r.username + (r.user_id === me.id ? ' (toi)' : '')),
      h('small', { class: 'muted' }, `${r.done} / ${r.total} moves`), bar(p)),
    h('span', { class: 'pct' }, p + '%')));
}

// ───────────── Connexion ─────────────
// Supabase veut un email : on le fabrique à partir du nom. Aucun mail n'est envoyé
// (inscription confirmée d'office) et « .invalid » est un domaine qui n'existe jamais.
function nameEmail(name) {
  const id = name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
  return id.length >= 2 ? id + '@pk-moves.invalid' : null;
}

function showAuth() {
  me = null;
  sheet.open && sheet.close();
  let signup = false;
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const render = () => app.replaceChildren(h('main', { class: 'auth' }, h('form', { class: 'auth-card', onsubmit: submit },
    h('div', { class: 'brand' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, 'PK'), h('h1', {}, 'PK Moves')),
    h('p', { class: 'muted' }, signup ? 'Crée ton compte pour rejoindre la team.' : 'Bienvenue ! Connecte-toi pour voir la progression de chacun.'),
    field('Nom', h('input', { name: 'username', required: true, minlength: 2, maxlength: 24, autocomplete: 'username', autocapitalize: 'off' })),
    field('Mot de passe', h('input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: signup ? 'new-password' : 'current-password' })),
    h('button', { class: 'btn primary block', type: 'submit' }, signup ? 'Créer mon compte' : 'Se connecter'),
    h('button', { class: 'btn ghost block', type: 'button', onclick: () => { signup = !signup; render(); } },
      signup ? "J'ai déjà un compte" : 'Pas de compte ? Inscris-toi'))));
  function submit(e) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const email = nameEmail(f.username);
    if (!email) return toast('Ton nom doit contenir au moins 2 lettres ou chiffres.', true);
    busy(e.submitter, async () => {
      if (!signup) return void await q(sb.auth.signInWithPassword({ email, password: f.password }));
      await q(sb.auth.signUp({ email, password: f.password, options: { data: { username: f.username.trim() } } }));
    });
  }
  render();
}

// la session reste dans le navigateur : on revient connecté à chaque ouverture
sb.auth.onAuthStateChange((_event, session) => {
  // pas d'appel Supabase directement dans ce callback (risque de blocage), d'où le setTimeout
  setTimeout(() => {
    if (!session) showAuth();
    else if (me?.id !== session.user.id) start(session.user);
  });
});

async function start(user) {
  me = { id: user.id };
  try {
    const [profile, list] = await Promise.all([
      q(sb.from('profiles').select('username,avatar_path,is_admin').eq('id', user.id).single()),
      q(sb.from('moves').select('id,name').order('id')),
    ]);
    Object.assign(me, profile);
    moves = list;
    shell();
    route();
    maybeInstallTuto();
    syncPush();
  } catch (e) {
    me = null;
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'auth-card' }, h('p', {}, msg(e)),
      h('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Réessayer'),
      h('button', { class: 'btn ghost block', onclick: () => sb.auth.signOut() }, 'Se déconnecter'))));
  }
}

// ───────────── Squelette + navigation ─────────────
const TABS = [['home', 'Accueil', 'home'], ['posts', 'Posts', 'play'], ['chat', 'Chat', 'chat'], ['rank', 'Classement', 'trophy'], ['moves', 'Mes moves', 'list']];

function shell() {
  app.replaceChildren(
    h('header', { class: 'top' },
      h('a', { class: 'brand small', href: '#home' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, 'PK'), 'PK Moves'),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: openNotifs }, icon('bell'), h('span', { class: 'badge', id: 'badge', hidden: true })),
        h('button', { class: 'icon-btn', 'aria-label': 'Se déconnecter', onclick: () => confirm('Se déconnecter ?') && logout() }, icon('logout')))),
    h('main', { id: 'view', class: 'view' }),
    h('nav', { class: 'tabs', 'aria-label': 'Navigation principale' },
      TABS.map(([id, label, ic]) => h('a', { href: '#' + id, 'data-tab': id }, icon(ic), h('span', {}, label)))));
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); me?.username && route(); });

// ───────────── Installer l'app sur le téléphone ─────────────
const HIDE_INSTALL = 'pk-install-hide';
window.addEventListener('appinstalled', () => localStorage.setItem(HIDE_INSTALL, '1'));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function installTuto(ios = isIos) {
  const steps = ios
    ? ['Ouvre ce site dans Safari.', 'Touche le bouton Partager (le carré avec une flèche vers le haut).', 'Choisis « Sur l’écran d’accueil » (fais défiler si besoin).',
      'Laisse « Ouvrir en tant qu’app web » activé si c’est proposé, puis touche « Ajouter ».']
    : ['Ouvre ce site dans Chrome.', 'Touche les 3 petits points ⋮ (en haut à droite), puis « Installer l’application » ou « Ajouter à l’écran d’accueil ».',
      'Si on te demande, choisis « Installer » (pas « Créer un raccourci »).'];
  openSheet('Installe PK Moves sur ton tél', h('div', { class: 'stack' },
    h('div', { class: 'tuto-head' }, h('img', { src: 'icon-192.png', alt: '', class: 'tuto-icon' }),
      h('p', {}, 'Mets l’app sur ton écran d’accueil : elle s’ouvre en plein écran comme une vraie app, et tu restes connecté.')),
    h('ol', { class: 'tuto' }, steps.map(s => h('li', {}, s))),
    h('p', { class: 'hint' }, 'Tu as déjà une icône PK Moves qui ouvre le navigateur ? Supprime-la et refais ces étapes : la nouvelle s’ouvre en plein écran, comme une vraie app.'),
    h('button', { class: 'btn ghost small', onclick: () => installTuto(!ios) }, ios ? 'Tu as un Android ?' : 'Tu as un iPhone ?'),
    h('div', { class: 'vote' },
      h('button', { class: 'btn primary', onclick: () => sheet.close() }, "J'ai compris"),
      h('button', { class: 'btn', onclick: () => { localStorage.setItem(HIDE_INSTALL, '1'); sheet.close(); route(); } }, 'Ne plus afficher'))));
}

// au lancement dans le navigateur : le tuto une fois par visite, tant que l'app n'est pas installée
function maybeInstallTuto() {
  if (installed() || localStorage.getItem(HIDE_INSTALL) || sessionStorage.getItem('pk-tuto')) return;
  sessionStorage.setItem('pk-tuto', '1');
  installTuto();
}

// ───────────── Notifs sur le téléphone ─────────────
const pushOk = 'PushManager' in window && 'Notification' in window && 'serviceWorker' in navigator;
const pushSub = () => navigator.serviceWorker.ready.then(r => r.pushManager.getSubscription());

async function savePush(sub) {
  const { endpoint, keys } = sub.toJSON();
  await q(sb.from('push_subscriptions').upsert({ endpoint, user_id: me.id, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: 'endpoint' }));
}

async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifs refusées : autorise-les dans les réglages du téléphone.');
  const [k] = await q(sb.from('push_keys').select('public_key')); // clé publique créée par l'Edge Function « push »
  if (!k) throw new Error('Les notifs ne sont pas encore prêtes, réessaie plus tard.');
  const reg = await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(k.public_key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  await savePush(await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  toast('Notifs activées 🔔');
  route();
}

// à chaque ouverture : l'abonnement du téléphone peut changer, on le garde à jour
function syncPush() {
  if (pushOk && Notification.permission === 'granted') pushSub().then(sub => sub && savePush(sub)).catch(() => {});
}

async function logout() {
  const sub = pushOk && await pushSub().catch(() => null);
  if (sub) await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  sb.auth.signOut();
}

function pushCard() {
  if (!pushOk || Notification.permission !== 'default') return null;
  return h('button', { class: 'card install', onclick: e => busy(e.currentTarget, enablePush) }, icon('bell'),
    h('span', { class: 'grow' }, h('strong', {}, 'Active les notifs sur ton tél'),
      h('small', { class: 'muted' }, 'Nouveaux moves postés et votes sur les tiens')));
}

function installCard() {
  if (installed() || localStorage.getItem(HIDE_INSTALL)) return null;
  return h('button', { class: 'card install', onclick: () => installTuto() }, icon('download'),
    h('span', { class: 'grow' }, h('strong', {}, "Installe l'app sur ton tél"), h('small', { class: 'muted' }, 'Voir comment faire (30 secondes)')));
}

async function route() {
  const token = ++routeToken;
  let [tab, arg] = (location.hash.slice(1) || 'home').split('/');
  const deep = { v: () => openValidationById(+arg), notifs: openNotifs }[tab];
  if (deep) { history.replaceState(null, '', '#home'); tab = 'home'; } // sinon chaque route() rouvrirait la fiche
  const view = document.getElementById('view');
  document.querySelectorAll('.tabs a').forEach(a =>
    a.dataset.tab === (tab === 'user' ? 'rank' : tab) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if (!view.childElementCount) view.replaceChildren(skeleton());
  try {
    mine = new Map((await q(sb.from('v_validations').select('*').eq('user_id', me.id))).map(v => [v.move_id, v]));
    deep?.();
    const render = { home, posts: postsView, chat, rank, moves: movesView, user: () => userView(arg) }[tab] || home;
    const content = await render();
    if (token !== routeToken) return; // l'utilisateur a changé d'onglet entre-temps
    view.replaceChildren(...[content].flat().filter(Boolean));
  } catch (e) {
    if (token === routeToken) view.replaceChildren(errorState(e));
  }
  refreshBadge();
}

// ───────────── Onglets ─────────────
async function home() {
  const [lb, todo] = await Promise.all([
    q(sb.from('v_leaderboard').select('*')),
    q(sb.from('v_to_review').select('*').order('created_at', { ascending: false })),
  ]);
  const done = moves.filter(m => isDone(m.id)).length;
  const p = pct(done, moves.length);
  const ranked = sortRank(lb);
  const next = moves.filter(m => stage(mine.get(m.id)) === 'todo').slice(0, 5); // pas encore postés (ou à reposter)
  const noVideo = [...mine.values()].filter(v => !v.video_path && !v.invalid).length;
  const toReview = todo.sort((a, b) => (a.ok_count > 0) - (b.ok_count > 0)); // 0 validation d'abord ; le tri garde les plus récents en premier
  return [
    installCard(),
    pushCard(),
    h('section', { class: 'hero card' }, ring(p), h('div', {},
      h('p', { class: 'muted' }, 'Salut ' + me.username + ' 👋'),
      h('h1', {}, `${done} / ${moves.length} moves`),
      h('p', {}, `#${ranked.findIndex(r => r.user_id === me.id) + 1} sur ${ranked.length} dans la team`))),
    noVideo > 0 && h('button', { class: 'card alert', onclick: openNotifs }, icon('video'),
      h('span', {}, `${noVideo} move${noVideo > 1 ? 's' : ''} sans vidéo — ajoute-la pour que la team vérifie`)),
    section('Prochains moves à faire', next.length ? list(next.map(m => moveRow(m))) : empty('Tu as toute la liste. Respect. 🔥')),
    section(`À valider (${toReview.length})`, toReview.length ? list(toReview.map(validationRow)) : empty('Tu as donné ton avis sur tous les posts. 👌')),
  ];
}

const PAGE = 15;
// filtres de "Posts", calculés par la base (comme les statuts de status())
const POST_FILTERS = {
  all: r => r,
  wait: r => r.eq('ok_count', 0).eq('ko_count', 0),
  ok: r => r.gt('ok_count', 0).eq('invalid', false),
  ko: r => r.gt('ko_count', 0).or('invalid.eq.true,ok_count.eq.0'), // potentiellement refusé ou non valide
};
async function postsView() {
  const feed = h('div', { class: 'feed' });
  const more = h('button', { class: 'btn block', hidden: true, onclick: () => busy(more, load) }, 'Voir plus');
  let from = 0;
  async function load() {
    const rows = await q(POST_FILTERS[postFilter](sb.from('v_validations').select('*')).order('created_at', { ascending: false }).range(from, from + PAGE - 1));
    const { urls, votes } = await postsData(rows);
    if (!from && !rows.length) feed.append(empty(postFilter === 'all' ? "Personne n'a encore posté. Lance-toi !" : 'Aucun post ici.'));
    from += rows.length;
    feed.append(...rows.map(v => postCard(v, urls.get(v.video_path), votes.get(v.id))));
    more.hidden = rows.length < PAGE;
  }
  await load();
  return [h('h1', { class: 'page-title' }, 'Posts'), h('p', { class: 'muted sub' }, 'Les derniers moves postés par toute la team'),
    segmented('Filtrer les posts', [['all', 'Tous'], ['wait', 'Non validés'], ['ok', 'Validés'], ['ko', 'Refusés']], postFilter, k => { postFilter = k; route(); }),
    feed, more];
}

// les liens des vidéos + mes votes (ok/ko) sur ces posts, pour savoir où proposer le vote rapide
async function postsData(rows) {
  const paths = rows.map(v => v.video_path).filter(Boolean);
  const [signed, votes] = await Promise.all([
    paths.length ? q(sb.storage.from('videos').createSignedUrls(paths, 3600)) : [],
    rows.length ? q(sb.from('reviews').select('validation_id,kind').eq('reviewer_id', me.id).neq('kind', 'comment').in('validation_id', rows.map(v => v.id))) : [],
  ]);
  return { urls: new Map(signed.map(s => [s.path, s.signedUrl])), votes: new Map(votes.map(r => [r.validation_id, r.kind])) };
}

// myVote : 'ok' / 'ko' si j'ai déjà jugé ; sinon boutons de vote rapide. after(kind) : quoi redessiner après le vote
function postCard(v, url, myVote, after) {
  const own = v.user_id === me.id;
  const open = () => openValidation(v);
  after ??= async kind => { // par défaut la carte se redessine avec les nouveaux chiffres
    sheet.open && sheet.close(); // la fenêtre du refus
    const nv = await q(sb.from('v_validations').select('*').eq('id', v.id).maybeSingle());
    card.replaceWith(nv ? postCard(nv, url, kind) : empty(`Le ${v.move_name} de ${v.username} n'est plus valide.`));
  };
  const card = h('article', { class: 'post' },
    h('button', { class: 'post-head', onclick: open }, avatar(v.username, v.avatar_path),
      h('span', { class: 'grow' }, h('strong', {}, own ? 'Toi' : v.username), h('small', { class: 'muted' }, ago(v.created_at))),
      chip(status(v))),
    h('h2', { class: 'post-move' }, v.move_name),
    url ? videoEl(url) : h('div', { class: 'novideo' }, icon('video'), h('span', {}, 'Pas encore de vidéo')),
    h('button', { class: 'post-foot', onclick: open },
      h('span', { class: 'ok' }, `✓ ${v.ok_count}`), h('span', { class: 'ko' }, `✕ ${v.ko_count}`),
      h('span', { class: 'grow' }), h('span', { class: 'muted' }, { ok: '✓ Tu as validé →', ko: '✕ Tu as refusé →' }[myVote] || 'Voir les avis →')),
    !own && !myVote && h('div', { class: 'quick' }, voteButtons(v, after)));
  return card;
}

// shortcut: le chat se relit toutes les 4 s tant qu'il est affiché ; passer à Supabase Realtime si la team grossit beaucoup
async function chat() {
  let last = 0; // id du dernier message affiché
  const listEl = h('ul', { class: 'chat' }, h('li', { class: 'empty' }, 'Aucun message pour l’instant. Lance la discussion ! 💬'));
  const bubble = m => {
    const mineMsg = m.user_id === me.id, who = m.profiles?.username;
    return h('li', { class: mineMsg ? 'mine' : '' }, !mineMsg && avatar(who, m.profiles?.avatar_path, 'small'),
      h('div', {}, !mineMsg && h('strong', {}, who), h('p', {}, m.body), h('small', { class: 'muted' }, ago(m.created_at))));
  };
  async function load() {
    const rows = (await q(sb.from('chat_messages').select('id,user_id,body,created_at,profiles(username,avatar_path)')
      .gt('id', last).order('id', { ascending: false }).limit(50))).reverse().filter(m => m.id > last); // 2 lectures en même temps : pas de doublon
    if (!rows.length) return;
    const atBottom = innerHeight + scrollY >= document.body.scrollHeight - 120;
    if (!last) listEl.replaceChildren(); // enlève « aucun message »
    last = rows.at(-1).id;
    localStorage.setItem(CHAT_SEEN, last); // lu : la pastille de l'onglet Chat disparaît
    document.querySelector('.tabs a[data-tab="chat"]')?.classList.remove('unread');
    listEl.append(...rows.map(bubble));
    if (atBottom) form.scrollIntoView({ block: 'end' });
  }
  const input = h('input', { maxlength: 500, autocomplete: 'off', placeholder: 'Écris à la team…', 'aria-label': 'Message' });
  const form = h('form', { class: 'chat-form', onsubmit: e => {
    e.preventDefault();
    const body = input.value.trim();
    if (body) busy(e.submitter, async () => {
      await q(sb.from('chat_messages').insert({ body }));
      input.value = '';
      await load();
      form.scrollIntoView({ block: 'end' });
    });
  } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer'));
  const token = routeToken; // un autre onglet (ou un nouvel affichage) arrête la relecture ; lu avant le chargement
  await load();
  const timer = setInterval(() => (token !== routeToken ? clearInterval(timer) : document.hidden || load().catch(() => {})), 4000);
  setTimeout(() => form.scrollIntoView({ block: 'end' })); // une fois affiché : en bas, sur les derniers messages
  return [h('h1', { class: 'page-title' }, 'Chat'), h('p', { class: 'muted sub' }, 'Toute la team'), listEl, form];
}

async function rank() {
  const [lb, todo] = await Promise.all([q(sb.from('v_leaderboard').select('*')),
    q(sb.from('v_validations').select('user_id').eq('ok_count', 0).eq('ko_count', 0).neq('user_id', me.id))]);
  const waiting = new Set(todo.map(v => v.user_id)); // pastille rouge : il a un move que personne n'a encore validé ni refusé
  return [h('h1', { class: 'page-title' }, 'Classement'), h('p', { class: 'muted sub' }, "% de la liste validée · touche quelqu'un pour voir son profil"),
    h('ol', { class: 'list rank' }, sortRank(lb).map((r, i) => memberRow(r, i, waiting.has(r.user_id))))];
}

// les moves de la liste avec recherche et filtres, pour moi (map = mine) ou pour un autre
function movesList(map, onOpen) {
  const listEl = h('ul', { class: 'list' });
  const draw = () => {
    const s = search.trim().toLowerCase();
    const items = moves.filter(m => (filter === 'all' || stage(map.get(m.id)) === filter) && m.name.toLowerCase().includes(s));
    listEl.replaceChildren(...(items.length ? items.map(m => moveRow(m, map, onOpen)) : [h('li', {}, empty('Aucun move ne correspond.'))]));
  };
  draw();
  return [h('div', { class: 'toolbar' },
    h('input', { type: 'search', placeholder: 'Chercher un move…', 'aria-label': 'Chercher un move', value: search, oninput: e => { search = e.target.value; draw(); } }),
    segmented('Filtrer les moves', [['all', 'Tous'], ['todo', 'À faire'], ['wait', 'En attente'], ['done', 'Validés']], filter, k => { filter = k; draw(); })),
  listEl];
}

function movesView() {
  return [h('h1', { class: 'page-title' }, 'Mes moves'),
    h('p', { class: 'muted sub' }, `${moves.filter(m => isDone(m.id)).length} validés sur ${moves.length} · touche un move pour le valider`),
    ...movesList(mine, openMove),
    h('button', { class: 'btn ghost block propose', onclick: proposeMove }, '💡 Proposer un move')];
}

function proposeMove() {
  const save = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await q(sb.from('move_proposals').insert({ name: e.target.name.value.trim() }));
      sheet.close();
      toast("Proposition envoyée à l'admin 👍");
    });
  };
  openSheet('Proposer un move', h('form', { class: 'stack', onsubmit: save },
    h('label', { class: 'field' }, h('span', {}, 'Nom du move'), h('input', { name: 'name', required: true, minlength: 2, maxlength: 60 })),
    h('p', { class: 'hint' }, "L'admin l'ajoute à la liste s'il l'accepte."),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Envoyer')));
}

async function userView(id) {
  const [[p], vals] = await Promise.all([
    q(sb.from('v_leaderboard').select('*').eq('user_id', id)),
    q(sb.from('v_validations').select('*').eq('user_id', id).order('move_id')),
  ]);
  if (!p) return empty('Membre introuvable.');
  const own = id === me.id, pc = pct(p.done, p.total);
  const openTheirs = (m, v) => (v ? openValidation(v) : openSheet(m.name, h('div', { class: 'stack' }, empty(`${p.username} ne l'a pas encore posté.`), videosBtn(m))));
  return [h('a', { class: 'back', href: '#rank' }, '← Classement'),
    h('section', { class: 'hero card' }, avatar(p.username, p.avatar_path, 'big'), h('div', { class: 'grow' },
      h('h1', {}, p.username + (own ? ' (toi)' : '')), h('p', {}, `${p.done} / ${p.total} moves validés · ${pc}%`), bar(pc),
      own && h('div', { class: 'own-actions' }, h('label', { class: 'btn small photo-btn' }, '📷 Changer ma photo',
        h('input', { type: 'file', accept: 'image/*', class: 'file', onchange: e => {
          const file = e.target.files[0];
          e.target.value = ''; // pour pouvoir rechoisir la même photo
          busy(e.target.closest('label'), () => adjustPhoto(file));
        } })),
        h('button', { class: 'btn small', onclick: () => changeName() }, '✏️ Changer mon nom')),
      !own && me.is_admin && h('div', { class: 'own-actions' }, h('button', { class: 'btn small', onclick: () => changeName(p) }, '✏️ Renommer (admin)')))),
    h('h2', { class: 'section-title' }, own ? 'Mes moves' : `Les moves de ${p.username}`),
    ...movesList(new Map(vals.map(v => [v.move_id, v])), own ? openMove : openTheirs)];
}

// le nom sert aussi à se connecter : on change les deux d'un coup (la base recopie le nom dans le profil)
function changeName(other) { // other : un membre (v_leaderboard) que l'admin renomme
  const save = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const name = e.target.username.value.trim(), email = nameEmail(name);
      if (!email) throw new Error('Le nom doit contenir au moins 2 lettres ou chiffres.');
      if (other) await q(sb.rpc('admin_rename', { target: other.user_id, new_name: name, new_email: email }));
      else { await q(sb.auth.updateUser({ email, data: { username: name } })); me.username = name; }
      sheet.close();
      toast(other ? `${name} se connecte maintenant avec ce nom 👌` : `C'est fait ! Connecte-toi maintenant avec « ${name} » 👌`);
      route();
    });
  };
  openSheet(other ? `Renommer ${other.username}` : 'Changer mon nom', h('form', { class: 'stack', onsubmit: save },
    h('label', { class: 'field' }, h('span', {}, 'Nouveau nom'),
      h('input', { name: 'username', value: other ? other.username : me.username, required: true, minlength: 2, maxlength: 24, autocomplete: 'off', autocapitalize: 'off' })),
    h('p', { class: 'hint' }, other ? 'Il se connectera avec ce nouveau nom (même mot de passe).' : 'Tu te connecteras avec ce nouveau nom (même mot de passe).'),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Enregistrer')));
}

// la photo s'ouvre dans un cadre rond : on la glisse et on zoome, puis on garde ce carré en 256 px (petit, rapide à charger)
async function adjustPhoto(file) {
  if (!file) return;
  const img = new Image(); // <img> applique la rotation des photos de téléphone
  img.src = URL.createObjectURL(file);
  await img.decode().catch(() => { URL.revokeObjectURL(img.src); throw new Error('Image illisible, essaie une autre photo.'); });
  const W = img.naturalWidth, H = img.naturalHeight;
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
  let zoom = 1, cx = W / 2, cy = H / 2, drag = null; // centre du cadre, en pixels de la photo
  const side = () => Math.min(W, H) / zoom;
  const draw = c => {
    const s = side();
    cx = clamp(cx, s / 2, W - s / 2); cy = clamp(cy, s / 2, H - s / 2); // le cadre reste plein
    c.getContext('2d').drawImage(img, cx - s / 2, cy - s / 2, s, s, 0, 0, c.width, c.height);
  };
  const move = (dx, dy) => { const k = side() / view.clientWidth; cx -= dx * k; cy -= dy * k; draw(view); };
  const view = h('canvas', { class: 'crop', width: 512, height: 512, tabindex: 0, 'aria-label': 'Aperçu : glisse la photo (ou flèches du clavier) pour la placer',
    onpointerdown: e => { if (!e.isPrimary) return; drag = [e.clientX, e.clientY]; view.setPointerCapture(e.pointerId); },
    onpointermove: e => { if (drag && e.isPrimary) { move(e.clientX - drag[0], e.clientY - drag[1]); drag = [e.clientX, e.clientY]; } },
    onpointerup: () => (drag = null), onpointercancel: () => (drag = null),
    onkeydown: e => {
      const d = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
      if (d) { e.preventDefault(); move(...d); }
    } });
  const save = h('button', { class: 'btn primary block', onclick: () => busy(save, async () => {
    const out = Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
    draw(out);
    await changeAvatar(await new Promise(ok => out.toBlob(ok, 'image/jpeg', 0.85)));
  }) }, 'Enregistrer');
  openSheet('Ajuste ta photo', h('div', { class: 'stack' },
    view,
    h('p', { class: 'hint' }, '👆 Glisse la photo pour la placer dans le rond.'),
    h('label', { class: 'zoom' }, '🔍', h('input', { type: 'range', min: 1, max: 3, step: 0.01, value: 1, 'aria-label': 'Zoom',
      oninput: e => { zoom = +e.target.value; draw(view); } })),
    save));
  sheet.addEventListener('close', () => URL.revokeObjectURL(img.src), { once: true }); // libère la photo
  draw(view);
}

async function changeAvatar(blob) {
  const path = `${me.id}/${Date.now()}.jpg`;
  await q(sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg' }));
  await q(sb.from('profiles').update({ avatar_path: path }).eq('id', me.id));
  if (me.avatar_path) sb.storage.from('avatars').remove([me.avatar_path]); // l'ancienne photo
  me.avatar_path = path;
  sheet.close();
  toast('Photo de profil changée 👌');
  route();
}

// ───────────── Fenêtre du bas (détail d'un move) ─────────────
function openSheet(title, ...content) {
  sheet.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-title' }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => sheet.close() }, icon('x'))),
    h('div', { class: 'sheet-body' }, ...content));
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', e => e.target === sheet && sheet.close()); // clic à côté = fermer
sheet.addEventListener('close', () => !sheet.open && sheet.replaceChildren()); // coupe la vidéo

function openMove(m) {
  const v = mine.get(m.id);
  if (v) return openValidation(v);
  openSheet(m.name, h('div', { class: 'stack' }, videosBtn(m), uploadForm(m, null)));
}

// « Voir (N) » : les vidéos de ce move postées par toute la team
const moveVideos = m => q(sb.from('v_validations').select('*').eq('move_id', m.id).not('video_path', 'is', null).order('created_at', { ascending: false }));
function videosBtn(m) {
  const btn = h('button', { class: 'btn block', disabled: true }, '👀 Voir les vidéos…');
  moveVideos(m).then(rows => {
    btn.textContent = rows.length ? `👀 Voir (${rows.length} ${rows.length > 1 ? 'personnes ont' : 'personne a'} posté une vidéo)` : 'Personne n’a encore posté de vidéo de ce move';
    btn.disabled = !rows.length;
    btn.addEventListener('click', () => busy(btn, () => openMoveVideos(m, rows)));
  }, () => btn.remove());
  return btn;
}

async function openMoveVideos(m, rows) {
  rows ??= await moveVideos(m);
  const { urls, votes } = await postsData(rows);
  openSheet(m.name, rows.length
    ? h('div', { class: 'feed' }, rows.map(v => postCard(v, urls.get(v.video_path), votes.get(v.id), () => openMoveVideos(m))))
    : empty('Plus aucune vidéo de ce move.'));
}

async function openValidationById(id) {
  try {
    const v = await q(sb.from('v_validations').select('*').eq('id', id).maybeSingle());
    if (v) return openValidation(v);
    sheet.close();
    toast("Ce post n'est plus visible (retiré ou non valide).");
  } catch (e) { toast(msg(e), true); }
}

async function refreshValidation(id) {
  await openValidationById(id);
  route(); // met à jour la page derrière
}

async function openValidation(v) {
  const own = v.user_id === me.id;
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  openSheet(v.move_name, body);
  try {
    const [reviews, url] = await Promise.all([
      q(sb.from('v_reviews').select('*').eq('validation_id', v.id).order('created_at')),
      v.video_path ? sb.storage.from('videos').createSignedUrl(v.video_path, 3600).then(r => r.data?.signedUrl) : null,
    ]);
    const myVote = reviews.find(r => r.reviewer_id === me.id && r.kind !== 'comment');
    body.replaceChildren(...[ // filter : les blocs absents (false) ne doivent pas s'afficher en texte
      h('div', { class: 'meta' }, chip(status(v)), h('span', { class: 'muted' }, `posté par ${own ? 'toi' : v.username} · ${ago(v.created_at)}`)),
      url ? videoEl(url)
        : h('div', { class: 'novideo' }, icon('video'), h('span', {}, own ? 'Pas encore de vidéo.' : `Pas encore de vidéo, elle est demandée à ${v.username}.`)),
      videosBtn({ id: v.move_id, name: v.move_name }),
      h('div', { class: 'score' },
        h('span', { class: 'ok' }, `✓ ${v.ok_count} validation${v.ok_count > 1 ? 's' : ''}`),
        h('span', { class: 'ko' }, `✕ ${v.ko_count} refus`),
        h('small', { class: 'muted' }, v.invalid ? 'Non valide : 2 refus. Il doit être reposté avec une nouvelle vidéo.' : 'Non valide à partir de 2 refus')),
      own ? ownerActions(v) : voteActions(v, myVote),
      !own && me.is_admin && v.video_path && h('button', { class: 'btn ghost danger block', onclick: e => busy(e.currentTarget, async () => {
        if (!confirm(`Supprimer la vidéo de ${v.username} ? Elle lui sera redemandée.`)) return;
        await q(sb.from('validations').update({ video_path: null }).eq('id', v.id));
        await sb.storage.from('videos').remove([v.video_path]); // au pire un fichier orphelin
        sheet.close();
        toast('Vidéo supprimée.');
        route();
      }) }, '🗑️ Supprimer la vidéo (admin)'),
      h('h3', {}, 'Avis & commentaires'),
      reviews.length ? h('ul', { class: 'reviews' }, reviews.map(reviewItem)) : h('p', { class: 'muted' }, "Aucun avis pour l'instant."),
      !own && commentForm(v), // pas de commentaire sur ses propres posts
    ].filter(Boolean));
  } catch (e) {
    body.replaceChildren(errorState(e));
  }
}

function uploadForm(m, v) {
  // v absent : première validation ; v sans vidéo : on ajoute la vidéo ; v non valide : on reposte (les refus repartent à 0)
  const addOnly = v && !v.invalid;
  const input = h('input', { type: 'file', accept: 'video/*', class: 'file' });
  const picked = h('small', { class: 'muted' }, 'Aucune vidéo choisie');

  // découpe : on choisit le début puis la durée. Pendant qu'on glisse, l'aperçu montre l'image en direct ;
  // quand on relâche, il rejoue le passage gardé en boucle (= le rendu final)
  const preview = h('video', { class: 'video', playsinline: true, muted: true, hidden: true });
  preview.muted = true; // l'attribut seul ne coupe pas le son : sans ça, le téléphone bloque la lecture auto en boucle
  const startIn = h('input', { type: 'range', min: 0, step: 0.1, value: 0, 'aria-label': 'Début du passage' });
  const lenIn = h('input', { type: 'range', min: 0.5, step: 0.1, value: MAX_CLIP, 'aria-label': 'Durée du passage' });
  const sel = h('span', {}), summary = h('b', {});
  const trimBox = h('div', { class: 'trim', hidden: true },
    h('p', { class: 'hint' }, `✂️ Place le début du move, puis règle sa durée (${MAX_CLIP} s max). L'aperçu rejoue ton passage en boucle.`),
    h('div', { class: 'trim-bar' }, sel),
    h('label', { class: 'trim-row' }, h('span', {}, 'Début'), startIn),
    h('label', { class: 'trim-row' }, h('span', {}, 'Durée'), lenIn),
    summary);
  const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  const range = () => trimBox.hidden ? [0, MAX_CLIP] : [+startIn.value, Math.min(+startIn.value + +lenIn.value, preview.duration)];
  let pending = null; // une seule recherche d'image à la fois : le glissé reste fluide sur téléphone
  preview.addEventListener('seeked', () => { if (pending != null) { preview.currentTime = pending; pending = null; } });
  const scrub = t => {
    const [s, e] = range(), d = preview.duration;
    summary.textContent = `${fmt(s)} → ${fmt(e)} · ${(e - s).toFixed(1)} s gardées`;
    sel.style.left = `${s / d * 100}%`; sel.style.width = `${(e - s) / d * 100}%`;
    preview.pause();
    if (preview.seeking) pending = t; else preview.currentTime = t;
  };
  const loop = () => { pending = null; preview.currentTime = range()[0]; preview.play().catch(() => {}); };
  startIn.addEventListener('input', () => scrub(range()[0])); // on voit l'image du début
  lenIn.addEventListener('input', () => scrub(range()[1]));   // on voit l'image de fin
  startIn.addEventListener('change', loop);
  lenIn.addEventListener('change', loop);
  preview.addEventListener('timeupdate', () => { if (!preview.paused && preview.currentTime >= range()[1]) loop(); });
  preview.addEventListener('ended', loop);
  preview.addEventListener('loadedmetadata', () => {
    const d = preview.duration;
    trimBox.hidden = !(isFinite(d) && d > 1); // durée inconnue ou très courte : on garde les 8 premières secondes
    if (!trimBox.hidden) {
      startIn.max = d - 0.5;
      lenIn.max = Math.min(d, MAX_CLIP);
      startIn.value = 0;
      lenIn.value = lenIn.max;
      scrub(0);
    }
    loop();
  });

  input.addEventListener('change', () => {
    const f = input.files[0];
    picked.textContent = f ? `${f.name} · ${(f.size / 1048576).toFixed(1)} Mo` : 'Aucune vidéo choisie';
    if (preview.src) URL.revokeObjectURL(preview.src);
    preview.hidden = !f;
    trimBox.hidden = true;
    if (f) preview.src = URL.createObjectURL(f);
  });
  const label = addOnly ? 'Envoyer la vidéo' : v ? 'Reposter avec une nouvelle vidéo' : 'Poster ma validation';
  const btn = h('button', { class: 'btn primary block', onclick: () => busy(btn, async () => {
    const file = input.files[0];
    if (!file && addOnly) return toast('Choisis une vidéo.', true);
    if (!file && !confirm('Valider sans vidéo ? Elle te sera demandée dans les notifications.')) return;
    const path = file ? await uploadVideo(file, m.id, range(), p => (btn.textContent = `Compression… ${Math.round(p * 100)} %`)) : null;
    if (addOnly) {
      await q(sb.from('validations').update({ video_path: path }).eq('id', v.id));
    } else {
      if (v) await removeValidation(v);
      await q(sb.from('validations').insert({ move_id: m.id, video_path: path }));
    }
    sheet.close();
    toast(addOnly ? 'Vidéo ajoutée 📹' : 'Move validé ! 🔥');
    route();
  }).finally(() => (btn.textContent = label)) }, label);
  return h('div', { class: 'stack' },
    v?.invalid && h('p', { class: 'warnbox' }, "Ce move n'est plus valide (2 refus). Reposte-le avec une nouvelle vidéo."),
    h('label', { class: 'drop' }, icon('video'), h('strong', {}, 'Choisir ou filmer une vidéo'), picked, input),
    preview,
    trimBox,
    btn,
    !addOnly && h('p', { class: 'hint' }, "Pas de vidéo sous la main ? Poste quand même, elle te sera demandée dans les notifications."));
}

// coupe le passage et le réencode en 480p léger, directement sur le téléphone (rien n'est envoyé avant)
async function compress(file, [start, end], onProgress) {
  const mb = await import(MEDIABUNNY); // chargé seulement au moment de poster une vidéo
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const conv = await mb.Conversion.init({
    input: new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS }),
    output,
    trim: { start, end },
    video: async t => {
      const w = await t.getDisplayWidth(), hgt = await t.getDisplayHeight();
      const side = Math.min(480, w, hgt) & ~1; // petit côté à 480 px (pair pour l'encodeur)
      return { codec: 'avc', [w > hgt ? 'height' : 'width']: side, frameRate: 30, quality: new mb.Quality({ bitrate: 350_000 }) };
    },
    audio: { codec: 'aac', quality: new mb.Quality({ bitrate: 48_000 }) }, // son retiré si le téléphone ne sait pas l'encoder
    showWarnings: false,
  });
  if (!conv.utilizedTracks.some(t => t.isVideoTrack())) throw new Error("Ton téléphone n'arrive pas à compresser cette vidéo : mets à jour ton navigateur.");
  conv.onProgress = onProgress;
  await conv.execute();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

async function uploadVideo(file, moveId, range, onProgress) {
  const small = await compress(file, range, onProgress);
  const path = `${me.id}/${moveId}-${Date.now()}.mp4`;
  await q(sb.storage.from('videos').upload(path, small, { contentType: 'video/mp4' }));
  return path;
}

async function removeValidation(v) {
  await q(sb.from('validations').delete().eq('id', v.id));
  if (v.video_path) await sb.storage.from('videos').remove([v.video_path]); // au pire un fichier orphelin
}

function ownerActions(v) {
  const m = moves.find(x => x.id === v.move_id);
  return h('div', { class: 'stack' },
    (v.invalid || !v.video_path) && uploadForm(m, v),
    h('button', { class: 'btn ghost danger block', onclick: e => busy(e.currentTarget, async () => {
      if (!confirm('Retirer ta validation de ce move ? Les avis seront effacés.')) return;
      await removeValidation(v);
      sheet.close();
      toast('Validation retirée.');
      route();
    }) }, 'Retirer ma validation'));
}

function voteActions(v, myVote) {
  if (myVote) {
    return h('div', { class: 'voted ' + myVote.kind },
      h('span', {}, myVote.kind === 'ok' ? '✓ Tu as validé ce move' : '✕ Tu as refusé ce move'),
      h('button', { class: 'btn ghost small', onclick: e => busy(e.currentTarget, async () => {
        await q(sb.from('reviews').delete().eq('id', myVote.id));
        await refreshValidation(v.id);
      }) }, "Changer d'avis"));
  }
  return voteButtons(v, () => refreshValidation(v.id));
}

// ✓ d'un clic ; ✕ ouvre une fenêtre pour dire pourquoi. after(kind) redessine ce qu'il faut après le vote
function voteButtons(v, after) {
  return h('div', { class: 'vote' },
    h('button', { class: 'btn ok', onclick: e => busy(e.currentTarget, async () => {
      await q(sb.from('reviews').insert({ validation_id: v.id, kind: 'ok' }));
      await after('ok');
      toast('Validé ✓'); // après le redessin, sinon il serait effacé avec l'ancienne fenêtre
    }) }, '✓ Valider'),
    h('button', { class: 'btn ko', onclick: () => refuse(v, after) }, '✕ Refuser'));
}

function refuse(v, after) {
  const save = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const body = e.target.reason.value.trim();
      if (!body) throw new Error('Dis pourquoi tu ne valides pas.');
      await q(sb.from('reviews').insert({ validation_id: v.id, kind: 'ko', body }));
      await after('ko');
      toast(v.ko_count ? "Refus envoyé : ce move n'est plus valide." : 'Refus envoyé');
    });
  };
  openSheet(`Refuser : ${v.move_name} de ${v.username}`, h('form', { class: 'stack', onsubmit: save },
    h('label', { class: 'field' }, h('span', {}, 'Pourquoi ? (obligatoire)'),
      h('textarea', { name: 'reason', rows: 3, maxlength: 500, required: true, autofocus: true, placeholder: 'Ex. : réception pas contrôlée' })),
    h('p', { class: 'hint' }, v.ko_count ? "C'est le 2e refus : le move ne sera plus valide." : "Au 2e refus, le move n'est plus valide."),
    h('button', { class: 'btn ko block', type: 'submit' }, '✕ Envoyer le refus')));
}

function reviewItem(r) {
  const [cls, verb] = { ok: ['ok', 'a validé'], ko: ['ko', "n'a pas validé"], comment: ['', 'a commenté'] }[r.kind];
  return h('li', { class: 'review ' + cls }, avatar(r.reviewer_name, r.reviewer_avatar), h('div', { class: 'grow' },
    h('p', {}, h('strong', {}, r.reviewer_id === me.id ? 'Toi' : r.reviewer_name), ' ' + verb, h('small', { class: 'muted' }, ' · ' + ago(r.created_at))),
    r.body && h('p', { class: 'body' }, r.body)));
}

function commentForm(v) {
  const ta = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Écrire un commentaire…', 'aria-label': 'Commentaire', required: true });
  return h('form', { class: 'comment', onsubmit: e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      if (!ta.value.trim()) return;
      await q(sb.from('reviews').insert({ validation_id: v.id, kind: 'comment', body: ta.value.trim() }));
      await refreshValidation(v.id);
    });
  } }, ta, h('button', { class: 'btn primary', type: 'submit' }, 'Envoyer'));
}

// ───────────── Notifications ─────────────
async function fetchNotifs() {
  const reviews = await q(sb.from('v_reviews').select('*').eq('owner_id', me.id).neq('reviewer_id', me.id)
    .order('created_at', { ascending: false }).limit(30));
  const proposals = me.is_admin ? await q(sb.from('move_proposals').select('id,name,created_at,profiles(username)').order('created_at')) : [];
  const mineList = [...mine.values()];
  return { reviews, proposals, noVideo: mineList.filter(v => !v.video_path && !v.invalid), invalid: mineList.filter(v => v.invalid) };
}

// pastille rouge sur l'onglet Chat : un message d'un autre, plus récent que le dernier lu sur ce téléphone
const CHAT_SEEN = 'pk-chat-seen';
async function refreshChatDot() {
  const tab = document.querySelector('.tabs a[data-tab="chat"]');
  const [newest] = await q(sb.from('chat_messages').select('id').neq('user_id', me.id).order('id', { ascending: false }).limit(1)).catch(() => []);
  const unread = !!newest && newest.id > +(localStorage.getItem(CHAT_SEEN) || 0);
  tab?.classList.toggle('unread', unread);
  tab?.setAttribute('aria-label', unread ? 'Chat (nouveaux messages)' : 'Chat');
}
// en revenant sur l'app (sortie de veille, autre appli) : cloche et pastille à jour
document.addEventListener('visibilitychange', () => !document.hidden && me?.username && refreshBadge());

async function refreshBadge() {
  const badge = document.getElementById('badge');
  if (!badge) return;
  refreshChatDot();
  try {
    const { reviews, proposals, noVideo, invalid } = await fetchNotifs();
    const seen = localStorage.getItem(SEEN_KEY) || '';
    const n = proposals.length + noVideo.length + invalid.length + reviews.filter(r => r.created_at > seen).length;
    badge.textContent = n > 9 ? '9+' : n;
    badge.hidden = !n;
  } catch { /* le badge n'est pas vital */ }
}

async function openNotifs() {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Chargement…'));
  openSheet('Notifications', body);
  try {
    const { reviews, proposals, noVideo, invalid } = await fetchNotifs();
    const seen = localStorage.getItem(SEEN_KEY) || '';
    if (reviews[0]) localStorage.setItem(SEEN_KEY, reviews[0].created_at); // heure serveur, pas l'horloge du tél
    const verb = { ok: 'a validé', ko: "n'a pas validé", comment: 'a commenté' };
    const item = (cls, title, text, onclick, isNew) => h('li', {}, h('button', { class: 'row notif ' + cls + (isNew ? ' new' : ''), onclick },
      h('span', { class: 'grow' }, h('strong', {}, title), text && h('small', { class: 'muted' }, text)), isNew && h('span', { class: 'dot', 'aria-label': 'nouveau' })));
    const decide = (btn, p, accept) => busy(btn, async () => {
      await q(sb.rpc('review_proposal', { proposal_id: p.id, accept }));
      if (accept) moves = await q(sb.from('moves').select('id,name').order('id'));
      await openNotifs(); // avant le toast : le redessin de la fenêtre l'effacerait
      toast(accept ? `${p.name} ajouté à la liste ✅` : 'Proposition refusée.');
    });
    const items = [
      ...proposals.map(p => h('li', { class: 'card proposal' },
        h('strong', {}, `💡 ${p.profiles?.username ?? 'Quelqu’un'} propose : ${p.name}`), h('small', { class: 'muted' }, ago(p.created_at)),
        h('div', { class: 'vote' },
          h('button', { class: 'btn ok', onclick: e => decide(e.currentTarget, p, true) }, 'Accepter'),
          h('button', { class: 'btn', onclick: e => decide(e.currentTarget, p, false) }, 'Refuser')))),
      ...invalid.map(v => item('ko', `${v.move_name} n'est plus valide`, '2 refus : reposte-le avec une nouvelle vidéo.', () => openValidation(v))),
      ...noVideo.map(v => item('warn', `📹 Vidéo demandée : ${v.move_name}`, "Tu l'as validé sans vidéo, ajoute-la pour que la team vérifie.", () => openValidation(v))),
      ...reviews.map(r => item(r.kind, `${r.reviewer_name} ${verb[r.kind]} ton ${r.move_name}`,
        (r.body ? `« ${r.body} » · ` : '') + ago(r.created_at), () => openValidationById(r.validation_id), r.created_at > seen)),
    ];
    body.replaceChildren(items.length ? h('ul', { class: 'list' }, items) : empty('Rien de neuf pour toi.'));
    refreshBadge();
  } catch (e) {
    body.replaceChildren(errorState(e));
  }
}
