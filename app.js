import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm'; // version figée : une mise à jour piégée ne passe pas toute seule
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
// vidéo coupée à 8 s max et réencodée en 720p (≈ 1,5 Mo)
const MAX_CLIP = 8;
const MEDIABUNNY = 'https://cdn.jsdelivr.net/npm/mediabunny@1.66.4/dist/bundles/mediabunny.min.mjs';
const seenKey = () => (dark ? 'pk-seen-dark' : 'pk-seen'); // dernier avis vu dans la cloche, une par compétition
const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

let me = null;        // { id, username }
let moves = [];       // [{ id, name, position, points, demo_path }] dans l'ordre de la liste
let mine = new Map(); // move_id -> ma ligne v_validations
let hidden = new Set(); // id des moves que j'ai cachés de ma liste
let routeToken = 0;
let filter = 'all', search = ''; // gardés entre deux affichages de "Mes moves" (et des profils)
let postFilter = 'all';          // pareil pour "Posts"
let voteFilter = 'open';         // pareil pour "Vote"
// mode dark = la 2e compétition, sur béton (l'app passe en rouge) : mêmes moves, mais posts, avis et classement à part.
// Gardé sur ce téléphone.
let dark = localStorage.getItem('pk-dark') === '1';
function applyDark() {
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#120b0d' : '#0d0f14');
}
applyDark();
const comp = () => (dark ? 'Compétition dark · sur béton' : 'Compétition normale · en salle');

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
  vote: '<path d="M4 13h16v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM7 13V4h10v9M9.5 8.5l2 2 3.5-4"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10M3.5 6l1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
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
const stage = v => (!v || v.invalid ? 'todo' : v.ok_count && !v.ko_count ? 'done' : 'wait'); // un refus passe avant les validations
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
  if (/move_ballots_pkey/.test(m)) return 'Tu as déjà voté.';
  if (/row-level security policy for table "move_ballots"/.test(m)) return 'Ce vote est déjà terminé.';
  if (/row-level security policy for table "move_votes"/.test(m)) return 'Vote impossible : place hors de la liste, ou à plus de 10 places de celle proposée.';
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
  if (v.ko_count) return { key: 'warn', label: 'Potentiellement refusé', mark: '!' }; // un refus passe avant les validations
  if (v.ok_count) return { key: 'ok', label: v.video_path ? 'Validé' : 'Validé sans vidéo', mark: '✓' };
  if (!v.video_path) return { key: 'warn', label: 'Sans vidéo', mark: '◐' };
  return { key: 'wait', label: 'En attente', mark: '◔' };
}

const fmtPoints = p => (p == null ? 'Points : inconnue' : `${(+p).toLocaleString('fr')} point${p >= 2 ? 's' : ''}`);
const MOVE_COLS = 'id,name,position,points,demo_path';
// liens des vidéos du bucket privé, par chemin. Le même lien est resservi 6 jours (il est valable 7) :
// le téléphone garde la vidéo en cache au lieu de la retélécharger, ce qui économise la bande passante gratuite (5 Go/mois)
const URLS = 'pk-urls', DAY = 86400000;
const urlCache = JSON.parse(localStorage.getItem(URLS) || '{}');
async function signedUrls(paths) {
  const now = Date.now(), missing = [...new Set(paths)].filter(p => !(urlCache[p]?.until > now));
  if (missing.length) {
    const fresh = await q(sb.storage.from('videos').createSignedUrls(missing, 7 * DAY / 1000));
    fresh.forEach(s => s.signedUrl && (urlCache[s.path] = { url: s.signedUrl, until: now + 6 * DAY }));
    for (const p in urlCache) if (!(urlCache[p].until > now)) delete urlCache[p]; // la liste ne grossit pas sans fin
    try { localStorage.setItem(URLS, JSON.stringify(urlCache)); } catch { /* stockage plein : le cache reste en mémoire */ }
  }
  return new Map(paths.map(p => [p, urlCache[p]?.url]));
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

// vidéos : lecture auto en boucle, sans son ni boutons ; on touche pour mettre en pause ou relancer.
// Elle ne joue que quand on la voit (fil Posts) ; une vidéo mise en pause le reste.
const onScreen = new IntersectionObserver(entries => entries.forEach(({ target: v, isIntersecting }) => {
  if (!v.isConnected) return onScreen.unobserve(v); // fenêtre fermée ou page changée
  isIntersecting && !v.dataset.paused ? v.play().catch(() => {}) : v.pause();
}), { threshold: 0.6 });
function videoEl(url) {
  const toggle = () => {
    if (v.paused) { delete v.dataset.paused; v.play().catch(() => {}); } else { v.dataset.paused = '1'; v.pause(); }
  };
  // #t=0.1 : montre la 1re image sur iPhone tant qu'elle ne joue pas
  const v = h('video', { src: url + '#t=0.1', muted: true, loop: true, playsinline: true, preload: 'metadata', class: 'video', tabindex: 0,
    'aria-label': 'Vidéo : touche pour mettre en pause ou relancer', onclick: toggle,
    onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } } });
  v.muted = true; // l'attribut seul ne coupe pas le son : sans ça, le téléphone bloque la lecture auto
  onScreen.observe(v);
  return v;
}
const errorState = (e, retry = route) => h('div', { class: 'error', role: 'alert' }, h('p', {}, msg(e)), h('button', { class: 'btn', onclick: () => retry() }, 'Réessayer'));
const skeleton = () => h('div', { 'aria-busy': 'true', 'aria-label': 'Chargement' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skel' })));

function segmented(label, options, current, onPick) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label },
    options.map(([k, text]) => h('button', { type: 'button', 'aria-pressed': String(current === k), onclick: e => {
      el.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      onPick(k);
    } }, text)));
  return el;
}

function moveRow(m, map = mine, onOpen = openMove) {
  const v = map.get(m.id);
  return h('li', {}, h('button', { class: 'row', onclick: () => onOpen(m, v) },
    h('span', { class: 'num' }, m.position),
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
    Object.assign(me, await q(sb.from('profiles').select('username,avatar_path,is_admin').eq('id', user.id).single()));
    const deepLink = /^#(v\/|notifs)/.test(location.hash); // ouvert depuis une notif : elle montre déjà le principal
    shell();
    route().then(() => deepLink || whileAway());
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
const TABS = [['home', 'Accueil', 'home'], ['posts', 'Posts', 'play'], ['vote', 'Vote', 'vote'], ['rank', 'Classement', 'trophy'], ['moves', 'Mes moves', 'list']];

function shell() {
  app.replaceChildren(
    h('header', { class: 'top' },
      h('a', { class: 'brand small', href: '#home' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, 'PK'), 'PK Moves', h('span', { class: 'mode' }, 'DARK')), // visible en mode dark (CSS)
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn dark-btn', 'aria-pressed': String(dark), 'aria-label': 'Mode dark : compétition sur béton', onclick: toggleDark }, icon('moon')),
        h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: openNotifs }, icon('bell'), h('span', { class: 'badge', id: 'badge', hidden: true })),
        h('button', { class: 'icon-btn', 'aria-label': 'Se déconnecter', onclick: () => confirm('Se déconnecter ?') && logout() }, icon('logout')))),
    h('main', { id: 'view', class: 'view' }),
    h('nav', { class: 'tabs', 'aria-label': 'Navigation principale' },
      TABS.map(([id, label, ic]) => h('a', { href: '#' + id, 'data-tab': id }, icon(ic), h('span', {}, label)))));
}

function toggleDark(e) {
  const flip = () => {
    dark = !dark;
    localStorage.setItem('pk-dark', dark ? '1' : '');
    applyDark();
    document.querySelector('.dark-btn').setAttribute('aria-pressed', String(dark));
    route();
    toast(dark ? 'Mode dark : la compétition sur béton 🔴' : 'Mode normal : la compétition en salle');
  };
  if (calm.matches) return flip();
  if (!document.startViewTransition) return flip(), app.animate({ opacity: [0.4, 1] }, 300);
  // le nouveau thème s'ouvre en cercle depuis le bouton lune
  const r = e.currentTarget.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  document.startViewTransition(flip).ready.then(() => document.documentElement.animate(
    { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
    { duration: 450, easing: 'cubic-bezier(.4,0,.2,1)', pseudoElement: '::view-transition-new(root)' })).catch(() => {});
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
  localStorage.removeItem(URLS); // les liens des vidéos ne restent pas sur le téléphone
  for (const p in urlCache) delete urlCache[p];
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
    // relus à chaque fois : un vote adopté ou un move accepté change la liste de tout le monde
    const [list, vals, hid] = await Promise.all([
      q(sb.from('moves').select(MOVE_COLS).order('position')),
      q(sb.from('v_validations').select('*').eq('user_id', me.id).eq('dark', dark)),
      q(sb.from('hidden_moves').select('move_id')),
    ]);
    if (token !== routeToken) return deep?.(); // une autre page (ou l'autre mode) a été demandée entre-temps
    moves = list;
    mine = new Map(vals.map(v => [v.move_id, v]));
    hidden = new Set(hid.map(r => r.move_id));
    deep?.();
    const render = { home, posts: postsView, vote: votesView, rank, moves: movesView, user: () => userView(arg) }[tab] || home;
    const content = await render();
    if (token !== routeToken) return; // l'utilisateur a changé d'onglet entre-temps
    view.querySelectorAll('video').forEach(v => onScreen.unobserve(v)); // les vidéos de l'écran qu'on quitte
    view.replaceChildren(...[content].flat().filter(Boolean));
    enter(view, tab, `${tab}/${arg}/${dark}`);
  } catch (e) {
    if (token === routeToken) view.replaceChildren(errorState(e));
  }
  refreshBadge();
}

// nouvel onglet (ou autre mode) : le contenu arrive du côté de l'onglet touché, vite pour ne pas gêner
const calm = matchMedia('(prefers-reduced-motion: reduce)');
let shown = '', shownIdx = 0;
function enter(view, tab, key) {
  if (key === shown) return; // même écran redessiné (après un vote…) : rien ne bouge
  const idx = TABS.findIndex(([id]) => id === (tab === 'user' ? 'rank' : tab));
  const dir = shown ? Math.sign(idx - shownIdx) : 0;
  shown = key; shownIdx = idx;
  if (calm.matches) return;
  [...view.children].slice(0, 6).forEach((el, i) => el.animate(
    [{ opacity: 0, transform: `translate(${dir * 28}px, ${dir ? 0 : 10}px)` }, { opacity: 1, transform: 'none' }],
    { duration: 220, delay: i * 25, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }));
}

// ───────────── Pendant ton absence ─────────────
// au lancement (et au retour dans l'app) : mes moves validés / refusés et les votes décidés depuis la dernière visite
const SINCE = 'pk-since';
const markSeen = () => me?.username && localStorage.setItem(SINCE, new Date().toISOString());
document.addEventListener('visibilitychange', () => (document.hidden ? markSeen() : whileAway()));

async function whileAway() {
  const since = localStorage.getItem(SINCE);
  if (!me?.username || !since) return markSeen(); // 1re visite : rien à raconter
  const [revs, votes] = await Promise.all([
    q(sb.from('v_reviews').select('validation_id').eq('owner_id', me.id).neq('kind', 'comment').gt('created_at', since)),
    q(sb.from('move_votes').select('move_id,status,new_position,demo_path').neq('status', 'open').gt('decided_at', since)),
  ]).catch(() => [[], []]); // pas de réseau : on réessaiera au prochain retour
  const ids = [...new Set(revs.map(r => r.validation_id))];
  const mineNow = ids.length ? await q(sb.from('v_validations').select('*').in('id', ids)).catch(() => []) : [];
  const name = id => moves.find(m => m.id === id)?.name ?? 'Un move';
  const lines = [
    ...mineNow.filter(v => stage(v) !== 'wait').map(v => { const ok = stage(v) === 'done'; // 'todo' = 2 refus
      return h('li', { class: ok ? 'ok' : 'ko' }, `${ok ? '✅' : '❌'} Ton ${v.move_name}${v.dark ? ' (dark)' : ''} ${ok ? 'est validé' : 'est refusé : reposte-le'}`); }),
    ...votes.map(v => h('li', { class: v.status === 'passed' ? 'ok' : 'ko' }, v.status === 'passed'
      ? `🗳️ ${name(v.move_id)} ${v.demo_path ? 'a une nouvelle vidéo démo' : `passe n° ${v.new_position}`}`
      : `🚫 Vote refusé : ${name(v.move_id)} ${v.demo_path ? '(vidéo démo)' : `n° ${v.new_position}`}`)),
  ];
  if (sheet.open) return; // une fenêtre s'est ouverte entre-temps (lien d'une notif, tuto) : on ne la cache pas
  markSeen();
  if (lines.length) popup('👋', 'Pendant ton absence', '', h('ul', { class: 'away' }, lines),
    h('button', { class: 'btn primary block', onclick: () => sheet.close() }, 'Trop bien'));
}

// ───────────── Onglets ─────────────
async function home() {
  const [lb, todo] = await Promise.all([
    q(sb.from('v_leaderboard').select('*').eq('dark', dark)),
    q(sb.from('v_to_review').select('*').eq('dark', dark).order('created_at', { ascending: false })),
  ]);
  const done = moves.filter(m => isDone(m.id)).length;
  const p = pct(done, moves.length);
  const ranked = sortRank(lb);
  const next = moves.filter(m => !hidden.has(m.id) && stage(mine.get(m.id)) === 'todo').slice(0, 5); // pas encore postés (ou à reposter)
  const noVideo = [...mine.values()].filter(v => !v.video_path && !v.invalid).length;
  const toReview = todo.sort((a, b) => (a.ok_count > 0) - (b.ok_count > 0)); // 0 validation d'abord ; le tri garde les plus récents en premier
  return [
    installCard(),
    pushCard(),
    h('section', { class: 'hero card' }, ring(p), h('div', {},
      h('p', { class: 'muted' }, 'Salut ' + me.username + ' 👋'),
      h('small', { class: 'comp' }, comp()),
      h('h1', {}, `${done} / ${moves.length} moves`),
      h('p', {}, `#${ranked.findIndex(r => r.user_id === me.id) + 1} sur ${ranked.length} dans la team`))),
    noVideo > 0 && h('button', { class: 'card alert', onclick: openNotifs }, icon('video'),
      h('span', {}, `${noVideo} move${noVideo > 1 ? 's' : ''} sans vidéo — ajoute-la pour que la team vérifie`)),
    section('Prochains moves à faire', next.length ? list(next.map(m => moveRow(m))) : empty('Tu as toute la liste. Respect. 🔥')),
    // 10 à la fois : après un avis la page se recharge (refreshValidation) et le suivant remonte
    section(`À valider (${toReview.length})`, toReview.length ? list(toReview.slice(0, 10).map(validationRow)) : empty('Tu as donné ton avis sur tous les posts. 👌')),
  ];
}

const PAGE = 15;
// filtres de "Posts", calculés par la base (comme les statuts de status())
const POST_FILTERS = {
  all: r => r,
  wait: r => r.eq('ok_count', 0).eq('ko_count', 0),
  ok: r => r.gt('ok_count', 0).eq('ko_count', 0),
  ko: r => r.gt('ko_count', 0), // potentiellement refusé ou non valide (un refus passe avant les validations)
};
async function postsView() {
  const feed = h('div', { class: 'feed' });
  const more = h('button', { class: 'btn block', hidden: true, onclick: () => busy(more, load) }, 'Voir plus');
  let from = 0;
  async function load() {
    const rows = await q(POST_FILTERS[postFilter](sb.from('v_validations').select('*').eq('dark', dark)).order('created_at', { ascending: false }).range(from, from + PAGE - 1));
    const { urls, votes } = await postsData(rows);
    if (!from && !rows.length) feed.append(empty(postFilter === 'all' ? "Personne n'a encore posté. Lance-toi !" : 'Aucun post ici.'));
    from += rows.length;
    feed.append(...rows.map(v => postCard(v, urls.get(v.video_path), votes.get(v.id))));
    more.hidden = rows.length < PAGE;
  }
  await load();
  return [h('h1', { class: 'page-title' }, 'Posts'), h('p', { class: 'muted sub' }, `Les derniers moves postés par toute la team · ${comp()}`),
    segmented('Filtrer les posts', [['all', 'Tous'], ['wait', 'Non validés'], ['ok', 'Validés'], ['ko', 'Refusés']], postFilter, k => { postFilter = k; route(); }),
    feed, more];
}

// les liens des vidéos + mes votes (ok/ko) sur ces posts, pour savoir où proposer le vote rapide
async function postsData(rows) {
  const [urls, votes] = await Promise.all([
    signedUrls(rows.map(v => v.video_path).filter(Boolean)),
    rows.length ? q(sb.from('reviews').select('validation_id,kind').eq('reviewer_id', me.id).neq('kind', 'comment').in('validation_id', rows.map(v => v.id))) : [],
  ]);
  return { urls, votes: new Map(votes.map(r => [r.validation_id, r.kind])) };
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

// ───────────── Vote : changer la place d'un move ou sa vidéo démo (4 pour = adopté, 2 contre = refusé) ─────────────
const VOTE_STATUS = { open: { key: 'wait', label: 'En cours', mark: '◔' }, passed: { key: 'ok', label: 'Adopté', mark: '✓' }, refused: { key: 'ko', label: 'Refusé', mark: '✕' } };

async function votesView() {
  // shortcut: les 50 derniers votes de chaque onglet ; ajouter « Voir plus » si l'historique devient long
  const rows = await q(sb.from('move_votes').select('*, profiles!move_votes_user_id_fkey(username,avatar_path), move_ballots(user_id,ok)')
    .eq('status', voteFilter).order('created_at', { ascending: false }).limit(50));
  const urls = await signedUrls(rows.map(v => v.demo_path).filter(Boolean));
  return [h('h1', { class: 'page-title' }, 'Vote'),
    h('p', { class: 'muted sub' }, 'Change la place d’un move dans la liste ou sa vidéo démo · 4 pour = adopté, 2 contre = refusé'),
    h('button', { class: 'btn primary block', onclick: () => newVote() }, '＋ Lancer un vote'),
    segmented('Filtrer les votes', [['open', 'En cours'], ['passed', 'Validés'], ['refused', 'Refusés']], voteFilter, k => { voteFilter = k; route(); }),
    rows.length ? h('div', { class: 'feed' }, rows.map(v => voteCard(v, urls.get(v.demo_path))))
      : empty({ open: 'Aucun vote en cours. Lance le premier !', passed: 'Aucun vote adopté pour l’instant.', refused: 'Aucun vote refusé.' }[voteFilter])];
}

function voteCard(v, url) {
  const m = moves.find(x => x.id === v.move_id) ?? { id: v.move_id, name: 'Move retiré', position: '?' };
  const who = v.profiles?.username ?? '?', own = v.user_id === me.id;
  const yes = v.move_ballots.filter(b => b.ok).length, no = v.move_ballots.length - yes;
  const myBallot = v.move_ballots.find(b => b.user_id === me.id);
  const ballot = (btn, ok) => busy(btn, async () => {
    btn.parentElement.querySelectorAll('button').forEach(b => (b.disabled = true)); // pas de « Pour » puis « Contre » d'affilée
    try { await q(sb.from('move_ballots').insert({ vote_id: v.id, ok })); } catch (e) { route(); throw e; } // vote fini entre-temps : la carte se met à jour
    // mon bulletin a peut-être fait passer le vote (4e pour) ou l'a coulé (2e contre), même si d'autres ont voté depuis l'affichage
    const done = (await q(sb.from('move_votes').select('status').eq('id', v.id).single())).status;
    route();
    if (done === 'passed') popup('🎉', 'Vote adopté !', v.demo_path ? `${m.name} a une nouvelle vidéo démo pour toute la team.` : `${m.name} passe n° ${v.new_position} dans la liste de tout le monde.`);
    else if (done === 'refused') popup('🚫', 'Vote refusé', `2 contre : ${m.name} ne change pas.`);
    else toast(ok ? 'Tu as voté pour ✓' : 'Tu as voté contre ✕');
  });
  return h('article', { class: 'post' },
    h('div', { class: 'post-head' }, avatar(who, v.profiles?.avatar_path),
      h('span', { class: 'grow' }, h('strong', {}, own ? 'Toi' : who), h('small', { class: 'muted' }, (v.parent_id ? 'Contre-proposition · ' : '') + ago(v.created_at))),
      chip(VOTE_STATUS[v.status])),
    v.demo_path
      ? [h('h2', { class: 'post-move' }, `🎬 Vidéo démo : ${m.name}`), url ? videoEl(url) : h('div', { class: 'novideo' }, icon('video'), h('span', {}, 'Vidéo introuvable'))]
      : h('div', { class: 'post-move' }, h('h2', {}, `↕️ ${m.name} → n° ${v.new_position}`),
        v.status === 'open' && h('small', { class: 'muted' }, `aujourd'hui n° ${m.position}`)),
    v.reason && h('p', { class: 'reason' }, '« ' + v.reason + ' »'),
    h('div', { class: 'post-foot' }, h('span', { class: 'ok' }, `✓ ${yes} / 4`), h('span', { class: 'ko' }, `✕ ${no} / 2`), h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, myBallot ? (myBallot.ok ? '✓ Tu as voté pour' : '✕ Tu as voté contre') : own && v.status === 'open' ? 'Les autres votent' : '')),
    v.status === 'open' && !own && !myBallot && h('div', { class: 'quick stack' },
      h('div', { class: 'vote' },
        h('button', { class: 'btn ok', onclick: e => ballot(e.currentTarget, true) }, '✓ Pour'),
        h('button', { class: 'btn ko', onclick: e => ballot(e.currentTarget, false) }, '✕ Contre')),
      !v.demo_path && h('button', { class: 'btn ghost block', onclick: () => counterVote(v, m) }, '↕️ Proposer une autre place')),
    v.status === 'refused' && h('div', { class: 'quick' }, h('button', { class: 'btn block', onclick: () => newVote(v) },
      '↻ Reproposer')));
}

// nouveau vote ; pre = un vote refusé à reproposer (pareil, ou en changeant la place / la vidéo)
function newVote(pre = {}) {
  let kind = pre.demo_path ? 'demo' : 'place';
  const moveSel = h('select', { 'aria-label': 'Move' }, h('option', { value: '' }, 'Choisis un move…'),
    moves.map(m => h('option', { value: m.id, selected: m.id === pre.move_id }, `n° ${m.position} · ${m.name}`)));
  const pos = h('input', { type: 'number', min: 1, max: moves.length, inputmode: 'numeric', value: pre.new_position ?? '' });
  const reason = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Ex. : plus facile que le move d’avant' }, pre.reason ?? '');
  const picker = videoPicker(pre.demo_path ? 'Choisir une autre vidéo (sinon la même)' : 'Choisir ou filmer la vidéo démo');
  const placeBox = h('label', { class: 'field' }, h('span', {}, 'Nouvelle place (n°)'), pos);
  const show = () => { placeBox.hidden = pos.disabled = kind !== 'place'; picker.el.hidden = kind !== 'demo'; }; // désactivé = pas vérifié par le navigateur
  const label = pre.move_id ? 'Reproposer' : 'Lancer le vote';
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, label);
  const save = e => {
    e.preventDefault();
    busy(btn, async () => {
      const m = moves.find(x => x.id === +moveSel.value);
      if (!m) throw new Error('Choisis un move.');
      const row = { move_id: m.id, reason: reason.value.trim() };
      if (kind === 'place') {
        row.new_position = Math.round(+pos.value);
        if (!(row.new_position >= 1 && row.new_position <= moves.length)) throw new Error(`Choisis une place entre 1 et ${moves.length}.`);
        if (row.new_position === m.position) throw new Error(`${m.name} est déjà n° ${m.position}.`);
      } else {
        const file = picker.file();
        if (!file && !pre.demo_path) throw new Error('Choisis la vidéo démo.');
        row.demo_path = file ? await uploadVideo(file, 'demo', picker.range(), p => (btn.textContent = `Compression… ${Math.round(p * 100)} %`)) : pre.demo_path;
      }
      await q(sb.from('move_votes').insert(row));
      voteFilter = 'open';
      location.hash === '#vote' ? (scrollTo(0, 0), route()) : (location.hash = '#vote'); // son vote apparaît en haut
      popup('🗳️', 'Vote lancé !', `La team vote pour ${kind === 'place' ? `mettre ${m.name} n° ${row.new_position}` : `la vidéo démo de ${m.name}`}. 4 pour = adopté, 2 contre = refusé.`);
    }).finally(() => (btn.textContent = label));
  };
  openSheet(pre.move_id ? 'Reproposer le vote' : 'Lancer un vote', h('form', { class: 'stack', onsubmit: save },
    segmented('Type de vote', [['place', '↕️ Changer sa place'], ['demo', '🎬 Vidéo démo']], kind, k => { kind = k; show(); }),
    h('label', { class: 'field' }, h('span', {}, 'Move'), moveSel),
    placeBox, picker.el,
    h('label', { class: 'field' }, h('span', {}, 'Pourquoi ? (facultatif)'), reason),
    h('p', { class: 'hint' }, '4 pour = adopté pour toute la team · 2 contre = refusé'),
    btn));
  show();
}

// « Autre place » : une contre-proposition à 10 places max de celle proposée, votée à part
function counterVote(v, m) {
  const lo = Math.max(1, v.new_position - 10), hi = Math.min(moves.length, v.new_position + 10);
  const save = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const p = Math.round(+e.target.pos.value);
      if (p === v.new_position) throw new Error('Choisis une autre place que celle proposée.');
      await q(sb.from('move_votes').insert({ move_id: v.move_id, new_position: p, parent_id: v.id, reason: e.target.reason.value.trim() }));
      route();
      popup('🗳️', 'Contre-proposition lancée !', `${m.name} n° ${p} : la team vote à part. 4 pour = adopté, 2 contre = refusé.`);
    });
  };
  openSheet(`Autre place : ${m.name}`, h('form', { class: 'stack', onsubmit: save },
    h('p', { class: 'muted' }, `Proposé : n° ${v.new_position} (aujourd'hui n° ${m.position}). Tu peux proposer de n° ${lo} à n° ${hi}.`),
    h('label', { class: 'field' }, h('span', {}, 'Ta place (n°)'), h('input', { name: 'pos', type: 'number', min: lo, max: hi, required: true, inputmode: 'numeric' })),
    h('label', { class: 'field' }, h('span', {}, 'Pourquoi ? (facultatif)'), h('textarea', { name: 'reason', rows: 2, maxlength: 500 })),
    h('p', { class: 'hint' }, 'Elle est votée à part, comme un nouveau vote.'),
    h('button', { class: 'btn primary block', type: 'submit' }, 'Lancer la contre-proposition')));
}

async function rank() {
  const [lb, todo] = await Promise.all([q(sb.from('v_leaderboard').select('*').eq('dark', dark)),
    q(sb.from('v_validations').select('user_id').eq('dark', dark).eq('ok_count', 0).eq('ko_count', 0).neq('user_id', me.id))]);
  const waiting = new Set(todo.map(v => v.user_id)); // pastille rouge : il a un move que personne n'a encore validé ni refusé
  return [h('h1', { class: 'page-title' }, 'Classement'), h('p', { class: 'muted sub' }, `${comp()} · % de la liste validée · touche quelqu'un pour voir son profil`),
    h('ol', { class: 'list rank' }, sortRank(lb).map((r, i) => memberRow(r, i, waiting.has(r.user_id))))];
}

// les moves de la liste avec recherche et filtres, pour moi (map = mine) ou pour un autre ; skip = moves cachés
function movesList(map, onOpen, skip = new Set()) {
  const listEl = h('ul', { class: 'list' });
  const draw = () => {
    const s = search.trim().toLowerCase();
    const items = moves.filter(m => !skip.has(m.id) && (filter === 'all' || stage(map.get(m.id)) === filter) && m.name.toLowerCase().includes(s));
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
    ...movesList(mine, openMove, hidden),
    hidden.size > 0 && h('button', { class: 'btn ghost block propose', onclick: openHidden }, `🙈 Moves cachés (${hidden.size})`),
    h('button', { class: 'btn ghost block', onclick: proposeMove }, '💡 Proposer un move')];
}

// cacher un move de ma liste (et de « Prochains moves ») ; le classement ne change pas
function hideBtn(m) {
  const on = hidden.has(m.id);
  return h('button', { class: 'btn ghost block', onclick: e => busy(e.currentTarget, async () => {
    await q(on ? sb.from('hidden_moves').delete().eq('move_id', m.id) : sb.from('hidden_moves').insert({ move_id: m.id }));
    sheet.close();
    toast(on ? `${m.name} est de retour dans ta liste 👁️` : `${m.name} caché. Retrouve-le en bas de « Mes moves ».`);
    route();
  }) }, on ? '👁️ Remettre dans ma liste' : '🙈 Cacher de ma liste');
}

function openHidden() {
  openSheet('Moves cachés', h('div', { class: 'stack' },
    h('p', { class: 'hint' }, 'Touche un move pour le voir ou le remettre dans ta liste.'),
    list(moves.filter(m => hidden.has(m.id)).map(m => moveRow(m)))));
}

function proposeMove() {
  const picker = videoPicker('Ajouter une vidéo démo (facultatif)');
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, 'Envoyer');
  const save = e => {
    e.preventDefault();
    const f = e.target;
    busy(btn, async () => {
      const file = picker.file();
      const demo_path = file ? await uploadVideo(file, 'demo', picker.range(), p => (btn.textContent = `Compression… ${Math.round(p * 100)} %`)) : null;
      await q(sb.from('move_proposals').insert({ name: f.name.value.trim(), points: f.points.value === '' ? null : +f.points.value, demo_path }));
      popup('📨', 'Demande envoyée !', `L'admin a bien reçu « ${f.name.value.trim()} ». S'il l'accepte, il arrive dans la liste et toute la team est prévenue.`);
    }).finally(() => (btn.textContent = 'Envoyer'));
  };
  openSheet('Proposer un move', h('form', { class: 'stack', onsubmit: save },
    h('label', { class: 'field' }, h('span', {}, 'Nom du move'), h('input', { name: 'name', required: true, minlength: 2, maxlength: 60 })),
    h('label', { class: 'field' }, h('span', {}, 'Points (facultatif)'),
      h('input', { name: 'points', type: 'number', min: 0, max: 99, step: 0.1, inputmode: 'decimal', placeholder: 'Vide = inconnue' })),
    picker.el,
    h('p', { class: 'hint' }, "L'admin l'ajoute en bas de la liste s'il l'accepte ; un vote peut ensuite le déplacer."),
    btn));
}

async function userView(id) {
  const [[p], vals] = await Promise.all([
    q(sb.from('v_leaderboard').select('*').eq('user_id', id).eq('dark', dark)),
    q(sb.from('v_validations').select('*').eq('user_id', id).eq('dark', dark)),
  ]);
  if (!p) return empty('Membre introuvable.');
  const own = id === me.id, pc = pct(p.done, p.total);
  const openTheirs = (m, v) => (v ? openValidation(v) : openSheet(m.name, h('div', { class: 'stack' }, moveInfo(m, true), empty(`${p.username} ne l'a pas encore posté.`), videosBtn(m))));
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
    ...movesList(new Map(vals.map(v => [v.move_id, v])), own ? openMove : openTheirs, own ? hidden : undefined)];
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
  sheet.classList.remove('pop');
  sheet.replaceChildren(
    h('div', { class: 'sheet-head' }, h('h2', { id: 'sheet-title' }, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => sheet.close() }, icon('x'))),
    h('div', { class: 'sheet-body' }, ...content));
  if (!sheet.open) sheet.showModal();
}
sheet.addEventListener('click', e => e.target === sheet && sheet.close()); // clic à côté = fermer
sheet.addEventListener('close', () => !sheet.open && sheet.replaceChildren()); // coupe la vidéo

// pop-up au centre pour les moments importants (move validé, demande envoyée, vote…), avec des confettis
function popup(emoji, title, text, ...actions) {
  if (sheet.open) sheet.close();
  sheet.classList.add('pop');
  sheet.replaceChildren(h('div', { class: 'pop-body' },
    h('div', { class: 'pop-emoji', 'aria-hidden': 'true' }, emoji),
    h('h2', { id: 'sheet-title' }, title),
    text && h('p', { class: 'muted' }, text),
    ...(actions.length ? actions : [h('button', { class: 'btn primary block', onclick: () => sheet.close() }, 'OK')])));
  sheet.showModal(); // rouverte : l'animation repart
  if (calm.matches) return;
  const colors = ['var(--accent)', 'var(--ok)', 'var(--warn)', '#fff'];
  const burst = h('div', { class: 'confetti', 'aria-hidden': 'true' }, Array.from({ length: 22 }, (_, i) => h('i', {
    style: `left:${35 + Math.random() * 30}%;--x:${Math.round((Math.random() - 0.5) * 300)}px;--r:${Math.round(Math.random() * 720 - 360)}deg;--d:${(Math.random() * 0.2).toFixed(2)}s;background:${colors[i % 4]}` })));
  sheet.append(burst);
  setTimeout(() => burst.remove(), 1500);
}

function openMove(m) {
  const v = mine.get(m.id);
  if (v) return openValidation(v);
  openSheet(m.name, h('div', { class: 'stack' }, moveInfo(m, true), videosBtn(m), uploadForm(m, null), hideBtn(m)));
}

// place, points et vidéo démo d'un move (démo ouverte d'office si on n'a pas encore d'autre vidéo à regarder)
function moveInfo(m, openDemo) {
  const demo = m.demo_path && h('details', { class: 'demo', open: openDemo }, h('summary', {}, '🎬 Vidéo démo'));
  if (demo) signedUrls([m.demo_path]).then(u => demo.append(videoEl(u.get(m.demo_path))), () => demo.remove());
  return [h('div', { class: 'meta' }, h('span', { class: 'chip' }, `n° ${m.position}`), h('span', { class: 'chip points' }, '⭐ ' + fmtPoints(m.points))), demo];
}

// « Voir (N) » : les vidéos de ce move postées par toute la team
const moveVideos = (m, d = dark) => q(sb.from('v_validations').select('*').eq('move_id', m.id).eq('dark', d).not('video_path', 'is', null).order('created_at', { ascending: false }));
function videosBtn(m, d = dark) { // d : compétition (un post ouvert depuis une notif peut être de l'autre mode)
  const btn = h('button', { class: 'btn block', disabled: true }, '👀 Voir les vidéos…');
  moveVideos(m, d).then(rows => {
    btn.textContent = rows.length ? `👀 Voir (${rows.length} ${rows.length > 1 ? 'personnes ont' : 'personne a'} posté une vidéo)` : 'Personne n’a encore posté de vidéo de ce move';
    btn.disabled = !rows.length;
    btn.addEventListener('click', () => busy(btn, () => openMoveVideos(m, rows, d)));
  }, () => btn.remove());
  return btn;
}

async function openMoveVideos(m, rows, d = dark) {
  rows ??= await moveVideos(m, d);
  const { urls, votes } = await postsData(rows);
  openSheet(m.name, rows.length
    ? h('div', { class: 'feed' }, rows.map(v => postCard(v, urls.get(v.video_path), votes.get(v.id), () => openMoveVideos(m, null, d))))
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
  const m = moves.find(x => x.id === v.move_id) ?? { id: v.move_id, name: v.move_name, position: '?' };
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  openSheet(v.move_name, body);
  try {
    const [reviews, url] = await Promise.all([
      q(sb.from('v_reviews').select('*').eq('validation_id', v.id).order('created_at')),
      v.video_path ? signedUrls([v.video_path]).then(u => u.get(v.video_path)).catch(() => null) : null,
    ]);
    const myVote = reviews.find(r => r.reviewer_id === me.id && r.kind !== 'comment');
    body.replaceChildren(...[ // filter : les blocs absents (false) ne doivent pas s'afficher en texte
      h('div', { class: 'meta' }, chip(status(v)), h('span', { class: 'muted' }, `posté par ${own ? 'toi' : v.username} · ${ago(v.created_at)}`)),
      url ? videoEl(url)
        : h('div', { class: 'novideo' }, icon('video'), h('span', {}, own ? 'Pas encore de vidéo.' : `Pas encore de vidéo, elle est demandée à ${v.username}.`)),
      ...moveInfo(m, false),
      videosBtn(m, v.dark),
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
      own && hideBtn(m),
    ].filter(Boolean));
  } catch (e) {
    body.replaceChildren(errorState(e, () => openValidation(v)));
  }
}

// choisir une vidéo et le passage à garder (8 s max) ; sert pour valider un move et pour les vidéos démo
function videoPicker(text = 'Choisir ou filmer une vidéo') {
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
  return { el: h('div', { class: 'stack' }, h('label', { class: 'drop' }, icon('video'), h('strong', {}, text), picked, input), preview, trimBox),
    file: () => input.files[0], range };
}

function uploadForm(m, v) {
  // v absent : première validation ; v sans vidéo : on ajoute la vidéo ; v non valide : on reposte (les refus repartent à 0)
  const addOnly = v && !v.invalid;
  const picker = videoPicker();
  const label = addOnly ? 'Envoyer la vidéo' : v ? 'Reposter avec une nouvelle vidéo' : 'Poster ma validation';
  const btn = h('button', { class: 'btn primary block', onclick: () => busy(btn, async () => {
    const file = picker.file();
    if (!file && addOnly) return toast('Choisis une vidéo.', true);
    if (!file && !confirm('Valider sans vidéo ? Elle te sera demandée dans les notifications.')) return;
    const path = file ? await uploadVideo(file, m.id, picker.range(), p => (btn.textContent = `Compression… ${Math.round(p * 100)} %`)) : null;
    let id = v?.id;
    if (addOnly) {
      await q(sb.from('validations').update({ video_path: path }).eq('id', v.id));
    } else {
      if (v) await removeValidation(v);
      // un repost garde la compétition du move (même ouvert depuis une notif de l'autre mode)
      id = (await q(sb.from('validations').insert({ move_id: m.id, video_path: path, dark: v ? v.dark : dark }).select('id').single())).id;
    }
    route();
    // pop-up de bravo, puis on arrive sur le post
    const go = h('button', { class: 'btn primary block go', onclick: () => openValidationById(id) }, 'Voir mon post');
    popup(addOnly ? '📹' : '🔥', addOnly ? 'Vidéo ajoutée !' : 'Move validé !',
      path ? `${m.name} est posté : la team va donner son avis.` : `${m.name} est posté. Ajoute la vidéo dès que tu peux : elle t'est demandée dans les notifs.`, go);
    setTimeout(() => go.isConnected && go.click(), 2200); // sauf si la pop-up a été fermée entre-temps
  }).finally(() => (btn.textContent = label)) }, label);
  return h('div', { class: 'stack' },
    v?.invalid && h('p', { class: 'warnbox' }, "Ce move n'est plus valide (2 refus). Reposte-le avec une nouvelle vidéo."),
    picker.el,
    btn,
    !addOnly && h('p', { class: 'hint' }, "Pas de vidéo sous la main ? Poste quand même, elle te sera demandée dans les notifications."));
}

// coupe le passage et le réencode en 720p, directement sur le téléphone (rien n'est envoyé avant)
async function compress(file, [start, end], onProgress) {
  const mb = await import(MEDIABUNNY); // chargé seulement au moment de poster une vidéo
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target: new mb.BufferTarget() });
  const conv = await mb.Conversion.init({
    input: new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS }),
    output,
    trim: { start, end },
    video: async t => {
      const w = await t.getDisplayWidth(), hgt = await t.getDisplayHeight();
      const side = Math.min(720, w, hgt) & ~1; // petit côté à 720 px (pair pour l'encodeur)
      return { codec: 'avc', [w > hgt ? 'height' : 'width']: side, frameRate: 30, quality: new mb.Quality({ bitrate: 1_500_000 }) };
    },
    audio: { codec: 'aac', quality: new mb.Quality({ bitrate: 48_000 }) }, // son retiré si le téléphone ne sait pas l'encoder
    showWarnings: false,
  });
  if (!conv.utilizedTracks.some(t => t.isVideoTrack())) throw new Error("Ton téléphone n'arrive pas à compresser cette vidéo : mets à jour ton navigateur.");
  conv.onProgress = onProgress;
  await conv.execute();
  return new Blob([output.target.buffer], { type: 'video/mp4' });
}

async function uploadVideo(file, name, range, onProgress) { // name : id du move, ou 'demo'
  const small = await compress(file, range, onProgress);
  const path = `${me.id}/${name}-${Date.now()}.mp4`;
  // chemin unique, vidéo jamais modifiée : le téléphone peut la garder en cache 1 an
  await q(sb.storage.from('videos').upload(path, small, { contentType: 'video/mp4', cacheControl: '31536000' }));
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
  const reviews = await q(sb.from('v_reviews').select('*').eq('owner_id', me.id).eq('dark', dark).neq('reviewer_id', me.id)
    .order('created_at', { ascending: false }).limit(30));
  const proposals = me.is_admin ? await q(sb.from('move_proposals').select('id,name,points,demo_path,created_at,profiles(username)').order('created_at')) : [];
  const mineList = [...mine.values()];
  return { reviews, proposals, noVideo: mineList.filter(v => !v.video_path && !v.invalid), invalid: mineList.filter(v => v.invalid) };
}

// pastille rouge sur l'onglet Vote : un vote en cours des autres où je n'ai pas encore voté
async function refreshVoteDot() {
  const tab = document.querySelector('.tabs a[data-tab="vote"]');
  const open = await q(sb.from('move_votes').select('id,move_ballots(user_id)').eq('status', 'open').neq('user_id', me.id)).catch(() => []);
  const todo = open.some(v => !v.move_ballots.some(b => b.user_id === me.id));
  tab?.classList.toggle('unread', todo);
  tab?.setAttribute('aria-label', todo ? 'Vote (des votes t’attendent)' : 'Vote');
}
// en revenant sur l'app (sortie de veille, autre appli) : cloche et pastille à jour
document.addEventListener('visibilitychange', () => !document.hidden && me?.username && refreshBadge());

async function refreshBadge() {
  const badge = document.getElementById('badge');
  if (!badge) return;
  refreshVoteDot();
  try {
    const { reviews, proposals, noVideo, invalid } = await fetchNotifs();
    const seen = localStorage.getItem(seenKey()) || '';
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
    const seen = localStorage.getItem(seenKey()) || '';
    if (reviews[0]) localStorage.setItem(seenKey(), reviews[0].created_at); // heure serveur, pas l'horloge du tél
    const verb = { ok: 'a validé', ko: "n'a pas validé", comment: 'a commenté' };
    const item = (cls, title, text, onclick, isNew) => h('li', {}, h('button', { class: 'row notif ' + cls + (isNew ? ' new' : ''), onclick },
      h('span', { class: 'grow' }, h('strong', {}, title), text && h('small', { class: 'muted' }, text)), isNew && h('span', { class: 'dot', 'aria-label': 'nouveau' })));
    const items = [
      ...proposals.map(p => item('proposal', `💡 ${p.profiles?.username ?? 'Quelqu’un'} propose : ${p.name}`,
        `${ago(p.created_at)} · touche pour tout voir et décider`, () => openProposal(p), true)),
      ...invalid.map(v => item('ko', `${v.move_name} n'est plus valide`, '2 refus : reposte-le avec une nouvelle vidéo.', () => openValidation(v))),
      ...noVideo.map(v => item('warn', `📹 Vidéo demandée : ${v.move_name}`, "Tu l'as validé sans vidéo, ajoute-la pour que la team vérifie.", () => openValidation(v))),
      ...reviews.map(r => item(r.kind, `${r.reviewer_name} ${verb[r.kind]} ton ${r.move_name}`,
        (r.body ? `« ${r.body} » · ` : '') + ago(r.created_at), () => openValidationById(r.validation_id), r.created_at > seen)),
    ];
    body.replaceChildren(items.length ? h('ul', { class: 'list' }, items) : empty('Rien de neuf pour toi.'));
    refreshBadge();
  } catch (e) {
    body.replaceChildren(errorState(e, openNotifs));
  }
}

// l'admin voit tout d'un move proposé (points, vidéo démo) avant d'accepter ou refuser
async function openProposal(p) {
  const who = p.profiles?.username ?? 'quelqu’un';
  const decide = (btn, accept) => busy(btn, async () => {
    await q(sb.rpc('review_proposal', { proposal_id: p.id, accept }));
    if (!accept && p.demo_path) await sb.storage.from('videos').remove([p.demo_path]); // au pire un fichier orphelin
    await openNotifs(); // avant le toast : le redessin de la fenêtre l'effacerait
    toast(accept ? `${p.name} ajouté en bas de la liste ✅` : 'Proposition refusée.');
    route();
  });
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Chargement…'));
  openSheet(`💡 ${p.name}`, body);
  try {
    const url = p.demo_path && (await signedUrls([p.demo_path])).get(p.demo_path);
    body.replaceChildren(
      h('div', { class: 'meta' }, h('span', { class: 'chip points' }, '⭐ ' + fmtPoints(p.points)), h('span', { class: 'muted' }, `proposé par ${who} · ${ago(p.created_at)}`)),
      url ? videoEl(url) : h('div', { class: 'novideo' }, icon('video'), h('span', {}, 'Pas de vidéo démo')),
      h('p', { class: 'hint' }, `Accepté, il arrive en bas de la liste (n° ${moves.length + 1}) ; un vote de la team peut ensuite le déplacer.`),
      h('div', { class: 'vote' },
        h('button', { class: 'btn ok', onclick: e => decide(e.currentTarget, true) }, '✓ Accepter'),
        h('button', { class: 'btn ko', onclick: e => decide(e.currentTarget, false) }, '✕ Refuser')),
      h('button', { class: 'btn ghost block', onclick: openNotifs }, '← Retour aux notifications'));
  } catch (e) {
    body.replaceChildren(errorState(e, () => openProposal(p)));
  }
}
