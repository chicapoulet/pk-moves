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
let filter = 'all', search = ''; // gardés entre deux affichages de "Mes moves"

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
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
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
const isDone = id => mine.has(id) && !mine.get(id).invalid && mine.get(id).ok_count > 0; // comme le classement : validé par au moins 1 autre
const sortRank = rows => [...rows].sort((a, b) => b.done - a.done || a.username.localeCompare(b.username));

async function q(request) {
  const { data, error } = await request;
  if (error) throw error;
  return data;
}

function msg(e) {
  const m = e?.message || String(e);
  if (/Invalid login/i.test(m)) return 'Nom ou mot de passe incorrect.';
  if (/already (been )?registered|Database error (saving new|updating) user/i.test(m)) return 'Ce nom est déjà pris.';
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
  if (v.invalid) return { key: 'ko', label: 'Dévalidé', mark: '✕' };
  if (!v.video_path) return { key: 'warn', label: 'Sans vidéo', mark: '◐' };
  if (!v.ok_count) return { key: 'wait', label: 'En attente', mark: '◔' };
  return { key: 'ok', label: 'Validé', mark: '✓' };
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

function moveRow(m) {
  const v = mine.get(m.id);
  return h('li', {}, h('button', { class: 'row', onclick: () => openMove(m) },
    h('span', { class: 'num' }, m.id),
    h('span', { class: 'grow' }, m.name),
    v && chip(status(v))));
}

function validationRow(v, showUser) {
  return h('li', {}, h('button', { class: 'row', onclick: () => openValidation(v) },
    showUser && avatar(v.username, v.avatar_path),
    h('span', { class: 'grow' }, h('strong', {}, v.move_name),
      h('small', { class: 'muted' }, (showUser ? v.username + ' · ' : '') + ago(v.created_at) + (v.video_path ? ' · 📹' : ''))),
    chip(status(v))));
}

function memberRow(r, pos) {
  const p = pct(r.done, r.total);
  return h('li', { class: r.user_id === me.id ? 'me' : '' }, h('a', { class: 'row', href: '#user/' + r.user_id },
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
      q(sb.from('profiles').select('username,avatar_path').eq('id', user.id).single()),
      q(sb.from('moves').select('id,name').order('id')),
    ]);
    Object.assign(me, profile);
    moves = list;
    shell();
    route();
    maybeInstallTuto();
  } catch (e) {
    me = null;
    app.replaceChildren(h('main', { class: 'auth' }, h('div', { class: 'auth-card' }, h('p', {}, msg(e)),
      h('button', { class: 'btn primary block', onclick: () => location.reload() }, 'Réessayer'),
      h('button', { class: 'btn ghost block', onclick: () => sb.auth.signOut() }, 'Se déconnecter'))));
  }
}

// ───────────── Squelette + navigation ─────────────
const TABS = [['home', 'Accueil', 'home'], ['posts', 'Posts', 'play'], ['team', 'Team', 'users'], ['rank', 'Classement', 'trophy'], ['moves', 'Mes moves', 'list']];

function shell() {
  app.replaceChildren(
    h('header', { class: 'top' },
      h('a', { class: 'brand small', href: '#home' }, h('span', { class: 'logo', 'aria-hidden': 'true' }, 'PK'), 'PK Moves'),
      h('div', { class: 'top-actions' },
        h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: openNotifs }, icon('bell'), h('span', { class: 'badge', id: 'badge', hidden: true })),
        h('button', { class: 'icon-btn', 'aria-label': 'Se déconnecter', onclick: () => confirm('Se déconnecter ?') && sb.auth.signOut() }, icon('logout')))),
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

function installCard() {
  if (installed() || localStorage.getItem(HIDE_INSTALL)) return null;
  return h('button', { class: 'card install', onclick: () => installTuto() }, icon('download'),
    h('span', { class: 'grow' }, h('strong', {}, "Installe l'app sur ton tél"), h('small', { class: 'muted' }, 'Voir comment faire (30 secondes)')));
}

async function route() {
  const token = ++routeToken;
  const [tab, arg] = (location.hash.slice(1) || 'home').split('/');
  const view = document.getElementById('view');
  document.querySelectorAll('.tabs a').forEach(a =>
    a.dataset.tab === (tab === 'user' ? 'team' : tab) ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if (!view.childElementCount) view.replaceChildren(skeleton());
  try {
    mine = new Map((await q(sb.from('v_validations').select('*').eq('user_id', me.id))).map(v => [v.move_id, v]));
    const render = { home, posts: postsView, team, rank, moves: movesView, user: () => userView(arg) }[tab] || home;
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
  const [lb, recent] = await Promise.all([
    q(sb.from('v_leaderboard').select('*')),
    q(sb.from('v_validations').select('*').neq('user_id', me.id).eq('invalid', false).order('created_at', { ascending: false }).limit(40)),
  ]);
  const votes = recent.length ? await q(sb.from('reviews').select('validation_id').eq('reviewer_id', me.id).neq('kind', 'comment').in('validation_id', recent.map(v => v.id))) : [];
  const voted = new Set(votes.map(r => r.validation_id));
  const done = moves.filter(m => isDone(m.id)).length;
  const p = pct(done, moves.length);
  const ranked = sortRank(lb);
  const next = moves.filter(m => !mine.has(m.id) || mine.get(m.id).invalid).slice(0, 5); // pas encore postés
  const noVideo = [...mine.values()].filter(v => !v.video_path && !v.invalid).length;
  const toReview = recent.filter(v => !voted.has(v.id)).slice(0, 8);
  return [
    installCard(),
    h('section', { class: 'hero card' }, ring(p), h('div', {},
      h('p', { class: 'muted' }, 'Salut ' + me.username + ' 👋'),
      h('h1', {}, `${done} / ${moves.length} moves`),
      h('p', {}, `#${ranked.findIndex(r => r.user_id === me.id) + 1} sur ${ranked.length} dans la team`))),
    noVideo > 0 && h('button', { class: 'card alert', onclick: openNotifs }, icon('video'),
      h('span', {}, `${noVideo} move${noVideo > 1 ? 's' : ''} sans vidéo — ajoute-la pour que la team vérifie`)),
    section('Prochains moves à valider', next.length ? list(next.map(moveRow)) : empty('Tu as toute la liste. Respect. 🔥')),
    section('À vérifier dans la team', toReview.length ? list(toReview.map(v => validationRow(v, true))) : empty("Rien à vérifier pour l'instant.")),
  ];
}

const PAGE = 15;
async function postsView() {
  const feed = h('div', { class: 'feed' });
  const more = h('button', { class: 'btn block', hidden: true, onclick: () => busy(more, load) }, 'Voir plus');
  let from = 0;
  async function load() {
    const rows = await q(sb.from('v_validations').select('*').order('created_at', { ascending: false }).range(from, from + PAGE - 1));
    const paths = rows.map(v => v.video_path).filter(Boolean);
    const signed = paths.length ? await q(sb.storage.from('videos').createSignedUrls(paths, 3600)) : [];
    const urls = new Map(signed.map(s => [s.path, s.signedUrl]));
    if (!from && !rows.length) feed.append(empty("Personne n'a encore posté. Lance-toi !"));
    from += rows.length;
    feed.append(...rows.map(v => postCard(v, urls.get(v.video_path))));
    more.hidden = rows.length < PAGE;
  }
  await load();
  return [h('h1', { class: 'page-title' }, 'Posts'), h('p', { class: 'muted sub' }, 'Les derniers moves postés par toute la team'), feed, more];
}

function postCard(v, url) {
  const own = v.user_id === me.id;
  const open = () => openValidation(v);
  return h('article', { class: 'post' },
    h('button', { class: 'post-head', onclick: open }, avatar(v.username, v.avatar_path),
      h('span', { class: 'grow' }, h('strong', {}, own ? 'Toi' : v.username), h('small', { class: 'muted' }, ago(v.created_at))),
      chip(status(v))),
    h('h2', { class: 'post-move' }, v.move_name),
    url ? videoEl(url) : h('div', { class: 'novideo' }, icon('video'), h('span', {}, 'Pas encore de vidéo')),
    h('button', { class: 'post-foot', onclick: open },
      h('span', { class: 'ok' }, `✓ ${v.ok_count}`), h('span', { class: 'ko' }, `✕ ${v.ko_count}`),
      h('span', { class: 'grow' }), h('span', { class: 'muted' }, own ? 'Voir les avis →' : 'Donner mon avis →')));
}

async function team() {
  const lb = await q(sb.from('v_leaderboard').select('*').order('username'));
  return [h('h1', { class: 'page-title' }, 'Team'), h('p', { class: 'muted sub' }, `${lb.length} membre${lb.length > 1 ? 's' : ''} · touche quelqu'un pour voir ses moves`),
    list(lb.map(r => memberRow(r)))];
}

async function rank() {
  const lb = sortRank(await q(sb.from('v_leaderboard').select('*')));
  return [h('h1', { class: 'page-title' }, 'Classement'), h('p', { class: 'muted sub' }, '% de la liste validée'),
    h('ol', { class: 'list rank' }, lb.map(memberRow))];
}

function movesView() {
  const listEl = h('ul', { class: 'list' });
  const draw = () => {
    const s = search.trim().toLowerCase();
    const items = moves.filter(m => (filter === 'all' || (filter === 'done') === isDone(m.id)) && m.name.toLowerCase().includes(s));
    listEl.replaceChildren(...(items.length ? items.map(moveRow) : [h('li', {}, empty('Aucun move ne correspond.'))]));
  };
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Filtrer les moves' },
    [['all', 'Tous'], ['todo', 'À faire'], ['done', 'Validés']].map(([k, label]) =>
      h('button', { 'aria-pressed': String(filter === k), onclick: e => {
        filter = k;
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
        draw();
      } }, label)));
  draw();
  return [h('h1', { class: 'page-title' }, 'Mes moves'),
    h('p', { class: 'muted sub' }, `${moves.filter(m => isDone(m.id)).length} validés sur ${moves.length} · touche un move pour le valider`),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: 'Chercher un move…', 'aria-label': 'Chercher un move', value: search, oninput: e => { search = e.target.value; draw(); } }),
      seg),
    listEl];
}

async function userView(id) {
  const [[p], vals] = await Promise.all([
    q(sb.from('v_leaderboard').select('*').eq('user_id', id)),
    q(sb.from('v_validations').select('*').eq('user_id', id).order('move_id')),
  ]);
  if (!p) return empty('Membre introuvable.');
  const own = id === me.id, pc = pct(p.done, p.total);
  return [h('a', { class: 'back', href: '#team' }, '← Team'),
    h('section', { class: 'hero card' }, avatar(p.username, p.avatar_path, 'big'), h('div', { class: 'grow' },
      h('h1', {}, p.username + (own ? ' (toi)' : '')), h('p', {}, `${p.done} / ${p.total} moves validés · ${pc}%`), bar(pc),
      own && h('div', { class: 'own-actions' }, h('label', { class: 'btn small photo-btn' }, '📷 Changer ma photo',
        h('input', { type: 'file', accept: 'image/*', class: 'file', onchange: e => {
          const file = e.target.files[0];
          e.target.value = ''; // pour pouvoir rechoisir la même photo
          busy(e.target.closest('label'), () => adjustPhoto(file));
        } })),
        h('button', { class: 'btn small', onclick: changeName }, '✏️ Changer mon nom')))),
    section('Moves postés', vals.length ? list(vals.map(v => validationRow(v, false))) : empty("Rien de posté pour l'instant."))];
}

// le nom sert aussi à se connecter : on change les deux d'un coup (la base recopie le nom dans le profil)
function changeName() {
  const save = e => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const name = e.target.username.value.trim(), email = nameEmail(name);
      if (!email) throw new Error('Ton nom doit contenir au moins 2 lettres ou chiffres.');
      await q(sb.auth.updateUser({ email, data: { username: name } }));
      me.username = name;
      sheet.close();
      toast(`C'est fait ! Connecte-toi maintenant avec « ${name} » 👌`);
      route();
    });
  };
  openSheet('Changer mon nom', h('form', { class: 'stack', onsubmit: save },
    h('label', { class: 'field' }, h('span', {}, 'Nouveau nom'),
      h('input', { name: 'username', value: me.username, required: true, minlength: 2, maxlength: 24, autocomplete: 'username', autocapitalize: 'off' })),
    h('p', { class: 'hint' }, 'Tu te connecteras avec ce nouveau nom (même mot de passe).'),
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
  openSheet(m.name, uploadForm(m, null));
}

async function openValidationById(id) {
  try { openValidation(await q(sb.from('v_validations').select('*').eq('id', id).single())); }
  catch (e) { toast(msg(e), true); }
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
    body.replaceChildren(
      h('div', { class: 'meta' }, chip(status(v)), h('span', { class: 'muted' }, `posté par ${own ? 'toi' : v.username} · ${ago(v.created_at)}`)),
      url ? videoEl(url)
        : h('div', { class: 'novideo' }, icon('video'), h('span', {}, own ? 'Pas encore de vidéo.' : `Pas encore de vidéo, elle est demandée à ${v.username}.`)),
      h('div', { class: 'score' },
        h('span', { class: 'ok' }, `✓ ${v.ok_count} validation${v.ok_count > 1 ? 's' : ''}`),
        h('span', { class: 'ko' }, `✕ ${v.ko_count} refus`),
        h('small', { class: 'muted' }, v.invalid ? 'Dévalidé : plus de 3 refus' : 'Dévalidé à partir de 4 refus')),
      own ? ownerActions(v) : voteActions(v, myVote),
      h('h3', {}, 'Avis & commentaires'),
      reviews.length ? h('ul', { class: 'reviews' }, reviews.map(reviewItem)) : h('p', { class: 'muted' }, "Aucun avis pour l'instant."),
      commentForm(v));
  } catch (e) {
    body.replaceChildren(errorState(e));
  }
}

function uploadForm(m, v) {
  // v absent : première validation ; v sans vidéo : on ajoute la vidéo ; v dévalidé : on reposte
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
    v?.invalid && h('p', { class: 'warnbox' }, 'Ce move a été dévalidé par la team. Reposte-le avec une meilleure vidéo.'),
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
  const reason = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Pourquoi ? (obligatoire)', 'aria-label': 'Raison du refus', hidden: true });
  const vote = (kind, btn) => busy(btn, async () => {
    if (kind === 'ko' && reason.hidden) {
      reason.hidden = false;
      btn.textContent = '✕ Envoyer le refus';
      return reason.focus();
    }
    if (kind === 'ko' && !reason.value.trim()) { reason.focus(); return toast('Dis pourquoi tu ne valides pas.', true); }
    await q(sb.from('reviews').insert({ validation_id: v.id, kind, body: kind === 'ko' ? reason.value.trim() : '' }));
    toast(kind === 'ok' ? 'Validé ✓' : 'Refus envoyé');
    await refreshValidation(v.id);
  });
  return h('div', { class: 'stack' },
    h('div', { class: 'vote' },
      h('button', { class: 'btn ok', onclick: e => vote('ok', e.currentTarget) }, '✓ Valider'),
      h('button', { class: 'btn ko', onclick: e => vote('ko', e.currentTarget) }, '✕ Ne pas valider')),
    reason);
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
  const mineList = [...mine.values()];
  return { reviews, noVideo: mineList.filter(v => !v.video_path && !v.invalid), invalid: mineList.filter(v => v.invalid) };
}

async function refreshBadge() {
  const badge = document.getElementById('badge');
  if (!badge) return;
  try {
    const { reviews, noVideo, invalid } = await fetchNotifs();
    const seen = localStorage.getItem(SEEN_KEY) || '';
    const n = noVideo.length + invalid.length + reviews.filter(r => r.created_at > seen).length;
    badge.textContent = n > 9 ? '9+' : n;
    badge.hidden = !n;
  } catch { /* le badge n'est pas vital */ }
}

async function openNotifs() {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Chargement…'));
  openSheet('Notifications', body);
  try {
    const { reviews, noVideo, invalid } = await fetchNotifs();
    const seen = localStorage.getItem(SEEN_KEY) || '';
    if (reviews[0]) localStorage.setItem(SEEN_KEY, reviews[0].created_at); // heure serveur, pas l'horloge du tél
    const verb = { ok: 'a validé', ko: "n'a pas validé", comment: 'a commenté' };
    const item = (cls, title, text, onclick, isNew) => h('li', {}, h('button', { class: 'row notif ' + cls + (isNew ? ' new' : ''), onclick },
      h('span', { class: 'grow' }, h('strong', {}, title), text && h('small', { class: 'muted' }, text)), isNew && h('span', { class: 'dot', 'aria-label': 'nouveau' })));
    const items = [
      ...invalid.map(v => item('ko', `${v.move_name} a été dévalidé`, 'Plus de 3 refus : reposte-le avec une nouvelle vidéo.', () => openValidation(v))),
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
