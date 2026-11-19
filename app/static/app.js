/* SPDX-License-Identifier: GPL-3.0-or-later
   Copyright (C) 2026 les contributeurs du projet */
"use strict";

/* =========================================================
   Inventaire de l'atelier
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LEVELS = ["Vide", "Peu", "Correct", "Beaucoup"];
const STALE_DAYS = 180;
const MAX_ROWS = 300;

const ICON_ITEM = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/></svg>';
const ICON_BOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l9-4 9 4v8l-9 4-9-4z"/><path d="M3 8l9 4 9-4M12 12v8"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICON_MOVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16M16 8l4 4-4 4M8 8l-4 4 4 4"/></svg>';
const ICON_PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const ICON_CAMERA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

const S = {
  locs: new Map(),
  items: new Map(),
  kids: new Map(),      // parent_id (ou "root") -> [id]
  index: new Map(),     // item id -> index de recherche
  tagFilter: new Set(),
  tagsQuery: "",
  tagsSort: "alpha",
  importResult: "",
  name: "",
  version: "",
  loaded: false,
};

/* ---------- Utilitaires ---------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const thumbUrl = (p) => `photos/${p}_t.jpg`;
const photoUrl = (p) => `photos/${p}.jpg`;
const isOut = (it) => (it.qty_mode === "approx" ? it.level === 0 : it.qty === 0);
const fmtDate = (iso) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
const plural = (n, one, many) => `${n}\u00a0${n > 1 ? many : one}`;
const isLow = (it) => it.low_at != null && !isOut(it) && (it.qty_mode === "approx" ? it.level <= it.low_at : it.qty <= it.low_at);
const fmtPrice = (p) => p == null ? "" : `${Number(p).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\u00a0€`;
const fmtDateTime = (iso) => new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function toast(msg, opts = {}) {
  const t = $("#toast");
  t.className = "on" + (opts.err ? " err" : "");
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = opts.action.label;
    b.onclick = () => { t.className = ""; opts.action.fn(); };
    t.appendChild(b);
  }
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = t.className.replace("on", ""); }, opts.err ? 6000 : 3200);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  let r;
  try { r = await fetch(url, opt); }
  catch { throw new Error("Serveur injoignable. Vérifiez votre connexion au réseau de l’atelier ou à Tailscale."); }
  let data = null;
  try { data = await r.json(); } catch { /* réponse vide */ }
  if (!r.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : `Le serveur a refusé l’opération (erreur ${r.status}).`);
  }
  return data;
}

/* ---------- Normalisation et recherche ---------- */

function stem(w) {
  return w.length > 3 && /[sx]$/.test(w) && !/\d/.test(w) ? w.slice(0, -1) : w;
}

function words(s) {
  let t = String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  t = t.replace(/[µμ]/g, "u").replace(/ω/g, " ohm ").replace(/(\d),(\d)/g, "$1.$2");
  t = t.replace(/[^a-z0-9.]+/g, " ").replace(/\.(?!\d)|(?<!\d)\./g, " ");
  return t.split(" ").filter(Boolean).map(stem);
}

// Distance de Damerau (OSA), avec arrêt anticipé
function osa(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

function tokenScore(t, ws, compact) {
  let best = 0;
  for (const w of ws) {
    if (w === t) return 1;
    if (w.startsWith(t)) best = Math.max(best, 0.9);
    else if (t.length >= 2 && w.includes(t)) best = Math.max(best, 0.7);
    else if (best < 0.55 && t.length >= 4 && (osa(t, w.slice(0, t.length)) <= 1 || osa(t, w) <= 1)) best = 0.55;
  }
  if (!best && t.length >= 3 && compact.includes(t)) best = 0.5;
  return best;
}

const FIELDS = [["name", 3], ["tags", 2], ["loc", 1.2], ["note", 1]];

function buildIndex(it) {
  const f = {
    name: words(it.name),
    tags: words(it.tags.join(" ")),
    loc: words(locPath(it.location_id).map((l) => l.name).join(" ")),
    note: words(it.note),
  };
  for (const k of Object.keys(f)) f[k + "C"] = f[k].join("");
  return f;
}

function scoreItem(it, tokens, fields = FIELDS) {
  const ix = S.index.get(it.id);
  let total = 0;
  for (const t of tokens) {
    let m = 0;
    for (const [k, w] of fields) m = Math.max(m, tokenScore(t, ix[k], ix[k + "C"]) * w);
    if (!m) return 0;
    total += m;
  }
  return total;
}

function searchLocs(tokens) {
  const hits = [];
  for (const l of S.locs.values()) {
    const own = words(l.name), ownC = own.join("");
    const all = words(locPath(l.id).map((x) => x.name).join(" ")), allC = all.join("");
    let score = 0, onOwn = false, ok = true;
    for (const t of tokens) {
      const a = tokenScore(t, own, ownC), b = tokenScore(t, all, allC) * 0.6;
      if (!a && !b) { ok = false; break; }
      if (a) onOwn = true;
      score += Math.max(a, b);
    }
    if (ok && onOwn) hits.push([score, l]);
  }
  return hits.sort((a, b) => b[0] - a[0]).slice(0, 6).map((h) => h[1]);
}

/* ---------- Données ---------- */

function setData(data) {
  S.locs = new Map(data.locations.map((l) => [l.id, l]));
  S.items = new Map(data.items.map((i) => [i.id, i]));
  rebuild();
  S.loaded = true;
}

function rebuild() {
  S.kids = new Map();
  for (const l of S.locs.values()) {
    const k = l.parent_id ?? "root";
    if (!S.kids.has(k)) S.kids.set(k, []);
    S.kids.get(k).push(l.id);
  }
  const byName = (a, b) => S.locs.get(a).name.localeCompare(S.locs.get(b).name, "fr", { numeric: true });
  for (const arr of S.kids.values()) arr.sort(byName);
  S.index = new Map([...S.items.values()].map((it) => [it.id, buildIndex(it)]));
}

function locPath(id) {
  const out = [];
  const seen = new Set();
  while (id != null && S.locs.has(id) && !seen.has(id)) {
    seen.add(id);
    const l = S.locs.get(id);
    out.unshift(l);
    id = l.parent_id;
  }
  return out;
}

function descendants(id) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) for (const c of S.kids.get(stack.pop()) || []) { out.add(c); stack.push(c); }
  return out;
}

function itemsIn(locId) {
  return [...S.items.values()].filter((it) => it.location_id === locId);
}

function countDeep(locId) {
  const all = descendants(locId);
  let n = 0;
  for (const it of S.items.values()) if (all.has(it.location_id)) n++;
  return n;
}

function nearestPhoto(locId) {
  const p = locPath(locId).reverse().find((l) => l.photo);
  return p || null;
}

const sortItems = (a, b) => (isOut(a) - isOut(b)) || a.name.localeCompare(b.name, "fr", { numeric: true });

/* ---------- Fragments HTML ---------- */

function pathHTML(locId, { links = true } = {}) {
  const p = locPath(locId);
  if (!p.length) return '<div class="path none"><span>Sans emplacement</span></div>';
  const seg = p.map((l) => links
    ? `<a href="#/lieu/${l.id}" data-nav>${esc(l.name)}</a>`
    : `<span>${esc(l.name)}</span>`).join("");
  return `<div class="path">${seg}</div>`;
}

function thumbHTML(photo, icon) {
  return `<div class="thumb">${photo ? `<img src="${thumbUrl(photo)}" alt="" loading="lazy">` : icon}</div>`;
}

function qtyHTML(it) {
  if (it.qty_mode === "approx") {
    const bars = [1, 2, 3].map((n) =>
      `<button type="button" data-act="lvl" data-lvl="${n}" class="${it.level >= n ? "on" : ""}" aria-label="Régler sur ${LEVELS[n]}"></button>`).join("");
    return `<div class="qty-wrap"><span class="gauge-label">${LEVELS[it.level]}</span><div class="gauge" role="group" aria-label="Niveau de stock : ${LEVELS[it.level]}">${bars}</div></div>`;
  }
  return `<div class="qty"><button type="button" data-act="dec" aria-label="Retirer un">−</button><output aria-label="Quantité">${it.qty}</output><button type="button" data-act="inc" aria-label="Ajouter un">+</button></div>`;
}

function itemRowHTML(it, { showPath = true, buy = false, want = false } = {}) {
  const out = isOut(it);
  const low = isLow(it) ? `<span class="low-flag" title="Stock bas : alerte à ${it.qty_mode === "approx" ? "« Peu »" : it.low_at}" aria-label="Stock bas">!</span>` : "";
  const badges = (out ? '<span class="badge out">Épuisé</span>' : "") + (it.wanted ? '<span class="badge want">À acheter</span>' : "");
  const tags = it.tags.length ? `<div class="row-tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : "";
  return `<li class="row${out ? " out" : ""}" data-item="${it.id}" tabindex="0">
    ${thumbHTML(it.photo, ICON_ITEM)}
    <div class="row-main"><div class="row-name">${low}${esc(it.name)}${badges}</div>${showPath ? pathHTML(it.location_id) : ""}${tags}${buy && it.price != null ? `<div class="price">${fmtPrice(it.price)} l’unité</div>` : ""}</div>
    <div class="row-actions">
      ${buy && it.buy_url ? `<a class="btn small" href="${esc(it.buy_url)}" target="_blank" rel="noopener noreferrer">Commander</a>` : ""}
      ${buy
        ? `<button type="button" class="btn small primary" data-act="buy">Acheté</button>`
        : want
          ? (it.wanted
            ? `<button type="button" class="btn small" data-act="want" aria-pressed="true" title="Retirer de la liste d’achat">Dans la liste</button>`
            : `<button type="button" class="btn small primary" data-act="want">Ajouter aux achats</button>`)
          : `<button type="button" class="btn ghost move" data-act="move" title="Déplacer" aria-label="Déplacer ${esc(it.name)}">${ICON_MOVE}</button>`}
      ${qtyHTML(it)}
    </div>
  </li>`;
}

function locRowHTML(l) {
  const sub = (S.kids.get(l.id) || []).length;
  const n = countDeep(l.id);
  const parts = [];
  if (sub) parts.push(plural(sub, "contenant", "contenants"));
  parts.push(n ? plural(n, "article", "articles") : "vide");
  return `<li class="row" data-loc="${l.id}" tabindex="0">
    ${thumbHTML(l.photo, ICON_BOX)}
    <div class="row-main"><div class="row-name">${esc(l.name)}</div><div class="sub">${parts.join(", ")}</div></div>
    <div class="loc-tail"><button type="button" class="btn ghost move" data-act="move-loc" title="Déplacer" aria-label="Déplacer ${esc(l.name)}">${ICON_MOVE}</button>${ICON_CHEV}</div>
  </li>`;
}

function listHTML(rows) {
  return `<ul class="list">${rows.join("")}</ul>`;
}

/* ---------- Vues ---------- */

function route() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("lieu/")) return { view: "lieux", id: Number(h.slice(5)) };
  if (h === "lieux") return { view: "lieux", id: null };
  if (h === "courses") return { view: "courses" };
  if (h === "tags") return { view: "tags" };
  if (h === "bas") return { view: "bas" };
  if (h === "outils") return { view: "outils" };
  if (h.startsWith("verif/")) return { view: "verif", id: Number(h.slice(6)) };
  if (h === "projets") return { view: "projets" };
  if (h.startsWith("projet/")) {
    const [id, sub] = h.slice(7).split("/");
    return { view: "projets", id: Number(id), sortie: sub === "sortie" };
  }
  return { view: "inventaire" };
}

function render() {
  const r = route();
  $$("#nav [data-view]").forEach((a) => {
    if (a.dataset.view === r.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  renderStats();
  if (!S.loaded) return;
  renderTagbar();
  const v = $("#view");
  if (r.view === "lieux") v.innerHTML = viewLieux(r.id);
  else if (r.view === "courses") v.innerHTML = viewCourses();
  else if (r.view === "tags") { v.innerHTML = viewTags(); drawTagsList(); }
  else if (r.view === "bas") v.innerHTML = viewBas();
  else if (r.view === "outils") { v.innerHTML = viewOutils(); loadBackupStatus(); }
  else if (r.view === "verif") { v.innerHTML = viewVerif(r.id); drawVerifBar(); }
  else if (r.view === "projets") { v.innerHTML = r.id != null ? viewProjet(r.id, r.sortie) : viewProjets(); drawPickBar(); }
  else v.innerHTML = viewInventaire();
}

function renderStats() {
  if (!S.loaded) { $("#stats").innerHTML = ""; return; }
  let stock = 0, out = 0, want = 0, low = 0;
  for (const it of S.items.values()) {
    if (isOut(it)) out++; else stock++;
    if (it.wanted) want++;
    if (isLow(it)) low++;
  }
  $("#stats").innerHTML =
    `<span><b>${stock}</b>en stock</span>` +
    `<a href="#/bas"${low ? ' class="alert"' : ""}><b>${low}</b>stock bas</a>` +
    `<a href="#/courses"><b>${out}</b>${out > 1 ? "épuisés" : "épuisé"}</a>` +
    `<a href="#/courses"><b>${want}</b>à acheter</a>`;
}

function viewInventaire() {
  if (!S.locs.size && !S.items.size) {
    return `<div class="empty">
      <h3>Votre inventaire est vide</h3>
      <p>Commencez par décrire vos emplacements : une pièce, puis ses meubles, puis les cartons qu’ils contiennent. Vous y rangerez ensuite vos articles.</p>
      <div class="actions"><button class="btn primary" type="button" data-act="new-loc">Créer un emplacement</button>
      <button class="btn" type="button" data-act="new-item">Ajouter un article</button></div></div>`;
  }
  const q = $("#q").value.trim();
  const tokens = words(q);
  let items = [...S.items.values()];

  if (S.tagFilter.size) items = items.filter((it) => [...S.tagFilter].every((t) => it.tags.includes(t)));

  let locHits = "";
  if (tokens.length) {
    const scored = items.map((it) => [scoreItem(it, tokens), it]).filter((s) => s[0] > 0);
    scored.sort((a, b) => (isOut(a[1]) - isOut(b[1])) || b[0] - a[0] || a[1].name.localeCompare(b[1].name, "fr"));
    items = scored.map((s) => s[1]);
    const locs = S.tagFilter.size ? [] : searchLocs(tokens);
    if (locs.length) {
      locHits = `<div class="loc-hits">${locs.map((l) =>
        `<a class="loc-hit" href="#/lieu/${l.id}">${thumbHTML(l.photo, ICON_BOX)}${pathHTML(l.id, { links: false })}</a>`).join("")}</div>`;
    }
  } else {
    items.sort(sortItems);
  }

  const title = tokens.length ? "Résultats" : (S.tagFilter.size ? "Articles filtrés" : "Tous les articles");
  let body;
  if (!items.length) {
    body = tokens.length || S.tagFilter.size
      ? `<div class="empty"><h3>Aucun article ne correspond</h3><p>Essayez un autre mot, retirez un filtre, ou ajoutez cet article s’il n’existe pas encore.</p>
         <div class="actions"><button class="btn primary" type="button" data-act="new-item-q">Ajouter « ${esc(q || [...S.tagFilter].join(" "))} »</button></div></div>`
      : `<div class="empty"><h3>Aucun article pour l’instant</h3><p>Ajoutez votre premier article et indiquez dans quel emplacement il est rangé.</p>
         <div class="actions"><button class="btn primary" type="button" data-act="new-item">Ajouter un article</button></div></div>`;
  } else {
    const shown = items.slice(0, MAX_ROWS);
    body = listHTML(shown.map((it) => itemRowHTML(it)));
    if (items.length > MAX_ROWS) body += `<p class="sub">${MAX_ROWS} premiers résultats sur ${items.length}. Précisez la recherche pour affiner.</p>`;
  }

  return `${locHits}
    <section class="section">
      <div class="section-head"><h2>${title}</h2><span class="count">${items.length}</span></div>
      ${body}
    </section>`;
}

function viewLieux(id) {
  const loc = id != null ? S.locs.get(id) : null;
  if (id != null && !loc) {
    return `<div class="empty"><h3>Cet emplacement n’existe plus</h3><p>Il a peut-être été supprimé depuis un autre appareil.</p>
      <div class="actions"><a class="btn" href="#/lieux">Voir tous les emplacements</a></div></div>`;
  }
  const crumbs = `<nav class="crumbs" aria-label="Chemin">${loc
    ? `<a href="#/lieux">Emplacements</a>${locPath(id).map((l, i, a) =>
        i === a.length - 1 ? `<span>${esc(l.name)}</span>` : `<a href="#/lieu/${l.id}">${esc(l.name)}</a>`).join("")}`
    : "<span>Emplacements</span>"}</nav>`;

  const children = (S.kids.get(id ?? "root") || []).map((k) => S.locs.get(k));
  const here = loc ? itemsIn(id).sort(sortItems) : [];

  let head = "";
  if (loc) {
    const days = loc.verified_at ? (Date.now() - new Date(loc.verified_at)) / 864e5 : Infinity;
    const verif = loc.verified_at ? `Vérifié le ${fmtDate(loc.verified_at)}` : "Jamais vérifié";
    head = `<div class="loc-head">
      ${loc.photo
        ? `<button type="button" class="cover" data-act="zoom" data-photo="${loc.photo}" aria-label="Agrandir la photo"><img src="${photoUrl(loc.photo)}" alt="Photo de ${esc(loc.name)}"></button>`
        : `<button type="button" class="cover empty" data-act="loc-photo">${ICON_CAMERA}<span>Ajouter une photo</span></button>`}
      <div class="loc-meta">
        ${loc.note ? `<p class="note">${esc(loc.note)}</p>` : ""}
        <div class="verified${loc.verified_at && days > STALE_DAYS ? " stale" : ""}"><span>${verif}</span>
          <a class="btn small" href="#/verif/${loc.id}">Vérifier le contenu</a></div>
        <div class="actions">
          <button type="button" class="btn primary" data-act="new-item-here">Ajouter un article ici</button>
          <button type="button" class="btn" data-act="new-loc-here">Nouveau contenant ici</button>
          <button type="button" class="btn" data-act="move-this-loc">Déplacer</button>
          <button type="button" class="btn ghost" data-act="edit-loc">Modifier</button>
          <button type="button" class="btn ghost" data-act="print">Imprimer l’étiquette</button>
        </div>
      </div></div>`;
  } else {
    head = `<div class="actions" style="margin-bottom:6px"><button type="button" class="btn primary" data-act="new-loc">Nouvel emplacement</button></div>`;
  }

  let content = "";
  if (children.length) {
    content += `<section class="section"><div class="section-head"><h2>Contenants</h2><span class="count">${children.length}</span></div>${listHTML(children.map(locRowHTML))}</section>`;
  }
  if (here.length) {
    content += `<section class="section"><div class="section-head"><h2>Articles rangés ici</h2><span class="count">${here.length}</span></div>${listHTML(here.map((it) => itemRowHTML(it, { showPath: false })))}</section>`;
  }
  if (!content) {
    content = loc
      ? `<section class="section"><div class="empty"><h3>Ce contenant est vide</h3><p>Ajoutez-y des articles ou d’autres contenants (un carton dans un carton, par exemple).</p></div></section>`
      : `<section class="section"><div class="empty"><h3>Aucun emplacement</h3><p>Créez vos emplacements de premier niveau, comme « Bureau » ou « Garage ». Vous pourrez ensuite y ranger des meubles, des cartons et des articles.</p>
         <div class="actions"><button type="button" class="btn primary" data-act="new-loc">Créer un emplacement</button></div></div></section>`;
  }
  return crumbs + head + content;
}

function viewCourses() {
  const all = [...S.items.values()];
  const want = all.filter((it) => it.wanted).sort(sortItems);
  const out = all.filter((it) => isOut(it) && !it.wanted).sort(sortItems);
  if (!want.length && !out.length) {
    return `<div class="empty"><h3>Rien à acheter</h3><p>Les articles épuisés et ceux que vous marquez « À acheter » dans leur fiche apparaîtront ici.</p></div>`;
  }
  let html = "";
  if (want.length) html += `<section class="section"><div class="section-head"><h2>À acheter</h2><span class="count">${want.length}</span></div>${listHTML(want.map((it) => itemRowHTML(it, { buy: true })))}</section>`;
  if (out.length) html += `<section class="section"><div class="section-head"><h2>Épuisés</h2><span class="count">${out.length}</span></div>${listHTML(out.map((it) => itemRowHTML(it, { buy: true })))}</section>`;
  return html;
}

/* ---------- Mise à jour rapide des quantités ---------- */

const queues = new Map();
function patchItem(id, body) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => api("PATCH", `api/items/${id}`, body));
  queues.set(id, next);
  return next;
}

function refreshRows(id) {
  const it = S.items.get(id);
  for (const li of $$(`#view li[data-item="${id}"]`)) {
    const showPath = !!li.querySelector(".path");
    const buy = !!li.querySelector('[data-act="buy"]');
    const want = !!li.querySelector('[data-act="want"]');
    const tmp = document.createElement("template");
    tmp.innerHTML = (li.classList.contains("verif") ? verifRowHTML(it) : itemRowHTML(it, { showPath, buy, want })).trim();
    li.replaceWith(tmp.content.firstChild);
  }
  renderStats();
  if (route().view === "verif") drawVerifBar();
}

function quickQty(id, act, lvl) {
  const it = S.items.get(id);
  const before = { qty: it.qty, level: it.level };
  let body;
  if (act === "inc") { it.qty += 1; body = { qty: it.qty }; }
  else if (act === "dec") { if (it.qty === 0) return; it.qty -= 1; body = { qty: it.qty }; }
  else { it.level = it.level === lvl ? lvl - 1 : lvl; body = { level: it.level }; }
  refreshRows(id);
  const btnSel = act === "lvl" ? `[data-act="lvl"][data-lvl="${lvl}"]` : `[data-act="${act}"]`;
  $(`#view li[data-item="${id}"] ${btnSel}`)?.focus({ preventScroll: true });
  patchItem(id, body).then((saved) => {
    if (saved) { S.items.set(id, saved); }
  }).catch((e) => {
    Object.assign(it, before); refreshRows(id); toast(e.message, { err: true });
  });
}

/* ---------- Photos ---------- */

let fileCallback = null;
function chooseFile(cb) {
  fileCallback = cb;
  $("#fileInput").value = "";
  $("#fileInput").click();
}
$("#fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (f && fileCallback) fileCallback(f);
  fileCallback = null;
});

function openPhoto(name) {
  $("#lightImg").src = photoUrl(name);
  $("#dlgPhoto").showModal();
}

function photoFieldHTML(previewUrl, hasPhoto, label) {
  return `<button type="button" class="pic" data-pic aria-label="${hasPhoto ? "Changer la photo" : "Ajouter une photo"}">
      ${previewUrl ? `<img src="${previewUrl}" alt="">` : ICON_CAMERA}</button>
    <div class="pic-actions">
      <button type="button" class="btn small" data-pic>${hasPhoto ? "Changer la photo" : label}</button>
      ${hasPhoto ? '<button type="button" class="btn small ghost danger" data-pic-remove>Retirer la photo</button>' : ""}
    </div>`;
}

/* ---------- Sélecteur d'emplacement ---------- */

function pickLocation({ title, noneLabel = null, current, exclude = new Set(), excludeTitle = "Impossible : ce serait le ranger dans lui-même" }) {
  return new Promise((resolve) => {
    const dlg = $("#dlgPick");
    const list = $("#pickList");
    const q = $("#pickQ");
    $("#dlgPickTitle").textContent = title;
    q.value = "";
    const entries = [...S.locs.values()]
      .map((l) => ({ l, path: locPath(l.id), key: words(locPath(l.id).map((x) => x.name).join(" ")) }))
      .sort((a, b) => a.path.map((x) => x.name).join("\u0001").localeCompare(b.path.map((x) => x.name).join("\u0001"), "fr", { numeric: true }));
    let sel = 0, done = false;

    const draw = () => {
      const tokens = words(q.value);
      const rows = [];
      if (!tokens.length && noneLabel) rows.push({ id: null, html: `<span>${esc(noneLabel)}</span>`, special: true });
      for (const e of entries) {
        if (tokens.length && !tokens.every((t) => tokenScore(t, e.key, e.key.join("")) > 0)) continue;
        rows.push({ id: e.l.id, html: pathHTML(e.l.id, { links: false }), disabled: exclude.has(e.l.id) });
      }
      sel = Math.max(0, rows.findIndex((r) => r.id === current && !r.disabled));
      if (tokens.length) sel = rows.findIndex((r) => !r.disabled);
      list.innerHTML = rows.length
        ? rows.map((r, i) => `<li role="option" data-i="${i}" data-id="${r.id ?? ""}" class="${r.special ? "special" : ""}${r.disabled ? " disabled" : ""}" aria-selected="${i === sel}"${r.disabled ? ` aria-disabled="true" title="${esc(excludeTitle)}"` : ""}>${r.html}</li>`).join("")
        : `<li class="special">Aucun emplacement ne correspond.</li>`;
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
    };
    const finish = (val) => { if (done) return; done = true; cleanup(); dlg.close(); resolve(val); };
    const choose = (li) => {
      if (!li || li.classList.contains("disabled") || !li.hasAttribute("data-id")) return;
      finish(li.dataset.id === "" ? null : Number(li.dataset.id));
    };
    const onClick = (e) => choose(e.target.closest("li"));
    const onKey = (e) => {
      const lis = $$("li[data-i]", list);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        let i = sel;
        do { i = e.key === "ArrowDown" ? Math.min(lis.length - 1, i + 1) : Math.max(0, i - 1); } while (lis[i]?.classList.contains("disabled") && i > 0 && i < lis.length - 1);
        sel = i;
        lis.forEach((li, k) => li.setAttribute("aria-selected", k === sel));
        lis[sel]?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); choose(lis[sel]); }
    };
    const onClose = () => { if (!done) { done = true; cleanup(); resolve(undefined); } };
    const cleanup = () => {
      list.removeEventListener("click", onClick); q.removeEventListener("keydown", onKey);
      q.removeEventListener("input", draw); dlg.removeEventListener("close", onClose);
    };
    list.addEventListener("click", onClick);
    q.addEventListener("keydown", onKey);
    q.addEventListener("input", draw);
    dlg.addEventListener("close", onClose);
    draw();
    dlg.showModal();
    q.focus();
  });
}

/* ---------- Fiche article ---------- */

const D = { item: null };   // brouillon en cours

function allTagCounts() {
  const m = new Map();
  for (const it of S.items.values()) for (const t of it.tags) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function openItem(id, preset = {}) {
  const it = id != null ? S.items.get(id) : null;
  D.item = {
    id: it ? it.id : null,
    name: it ? it.name : (preset.name || ""),
    location_id: it ? it.location_id : (preset.location_id ?? null),
    qty_mode: it ? it.qty_mode : (preset.qty_mode || "exact"),
    qty: it ? it.qty : 1,
    level: it ? it.level : 2,
    wanted: it ? it.wanted : false,
    note: it ? it.note : "",
    tags: it ? [...it.tags] : (preset.tags || []),
    photo: it ? it.photo : null,
    low_at: it ? it.low_at : null,
    file: null, previewUrl: null, removePhoto: false,
  };
  $("#dlgItemTitle").textContent = it ? "Modifier l’article" : "Nouvel article";
  $("#itemName").value = D.item.name;
  $("#itemQty").value = D.item.qty;
  $("#itemWanted").checked = D.item.wanted;
  $("#itemNote").value = D.item.note;
  $("#itemDelete").hidden = !it;
  $("#itemSaveNext").hidden = !!it;
  $("#itemLow").value = it && it.qty_mode === "exact" && it.low_at != null ? it.low_at : "";
  $("#itemLowApprox").checked = !!(it && it.qty_mode === "approx" && it.low_at != null);
  $("#itemUrl").value = it ? it.buy_url || "" : "";
  $("#itemPrice").value = it && it.price != null ? it.price.toFixed(2).replace(".", ",") : "";
  drawUrlOpen();
  $("#itemHistory").open = false;
  $("#itemHistory").hidden = !it;
  $("#historyList").innerHTML = "";
  $("#tagInput").value = "";
  drawItemPhoto(); drawItemLoc(); drawQtyMode(); drawTags(); drawDupes();
  $("#tagSuggest").hidden = true;
  $("#dlgItem").showModal();
  if (!it) $("#itemName").focus(); else $("#itemName").blur();
}

function drawItemPhoto() {
  const d = D.item;
  const url = d.previewUrl || (!d.removePhoto && d.photo ? thumbUrl(d.photo) : null);
  $("#itemPhoto").innerHTML = photoFieldHTML(url, !!url, "Prendre ou choisir une photo");
}

function drawItemLoc() {
  const d = D.item;
  $("#itemLoc").innerHTML = (d.location_id != null ? pathHTML(d.location_id, { links: false }) : '<div class="path none"><span>Aucun emplacement</span></div>')
    + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  const ph = d.location_id != null ? nearestPhoto(d.location_id) : null;
  $("#itemLocPhoto").innerHTML = ph
    ? `<div class="loc-photo-hint"><button type="button" data-zoom="${ph.photo}" aria-label="Agrandir la photo de ${esc(ph.name)}"><img src="${thumbUrl(ph.photo)}" alt=""></button><span>Photo de « ${esc(ph.name)} »</span></div>`
    : "";
}

function drawQtyMode() {
  const d = D.item;
  $$("#dlgItem [data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === d.qty_mode));
  $("#qtyExact").hidden = d.qty_mode !== "exact";
  $("#qtyApprox").hidden = d.qty_mode !== "approx";
  $$("#qtyApprox [data-level]").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.level) === d.level));
  $("#lowExact").hidden = d.qty_mode !== "exact";
  $("#lowApprox").hidden = d.qty_mode !== "approx";
  drawLowWarn();
}

function draftLowAt() {
  if (D.item.qty_mode === "approx") return $("#itemLowApprox").checked ? 1 : null;
  const v = $("#itemLow").value.trim();
  return v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
}

function drawLowWarn() {
  const d = D.item;
  const probe = { qty_mode: d.qty_mode, qty: Math.max(0, parseInt($("#itemQty").value, 10) || 0), level: d.level, low_at: draftLowAt() };
  const w = $("#lowWarn");
  w.hidden = !isLow(probe);
  if (!w.hidden) {
    w.innerHTML = `<span class="low-flag" aria-hidden="true">!</span>` + (d.qty_mode === "approx"
      ? "Stock bas."
      : `Stock bas : ${plural(probe.qty, "restant", "restants")}, alerte à ${probe.low_at}.`);
  }
}

function drawUrlOpen() {
  const v = $("#itemUrl").value.trim();
  const a = $("#itemUrlOpen");
  a.hidden = !v;
  a.href = v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : "#";
}

function parsePrice(raw) {
  const v = raw.trim().replace(/\s|€/g, "").replace(",", ".");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10000) / 10000 : NaN;
}

const HISTORY_TEXT = {
  created: (h) => h.old === "import"
    ? `Importé depuis un fichier CSV${h.new ? ` dans ${h.new}` : ""}`
    : h.old
      ? `Créé par déplacement de ${h.n} depuis ${h.old}`
      : `Ajouté${h.n != null ? ` (${h.n})` : ""} ${h.new ? `dans ${h.new}` : "sans emplacement"}`,
  moved: (h) => `Déplacé de ${h.old || "aucun emplacement"} vers ${h.new || "aucun emplacement"}`,
  split_out: (h) => `${h.n} déplacé${h.n > 1 ? "s" : ""} vers ${h.new}`,
  split_in: (h) => `${h.n} reçu${h.n > 1 ? "s" : ""} depuis ${h.old}`,
  qty: (h) => `Quantité : ${h.old} → ${h.new}`,
  level: (h) => `Niveau : ${h.old} → ${h.new}`,
  mode: (h) => h.new === "approx" ? "Passé en quantité approximative" : "Passé en nombre exact",
  wanted: (h) => h.new === "1" ? "Ajouté à la liste d’achat" : "Retiré de la liste d’achat",
  bought: (h) => h.n != null ? `Acheté : +${h.n} (stock ${h.old} → ${h.new})` : `Acheté : niveau ${h.old} → ${h.new}`,
  missing: () => "Absent lors d’une vérification",
  renamed: (h) => `Renommé : « ${h.old} » → « ${h.new} »`,
  taken: (h) => h.n != null
    ? `Sorti pour le projet « ${h.ref} » : −${h.n} (stock ${h.old} → ${h.new})`
    : `Sorti pour le projet « ${h.ref} » : niveau ${h.old} → ${h.new}`,
};

async function loadHistory() {
  const list = $("#historyList");
  list.innerHTML = "<li><span></span><span class=\"what\">Chargement…</span></li>";
  try {
    const rows = await api("GET", `api/items/${D.item.id}/history`);
    list.innerHTML = rows.length
      ? rows.map((h) => `<li><time datetime="${h.at}">${fmtDateTime(h.at)}</time><span class="what">${esc((HISTORY_TEXT[h.kind] || (() => h.kind))(h))}</span></li>`).join("")
      : "<li><span></span><span class=\"what\">Aucun événement enregistré pour l’instant.</span></li>";
  } catch (e) {
    list.innerHTML = `<li><span></span><span class="what">${esc(e.message)}</span></li>`;
  }
}

function drawTags() {
  const box = $("#tagBox");
  $$(".chip", box).forEach((c) => c.remove());
  const input = $("#tagInput");
  for (const t of D.item.tags) {
    const c = document.createElement("span");
    c.className = "chip";
    c.innerHTML = `${esc(t)}<button type="button" data-untag="${esc(t)}" aria-label="Retirer le tag ${esc(t)}">${ICON_X}</button>`;
    box.insertBefore(c, input);
  }
}

function drawSuggest() {
  const input = $("#tagInput");
  const typed = input.value.trim();
  const tokens = words(typed);
  const counts = allTagCounts();
  let cands = [...counts.entries()].filter(([t]) => !D.item.tags.includes(t));
  if (tokens.length) {
    cands = cands.filter(([t]) => { const w = words(t); return tokens.every((k) => tokenScore(k, w, w.join("")) > 0); });
  }
  cands.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"));
  const box = $("#tagSuggest");
  const show = cands.slice(0, 10);
  box.innerHTML = show.map(([t, n]) => `<button type="button" class="chip" data-addtag="${esc(t)}">${esc(t)} <span class="n">${n}</span></button>`).join("");
  box.hidden = !show.length || document.activeElement !== input;
}

function addTag(raw) {
  const t = raw.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
  if (!t) return;
  const key = words(t).join(" ");
  const existing = [...allTagCounts().keys()].find((x) => words(x).join(" ") === key);
  const tag = existing || t;
  if (!D.item.tags.includes(tag)) D.item.tags.push(tag);
  $("#tagInput").value = "";
  drawTags(); drawSuggest();
}

function drawDupes() {
  const box = $("#dupes");
  const d = D.item;
  const tokens = words($("#itemName").value);
  if (d.id != null || !tokens.length || tokens.join("").length < 3) { box.hidden = true; return; }
  const hits = [...S.items.values()]
    .map((it) => [scoreItem(it, tokens, [["name", 3], ["tags", 1]]), it])
    .filter((s) => s[0] > 0).sort((a, b) => b[0] - a[0]).slice(0, 3);
  if (!hits.length) { box.hidden = true; return; }
  box.innerHTML = `<div class="dupe-title">Vous avez peut-être déjà cet article :</div>` + hits.map(([, it]) => `
    <div class="dupe">${thumbHTML(it.photo, ICON_ITEM)}
      <div class="row-main"><div class="row-name">${esc(it.name)} <span class="sub">(${it.qty_mode === "approx" ? LEVELS[it.level].toLowerCase() : it.qty})</span></div>${pathHTML(it.location_id, { links: false })}</div>
      <div class="btns">${it.qty_mode === "exact" ? `<button type="button" class="btn small" data-dupe-inc="${it.id}">+1</button>` : ""}<button type="button" class="btn small" data-dupe-open="${it.id}">Ouvrir</button></div>
    </div>`).join("");
  box.hidden = false;
}

async function saveItem({ next = false } = {}) {
  const d = D.item;
  const name = $("#itemName").value.trim();
  if (!name) { toast("Indiquez un nom pour l’article.", { err: true }); $("#itemName").focus(); return; }
  const pendingTag = $("#tagInput").value.trim();
  if (pendingTag) addTag(pendingTag);
  const body = {
    name,
    location_id: d.location_id,
    qty_mode: d.qty_mode,
    qty: Math.max(0, parseInt($("#itemQty").value, 10) || 0),
    level: d.level,
    wanted: $("#itemWanted").checked,
    note: $("#itemNote").value,
    tags: d.tags,
    low_at: draftLowAt(),
    buy_url: $("#itemUrl").value.trim(),
    price: parsePrice($("#itemPrice").value),
  };
  if (Number.isNaN(body.price)) { toast("Le prix n’est pas lisible. Exemple : 3,50", { err: true }); $("#itemPrice").focus(); return; }
  const btn = next ? $("#itemSaveNext") : $("#itemSave");
  btn.disabled = true;
  try {
    let saved = d.id == null ? await api("POST", "api/items", body) : await api("PATCH", `api/items/${d.id}`, body);
    if (d.file) {
      const fd = new FormData(); fd.append("file", d.file);
      saved = await api("POST", `api/items/${saved.id}/photo`, fd);
    } else if (d.removePhoto && d.photo) {
      saved = await api("DELETE", `api/items/${saved.id}/photo`);
    }
    S.items.set(saved.id, saved);
    rebuild();
    $("#dlgItem").close();
    render();
    toast(d.id == null ? `« ${saved.name} » ajouté.` : "Modifications enregistrées.");
    if (next) openItem(null, { location_id: saved.location_id, tags: [...saved.tags], qty_mode: saved.qty_mode });
  } catch (e) {
    toast(e.message, { err: true });
  } finally {
    btn.disabled = false;
  }
}

async function deleteItem() {
  const d = D.item;
  const it = S.items.get(d.id);
  if (!it || !confirm(`Supprimer « ${it.name} » ? Cette action est définitive.\n\nAstuce : pour garder une trace d’un article épuisé, mettez plutôt sa quantité à zéro.`)) return;
  try {
    await api("DELETE", `api/items/${it.id}`);
    S.items.delete(it.id);
    rebuild();
    $("#dlgItem").close();
    render();
    toast(`« ${it.name} » supprimé.`);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ---------- Fiche emplacement ---------- */

const L = { loc: null };

function openLoc(id, parentId = null) {
  const l = id != null ? S.locs.get(id) : null;
  L.loc = {
    id: l ? l.id : null,
    parent_id: l ? l.parent_id : parentId,
    photo: l ? l.photo : null,
    file: null, previewUrl: null, removePhoto: false,
  };
  $("#dlgLocTitle").textContent = l ? "Modifier l’emplacement" : "Nouvel emplacement";
  $("#locName").value = l ? l.name : "";
  $("#locNote").value = l ? l.note : "";
  $("#locDelete").hidden = !l;
  drawLocPhoto(); drawLocParent();
  $("#dlgLoc").showModal();
  $("#locName").focus();
}

function drawLocPhoto() {
  const d = L.loc;
  const url = d.previewUrl || (!d.removePhoto && d.photo ? thumbUrl(d.photo) : null);
  $("#locPhoto").innerHTML = photoFieldHTML(url, !!url, "Photographier l’emplacement");
}

function drawLocParent() {
  const d = L.loc;
  $("#locParent").innerHTML = (d.parent_id != null ? pathHTML(d.parent_id, { links: false }) : '<div class="path none"><span>Aucun (premier niveau)</span></div>')
    + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
}

async function saveLoc() {
  const d = L.loc;
  const name = $("#locName").value.trim();
  if (!name) { toast("Indiquez un nom pour l’emplacement.", { err: true }); $("#locName").focus(); return; }
  const body = { name, parent_id: d.parent_id, note: $("#locNote").value };
  try {
    let saved = d.id == null ? await api("POST", "api/locations", body) : await api("PATCH", `api/locations/${d.id}`, body);
    if (d.file) {
      const fd = new FormData(); fd.append("file", d.file);
      saved = await api("POST", `api/locations/${saved.id}/photo`, fd);
    } else if (d.removePhoto && d.photo) {
      saved = await api("DELETE", `api/locations/${saved.id}/photo`);
    }
    S.locs.set(saved.id, saved);
    rebuild();
    $("#dlgLoc").close();
    const pending = L.onSaved; L.onSaved = null;
    if (pending) pending(saved);
    else if (d.id == null) location.hash = `#/lieu/${saved.id}`;
    render();
    toast(d.id == null ? `« ${saved.name} » créé.` : "Modifications enregistrées.");
  } catch (e) { toast(e.message, { err: true }); }
}

async function deleteLoc() {
  const l = S.locs.get(L.loc.id);
  if (!l) return;
  if ((S.kids.get(l.id) || []).length || itemsIn(l.id).length) {
    toast("Ce contenant n’est pas vide. Déplacez ou supprimez d’abord ce qu’il contient.", { err: true });
    return;
  }
  if (!confirm(`Supprimer l’emplacement « ${l.name} » ?`)) return;
  try {
    await api("DELETE", `api/locations/${l.id}`);
    S.locs.delete(l.id);
    rebuild();
    $("#dlgLoc").close();
    location.hash = l.parent_id != null ? `#/lieu/${l.parent_id}` : "#/lieux";
    render();
    toast(`« ${l.name} » supprimé.`);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ---------- Déplacements ---------- */

const M = { it: null, dest: null, part: false, resolve: null };

async function startMove(id) {
  const it = S.items.get(id);
  if (!it) return null;
  const dest = await pickLocation({
    title: `Déplacer « ${it.name} » vers…`,
    current: it.location_id,
    exclude: new Set(it.location_id != null ? [it.location_id] : []),
    excludeTitle: "L’article est déjà rangé ici",
  });
  if (dest == null) return null;
  if (it.qty_mode === "exact" && it.qty > 1) return openMoveDialog(it, dest);
  return doMove(it, dest, null);
}

function openMoveDialog(it, dest) {
  return new Promise((resolve) => {
    Object.assign(M, { it, dest, part: false, resolve });
    $("#dlgMoveTitle").textContent = `Déplacer « ${it.name} »`;
    $("#moveFrom").innerHTML = `<div class="static-path">${pathHTML(it.location_id, { links: false })}</div>`;
    $("#moveQty").value = 1;
    $("#moveQty").max = it.qty;
    drawMove();
    $("#dlgMove").showModal();
  });
}

function drawMove() {
  const it = M.it;
  $("#moveDest").innerHTML = pathHTML(M.dest, { links: false }) + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  $$("#dlgMove [data-move]").forEach((b) => b.setAttribute("aria-pressed", (b.dataset.move === "part") === M.part));
  $("#movePart").hidden = !M.part;
  const n = Math.min(it.qty, Math.max(1, parseInt($("#moveQty").value, 10) || 1));
  const here = locPath(it.location_id).at(-1);
  $("#moveHint").innerHTML = !M.part || n >= it.qty
    ? `Les <b>${it.qty}</b> seront déplacés.`
    : `<b>${n}</b> déplacé${n > 1 ? "s" : ""}, <b>${it.qty - n}</b> reste${it.qty - n > 1 ? "nt" : ""} dans « ${esc(here ? here.name : "sans emplacement")} ».`;
}

async function doMove(it, dest, qty) {
  try {
    const res = await api("POST", `api/items/${it.id}/move`, { location_id: dest, qty });
    for (const x of res.items) S.items.set(x.id, x);
    rebuild();
    render();
    const name = S.locs.get(dest)?.name ?? "";
    toast(qty && qty < it.qty
      ? `${qty} × « ${it.name} » déplacé${qty > 1 ? "s" : ""} vers « ${name} ».`
      : `« ${it.name} » déplacé vers « ${name} ».`);
    return res.items;
  } catch (e) {
    toast(e.message, { err: true });
    return null;
  }
}

async function moveLoc(id) {
  const l = S.locs.get(id);
  if (!l) return;
  const v = await pickLocation({
    title: `Déplacer « ${l.name} » dans…`,
    noneLabel: "Aucun (emplacement de premier niveau)",
    current: l.parent_id,
    exclude: descendants(id),
  });
  if (v === undefined || v === l.parent_id) return;
  try {
    const saved = await api("PATCH", `api/locations/${id}`, { parent_id: v });
    S.locs.set(saved.id, saved);
    rebuild();
    render();
    toast(`« ${l.name} » déplacé ${v == null ? "au premier niveau" : `dans « ${S.locs.get(v).name} »`}, avec tout son contenu.`);
  } catch (e) { toast(e.message, { err: true }); }
}

$("#dlgMove").addEventListener("click", async (e) => {
  const m = e.target.closest("[data-move]");
  if (m) { M.part = m.dataset.move === "part"; drawMove(); if (M.part) $("#moveQty").select(); return; }
  const st = e.target.closest("[data-mstep]");
  if (st) {
    const q = $("#moveQty");
    q.value = Math.min(M.it.qty, Math.max(1, (parseInt(q.value, 10) || 1) + Number(st.dataset.mstep)));
    drawMove(); return;
  }
  if (e.target.closest("#moveDest")) {
    const v = await pickLocation({
      title: `Déplacer « ${M.it.name} » vers…`, current: M.dest,
      exclude: new Set(M.it.location_id != null ? [M.it.location_id] : []), excludeTitle: "L’article est déjà rangé ici",
    });
    if (v != null) { M.dest = v; drawMove(); }
  }
});
$("#moveQty").addEventListener("input", drawMove);
$("#formMove").addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = M.part ? Math.min(M.it.qty, Math.max(1, parseInt($("#moveQty").value, 10) || 1)) : null;
  const res = await doMove(M.it, M.dest, n);
  if (res) { const r = M.resolve; M.resolve = null; $("#dlgMove").close(); r && r(res); }
});
$("#dlgMove").addEventListener("close", () => { if (M.resolve) { const r = M.resolve; M.resolve = null; r(null); } });

/* ---------- Article acheté ---------- */

const Buy = { it: null, loc: null, level: 2 };

function openBuy(id) {
  const it = S.items.get(id);
  if (!it) return;
  Object.assign(Buy, { it, loc: it.location_id, level: Math.max(2, it.level) });
  $("#buyName").textContent = it.name;
  $("#buyQty").value = 1;
  $("#buyExact").hidden = it.qty_mode !== "exact";
  $("#buyApprox").hidden = it.qty_mode !== "approx";
  drawBuy();
  $("#dlgBuy").showModal();
  if (it.qty_mode === "exact") $("#buyQty").select();
}

function drawBuy() {
  const it = Buy.it;
  const n = Math.max(1, parseInt($("#buyQty").value, 10) || 1);
  $("#buyHint").innerHTML = `Stock : ${it.qty} → <b>${it.qty + n}</b>`;
  $$("#dlgBuy [data-blevel]").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.blevel) === Buy.level));
  $("#buyLoc").innerHTML = (Buy.loc != null ? pathHTML(Buy.loc, { links: false }) : '<div class="path none"><span>Choisir un emplacement</span></div>')
    + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
}

async function pickBuyLoc() {
  const v = await pickLocation({ title: `Où rangez-vous « ${Buy.it.name} » ?`, current: Buy.loc });
  if (v != null) { Buy.loc = v; drawBuy(); }
}

$("#dlgBuy").addEventListener("click", (e) => {
  const st = e.target.closest("[data-bstep]");
  if (st) { const q = $("#buyQty"); q.value = Math.max(1, (parseInt(q.value, 10) || 1) + Number(st.dataset.bstep)); drawBuy(); return; }
  const lv = e.target.closest("[data-blevel]");
  if (lv) { Buy.level = Number(lv.dataset.blevel); drawBuy(); return; }
  if (e.target.closest("#buyLoc")) pickBuyLoc();
});
$("#buyQty").addEventListener("input", drawBuy);
$("#formBuy").addEventListener("submit", async (e) => {
  e.preventDefault();
  const it = Buy.it;
  if (Buy.loc == null) { toast("Indiquez où vous rangez cet article.", { err: true }); pickBuyLoc(); return; }
  const body = { wanted: false, location_id: Buy.loc, event: "buy" };
  if (it.qty_mode === "exact") body.qty = it.qty + Math.max(1, parseInt($("#buyQty").value, 10) || 1);
  else body.level = Buy.level;
  try {
    const saved = await api("PATCH", `api/items/${it.id}`, body);
    S.items.set(saved.id, saved);
    rebuild();
    $("#dlgBuy").close();
    render();
    toast(saved.qty_mode === "exact"
      ? `« ${saved.name} » ajouté au stock (${saved.qty} au total).`
      : `« ${saved.name} » ajouté au stock.`);
  } catch (err) { toast(err.message, { err: true }); }
});

/* ---------- Filtre par tag (inventaire) ---------- */

function renderTagbar() {
  const bar = $("#tagbar");
  const counts = allTagCounts();
  for (const t of [...S.tagFilter]) if (!counts.has(t)) S.tagFilter.delete(t);
  if (route().view !== "inventaire" || !counts.size) { bar.hidden = true; return; }
  bar.hidden = false;
  $("#tagSel").innerHTML = [...S.tagFilter].map((t) =>
    `<button type="button" class="chip" aria-pressed="true" data-tagdel="${esc(t)}" aria-label="Retirer le filtre ${esc(t)}">${esc(t)} ${ICON_X}</button>`).join("");
  const freq = [...counts.entries()].filter(([t]) => !S.tagFilter.has(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr")).slice(0, 8);
  $("#tagFreq").innerHTML = freq.map(([t, n]) =>
    `<button type="button" class="chip" data-tagadd="${esc(t)}">${esc(t)} <span class="n">${n}</span></button>`).join("");
}

let dropSel = 0;
function drawTagDrop() {
  const input = $("#tagQ");
  const drop = $("#tagDrop");
  const tokens = words(input.value);
  let cands = [...allTagCounts().entries()].filter(([t]) => !S.tagFilter.has(t));
  if (tokens.length) {
    cands = cands.map(([t, n]) => {
      const w = words(t);
      let sc = 0;
      for (const k of tokens) { const v = tokenScore(k, w, w.join("")); if (!v) return null; sc += v; }
      return [t, n, sc];
    }).filter(Boolean).sort((a, b) => b[2] - a[2] || b[1] - a[1]);
  } else {
    cands.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"));
  }
  cands = cands.slice(0, 30);
  dropSel = 0;
  drop.innerHTML = cands.length
    ? cands.map(([t, n], i) => `<li role="option" data-tag="${esc(t)}" aria-selected="${i === 0}"><span>${esc(t)}</span><span class="n">${n}</span></li>`).join("")
    : '<li class="none">Aucun tag ne correspond.</li>';
  const show = document.activeElement === input;
  drop.hidden = !show;
  input.setAttribute("aria-expanded", show);
}

function addTagFilter(t) {
  S.tagFilter.add(t);
  $("#tagQ").value = "";
  render();
  drawTagDrop();
}

$("#tagQ").addEventListener("input", drawTagDrop);
$("#tagQ").addEventListener("focus", drawTagDrop);
$("#tagQ").addEventListener("blur", () => setTimeout(() => { $("#tagDrop").hidden = true; $("#tagQ").setAttribute("aria-expanded", "false"); }, 150));
$("#tagQ").addEventListener("keydown", (e) => {
  const lis = $$("#tagDrop li[data-tag]");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!lis.length) return;
    dropSel = e.key === "ArrowDown" ? Math.min(lis.length - 1, dropSel + 1) : Math.max(0, dropSel - 1);
    lis.forEach((li, i) => li.setAttribute("aria-selected", i === dropSel));
    lis[dropSel].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (lis[dropSel]) addTagFilter(lis[dropSel].dataset.tag);
  } else if (e.key === "Escape") {
    e.target.value = ""; $("#tagDrop").hidden = true;
  } else if (e.key === "Backspace" && !e.target.value && S.tagFilter.size) {
    S.tagFilter.delete([...S.tagFilter].at(-1)); render(); drawTagDrop();
  }
});
$("#tagDrop").addEventListener("mousedown", (e) => e.preventDefault());
$("#tagDrop").addEventListener("click", (e) => { const li = e.target.closest("li[data-tag]"); if (li) addTagFilter(li.dataset.tag); });
$("#tagbar").addEventListener("click", (e) => {
  const del = e.target.closest("[data-tagdel]");
  if (del) { S.tagFilter.delete(del.dataset.tagdel); render(); return; }
  const add = e.target.closest("[data-tagadd]");
  if (add) { S.tagFilter.add(add.dataset.tagadd); render(); }
});

/* ---------- Page des tags ---------- */

function viewTags() {
  const counts = allTagCounts();
  if (!counts.size) {
    return `<div class="empty"><h3>Aucun tag pour l’instant</h3><p>Ajoutez des tags dans la fiche de vos articles : ils apparaîtront ici, et vous pourrez les renommer ou les fusionner.</p></div>`;
  }
  return `<div class="tags-tools">
      <input id="tagsQ" type="search" autocomplete="off" placeholder="Chercher un tag" aria-label="Chercher un tag" value="${esc(S.tagsQuery)}">
      <div class="seg small" role="group" aria-label="Ordre">
        <button type="button" data-tsort="alpha" aria-pressed="${S.tagsSort === "alpha"}">Alphabétique</button>
        <button type="button" data-tsort="count" aria-pressed="${S.tagsSort === "count"}">Plus utilisés</button>
      </div>
      <span class="sub" id="tagsCount"></span>
    </div>
    <div id="tagsList"></div>`;
}

function drawTagsList() {
  const box = $("#tagsList");
  if (!box) return;
  const tokens = words(S.tagsQuery);
  let rows = [...allTagCounts().entries()];
  if (tokens.length) rows = rows.filter(([t]) => { const w = words(t); return tokens.every((k) => tokenScore(k, w, w.join("")) > 0); });
  const coll = (a, b) => a[0].localeCompare(b[0], "fr", { numeric: true });
  rows.sort(S.tagsSort === "count" ? (a, b) => b[1] - a[1] || coll(a, b) : coll);
  $("#tagsCount").textContent = plural(rows.length, "tag", "tags");
  if (!rows.length) { box.innerHTML = '<div class="empty"><p>Aucun tag ne correspond.</p></div>'; return; }
  let html = "", letter = null;
  for (const [t, n] of rows) {
    if (S.tagsSort === "alpha") {
      const l = (words(t)[0] || "#")[0].toUpperCase();
      const L = /[A-Z]/.test(l) ? l : "#";
      if (L !== letter) { letter = L; html += `<li class="letter">${L}</li>`; }
    }
    html += `<li><button type="button" class="tname" data-tview="${esc(t)}" title="Voir les articles">${esc(t)}</button><span class="n">${n}</span>
      <button type="button" class="btn ghost icon" data-trename="${esc(t)}" title="Renommer ou fusionner" aria-label="Renommer ${esc(t)}">${ICON_PENCIL}</button>
      <button type="button" class="btn ghost icon danger" data-tdelete="${esc(t)}" title="Supprimer" aria-label="Supprimer ${esc(t)}">${ICON_TRASH}</button></li>`;
  }
  box.innerHTML = `<ul class="tag-grid">${html}</ul>`;
}

document.addEventListener("input", (e) => {
  if (e.target.id === "tagsQ") { S.tagsQuery = e.target.value; drawTagsList(); }
});

async function renameTag(old) {
  const input = prompt(`Nouveau nom pour le tag « ${old} ».\nSi ce nom existe déjà, les deux tags seront fusionnés.`, old);
  if (input == null) return;
  const name = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!name || name === old) return;
  const merge = allTagCounts().has(name);
  try {
    const res = await api("POST", "api/tags/rename", { old, new: name });
    if (S.tagFilter.delete(old)) S.tagFilter.add(name);
    await load({ silent: true });
    toast(merge ? `« ${old} » fusionné dans « ${name} » (${plural(res.count, "article", "articles")}).` : `Tag renommé en « ${name} ».`);
  } catch (e) { toast(e.message, { err: true }); }
}

async function deleteTag(tag) {
  const n = allTagCounts().get(tag) || 0;
  if (!confirm(`Retirer le tag « ${tag} » de ${plural(n, "article", "articles")} ? Les articles eux-mêmes sont conservés.`)) return;
  try {
    await api("POST", "api/tags/rename", { old: tag, new: "" });
    S.tagFilter.delete(tag);
    await load({ silent: true });
    toast(`Tag « ${tag} » supprimé.`);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ---------- Stock bas ---------- */

function viewBas() {
  const low = [...S.items.values()].filter(isLow).sort(sortItems);
  if (!low.length) {
    return `<div class="empty"><h3>Aucun article en stock bas</h3><p>Définissez un seuil d’alerte dans la fiche d’un article : il apparaîtra ici quand son stock passera sous ce seuil.</p></div>`;
  }
  return `<section class="section"><div class="section-head"><h2>Stock bas</h2><span class="count">${low.length}</span></div>
    <p class="verif-intro">Ces articles sont passés sous leur seuil d’alerte. Ajoutez ceux que vous voulez racheter à la liste d’achat.</p>
    ${listHTML(low.map((it) => itemRowHTML(it, { want: true })))}</section>`;
}

async function toggleWant(id) {
  const it = S.items.get(id);
  try {
    const saved = await api("PATCH", `api/items/${id}`, { wanted: !it.wanted });
    S.items.set(id, saved);
    rebuild();
    refreshRows(id);
    toast(saved.wanted ? `« ${saved.name} » ajouté à la liste d’achat.` : `« ${saved.name} » retiré de la liste d’achat.`);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ---------- Outils : sauvegarde, export, import ---------- */

function applyName() {
  $("#brandName").textContent = S.name;
  document.title = S.name ? `Inventaire – ${S.name}` : "Inventaire";
}

async function saveName() {
  const input = $("#setName");
  const name = input.value.trim();
  if (!name) { toast("Le nom ne peut pas être vide.", { err: true }); input.focus(); return; }
  try {
    const st = await api("PUT", "api/settings", { name });
    S.name = st.name;
    applyName();
    toast(`Nom enregistré : « ${st.name} ».`);
  } catch (e) { toast(e.message, { err: true }); }
}

function viewOutils() {
  return `<div class="tools">
    <section class="tool">
      <h2>Nom de l’atelier</h2>
      <p>Affiché en haut de chaque page, sur les étiquettes imprimées et dans le nom des fichiers exportés.</p>
      <div class="proj-new" style="margin:0"><input id="setName" type="text" maxlength="60" autocomplete="off" value="${esc(S.name)}" aria-label="Nom de l’atelier">
        <button type="button" class="btn primary" data-act="save-name">Enregistrer</button></div>
    </section>
    <section class="tool">
      <h2>Sauvegardes</h2>
      <p id="bkStatus">Vérification de l’état des sauvegardes…</p>
      <p>Chaque jour, une copie complète (base et photos) est enregistrée dans le dossier de sauvegarde du serveur, idéalement placé sur un autre disque que les données. Pour vous protéger aussi d’une panne du serveur lui-même, téléchargez une copie sur votre PC de temps en temps.</p>
      <div class="actions"><a class="btn primary" href="api/backup" download>Télécharger une sauvegarde complète</a></div>
    </section>
    <section class="tool">
      <h2>Exporter</h2>
      <p>Tout l’inventaire dans un fichier tableur (CSV, séparateur point-virgule), lisible par Excel ou LibreOffice.</p>
      <div class="actions"><a class="btn" href="api/export.csv" download>Exporter l’inventaire</a></div>
    </section>
    <section class="tool">
      <h2>Importer</h2>
      <p>Ajoutez une liste d’articles d’un coup depuis un fichier CSV. Seule la colonne « nom » est obligatoire. Les emplacements écrits sous la forme « Bureau › Meuble A › Carton X » sont créés s’ils n’existent pas, et un article déjà présent au même endroit sous le même nom est ignoré.</p>
      <div class="actions">
        <button type="button" class="btn primary" data-act="import">Importer un fichier CSV</button>
        <a class="btn" href="api/import-template.csv" download>Télécharger le modèle</a>
      </div>
      <div id="importResult">${S.importResult}</div>
    </section>
    <p class="sub">Version ${esc(S.version)}</p>
  </div>`;
}

async function loadBackupStatus() {
  try {
    const st = await api("GET", "api/backups");
    const el = $("#bkStatus");
    if (!el) return;
    if (!st.enabled) {
      el.innerHTML = "<b>La sauvegarde automatique est inactive</b> : le dossier de sauvegarde est introuvable sur le serveur. Vérifiez le fichier docker-compose.yml.";
    } else if (!st.count) {
      el.innerHTML = "La première sauvegarde automatique est en cours ou interviendra dans l’heure.";
    } else {
      el.innerHTML = `Dernière sauvegarde automatique : <b>${fmtDateTime(st.last)}</b>. ${plural(st.count, "copie conservée", "copies conservées")} sur ${st.keep} au maximum.`;
    }
  } catch (e) {
    const el = $("#bkStatus"); if (el) el.textContent = e.message;
  }
}

$("#csvInput").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  try {
    const r = await api("POST", "api/import", fd);
    const parts = [`<b>${plural(r.created, "article ajouté", "articles ajoutés")}</b>`];
    if (r.locations) parts.push(plural(r.locations, "emplacement créé", "emplacements créés"));
    if (r.skipped) parts.push(`${plural(r.skipped, "article ignoré", "articles ignorés")} car déjà présent${r.skipped > 1 ? "s" : ""}`);
    S.importResult = `<div class="import-result"><p>Import de « ${esc(f.name)} » : ${parts.join(", ")}.</p>${r.errors.length ? `<ul>${r.errors.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`;
    await load({ silent: true });
    toast(`${plural(r.created, "article importé", "articles importés")}.`);
  } catch (err) { toast(err.message, { err: true }); }
});

/* ---------- Vérification d'un contenant ---------- */

const V = { loc: null, marks: new Map() };

function verifRowHTML(it) {
  const m = V.marks.get(it.id);
  return `<li class="row verif${m ? " " + m : ""}" data-item="${it.id}" tabindex="0">
    ${thumbHTML(it.photo, ICON_ITEM)}
    <div class="row-main"><div class="row-name">${isLow(it) ? '<span class="low-flag" aria-label="Stock bas">!</span>' : ""}${esc(it.name)}</div>${it.tags.length ? `<div class="row-tags">${it.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}</div>
    ${qtyHTML(it)}
    <div class="marks" role="group" aria-label="Pointage">
      <button type="button" data-act="mark" data-mark="ok" aria-pressed="${m === "ok"}">Présent</button>
      <button type="button" data-act="mark" data-mark="missing" aria-pressed="${m === "missing"}">Absent</button>
    </div>
  </li>`;
}

function viewVerif(id) {
  const loc = S.locs.get(id);
  if (!loc) return `<div class="empty"><h3>Cet emplacement n’existe plus</h3><div class="actions"><a class="btn" href="#/lieux">Voir les emplacements</a></div></div>`;
  if (V.loc !== id) { V.loc = id; V.marks = new Map(); }
  const items = itemsIn(id).sort(sortItems);
  const kids = (S.kids.get(id) || []).map((k) => S.locs.get(k));
  const crumbs = `<nav class="crumbs" aria-label="Chemin"><a href="#/lieux">Emplacements</a>${locPath(id).map((l) => `<a href="#/lieu/${l.id}">${esc(l.name)}</a>`).join("")}<span>Vérification</span></nav>`;
  let html = crumbs;
  if (items.length) {
    html += `<p class="verif-intro">Pointez chaque article présent et corrigez la quantité si besoin. Les articles marqués absents passeront en épuisé, sans être supprimés.</p>
      ${listHTML(items.map(verifRowHTML))}`;
  } else {
    html += `<div class="empty"><h3>Aucun article rangé directement ici</h3><p>Vous pouvez tout de même marquer ce contenant comme vérifié.</p></div>`;
  }
  if (kids.length) {
    html += `<section class="section"><div class="section-head"><h2>Contenants à vérifier séparément</h2><span class="count">${kids.length}</span></div>
      <div class="loc-hits">${kids.map((k) => `<a class="loc-hit" href="#/verif/${k.id}">${thumbHTML(k.photo, ICON_BOX)}<span>${esc(k.name)}</span></a>`).join("")}</div></section>`;
  }
  html += `<div class="verif-bar"><span class="progress" id="verifProgress"></span>
    <a class="btn ghost" href="#/lieu/${id}">Annuler</a>
    ${items.length ? '<button type="button" class="btn primary" data-act="verif-done">Terminer la vérification</button>'
                   : '<button type="button" class="btn primary" data-act="verif-quick">Marquer comme vérifié</button>'}</div>`;
  return html;
}

function drawVerifBar() {
  const el = $("#verifProgress");
  if (!el || V.loc == null) return;
  const total = itemsIn(V.loc).length;
  const done = [...V.marks.keys()].filter((id) => S.items.get(id)?.location_id === V.loc).length;
  el.innerHTML = total ? `<b>${done}</b> / ${total} pointés` : "";
}

function markVerif(id, mark) {
  if (V.marks.get(id) === mark) V.marks.delete(id); else V.marks.set(id, mark);
  refreshRows(id);
}

async function finishVerif(quick = false) {
  const id = V.loc;
  const loc = S.locs.get(id);
  if (!loc) return;
  const items = itemsIn(id);
  if (!quick) {
    const unmarked = items.filter((it) => !V.marks.has(it.id)).length;
    if (unmarked && !confirm(`${plural(unmarked, "article n’a pas été pointé", "articles n’ont pas été pointés")}. Terminer quand même ? Ils resteront inchangés.`)) return;
  }
  const missing = items.filter((it) => V.marks.get(it.id) === "missing");
  try {
    for (const it of missing) {
      const body = it.qty_mode === "approx" ? { level: 0, event: "missing" } : { qty: 0, event: "missing" };
      S.items.set(it.id, await api("PATCH", `api/items/${it.id}`, body));
    }
    S.locs.set(id, await api("PATCH", `api/locations/${id}`, { verified: true }));
    rebuild();
    const ok = items.filter((it) => V.marks.get(it.id) === "ok").length;
    V.loc = null; V.marks = new Map();
    location.hash = `#/lieu/${id}`;
    toast(quick ? `« ${loc.name} » marqué comme vérifié.` : `Vérification terminée : ${plural(ok, "présent", "présents")}, ${plural(missing.length, "absent", "absents")}.`);
  } catch (e) { toast(e.message, { err: true }); }
}

/* ---------- Étiquette imprimable ---------- */

function printLabel(id) {
  const loc = S.locs.get(id);
  if (!loc) return;
  const qtyText = (it) => isOut(it) ? "épuisé" : it.qty_mode === "approx" ? LEVELS[it.level].toLowerCase() : `× ${it.qty}`;
  const block = (lid) => {
    const items = itemsIn(lid).sort((a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }));
    let h = items.length
      ? `<ul>${items.map((it) => `<li><span>${esc(it.name)}</span><span>${qtyText(it)}</span></li>`).join("")}</ul>`
      : "";
    for (const k of S.kids.get(lid) || []) {
      const sub = S.locs.get(k);
      const path = locPath(k).slice(locPath(id).length).map((l) => esc(l.name)).join(" › ");
      h += `<h2>${path}</h2>${block(k) || '<p class="lempty">Vide</p>'}`;
    }
    return h;
  };
  const parent = locPath(id).slice(0, -1).map((l) => esc(l.name)).join(" › ");
  const body = block(id) || '<p class="lempty">Ce contenant est vide.</p>';
  $("#print").innerHTML = `<div class="label">${parent ? `<div class="lpath">${parent}</div>` : ""}<h1>${esc(loc.name)}</h1>
    <div class="ldate">${esc(S.name)}, contenu au ${fmtDate(new Date().toISOString())}</div>${body}</div>`;
  window.print();
}

/* ---------- Projets ---------- */

const ICON_PROJ = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/></svg>';
const PJ = { list: null, cur: null, loading: null, pick: null, dropSel: 0 };

const normName = (s) => words(s).join(" ");
function sameName(it) {
  const k = normName(it.name);
  return [...S.items.values()].filter((x) => x.qty_mode === "exact" && normName(x.name) === k);
}
const totalStock = (it) => it.qty_mode === "exact" ? sameName(it).reduce((a, x) => a + x.qty, 0) : null;

function fetchProjects(id) {
  const key = id == null ? "list" : `p${id}`;
  if (PJ.loading === key) return;
  PJ.loading = key;
  api("GET", id == null ? "api/projects" : `api/projects/${id}`)
    .then((d) => { if (id == null) PJ.list = d; else PJ.cur = d; })
    .catch((e) => { if (id == null) PJ.list = []; else PJ.cur = { id, missing: true, error: e.message }; })
    .finally(() => { PJ.loading = null; render(); });
}

function viewProjets() {
  if (!PJ.list) { fetchProjects(null); return '<p class="sub">Chargement des projets…</p>'; }
  const form = `<div class="proj-new"><input id="newProj" type="text" maxlength="200" autocomplete="off" placeholder="Nom du nouveau projet, par exemple « Station météo »" aria-label="Nom du nouveau projet">
    <button type="button" class="btn primary" data-act="proj-create">Créer</button></div>`;
  if (!PJ.list.length) {
    return form + `<div class="empty"><h3>Aucun projet pour l’instant</h3><p>Un projet rassemble les composants à sortir pour une réalisation. L’outil en tire une liste de sortie classée par emplacement, puis décompte le stock en une fois.</p></div>`;
  }
  const rows = PJ.list.map((p) => {
    const sub = p.status === "done"
      ? `Sorti le ${fmtDate(p.done_at)}`
      : `En préparation, ${plural(p.line_count, "composant", "composants")}`;
    return `<li class="row" data-proj="${p.id}" tabindex="0">
      <div class="thumb">${ICON_PROJ}</div>
      <div class="row-main"><div class="row-name">${esc(p.name)}<span class="badge ${p.status}">${p.status === "done" ? "Sorti" : "En préparation"}</span></div><div class="sub">${sub}</div></div>
      ${ICON_CHEV}</li>`;
  });
  return form + listHTML(rows);
}

function projCrumbs(p, extra) {
  return `<nav class="crumbs" aria-label="Chemin"><a href="#/projets">Projets</a>${extra
    ? `<a href="#/projet/${p.id}">${esc(p.name)}</a><span>${extra}</span>` : `<span>${esc(p.name)}</span>`}</nav>`;
}

function viewProjet(id, sortie) {
  if (!PJ.cur || PJ.cur.id !== id) { fetchProjects(id); return '<p class="sub">Chargement du projet…</p>'; }
  const p = PJ.cur;
  if (p.missing) return `<div class="empty"><h3>Projet introuvable</h3><p>${esc(p.error || "")}</p><div class="actions"><a class="btn" href="#/projets">Tous les projets</a></div></div>`;
  if (p.status === "done") return viewProjetDone(p);
  if (sortie) return viewSortie(p);

  const lines = p.lines.map((ln) => {
    const it = ln.item_id != null ? S.items.get(ln.item_id) : null;
    if (!it) {
      return `<li class="row" data-line="${ln.id}"><div class="thumb">${ICON_ITEM}</div>
        <div class="row-main"><div class="row-name">${esc(ln.name)}</div><div class="warn">Cet article a été supprimé de l’inventaire.</div></div>
        <div class="row-actions"><button type="button" class="btn ghost icon del" data-act="line-del" aria-label="Retirer">${ICON_X}</button></div></li>`;
    }
    const total = totalStock(it);
    const elsewhere = total != null ? total - it.qty : 0;
    const stock = it.qty_mode === "approx"
      ? `Stock : ${LEVELS[it.level].toLowerCase()}`
      : `Stock : ${it.qty} ici${elsewhere ? `, ${elsewhere} ailleurs` : ""}`;
    const warn = it.qty_mode === "exact" && ln.qty > total ? `<div class="warn">Stock insuffisant : ${total} disponible${total > 1 ? "s" : ""} au total.</div>` : "";
    const ctrl = it.qty_mode === "exact"
      ? `<div class="line-qty"><button type="button" data-act="line-dec" aria-label="Un de moins">−</button><input class="line-qty-in" type="number" min="0" inputmode="numeric" value="${ln.qty}" aria-label="Quantité nécessaire"><button type="button" data-act="line-inc" aria-label="Un de plus">+</button></div>`
      : `<span class="free-qty">Quantité libre</span>`;
    return `<li class="row" data-line="${ln.id}" data-line-item="${it.id}">
      ${thumbHTML(it.photo, ICON_ITEM)}
      <div class="row-main"><div class="row-name">${isLow(it) ? '<span class="low-flag" aria-label="Stock bas">!</span>' : ""}${esc(it.name)}</div>${pathHTML(it.location_id)}<div class="stock-info">${stock}</div>${warn}</div>
      <div class="row-actions">${ctrl}<button type="button" class="btn ghost icon del" data-act="line-del" aria-label="Retirer ${esc(it.name)}">${ICON_X}</button></div>
    </li>`;
  });

  return `${projCrumbs(p)}
    <div class="proj-head"><span class="badge draft">En préparation</span><span class="spacer"></span>
      <button type="button" class="btn ghost" data-act="proj-rename">Renommer</button>
      <button type="button" class="btn ghost danger" data-act="proj-del">Supprimer</button></div>
    <div class="proj-add">
      <svg class="lead" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <input id="projAdd" type="text" autocomplete="off" spellcheck="false" placeholder="Ajouter un composant : tapez son nom…" aria-label="Ajouter un composant" role="combobox" aria-expanded="false" aria-controls="projDrop">
      <ul id="projDrop" class="drop" role="listbox" hidden></ul>
    </div>
    ${p.lines.length
      ? `<section class="section"><div class="section-head"><h2>À sortir</h2><span class="count">${p.lines.length}</span><span class="spacer"></span>
          <a class="btn primary" href="#/projet/${p.id}/sortie">Préparer la sortie</a></div>${listHTML(lines)}</section>`
      : `<div class="empty"><h3>Liste vide</h3><p>Tapez le nom d’un composant dans le champ ci-dessus, puis Entrée pour l’ajouter. Enchaînez ainsi tous les composants du projet.</p></div>`}`;
}

function drawProjDrop() {
  const input = $("#projAdd");
  const drop = $("#projDrop");
  if (!input || !drop) return;
  const tokens = words(input.value);
  if (!tokens.length || document.activeElement !== input) { drop.hidden = true; input?.setAttribute("aria-expanded", "false"); return; }
  const hits = [...S.items.values()].map((it) => [scoreItem(it, tokens), it]).filter((h) => h[0] > 0)
    .sort((a, b) => (isOut(a[1]) - isOut(b[1])) || b[0] - a[0]).slice(0, 12).map((h) => h[1]);
  PJ.dropSel = 0;
  drop.innerHTML = hits.length
    ? hits.map((it, i) => `<li role="option" data-add-item="${it.id}" aria-selected="${i === 0}">${thumbHTML(it.photo, ICON_ITEM)}
        <div class="row-main"><div class="row-name">${esc(it.name)}</div>${pathHTML(it.location_id, { links: false })}</div>
        <span class="stock">${it.qty_mode === "approx" ? LEVELS[it.level] : `${it.qty} en stock`}</span></li>`).join("")
    : '<li class="none">Aucun article ne correspond. Ajoutez-le d’abord à l’inventaire.</li>';
  drop.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

async function projAction(fn, success) {
  try {
    const res = await fn();
    if (res && res.lines) PJ.cur = res;
    render();
    if (success) toast(success);
    return res;
  } catch (e) { toast(e.message, { err: true }); return null; }
}

async function addLine(itemId) {
  const it = S.items.get(itemId);
  await projAction(() => api("POST", `api/projects/${PJ.cur.id}/lines`, { item_id: itemId, qty: 1 }), `« ${it.name} » ajouté au projet.`);
  const input = $("#projAdd");
  if (input) { input.value = ""; input.focus(); }
}

const lineTimers = new Map();
function setLineQty(lineId, qty, { now: immediate = false } = {}) {
  const ln = PJ.cur.lines.find((l) => l.id === lineId);
  if (!ln) return;
  ln.qty = Math.max(0, qty);
  clearTimeout(lineTimers.get(lineId));
  const send = () => api("PATCH", `api/projects/${PJ.cur.id}/lines/${lineId}`, { qty: ln.qty })
    .then((d) => { PJ.cur = d; }).catch((e) => toast(e.message, { err: true }));
  if (immediate) send(); else lineTimers.set(lineId, setTimeout(send, 400));
}

/* Liste de sortie : répartition et ordre de passage */

function locOrder() {
  const order = new Map();
  let i = 0;
  const walk = (k) => { for (const id of S.kids.get(k) || []) { order.set(id, i++); walk(id); } };
  walk("root");
  return order;
}

function buildPick(p) {
  const rows = [], short = [], gone = [];
  const used = new Set();
  const lines = p.lines.map((ln) => ({ ln, it: ln.item_id != null ? S.items.get(ln.item_id) : null }));
  for (const { ln, it } of lines) if (!it) gone.push(ln.name);
  const valid = lines.filter((x) => x.it);

  // 1. Articles approximatifs et articles présents à un seul endroit : emplacement imposé
  const multi = [];
  for (const x of valid) {
    if (x.it.qty_mode === "approx") {
      rows.push({ key: `a${x.it.id}`, item_id: x.it.id, approx: true, level: x.it.level, checked: false });
      used.add(x.it.location_id);
      continue;
    }
    if (x.ln.qty <= 0) continue;
    const cands = sameName(x.it).filter((c) => c.qty > 0 || c.id === x.it.id);
    if (cands.filter((c) => c.qty > 0).length <= 1) {
      const c = cands.find((c) => c.qty > 0);
      if (c) {
        rows.push({ key: `e${c.id}`, item_id: c.id, qty: Math.min(x.ln.qty, c.qty), checked: false });
        used.add(c.location_id);
      }
      const total = cands.reduce((a, c2) => a + c2.qty, 0);
      if (x.ln.qty > total) short.push({ name: x.it.name, missing: x.ln.qty - total });
    } else {
      multi.push({ ...x, cands });
    }
  }
  // 2. Composants présents à plusieurs endroits : priorité aux cartons déjà ouverts
  multi.sort((a, b) => b.ln.qty - a.ln.qty);
  for (const { ln, it, cands } of multi) {
    let need = ln.qty;
    const sorted = [...cands].filter((c) => c.qty > 0).sort((a, b) =>
      (used.has(b.location_id) - used.has(a.location_id)) || ((b.id === it.id) - (a.id === it.id)) || b.qty - a.qty);
    for (const c of sorted) {
      if (need <= 0) break;
      const take = Math.min(need, c.qty);
      const existing = rows.find((r) => r.item_id === c.id && !r.approx);
      if (existing) existing.qty += take;
      else rows.push({ key: `e${c.id}`, item_id: c.id, qty: take, checked: false });
      used.add(c.location_id);
      need -= take;
    }
    if (need > 0) short.push({ name: it.name, missing: need });
  }
  return { pid: p.id, rows, short, gone };
}

function viewSortie(p) {
  if (!p.lines.length) { location.hash = `#/projet/${p.id}`; return ""; }
  if (!PJ.pick || PJ.pick.pid !== p.id) PJ.pick = buildPick(p);
  const pk = PJ.pick;
  const order = locOrder();
  const groups = new Map();
  for (const r of pk.rows) {
    const it = S.items.get(r.item_id);
    if (!it) continue;
    const k = it.location_id ?? "none";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "none") - (b === "none") || (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const nItems = pk.rows.length;
  let html = `${projCrumbs(p, "Sortie")}
    <p class="pick-summary">Ordre de passage : <b>${plural(keys.length, "emplacement", "emplacements")}</b>, <b>${plural(nItems, "ligne", "lignes")}</b>. Cochez au fur et à mesure ; les quantités restent modifiables jusqu’à la validation.</p>`;
  if (pk.short.length || pk.gone.length) {
    html += `<div class="shortfall"><b>Attention</b><ul>${pk.short.map((s) => `<li>Il manque ${s.missing} × « ${esc(s.name)} » : le stock total ne suffit pas.</li>`).join("")}${pk.gone.map((g) => `<li>« ${esc(g)} » n’existe plus dans l’inventaire.</li>`).join("")}</ul></div>`;
  }
  keys.forEach((k, i) => {
    const ph = k === "none" ? null : nearestPhoto(k);
    html += `<section class="pick-group"><div class="pick-group-head"><span class="step-n">${i + 1}</span>
      ${ph ? `<button type="button" class="thumb" data-act="zoom" data-photo="${ph.photo}" aria-label="Photo de ${esc(ph.name)}"><img src="${thumbUrl(ph.photo)}" alt=""></button>` : ""}
      ${k === "none" ? '<div class="path none"><span>Sans emplacement</span></div>' : pathHTML(k, { links: false })}</div>
      ${listHTML(groups.get(k).map(pickRowHTML))}</section>`;
  });
  html += `<div class="verif-bar"><span class="progress" id="pickProgress"></span>
    <a class="btn ghost" href="#/projet/${p.id}">Retour à la liste</a>
    <button type="button" class="btn primary" data-act="sortie-validate">Valider la sortie</button></div>`;
  return html;
}

function pickRowHTML(r) {
  const it = S.items.get(r.item_id);
  let ctrl, warn = "";
  if (r.approx) {
    ctrl = `<div class="seg small" role="group" aria-label="Niveau restant après la sortie">${LEVELS.map((l, i) =>
      `<button type="button" data-act="pick-level" data-lvl="${i}" aria-pressed="${r.level === i}">${l}</button>`).join("")}</div>`;
  } else {
    ctrl = `<div class="line-qty"><button type="button" data-act="pick-dec" aria-label="Un de moins">−</button><input class="pick-qty-in" type="number" min="0" inputmode="numeric" value="${r.qty}" aria-label="Quantité à prendre"><button type="button" data-act="pick-inc" aria-label="Un de plus">+</button><span class="of">sur ${it.qty}</span></div>`;
    if (r.qty > it.qty) warn = `<div class="warn">Seulement ${it.qty} en stock à cet endroit.</div>`;
  }
  return `<li class="row pick${r.checked ? " taken" : ""}" data-pick="${r.key}">
    <input type="checkbox" class="pick-check" data-act="pick-check" ${r.checked ? "checked" : ""} aria-label="Pris : ${esc(it.name)}">
    ${thumbHTML(it.photo, ICON_ITEM)}
    <div class="row-main"><div class="row-name">${esc(it.name)}</div>${r.approx ? '<div class="stock-info">Niveau restant après la sortie :</div>' : ""}${warn}</div>
    ${ctrl}</li>`;
}

function refreshPick(key) {
  const r = PJ.pick.rows.find((x) => x.key === key);
  const li = $(`#view li[data-pick="${key}"]`);
  if (r && li) {
    const tmp = document.createElement("template");
    tmp.innerHTML = pickRowHTML(r).trim();
    li.replaceWith(tmp.content.firstChild);
  }
  drawPickBar();
}

function drawPickBar() {
  const el = $("#pickProgress");
  if (!el || !PJ.pick) return;
  el.innerHTML = `<b>${PJ.pick.rows.filter((r) => r.checked).length}</b> / ${PJ.pick.rows.length} pris`;
}

async function validateSortie() {
  const p = PJ.cur, pk = PJ.pick;
  const over = pk.rows.filter((r) => !r.approx && r.qty > (S.items.get(r.item_id)?.qty ?? 0));
  if (over.length) { toast(`Quantité supérieure au stock pour « ${S.items.get(over[0].item_id).name} ». Corrigez-la avant de valider.`, { err: true }); return; }
  const unchecked = pk.rows.filter((r) => !r.checked).length;
  if (unchecked && !confirm(`${plural(unchecked, "ligne n’est pas cochée", "lignes ne sont pas cochées")}. Valider quand même ? Toutes les quantités indiquées seront décomptées du stock.`)) return;
  const takes = pk.rows.map((r) => r.approx ? { item_id: r.item_id, level: r.level } : { item_id: r.item_id, qty: r.qty })
    .filter((t) => t.level != null || t.qty > 0);
  try {
    const res = await api("POST", `api/projects/${p.id}/checkout`, { takes });
    for (const it of res.items) S.items.set(it.id, it);
    rebuild();
    PJ.cur = res.project; PJ.pick = null; PJ.list = null;
    const alerts = res.items.filter((it) => isLow(it) || isOut(it)).length;
    location.hash = `#/projet/${p.id}`;
    toast(`Sortie validée, stock mis à jour.${alerts ? ` ${plural(alerts, "article passe", "articles passent")} en stock bas ou épuisé.` : ""}`);
  } catch (e) { toast(e.message, { err: true }); }
}

function viewProjetDone(p) {
  const rows = p.takes.map((t) => {
    const it = t.item_id != null ? S.items.get(t.item_id) : null;
    const amount = t.qty != null ? `<output>−${t.qty}</output>` : `<span class="free-qty">${esc(t.level_from)} → ${esc(t.level_to)}</span>`;
    return `<li class="row"${it ? ` data-item="${it.id}"` : ""}>${thumbHTML(it?.photo, ICON_ITEM)}
      <div class="row-main"><div class="row-name">${esc(t.name)}</div><div class="path"><span>${esc(t.path || "Sans emplacement")}</span></div></div>
      <div class="qty">${amount}</div></li>`;
  });
  return `${projCrumbs(p)}
    <div class="proj-head"><span class="badge done">Sorti le ${fmtDate(p.done_at)}</span><span class="spacer"></span>
      <button type="button" class="btn primary" data-act="proj-dup">Refaire ce projet</button>
      <button type="button" class="btn ghost danger" data-act="proj-del">Supprimer</button></div>
    <section class="section takes-list"><div class="section-head"><h2>Composants sortis</h2><span class="count">${p.takes.length}</span></div>
    ${p.takes.length ? listHTML(rows) : '<div class="empty"><p>Aucune quantité n’a été sortie.</p></div>'}</section>`;
}

async function createProject() {
  const input = $("#newProj");
  const name = input.value.trim();
  if (!name) { toast("Donnez un nom au projet.", { err: true }); input.focus(); return; }
  try {
    const p = await api("POST", "api/projects", { name });
    PJ.cur = p; PJ.list = null;
    location.hash = `#/projet/${p.id}`;
    setTimeout(() => $("#projAdd")?.focus(), 50);
  } catch (e) { toast(e.message, { err: true }); }
}

function handleProjectClick(e, actEl) {
  const act = actEl?.dataset.act;
  const p = PJ.cur;
  const lineLi = actEl?.closest("[data-line]");
  const pickLi = actEl?.closest("[data-pick]");
  switch (act) {
    case "proj-create": createProject(); return true;
    case "proj-rename": {
      const n = prompt("Nouveau nom du projet :", p.name);
      if (n && n.trim() && n.trim() !== p.name) projAction(() => api("PATCH", `api/projects/${p.id}`, { name: n.trim() }), "Projet renommé.");
      return true;
    }
    case "proj-del":
      if (confirm(`Supprimer le projet « ${p.name} » ?${p.status === "done" ? " Le stock déjà décompté n’est pas modifié." : ""}`)) {
        api("DELETE", `api/projects/${p.id}`).then(() => { PJ.cur = null; PJ.list = null; location.hash = "#/projets"; toast("Projet supprimé."); })
          .catch((err) => toast(err.message, { err: true }));
      }
      return true;
    case "proj-dup":
      api("POST", `api/projects/${p.id}/duplicate`).then((np) => { PJ.cur = np; PJ.list = null; location.hash = `#/projet/${np.id}`; toast("Nouveau projet préparé avec la même liste. Ajustez-la si besoin."); })
        .catch((err) => toast(err.message, { err: true }));
      return true;
    case "line-inc": case "line-dec": {
      const id = Number(lineLi.dataset.line);
      const ln = p.lines.find((l) => l.id === id);
      setLineQty(id, ln.qty + (act === "line-inc" ? 1 : -1));
      render();
      return true;
    }
    case "line-del": {
      const id = Number(lineLi.dataset.line);
      projAction(() => api("DELETE", `api/projects/${p.id}/lines/${id}`));
      return true;
    }
    case "pick-check": case "pick-inc": case "pick-dec": case "pick-level": {
      const r = PJ.pick.rows.find((x) => x.key === pickLi.dataset.pick);
      if (act === "pick-check") r.checked = actEl.checked;
      else if (act === "pick-level") r.level = Number(actEl.dataset.lvl);
      else r.qty = Math.max(0, r.qty + (act === "pick-inc" ? 1 : -1));
      if (act !== "pick-check" && !r.approx) r.checked = r.checked || false;
      refreshPick(r.key);
      return true;
    }
    case "sortie-validate": validateSortie(); return true;
  }
  return false;
}

document.addEventListener("change", (e) => {
  if (e.target.classList.contains("line-qty-in")) {
    const id = Number(e.target.closest("[data-line]").dataset.line);
    setLineQty(id, parseInt(e.target.value, 10) || 0, { now: true });
    setTimeout(render, 0);
  } else if (e.target.classList.contains("pick-qty-in")) {
    const r = PJ.pick.rows.find((x) => x.key === e.target.closest("[data-pick]").dataset.pick);
    r.qty = Math.max(0, parseInt(e.target.value, 10) || 0);
    refreshPick(r.key);
  }
});
document.addEventListener("input", (e) => { if (e.target.id === "projAdd") drawProjDrop(); });
document.addEventListener("focusin", (e) => { if (e.target.id === "projAdd") drawProjDrop(); });
document.addEventListener("focusout", (e) => {
  if (e.target.id === "projAdd") setTimeout(() => { const d = $("#projDrop"); if (d && document.activeElement?.id !== "projAdd") d.hidden = true; }, 150);
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "newProj" && e.key === "Enter") { e.preventDefault(); createProject(); return; }
  if (e.target.id === "setName" && e.key === "Enter") { e.preventDefault(); saveName(); return; }
  if (e.target.id !== "projAdd") return;
  const lis = $$("#projDrop li[data-add-item]");
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!lis.length) return;
    PJ.dropSel = e.key === "ArrowDown" ? Math.min(lis.length - 1, PJ.dropSel + 1) : Math.max(0, PJ.dropSel - 1);
    lis.forEach((li, i) => li.setAttribute("aria-selected", i === PJ.dropSel));
    lis[PJ.dropSel].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (lis[PJ.dropSel]) addLine(Number(lis[PJ.dropSel].dataset.addItem));
  } else if (e.key === "Escape") {
    e.target.value = ""; drawProjDrop();
  }
});
document.addEventListener("mousedown", (e) => { if (e.target.closest("#projDrop")) e.preventDefault(); });

/* ---------- Événements ---------- */

// Contenu principal
$("#view").addEventListener("click", async (e) => {
  const actEl = e.target.closest("[data-act]");
  const r = route();
  if (r.view === "projets" && actEl && handleProjectClick(e, actEl)) return;
  const addIt = e.target.closest("[data-add-item]");
  if (addIt) { addLine(Number(addIt.dataset.addItem)); return; }
  const projRow = e.target.closest("[data-proj]");
  if (projRow) { location.hash = `#/projet/${projRow.dataset.proj}`; return; }
  if (actEl) {
    const act = actEl.dataset.act;
    const row = actEl.closest("[data-item]");
    if (row && ["inc", "dec", "lvl"].includes(act)) {
      e.stopPropagation();
      if (row.classList.contains("verif")) V.marks.set(Number(row.dataset.item), "ok");
      quickQty(Number(row.dataset.item), act, Number(actEl.dataset.lvl));
      return;
    }
    if (row && act === "move") { startMove(Number(row.dataset.item)); return; }
    if (row && act === "buy") { openBuy(Number(row.dataset.item)); return; }
    if (row && act === "want") { toggleWant(Number(row.dataset.item)); return; }
    if (row && act === "mark") { markVerif(Number(row.dataset.item), actEl.dataset.mark); return; }
    const lrow = actEl.closest("[data-loc]");
    if (lrow && act === "move-loc") { moveLoc(Number(lrow.dataset.loc)); return; }
    switch (act) {
      case "new-item": openItem(null); return;
      case "new-item-q": openItem(null, { name: $("#q").value.trim(), tags: [...S.tagFilter] }); return;
      case "new-loc": openLoc(null, null); return;
      case "new-item-here": openItem(null, { location_id: r.id }); return;
      case "new-loc-here": openLoc(null, r.id); return;
      case "edit-loc": openLoc(r.id); return;
      case "move-this-loc": moveLoc(r.id); return;
      case "print": printLabel(r.id); return;
      case "verif-done": finishVerif(); return;
      case "verif-quick": finishVerif(true); return;
      case "import": $("#csvInput").value = ""; $("#csvInput").click(); return;
      case "save-name": saveName(); return;
      case "zoom": openPhoto(actEl.dataset.photo); return;
      case "loc-photo":
        chooseFile(async (f) => {
          const fd = new FormData(); fd.append("file", f);
          try { const saved = await api("POST", `api/locations/${r.id}/photo`, fd); S.locs.set(saved.id, saved); rebuild(); render(); toast("Photo ajoutée."); }
          catch (err) { toast(err.message, { err: true }); }
        });
        return;
      case "verify":
        try { const saved = await api("PATCH", `api/locations/${r.id}`, { verified: true }); S.locs.set(saved.id, saved); render(); toast("Emplacement marqué comme vérifié."); }
        catch (err) { toast(err.message, { err: true }); }
        return;
    }
  }
  const tv = e.target.closest("[data-tview]");
  if (tv) { S.tagFilter = new Set([tv.dataset.tview]); $("#q").value = ""; location.hash = "#/"; return; }
  const tr = e.target.closest("[data-trename]");
  if (tr) { renameTag(tr.dataset.trename); return; }
  const td = e.target.closest("[data-tdelete]");
  if (td) { deleteTag(td.dataset.tdelete); return; }
  const ts = e.target.closest("[data-tsort]");
  if (ts) { S.tagsSort = ts.dataset.tsort; render(); return; }
  if (e.target.closest("a")) return;
  const itemRow = e.target.closest("[data-item]");
  if (itemRow) { openItem(Number(itemRow.dataset.item)); return; }
  const locRow = e.target.closest("[data-loc]");
  if (locRow) location.hash = `#/lieu/${locRow.dataset.loc}`;
});

$("#view").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.closest("button, a")) return;
  const pr = e.target.closest("[data-proj]");
  if (pr) { e.preventDefault(); location.hash = `#/projet/${pr.dataset.proj}`; return; }
  const row = e.target.closest("[data-item], [data-loc]");
  if (!row) return;
  e.preventDefault();
  if (row.dataset.item) openItem(Number(row.dataset.item));
  else location.hash = `#/lieu/${row.dataset.loc}`;
});

// Recherche
$("#q").addEventListener("input", () => {
  if (route().view !== "inventaire") location.hash = "#/";
  else render();
});
$("#q").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { e.target.value = ""; render(); }
  if (e.key === "Enter") { const first = $("#view li[data-item]"); if (first) openItem(Number(first.dataset.item)); }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.target.closest("input, textarea, [contenteditable]") && !$("dialog[open]")) {
    e.preventDefault(); $("#q").focus(); $("#q").select();
  }
});

$("#btnAdd").addEventListener("click", () => {
  const r = route();
  openItem(null, r.view === "lieux" && r.id != null ? { location_id: r.id } : {});
});

$("#btnTheme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  $('meta[name="theme-color"]').content = next === "dark" ? "#08151E" : "#F1EBDD";
  try { localStorage.setItem("wms-theme", next); } catch { /* stockage indisponible */ }
});

// Fermeture des dialogues
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]");
  if (c) c.closest("dialog").close();
});
for (const id of ["#dlgPick", "#dlgPhoto"]) {
  $(id).addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
}

// Fiche article
$("#formItem").addEventListener("submit", (e) => { e.preventDefault(); saveItem(); });
$("#itemSaveNext").addEventListener("click", () => saveItem({ next: true }));
$("#itemUrl").addEventListener("input", drawUrlOpen);
$("#itemQty").addEventListener("input", drawLowWarn);
$("#itemLow").addEventListener("input", drawLowWarn);
$("#itemLowApprox").addEventListener("change", drawLowWarn);
$("#itemHistory").addEventListener("toggle", (e) => { if (e.target.open && D.item?.id != null) loadHistory(); });
$("#itemDelete").addEventListener("click", deleteItem);
$("#itemName").addEventListener("input", () => { clearTimeout(drawDupes.t); drawDupes.t = setTimeout(drawDupes, 120); });
$("#itemLoc").addEventListener("click", async () => {
  if (D.item.id != null) {
    const done = await startMove(D.item.id);
    if (done) {
      const it = S.items.get(D.item.id);
      D.item.location_id = it.location_id;
      $("#itemQty").value = it.qty;
      drawItemLoc();
    }
    return;
  }
  const v = await pickLocation({ title: "Où est rangé cet article ?", noneLabel: "Aucun emplacement (article à acheter)", current: D.item.location_id });
  if (v !== undefined) { D.item.location_id = v; drawItemLoc(); }
});
$("#itemLocPhoto").addEventListener("click", (e) => { const b = e.target.closest("[data-zoom]"); if (b) openPhoto(b.dataset.zoom); });
$("#dlgItem").addEventListener("click", (e) => {
  const mode = e.target.closest("[data-mode]");
  if (mode) {
    D.item.qty_mode = mode.dataset.mode;
    if (D.item.qty_mode === "approx" && D.item.id == null) D.item.level = Math.max(D.item.level, 1);
    drawQtyMode(); return;
  }
  const lvl = e.target.closest("[data-level]");
  if (lvl) { D.item.level = Number(lvl.dataset.level); drawQtyMode(); return; }
  const step = e.target.closest("[data-step]");
  if (step) { const q = $("#itemQty"); q.value = Math.max(0, (parseInt(q.value, 10) || 0) + Number(step.dataset.step)); drawLowWarn(); return; }
  const untag = e.target.closest("[data-untag]");
  if (untag) { D.item.tags = D.item.tags.filter((t) => t !== untag.dataset.untag); drawTags(); $("#tagInput").focus(); return; }
  const addt = e.target.closest("[data-addtag]");
  if (addt) { addTag(addt.dataset.addtag); $("#tagInput").focus(); return; }
  const dOpen = e.target.closest("[data-dupe-open]");
  if (dOpen) { openItem(Number(dOpen.dataset.dupeOpen)); return; }
  const dInc = e.target.closest("[data-dupe-inc]");
  if (dInc) {
    const id = Number(dInc.dataset.dupeInc);
    const it = S.items.get(id);
    patchItem(id, { qty: it.qty + 1 }).then((saved) => {
      S.items.set(id, saved); rebuild(); $("#dlgItem").close(); render();
      toast(`« ${saved.name} » : quantité passée à ${saved.qty}.`);
    }).catch((err) => toast(err.message, { err: true }));
    return;
  }
  if (e.target.closest("#itemPhoto [data-pic]")) {
    chooseFile((f) => {
      if (D.item.previewUrl) URL.revokeObjectURL(D.item.previewUrl);
      D.item.file = f; D.item.previewUrl = URL.createObjectURL(f); D.item.removePhoto = false; drawItemPhoto();
    });
    return;
  }
  if (e.target.closest("#itemPhoto [data-pic-remove]")) {
    if (D.item.previewUrl) URL.revokeObjectURL(D.item.previewUrl);
    D.item.file = null; D.item.previewUrl = null; D.item.removePhoto = true; drawItemPhoto();
  }
});
$("#tagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    if (e.target.value.trim()) { e.preventDefault(); addTag(e.target.value); }
    else if (e.key === "Enter") { e.preventDefault(); }
  } else if (e.key === "Backspace" && !e.target.value && D.item.tags.length) {
    D.item.tags.pop(); drawTags(); drawSuggest();
  }
});
$("#tagInput").addEventListener("input", drawSuggest);
$("#tagInput").addEventListener("focus", drawSuggest);
$("#tagInput").addEventListener("blur", () => setTimeout(() => {
  if (!$("#tagSuggest").contains(document.activeElement)) $("#tagSuggest").hidden = true;
}, 150));
$("#dlgItem").addEventListener("close", () => { if (D.item?.previewUrl) URL.revokeObjectURL(D.item.previewUrl); });

// Fiche emplacement
$("#formLoc").addEventListener("submit", (e) => { e.preventDefault(); saveLoc(); });
$("#locDelete").addEventListener("click", deleteLoc);
$("#locParent").addEventListener("click", async () => {
  const exclude = L.loc.id != null ? descendants(L.loc.id) : new Set();
  const v = await pickLocation({ title: "Dans quoi est-il rangé ?", noneLabel: "Aucun (emplacement de premier niveau)", current: L.loc.parent_id, exclude });
  if (v !== undefined) { L.loc.parent_id = v; drawLocParent(); }
});
$("#dlgLoc").addEventListener("click", (e) => {
  if (e.target.closest("#locPhoto [data-pic]")) {
    chooseFile((f) => {
      if (L.loc.previewUrl) URL.revokeObjectURL(L.loc.previewUrl);
      L.loc.file = f; L.loc.previewUrl = URL.createObjectURL(f); L.loc.removePhoto = false; drawLocPhoto();
    });
  } else if (e.target.closest("#locPhoto [data-pic-remove]")) {
    if (L.loc.previewUrl) URL.revokeObjectURL(L.loc.previewUrl);
    L.loc.file = null; L.loc.previewUrl = null; L.loc.removePhoto = true; drawLocPhoto();
  }
});

window.addEventListener("hashchange", () => {
  const r = route();
  if (r.view === "projets" && r.id == null) PJ.list = null;
  if (r.view === "projets" && r.id != null && PJ.cur && PJ.cur.id !== r.id) PJ.cur = null;
  if (!(r.view === "projets" && r.sortie)) PJ.pick = null;
  render(); window.scrollTo(0, 0);
});

/* ---------- Chargement ---------- */

async function load({ silent = false } = {}) {
  try {
    const [data, st] = await Promise.all([api("GET", "api/data"), api("GET", "api/settings")]);
    S.name = st.name; S.version = st.version;
    applyName();
    setData(data);
    render();
  } catch (e) {
    if (silent) return;
    $("#view").innerHTML = `<div class="empty"><h3>Impossible de charger l’inventaire</h3><p>${esc(e.message)}</p>
      <div class="actions"><button class="btn primary" type="button" onclick="location.reload()">Réessayer</button></div></div>`;
  }
}

// Recharge les données quand on revient sur l'onglet (modifications faites depuis un autre appareil)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.loaded && !$("dialog[open]")) load({ silent: true });
});

render();
load();
