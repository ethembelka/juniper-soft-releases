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
  getFirestore, collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc,
  serverTimestamp,
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

// Token imzalama servisi (Cloudflare Worker). Gizli anahtar ORADA durur;
// panel yalnız "şu lisansı imzala" der ve dönen token'ı Firestore'a yazar.
const SIGNER_DEFAULT = "";
const signerUrl = () => (localStorage.getItem("juniper_signer") || SIGNER_DEFAULT).replace(/\/$/, "");

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
  const signer = signerUrl();
  $("btnStaleAll").disabled = !signer;
  $("signerInfo").textContent = signer
    ? "İmzalama servisi: " + signer
    : "İmzalama servisi tanımlı değil — üstteki ⚙ Servis düğmesinden adresi girin.";
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
  const signer = signerUrl();
  $("btnToken").disabled = !signer || !current.machine_id;
  $("btnToken").title = !signer ? "Önce ⚙ Servis adresini girin"
    : (!current.machine_id ? "Lisans henüz aktive edilmedi" : "");
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

// ── Token imzalama (Cloudflare Worker) ──────────────────────────────────────
// Gizli Ed25519 anahtarı tarayıcıya KONULAMAZ; servis imzalar, yazmayı panel yapar.
// Yazma yetkisi yöneticinin Firestore oturumundan gelir → serviste servis hesabı yok.
async function signToken(licenseKey) {
  const base = signerUrl();
  if (!base) throw new Error("İmzalama servisi tanımlı değil (⚙ Servis ayarı).");
  const idt = await auth.currentUser.getIdToken();
  const r = await fetch(base + "/sign", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + idt },
    body: JSON.stringify({ licenseKey }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ("servis " + r.status));
  return d.token;
}

async function reissue(licenseKey) {
  const token = await signToken(licenseKey);
  await updateDoc(doc(db, "licences", licenseKey),
                  { license_token: token, token_reissue_needed: false,
                    token_issued_at: serverTimestamp() });
  const l = LICENCES.find(x => x.id === licenseKey);
  if (l) { l.license_token = token; l.token_reissue_needed = false; }
}

$("btnToken").addEventListener("click", async () => {
  if (!current) return;
  $("editErr").textContent = ""; $("editOk").textContent = "";
  $("btnToken").disabled = true;
  try {
    await reissue(current.id);
    $("editOk").textContent = "✓ Token yeniden imzalandı";
    openEdit(current.id); render();
  } catch (e) { $("editErr").textContent = "Token: " + e.message; }
  finally { $("btnToken").disabled = false; }
});

$("btnStaleAll").addEventListener("click", async () => {
  const list = LICENCES.filter(l => l.token_reissue_needed);
  $("btnStaleAll").disabled = true;
  const fails = [];
  for (const l of list) {
    try { await reissue(l.id); } catch (e) { fails.push(l.id + ": " + e.message); }
  }
  $("btnStaleAll").disabled = false;
  render();
  if (fails.length) alert("Bazıları imzalanamadı:\n" + fails.join("\n"));
});

$("btnSigner").addEventListener("click", () => {
  const v = prompt("İmzalama servisinin adresi (Cloudflare Worker):", signerUrl());
  if (v === null) return;
  const t = v.trim();
  if (t && !/^https:\/\//.test(t)) { alert("Adres https:// ile başlamalı."); return; }
  if (t) localStorage.setItem("juniper_signer", t);
  else localStorage.removeItem("juniper_signer");
  render();
});

// ── Şifre belirleme (werkzeug pbkdf2 biçimi) ────────────────────────────────
// Uygulama tarafı werkzeug.check_password_hash ile doğrular; biçim birebir aynı olmalı:
//   pbkdf2:sha256:<tur>$<tuz>$<hex özet>
async function werkzeugHash(password, iterations = 600000) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rnd = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(rnd, b => alphabet[b % alphabet.length]).join("");
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-256" }, base, 256);
  const hex = Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:sha256:${iterations}$${salt}$${hex}`;
}

$("btnPass").addEventListener("click", async () => {
  if (!current) return;
  const pw = prompt("Bu lisans için yeni şifre (en az 6 karakter):");
  if (pw === null) return;
  if (pw.length < 6) { alert("Şifre en az 6 karakter olmalı."); return; }
  $("btnPass").disabled = true;
  try {
    await updateDoc(doc(db, "licences", current.id),
                    { password_hash: await werkzeugHash(pw), updated_at: serverTimestamp() });
    $("editOk").textContent = "✓ Şifre güncellendi";
  } catch (e) { $("editErr").textContent = "Şifre: " + (e.code || e.message); }
  finally { $("btnPass").disabled = false; }
});

// ── Makine sıfırlama ────────────────────────────────────────────────────────
// Müşteri bilgisayar değiştirdiğinde. Token da TEMİZLENİR: eski token eski makineye
// bağlıdır, kalırsa yeni makinede çalışmaz ama eski makinede çalışmaya devam eder.
$("btnReset").addEventListener("click", async () => {
  if (!current) return;
  if (!confirm(`${current.customer_name || current.id}\n\nMakine kaydı silinsin mi? ` +
               "Program bir sonraki açılışta hangi bilgisayarda çalışıyorsa ona bağlanır.")) return;
  try {
    await updateDoc(doc(db, "licences", current.id), {
      machine_id: "", fingerprint: {}, license_token: "",
      token_reissue_needed: false, activated_at: "", updated_at: serverTimestamp(),
    });
    Object.assign(current, { machine_id: "", license_token: "", token_reissue_needed: false });
    $("editOk").textContent = "✓ Makine kaydı silindi";
    openEdit(current.id); render();
  } catch (e) { $("editErr").textContent = "Sıfırlama: " + (e.code || e.message); }
});

// ── Lisans silme ────────────────────────────────────────────────────────────
$("btnDelete").addEventListener("click", async () => {
  if (!current) return;
  const name = current.customer_name || current.id;
  if (prompt(`"${name}" lisansı KALICI olarak silinecek.\n` +
             `Onaylamak için lisans anahtarını yazın:\n${current.id}`) !== current.id) return;
  try {
    await deleteDoc(doc(db, "licences", current.id));
    LICENCES = LICENCES.filter(l => l.id !== current.id);
    current = null;
    $("editOverlay").hidden = true;
    render();
  } catch (e) { $("editErr").textContent = "Silme: " + (e.code || e.message); }
});

// ── Yeni lisans ─────────────────────────────────────────────────────────────
function newKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";            // karışan harfler yok (O/0, I/1)
  const part = n => Array.from(crypto.getRandomValues(new Uint8Array(n)),
                               b => chars[b % chars.length]).join("");
  return `JUNIPER-${part(4)}-${part(4)}-${part(4)}`;
}

$("btnNew").addEventListener("click", async () => {
  const name = prompt("Yeni lisans — müşteri adı:");
  if (!name) return;
  const key = newKey();
  const fresh = {
    customer_name: name.trim(), username: "", password_hash: "", status: "active",
    machine_id: "", activated_at: "", fingerprint: {}, license_token: "",
    company: {}, valid_until: "", last_online_auth: "",
    module_order_history: false, module_history_edit: false,
    module_pricing: false, module_cnc: false, token_reissue_needed: false,
    total_pdfs_uploaded: 0, total_labels_printed: 0, notes: "",
    created_at: serverTimestamp(),
  };
  try {
    await setDoc(doc(db, "licences", key), fresh);
    const snap = await getDoc(doc(db, "licences", key));
    LICENCES.push({ id: key, ...snap.data() });
    render();
    openEdit(key);
    $("editOk").textContent = "✓ Lisans oluşturuldu — anahtar: " + key;
  } catch (e) { alert("Oluşturulamadı: " + (e.code || e.message)); }
});

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
