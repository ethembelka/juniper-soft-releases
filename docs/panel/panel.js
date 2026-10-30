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
const SIGNER_DEFAULT = "https://juniper-token-signer.ethembelkajunipersoft.workers.dev";
const signerUrl = () => (localStorage.getItem("juniper_signer") || SIGNER_DEFAULT).replace(/\/$/, "");

const app = initializeApp(CONFIG);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = id => document.getElementById(id);
/* Tek bir eksik element TÜM modülü düşürmesin: modül üstü bir TypeError, ondan
   sonraki bütün olay bağlantılarını iptal eder (bir kez oldu: eksik bir düğme
   yüzünden panelin hiçbir düğmesi çalışmadı). */
const on = (id, ev, fn) => {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn("panel: #" + id + " bulunamadı, bağlanmadı");
};
const esc = s => { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; };
let LICENCES = [];
let current = null;

// ── Giriş ───────────────────────────────────────────────────────────────────
on("loginForm", "submit", async e => {
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
on("btnLogout", "click", () => signOut(auth));

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
on("btnReload", "click", load);
on("search", "input", render);
on("statusFilter", "change", render);

function render() {
  const q = $("search").value.trim().toLocaleLowerCase("tr");
  const st = $("statusFilter").value;
  const rows = LICENCES.filter(l =>
    (!st || (l.status || "active") === st) &&
    (!q || [l.id, l.customer_name, l.username].some(v => String(v || "").toLocaleLowerCase("tr").includes(q))));
  const stale = LICENCES.filter(needsToken).length;
  $("staleCount").textContent = stale;
  const signer = signerUrl();
  $("btnStaleAll").disabled = !signer || !stale;
  const attn = LICENCES.map(l => ({ l, is: issues(l).filter(i => i.lvl !== "info") }))
    .filter(x => x.is.length)
    .sort((a, b) => RANK[a.is[0].lvl] - RANK[b.is[0].lvl] || (a.l.customer_name || "").localeCompare(b.l.customer_name || "", "tr"));
  $("attn").hidden = !attn.length;
  $("attnCount").textContent = attn.length;
  $("attnList").innerHTML = attn.map(({ l, is }) =>
    '<div class="attn-row"><span class="who-c" data-open="' + esc(l.id) + '">' + esc(l.customer_name || l.id) + "</span>"
    + is.map(i => '<span class="chip ' + i.lvl + '" title="' + esc(i.hint) + '">' + esc(i.text) + "</span>").join("")
    + '<span class="grow"></span>'
    + (is.some(i => i.fix === "token") && l.machine_id
        ? '<button class="btn sm" data-sign="' + esc(l.id) + '"' + (signer ? "" : " disabled") + ">🔏 İmzala</button>" : "")
    + "</div>").join("");
  document.querySelectorAll("[data-sign]").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation();
    b.disabled = true; b.textContent = "İmzalanıyor…";
    try { await reissue(b.dataset.sign); render(); }
    catch (err) { b.disabled = false; b.textContent = "🔏 İmzala"; alert("İmzalanamadı: " + err.message); }
  }));
  $("signerInfo").textContent = signer
    ? "İmzalama servisi: " + signer
    : "İmzalama servisi tanımlı değil — üstteki ⚙ Servis düğmesinden adresi girin.";
  $("count").textContent = rows.length + " / " + LICENCES.length + " lisans";
  $("list").innerHTML = rows.length ? rows.map(card).join("")
    : '<div class="empty">Eşleşen lisans yok.</div>';
  document.querySelectorAll("[data-open]").forEach(el =>
    el.addEventListener("click", () => openEdit(el.dataset.open)));
}

function seenHtml(l) {
  const seen = lastSeen(l), sd = daysSince(seen);
  if (sd == null) return '<span class="muted small">son görülme: —</span>';
  const cls = sd >= GRACE_DAYS ? "seen-bad" : sd >= 4 ? "seen-warn" : "seen-ok";
  const rel = sd === 0 ? "bugün" : sd + " gün önce";
  return '<span class="small ' + cls + '" title="' + esc(fmt(seen)) + '">son görülme: ' + rel + "</span>";
}

function card(l) {
  const mods = MODULES.filter(([k]) => l[k]).map(([, lbl]) => '<span class="chip">' + lbl + "</span>").join("");
  const status = l.status || "active";
  return '<article class="row" data-open="' + esc(l.id) + '">'
    + '<div class="row-main"><b>' + esc(l.customer_name || "(isimsiz)") + "</b>"
    + '<span class="key">' + esc(l.id) + "</span>"
    + '<div class="chips">' + mods
    + issues(l).map(i => '<span class="chip ' + i.lvl + '" title="' + esc(i.hint) + '">' + esc(i.text) + "</span>").join("")
    + "</div></div>"
    + '<div class="row-side"><span class="pill ' + status + '">' + label(status) + "</span>"
    + '<span class="muted">' + (l.valid_until ? esc(String(l.valid_until).slice(0, 10)) : "süresiz") + "</span>"
    + '<span class="muted small">' + (l.machine_id ? "kurulu" : "aktive edilmedi") + "</span>"
    + seenHtml(l) + (l.app_version ? '<span class="muted small">v' + esc(l.app_version) + "</span>" : "")
    + "</div></article>";
}
const label = s => ({ active: "Aktif", suspended: "Askıda", revoked: "İptal" })[s] || s;

// ── Sağlık kontrolü ─────────────────────────────────────────────────────────
// Uygulama ile AYNI sabit (core/license.GRACE_DAYS): internetsiz en fazla bu kadar gün.
const GRACE_DAYS = 7;
const DAY = 86400000;
let LATEST = "";      // GitHub'daki son sürüm (eski sürüm uyarısı için)
fetch("https://api.github.com/repos/ethembelka/juniper-soft-releases/releases/latest")
  .then(r => r.ok ? r.json() : null)
  .then(j => { if (j && j.tag_name) { LATEST = String(j.tag_name).replace(/^v/, ""); if (LICENCES.length) render(); } })
  .catch(() => {});

const toDate = v => {
  if (!v) return null;
  const d = typeof v === "object" && v.seconds ? new Date(v.seconds * 1000) : new Date(String(v));
  return isNaN(d) ? null : d;
};
const daysSince = d => d ? Math.floor((Date.now() - d.getTime()) / DAY) : null;
const verLt = (a, b) => {
  const pa = String(a || "").split(".").map(Number), pb = String(b || "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0); }
  return false;
};
// Token içeriği (imzası doğrulanmaz — yalnız gösterim/karşılaştırma için okunur)
function tokenPayload(tok) {
  try {
    const b = String(tok).split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "===".slice((b.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch { return null; }
}
// Programın en son haber verdiği an: 'client.seen_at' (v1.10+) ya da 'last_online_auth'
function lastSeen(l) {
  const ds = [toDate(l.last_online_auth), toDate(l.client && l.client.seen_at)].filter(Boolean);
  return ds.length ? new Date(Math.max(...ds.map(d => d.getTime()))) : null;
}
const NET_TEXT = {
  dns: "DNS (sunucu adı çözülemedi)", ssl: "SSL (antivirüs/güvenlik duvarı HTTPS denetimi ya da yanlış saat)",
  timeout: "zaman aşımı", proxy: "proxy engeli", conn: "bağlantı kurulamadı", http: "sunucu hatası", other: "bilinmeyen",
};
const TOKEN_TEXT = {
  ok: "geçerli", none: "yok", invalid: "bozuk/okunamıyor", other_key: "başka lisansa ait",
  fp_mismatch: "bu bilgisayara ait değil",
};

/* Her lisans için sorun listesi: {lvl: bad|warn|info, text, hint, fix: "token"|null}.
   bad  = müşteri şu an ya da yakında programı açamayabilir
   warn = yakında sorun çıkabilir / yönetici işlemi bekliyor
   info = bilgi (eski sürüm, geçmiş bağlantı sorunu) */
function issues(l) {
  const out = [];
  const add = (lvl, text, hint = "", fix = null) => out.push({ lvl, text, hint, fix });
  const status = l.status || "active";
  if (status !== "active") return out;
  const tp = l.license_token ? tokenPayload(l.license_token) : null;
  const fp = l.fingerprint || {};
  const cl = l.client || {};
  const seen = lastSeen(l), sd = daysSince(seen);

  if (!l.password_hash || !l.username)
    add("bad", "Giriş bilgisi eksik — müşteri programa giriş yapamaz",
        "Kullanıcı adı ve şifre belirleyip Kaydet'e basın.");

  if (!l.machine_id) {
    const cd = daysSince(toDate(l.created_at));
    if (l.activated_at === "" && l.last_online_auth)
      add("warn", "Makine kaydı yok — program bir sonraki açılışta bilgisayarı kaydedecek",
          "Kayıt gelince token imzalayın. (v1.10+ kendiliğinden kaydeder; eski sürümde müşterinin lisans anahtarını yeniden girmesi gerekir.)");
    else
      add(cd != null && cd >= 3 ? "warn" : "info", "Henüz kurulmadı (aktivasyon bekleniyor)");
  } else {
    if (!l.license_token)
      add("bad", "Token yok — program internet olmadan AÇILMAZ",
          "Çevrimdışı çalışma izni verilmemiş. Bilgisayar internete bağlanmadan açılırsa müşteri 'İnternet Bağlantısı Gerekli' ekranını görür.", "token");
    else if (!tp)
      add("bad", "Token okunamıyor", "Yeniden imzalayın.", "token");
    else {
      if (tp.key && tp.key !== l.id) add("bad", "Token başka bir lisansa ait", "", "token");
      const tfp = tp.fp || {};
      const mism = ["guid", "vol"].filter(k => tfp[k] && fp[k] && tfp[k] !== fp[k]);
      if (mism.length)
        add("bad", "Token başka bir bilgisayar için imzalanmış (makine değişmiş)",
            "Kayıtlı bilgisayarla eşleşmiyor (" + mism.join(", ") + "). Yeniden imzalayın.", "token");
      if ((tp.valid_until || "") !== String(l.valid_until || "").slice(0, 10) && !l.token_reissue_needed)
        add("warn", "Token'daki bitiş tarihi lisanstakinden farklı (" + (tp.valid_until || "süresiz") + ")",
            "İnternetsiz çalışırken eski tarih geçerli olur.", "token");
    }
    if (l.token_reissue_needed)
      add("warn", "Token yenilenmeli (modül/süre/durum değişti)",
          "Değişiklik internetsiz çalışan programa ancak yeni token'la geçer.", "token");
    if (cl.token && cl.token !== "ok" && !(cl.token === "none" && !l.license_token))
      add("bad", "Program token'ı kullanamıyor: " + (TOKEN_TEXT[cl.token] || cl.token),
          "Programın son bildirimi (" + fmt(cl.seen_at) + "). Yeniden imzalayın.", "token");

    if (sd != null) {
      const left = GRACE_DAYS - sd;
      // v1.10 öncesi program 'son görülme'yi YALNIZ patron şifreyle girişte yazıyordu →
      // eski sürümde uzun sessizlik kullanılmadığı anlamına gelmez; kırmızı gösterme.
      const reliable = !!l.app_version;
      if (sd >= GRACE_DAYS)
        add(reliable && l.license_token ? "bad" : "warn", sd + " gündür programdan haber yok",
            !reliable ? "Eski sürüm: bu bilgi yalnız şifreyle girişte güncellenir; program kullanılıyor olabilir."
              : l.license_token ? "İnternetsiz kullanıyorsa " + GRACE_DAYS + " günlük süre dolmuştur — müşteriyi arayın."
              : "Program kullanılmıyor ya da sunucuya ulaşamıyor.");
      else if (sd >= 4 && l.license_token && reliable)
        add("warn", sd + " gündür programdan haber yok",
            "İnternetsiz kullanıyorsa yaklaşık " + left + " gün sonra 'İnternet Bağlantısı Gerekli' ekranı çıkar.");
    } else {
      add("info", "Programdan hiç haber alınmadı");
    }
  }

  const vu = toDate(l.valid_until);
  if (vu) {
    const dl = Math.ceil((vu.getTime() - Date.now()) / DAY);
    if (dl < 0) add("bad", "Lisans süresi doldu (" + String(l.valid_until).slice(0, 10) + ")");
    else if (dl <= 30) add("warn", "Lisans " + dl + " gün sonra bitiyor (" + String(l.valid_until).slice(0, 10) + ")");
  }
  if (cl.net_error) {
    const until = toDate(cl.net_error_until);
    if (!until || daysSince(until) <= 14)
      add("info", "Bağlantı sorunu yaşadı: " + (NET_TEXT[cl.net_error] || cl.net_error),
          fmt(cl.net_error_since) + " → " + fmt(cl.net_error_until) + (cl.net_error_text ? " · " + cl.net_error_text : ""));
  }
  if (LATEST && l.app_version && verLt(l.app_version, LATEST))
    add("info", "Eski sürüm: " + l.app_version + " (güncel " + LATEST + ")");
  return out;
}
const needsToken = l => issues(l).some(i => i.fix === "token") && !!l.machine_id;
const RANK = { bad: 0, warn: 1, info: 2 };

// ── Düzenleme ───────────────────────────────────────────────────────────────
function openEdit(id) {
  current = LICENCES.find(l => l.id === id);
  if (!current) return;
  $("editKey").textContent = current.customer_name || "(isimsiz)";
  $("editSub").textContent = current.id;
  $("fCustomer").value = current.customer_name || "";
  $("fUsername").value = current.username || "";
  $("fPassword").value = "";
  $("fPassword").type = "password"; $("pwEye").textContent = "göster";
  const hasPw = !!current.password_hash;
  $("pwState").textContent = hasPw ? "· tanımlı" : "· YOK — müşteri giriş yapamaz";
  $("pwState").className = hasPw ? "ok" : "bad";
  $("fPassword").placeholder = hasPw ? "Değiştirmek için yeni şifre yazın" : "En az 6 karakter";
  $("fStatus").value = current.status || "active";
  $("fValidUntil").value = current.valid_until ? String(current.valid_until).slice(0, 10) : "";
  const co = current.company || {};
  $("coName").value = co.name || ""; $("coPhone").value = co.phone || "";
  $("coEmail").value = co.email || ""; $("coWeb").value = co.web || "";
  $("coAddress").value = co.address || "";
  $("mods").innerHTML = MODULES.map(([k, lbl]) =>
    '<label class="mod"><input type="checkbox" data-mod="' + k + '"' + (current[k] ? " checked" : "") + "><span>" + lbl + "</span></label>").join("");
  $("fNotes").value = current.notes || "";
  $("rawDoc").textContent = rawView(current);
  const is = issues(current);
  $("issues").innerHTML = is.length
    ? is.map(i => '<div class="issue ' + i.lvl + '">' + esc(i.text) + (i.hint ? "<small>" + esc(i.hint) + "</small>" : "") + "</div>").join("")
    : (current.status || "active") === "active" ? '<div class="issue info">✓ Sorun görünmüyor</div>' : "";
  const cl = current.client || {};
  const tp = current.license_token ? tokenPayload(current.license_token) : null;
  const seen = lastSeen(current), sd = daysSince(seen);
  $("meta").innerHTML = [
    ["Makine", current.machine_id || "—"],
    ["Son görülme", seen ? fmt(seen) + " (" + (sd === 0 ? "bugün" : sd + " gün önce") + ")" : "—"],
    ["Program sürümü", current.app_version || "— (v1.10 öncesi)"],
    ["Programın bildirdiği durum", cl.status ? cl.status + " · token " + (TOKEN_TEXT[cl.token] || cl.token || "—") : "—"],
    ["Yüklenen PDF / etiket", (current.total_pdfs_uploaded || 0) + " / " + (current.total_labels_printed || 0)],
    ["Aktivasyon", fmt(current.activated_at)],
    ["Token", current.license_token ? (current.token_reissue_needed ? "var (yenilenmeli)" : "var") : "yok"],
    ["Token bitişi", tp ? (tp.valid_until || "süresiz") : "—"],
    ["Token imzalandı", fmt(current.token_issued_at)],
    ["Son bağlantı sorunu", cl.net_error ? (NET_TEXT[cl.net_error] || cl.net_error) + " · " + fmt(cl.net_error_since) + " → " + fmt(cl.net_error_until) : "—"],
    ["İşletim sistemi", cl.os || "—"],
    ["Giriş şifresi", current.password_hash ? "tanımlı" : "yok"],
    ["Parmak izi", Object.keys(current.fingerprint || {}).length
       ? Object.entries(current.fingerprint).map(([k, v]) => k + "=" + v).join(" · ") : "yok"],
    ["Oluşturma", fmt(current.created_at)],
  ].map(([k, v]) => "<div><span>" + k + "</span><b>" + esc(v) + "</b></div>").join("");
  const signer = signerUrl();
  $("btnToken").disabled = !signer || !current.machine_id;
  $("btnToken").title = !signer ? "Önce ⚙ Servis adresini girin"
    : (!current.machine_id ? "Makine kaydı yok — program açılınca bilgisayar kaydedilir, sonra imzalayın" : "");
  $("editErr").textContent = ""; $("editOk").textContent = "";
  $("editOverlay").hidden = false;
}
function rawView(lic) {
  const out = {};
  for (const k of Object.keys(lic).sort()) {
    const v = lic[k];
    if (k === "password_hash") out[k] = v ? "(tanımlı — gösterilmiyor)" : "";
    else if (k === "license_token" && v) out[k] = String(v).slice(0, 24) + "… (" + v.length + " karakter)";
    else if (v && typeof v === "object" && v.seconds) out[k] = fmt(v);
    else out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}

// Tarih + SAAT, yerel saatte (Türkiye). Firestore Timestamp ya da ISO metin gelebilir.
const fmt = v => {
  if (!v) return "—";
  const d = typeof v === "object" && v.seconds ? new Date(v.seconds * 1000) : new Date(String(v));
  if (isNaN(d)) return String(v).replace("T", " ").slice(0, 16);
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric",
                                     hour: "2-digit", minute: "2-digit" });
};
on("btnClose", "click", () => { $("editOverlay").hidden = true; });
on("editOverlay", "click", e => { if (e.target === $("editOverlay")) $("editOverlay").hidden = true; });

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

on("btnToken", "click", async () => {
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

on("btnStaleAll", "click", async () => {
  const list = LICENCES.filter(needsToken);
  $("btnStaleAll").disabled = true;
  const fails = [];
  for (const l of list) {
    try { await reissue(l.id); } catch (e) { fails.push(l.id + ": " + e.message); }
  }
  $("btnStaleAll").disabled = false;
  render();
  if (fails.length) alert("Bazıları imzalanamadı:\n" + fails.join("\n"));
});

on("btnSigner", "click", () => {
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

on("pwEye", "click", () => {
  const i = $("fPassword"), show = i.type === "password";
  i.type = show ? "text" : "password"; $("pwEye").textContent = show ? "gizle" : "göster";
});

// ── Makine sıfırlama ────────────────────────────────────────────────────────
// Müşteri bilgisayar değiştirdiğinde. Token da TEMİZLENİR: eski token eski makineye
// bağlıdır, kalırsa yeni makinede çalışmaz ama eski makinede çalışmaya devam eder.
on("btnReset", "click", async () => {
  if (!current) return;
  if (!confirm(`${current.customer_name || current.id}\n\nMakine kaydı silinsin mi? ` +
               "Program bir sonraki açılışta hangi bilgisayarda çalışıyorsa ona bağlanır.")) return;
  try {
    await updateDoc(doc(db, "licences", current.id), {
      machine_id: "", fingerprint: {}, license_token: "",
      token_reissue_needed: false, activated_at: "", updated_at: serverTimestamp(),
    });
    Object.assign(current, { machine_id: "", license_token: "", token_reissue_needed: false,
                             fingerprint: {}, activated_at: "" });
    $("editOk").textContent = "✓ Makine kaydı silindi — program bir sonraki açılışta bilgisayarı "
      + "kendiliğinden kaydeder (v1.10+). Kayıt gelince bu ekrandan token imzalayın.";
    openEdit(current.id); render();
  } catch (e) { $("editErr").textContent = "Sıfırlama: " + (e.code || e.message); }
});

// ── Lisans silme ────────────────────────────────────────────────────────────
on("btnDelete", "click", async () => {
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

on("btnNew", "click", async () => {
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
    $("editOk").textContent = "✓ Lisans oluşturuldu: " + key;
    $("editErr").textContent = "Şimdi kullanıcı adı ve şifre belirleyip Kaydet'e basın.";
    $("fUsername").focus();
  } catch (e) { alert("Oluşturulamadı: " + (e.code || e.message)); }
});

on("btnSave", "click", async () => {
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
    notes: $("fNotes").value.trim(),
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
  // Giriş şifresi: yazıldıysa uygulamanın doğruladığı biçimde (werkzeug pbkdf2) özetlenir
  const pw = $("fPassword").value;
  if (pw) {
    if (pw.length < 6) { $("editErr").textContent = "Şifre en az 6 karakter olmalı."; return; }
    changes.password_hash = await werkzeugHash(pw);
  }
  if (!Object.keys(changes).length) { $("editOk").textContent = "Değişiklik yok."; return; }
  if (Object.keys(changes).some(k => TOKEN_FIELDS.has(k)) && current.license_token) {
    changes.token_reissue_needed = true;      // yerel panel token'ı yenileyecek
  }
  changes.updated_at = serverTimestamp();
  try {
    $("btnSave").disabled = true;
    await updateDoc(doc(db, "licences", current.id), changes);
    Object.assign(current, next, { token_reissue_needed: !!changes.token_reissue_needed });
    if (changes.password_hash) current.password_hash = changes.password_hash;
    $("fPassword").value = "";
    const hasPw = !!current.password_hash;
    $("pwState").textContent = hasPw ? "· tanımlı" : "· YOK — müşteri giriş yapamaz";
    $("pwState").className = hasPw ? "ok" : "bad";
    $("fPassword").placeholder = hasPw ? "Değiştirmek için yeni şifre yazın" : "En az 6 karakter";
    const miss = [!current.username && "kullanıcı adı", !hasPw && "şifre"].filter(Boolean);
    $("editOk").textContent = "✓ Kaydedildi"
      + (changes.password_hash ? " · şifre güncellendi" : "")
      + (changes.token_reissue_needed ? " — token yenilenmeli" : "");
    if (miss.length) $("editErr").textContent = "Müşteri giriş yapamaz: " + miss.join(" ve ") + " eksik.";
    render();
  } catch (err) {
    $("editErr").textContent = "Kaydedilemedi: " + (err.code || err.message);
  } finally {
    $("btnSave").disabled = false;
  }
});
