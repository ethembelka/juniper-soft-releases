/*
 * Juniper Lisans Paneli — statik web sürümü (GitHub Pages).
 *
 * Erişim: Firebase Authentication (e-posta + şifre). Yetki Firestore KURALLARINDA
 * tanımlıdır (bkz. firestore.rules): yalnız izinli UID licences koleksiyonunu
 * okuyup yazabilir. Bu dosyadaki API anahtarı gizli değildir.
 *
 * Token (Ed25519) burada ÜRETİLMEZ: gizli imzalama anahtarı yalnız yönetici
 * bilgisayarındadır. Modül/süre değişince lisansa `token_reissue_needed: true`
 * yazılır; yerel panel bunu görüp token'ı yeniler.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, getDocs, doc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CONFIG = {
  apiKey: "AIzaSyAEjCGNOzHnRJkImXyhN6uG8qCdoI2YmbM",
  authDomain: "juniper-soft-license.firebaseapp.com",
  projectId: "juniper-soft-license",
};

// Uygulamadaki modül anahtarlarıyla BİREBİR aynı olmalı (core/license.has_module)
const MODULES = [
  ["module_order_history", "Geçmiş siparişler"],
  ["module_history_edit", "Geçmişte düzenleme"],
  ["module_pricing", "Fiyatlandırma"],
  ["module_cnc", "CNC kesim dosyası"],
];
// Değişince müşterinin token'ı bayatlar (offline doğrulama eski değeri taşır)
const TOKEN_FIELDS = new Set([...MODULES.map(m => m[0]), "valid_until", "status"]);

const app = initializeApp(CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
const esc = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
let LICENCES = [];
let current = null;

// ── Giriş ───────────────────────────────────────────────────────────────────
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginErr").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
  } catch (err) {
    $("loginErr").textContent = ({
      "auth/invalid-credential": "E-posta ya da şifre hatalı.",
      "auth/invalid-email": "E-posta geçersiz.",
      "auth/too-many-requests": "Çok fazla deneme. Biraz sonra tekrar deneyin.",
      "auth/network-request-failed": "İnternet bağlantısı yok.",
    })[err.code] || ("Giriş yapılamadı: " + err.code);
  }
});
$("btnLogout").addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, user => {
  $("loginView").hidden = !!user;
  $("panelView").hidden = !user;
  $("btnLogout").hidden = !user;
  $("who").textContent = user ? user.email : "";
  if (user) load();
});

// ── Liste ───────────────────────────────────────────────────────────────────
async function load() {
  try {
    const snap = await getDocs(collection(db, "licences"));
    LICENCES = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    LICENCES.sort((a, b) => (a.customer_name || a.id).localeCompare(b.customer_name || b.id, "tr"));
    render();
  } catch (err) {
    $("list").innerHTML = '<div class="empty">Liste okunamadı. Yetkiniz yoksa Firestore kuralları '
      + 'erişimi engelliyordur.<br><small>' + esc(err.code || err.message) + "</small></div>";
  }
}
$("btnReload").addEventListener("click", load);
$("search").addEventListener("input", render);
$("statusFilter").addEventListener("change", render);

function render() {
  const q = $("search").value.trim().toLocaleLowerCase("tr");
  const st = $("statusFilter").value;
  const rows = LICENCES.filter(l =>
    (!st || (l.status || "active") === st) &&
    (!q || [l.id, l.customer_name, l.username].some(v => String(v || "").toLocaleLowerCase("tr").includes(q))));
  const stale = LICENCES.filter(l => l.token_reissue_needed).length;
  $("warnStale").hidden = !stale;
  $("staleCount").textContent = stale;
  $("count").textContent = rows.length + " / " + LICENCES.length + " lisans";
  $("list").innerHTML = rows.length ? rows.map(card).join("")
    : '<div class="empty">Eşleşen lisans yok.</div>';
  document.querySelectorAll("[data-open]").forEach(el =>
    el.addEventListener("click", () => openEdit(el.dataset.open)));
}

function card(l) {
  const mods = MODULES.filter(([k]) => l[k]).map(([, lbl]) => '<span class="chip">' + lbl + "</span>").join("");
  const status = l.status || "active";
  return '<article class="row" data-open="' + esc(l.id) + '">'
    + '<div class="row-main"><b>' + esc(l.customer_name || "(isimsiz)") + "</b>"
    + '<span class="key">' + esc(l.id) + "</span>"
    + '<div class="chips">' + mods + (l.token_reissue_needed ? '<span class="chip warn">token yenilenmeli</span>' : "") + "</div></div>"
    + '<div class="row-side"><span class="pill ' + status + '">' + label(status) + "</span>"
    + '<span class="muted">' + (l.valid_until ? esc(String(l.valid_until).slice(0, 10)) : "süresiz") + "</span>"
    + '<span class="muted small">' + (l.machine_id ? "kurulu" : "aktive edilmedi") + "</span></div></article>";
}
const label = s => ({ active: "Aktif", suspended: "Askıda", revoked: "İptal" })[s] || s;

// ── Düzenleme ───────────────────────────────────────────────────────────────
function openEdit(id) {
  current = LICENCES.find(l => l.id === id);
  if (!current) return;
  $("editKey").textContent = current.customer_name || "(isimsiz)";
  $("editSub").textContent = current.id;
  $("fCustomer").value = current.customer_name || "";
  $("fUsername").value = current.username || "";
  $("fStatus").value = current.status || "active";
  $("fValidUntil").value = current.valid_until ? String(current.valid_until).slice(0, 10) : "";
  const co = current.company || {};
  $("coName").value = co.name || ""; $("coPhone").value = co.phone || "";
  $("coEmail").value = co.email || ""; $("coWeb").value = co.web || "";
  $("coAddress").value = co.address || "";
  $("mods").innerHTML = MODULES.map(([k, lbl]) =>
    '<label class="mod"><input type="checkbox" data-mod="' + k + '"' + (current[k] ? " checked" : "") + "><span>" + lbl + "</span></label>").join("");
  $("meta").innerHTML = [
    ["Makine", current.machine_id || "—"],
    ["Yüklenen PDF / etiket", (current.total_pdfs_uploaded || 0) + " / " + (current.total_labels_printed || 0)],
    ["Aktivasyon", fmt(current.activated_at)],
    ["Son çevrimiçi giriş", fmt(current.last_online_auth)],
    ["Token", current.license_token ? (current.token_reissue_needed ? "var (yenilenmeli)" : "var") : "yok"],
  ].map(([k, v]) => "<div><span>" + k + "</span><b>" + esc(v) + "</b></div>").join("");
  $("editErr").textContent = ""; $("editOk").textContent = "";
  $("editOverlay").hidden = false;
}
const fmt = v => {
  if (!v) return "—";
  const s = typeof v === "object" && v.seconds ? new Date(v.seconds * 1000).toISOString() : String(v);
  return s.replace("T", " ").slice(0, 16);
};
$("btnClose").addEventListener("click", () => { $("editOverlay").hidden = true; });
$("editOverlay").addEventListener("click", e => { if (e.target === $("editOverlay")) $("editOverlay").hidden = true; });

$("btnSave").addEventListener("click", async () => {
  if (!current) return;
  const vu = $("fValidUntil").value.trim();
  if (vu && !/^\d{4}-\d{2}-\d{2}$/.test(vu)) {
    $("editErr").textContent = "Tarih YYYY-AA-GG biçiminde olmalı."; return;
  }
  const next = {
    customer_name: $("fCustomer").value.trim(),
    username: $("fUsername").value.trim(),
    status: $("fStatus").value,
    valid_until: vu,
    company: {
      name: $("coName").value.trim(), phone: $("coPhone").value.trim(),
      email: $("coEmail").value.trim(), web: $("coWeb").value.trim(),
      address: $("coAddress").value.trim(),
    },
  };
  document.querySelectorAll("[data-mod]").forEach(c => { next[c.dataset.mod] = c.checked; });

  // Yalnız DEĞİŞEN alanlar yazılır (başka bir yönetici aynı anda düzenliyorsa ezmesin)
  const changes = {};
  for (const [k, v] of Object.entries(next)) {
    const cur = k === "company" ? JSON.stringify(current.company || {}) : current[k] ?? (typeof v === "boolean" ? false : "");
    const nv = k === "company" ? JSON.stringify(v) : v;
    if (String(cur) !== String(nv)) changes[k] = v;
  }
  if (!Object.keys(changes).length) { $("editOk").textContent = "Değişiklik yok."; return; }
  if (Object.keys(changes).some(k => TOKEN_FIELDS.has(k)) && current.license_token) {
    changes.token_reissue_needed = true;      // yerel panel token'ı yenileyecek
  }
  changes.updated_at = serverTimestamp();
  try {
    $("btnSave").disabled = true;
    await updateDoc(doc(db, "licences", current.id), changes);
    $("editOk").textContent = "✓ Kaydedildi" + (changes.token_reissue_needed ? " — token yenilenmeli" : "");
    Object.assign(current, next, { token_reissue_needed: !!changes.token_reissue_needed });
    render();
  } catch (err) {
    $("editErr").textContent = "Kaydedilemedi: " + (err.code || err.message);
  } finally {
    $("btnSave").disabled = false;
  }
});
