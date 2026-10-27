/* PDF Sign — pages drawn by pdf.js (Mozilla, Apache-2.0), marks embedded by pdf-lib (MIT). Everything runs in this tab. */
import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const { $, $$, h } = S3;
const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
const LH = 1.2, BASE = 0.947; // CSS line-height of text marks, and where the baseline sits in that line (Helvetica/Arial)

// ---------- geometry (pure) ----------
const norm = r => ((r % 360) + 360) % 360;
// A point on the page as it is shown (X right, Y up, origin bottom-left) -> PDF user space, for any /Rotate.
function toUser(box, rot, X, Y) {
  switch (norm(rot)) {
    case 90: return [box.x + box.w - Y, box.y + X];
    case 180: return [box.x + box.w - X, box.y + box.h - Y];
    case 270: return [box.x + Y, box.y + box.h - X];
    default: return [box.x + X, box.y + Y];
  }
}
function hexRgb(hex) { const n = parseInt(String(hex).slice(1), 16) || 0; return rgb((n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255); }
function encodable(font, s) { try { font.encodeText(s); return true; } catch (e) { return false; } }
const isRtl = s => /^[^A-Za-zÀ-ɏ]*[֐-ࣿיִ-ﻼ]/.test(s);

async function loadLib(bytes) {
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypted/i.test(e && e.message) ? "This PDF is password-protected or encrypted. Remove the protection first." : "This file couldn't be read as a PDF."); }
}
function openJs(bytes) { return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise; }
async function pageInfos(js) {
  const out = [];
  for (let i = 1; i <= js.numPages; i++) {
    const p = await js.getPage(i), vp = p.getViewport({ scale: 1 }), v = p.view;
    out.push({ W: vp.width, H: vp.height, rot: norm(p.rotate), box: { x: Math.min(v[0], v[2]), y: Math.min(v[1], v[3]), w: Math.abs(v[2] - v[0]), h: Math.abs(v[3] - v[1]) } });
  }
  return out;
}

// Text that the standard PDF font can't encode (Arabic, CJK…) is drawn to an image instead, so it still shows.
function textPng(lines, pt, color) {
  const k = 4, c = document.createElement("canvas"), x = c.getContext("2d"), font = (pt * k) + "px Helvetica, Arial, sans-serif";
  x.font = font;
  const w = Math.max(1, ...lines.map(l => x.measureText(l).width)) + 2;
  c.width = Math.ceil(w); c.height = Math.ceil(lines.length * LH * pt * k);
  x.font = font; x.fillStyle = color; x.textBaseline = "alphabetic";
  lines.forEach((l, i) => {
    const rtl = isRtl(l); x.direction = rtl ? "rtl" : "ltr"; x.textAlign = rtl ? "right" : "left";
    x.fillText(l, rtl ? c.width - 1 : 1, (i * LH + BASE) * pt * k);
  });
  return { src: c.toDataURL("image/png"), w: c.width / k, h: c.height / k };
}

// items: [{page, kind:"image", src, x, y, w, h} | {page, kind:"text", text, x, y, pt, color}] in shown-page points, y down from the top.
async function buildSigned(bytes, items, infos) {
  const doc = await loadLib(bytes), pages = doc.getPages(), cache = new Map();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = async src => { if (!cache.has(src)) cache.set(src, await doc.embedPng(src)); return cache.get(src); };
  for (const it of items) {
    const pg = pages[it.page], inf = infos[it.page], r = inf.rot;
    if (!pg) continue;
    const corner = (x, yTop, hh) => toUser(inf.box, r, x, inf.H - yTop - hh); // bottom-left of a box, in user space
    if (it.kind === "image") {
      const [x, y] = corner(it.x, it.y, it.h);
      pg.drawImage(await img(it.src), { x, y, width: it.w, height: it.h, rotate: degrees(r) });
    } else {
      const lines = String(it.text).split("\n");
      if (lines.every(l => encodable(font, l))) {
        lines.forEach((l, k) => {
          if (!l) return;
          const [x, y] = toUser(inf.box, r, it.x, inf.H - (it.y + (k * LH + BASE) * it.pt));
          pg.drawText(l, { x, y, size: it.pt, font, color: hexRgb(it.color), rotate: degrees(r) });
        });
      } else {
        const t = textPng(lines, it.pt, it.color), rtl = lines.every(isRtl), el = itemEl(it);
        // keep right-aligned RTL text anchored where it shows on screen
        const shownW = el && rtl ? el.offsetWidth / pageK(it.page) : t.w;
        const [x, y] = corner(it.x + (rtl ? shownW - t.w : 0), it.y, t.h);
        pg.drawImage(await img(t.src), { x, y, width: t.w, height: t.h, rotate: degrees(r) });
      }
    }
  }
  return doc.save();
}

// ---------- making marks: trim, pen, typed, uploaded ----------
function trim(c, pad) {
  const x = c.getContext("2d"), d = x.getImageData(0, 0, c.width, c.height).data;
  let l = c.width, t = c.height, r = -1, b = -1;
  for (let y = 0; y < c.height; y++) for (let i = 0; i < c.width; i++) {
    if (d[(y * c.width + i) * 4 + 3] > 8) { if (i < l) l = i; if (i > r) r = i; if (y < t) t = y; if (y > b) b = y; }
  }
  if (r < 0) return null;
  pad = pad || 0; l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(c.width - 1, r + pad); b = Math.min(c.height - 1, b + pad);
  const o = document.createElement("canvas"); o.width = r - l + 1; o.height = b - t + 1;
  o.getContext("2d").drawImage(c, l, t, o.width, o.height, 0, 0, o.width, o.height);
  return o;
}
// strokes: [[{x, y, t, p}]] with x, y as fractions of the pad width. Width follows speed (and pen pressure).
function paintStrokes(ctx, strokes, W, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = "round"; ctx.lineJoin = "round";
  const maxW = W * 0.0125, minW = W * 0.0045;
  strokes.forEach(s => {
    if (!s.length) return;
    const P = s.map(q => ({ x: q.x * W, y: q.y * W, t: q.t, p: q.p }));
    if (P.length < 3) { ctx.beginPath(); ctx.arc(P[0].x, P[0].y, maxW * 0.55, 0, 7); ctx.fill(); if (P.length < 2) return; }
    let w = maxW * 0.8;
    for (let i = 1; i < P.length; i++) {
      const a = P[i - 1], b = P[i], dist = Math.hypot(b.x - a.x, b.y - a.y) / W, dt = Math.max(1, b.t - a.t);
      let target = maxW - (maxW - minW) * Math.min(1, (dist / dt) / 0.0035);
      if (b.p > 0 && b.p !== 0.5) target *= 0.55 + b.p * 0.9;
      w = w * 0.65 + target * 0.35;
      const from = i === 1 ? a : { x: (P[i - 2].x + a.x) / 2, y: (P[i - 2].y + a.y) / 2 };
      const to = i === P.length - 1 ? b : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(from.x, from.y);
      if (i === 1) ctx.lineTo(to.x, to.y); else ctx.quadraticCurveTo(a.x, a.y, to.x, to.y);
      ctx.stroke();
    }
  });
}
function strokesPng(strokes, color) {
  if (!strokes.length) return null;
  const W = 1500, c = document.createElement("canvas"); c.width = W; c.height = Math.round(W / 3 * 1.25);
  paintStrokes(c.getContext("2d"), strokes, W, color);
  return trim(c, 8);
}
function typedPng(text, family, color) {
  if (!String(text).trim()) return null;
  const c = document.createElement("canvas"), x = c.getContext("2d"), size = 120, font = size + "px " + family;
  x.font = font; const w = Math.ceil(x.measureText(text).width) + size;
  c.width = Math.min(4000, w); c.height = Math.round(size * 2);
  x.font = font; x.fillStyle = color; x.textBaseline = "alphabetic"; x.direction = isRtl(text) ? "rtl" : "ltr";
  x.textAlign = "center"; x.fillText(text, c.width / 2, size * 1.3);
  return trim(c, 6);
}
function knockOut(img, thr) { // remove a light background: alpha fades out above the threshold
  const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
  const x = c.getContext("2d"); x.drawImage(img, 0, 0, c.width, c.height);
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data, soft = 40;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    if (lum >= thr) d[i + 3] = 0; else if (lum > thr - soft) d[i + 3] = Math.round(d[i + 3] * (thr - lum) / soft);
  }
  x.putImageData(im, 0, 0);
  return trim(c, 4);
}
const HANDS = ["Segoe Script", "Ink Free", "Lucida Handwriting", "Brush Script MT", "Segoe Print", "Bradley Hand", "Snell Roundhand", "Apple Chancery",
  "Savoye LET", "Noteworthy", "Mistral", "Freestyle Script", "Kristen ITC", "Dancing Script", "Caveat", "Pacifico", "Satisfy", "Great Vibes", "URW Chancery L", "Z003", "Comic Sans MS"];
function hasFont(name) {
  const x = document.createElement("canvas").getContext("2d"), s = "Signature Wwmli 0123";
  return ["monospace", "serif"].some(f => { x.font = "40px " + f; const a = x.measureText(s).width; x.font = '40px "' + name + '", ' + f; return Math.abs(x.measureText(s).width - a) > 0.5; });
}

// ---------- state ----------
const st = { file: null, base: "", bytes: null, js: null, infos: [], items: [], sel: null, arm: null, nid: 1, editing: null, slot: "sig" };
const newSlot = () => ({ mode: "draw", strokes: [], text: "", font: 0, img: null, thr: 210, png: null, w: 0, h: 0 });
const slots = { sig: newSlot(), ini: newSlot() };
let ink = S3.store("sign.ink") || "#111111", families = [];

// ---------- create panel ----------
function seg(el, value, onPick) {
  $$("button", el).forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.v === value));
    b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
  });
}
function setPressed(el, v) { $$("button", el).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === v))); }
const slot = () => slots[st.slot];

function rebuild(s, keepSaved) {
  s = s || slot();
  let c = null;
  if (s.mode === "draw") c = strokesPng(s.strokes, ink);
  else if (s.mode === "type") c = typedPng(s.text, families[s.font] || "cursive", ink);
  else if (s.mode === "upload" && s.img) c = knockOut(s.img, s.thr);
  if (c) { s.png = c.toDataURL("image/png"); s.w = c.width; s.h = c.height; } else if (!keepSaved) s.png = null;
  showPreview(); persist();
}
function showPreview() {
  const p = $("#preview"), s = slot(); p.innerHTML = "";
  p.appendChild(s.png ? h("img", { src: s.png, alt: st.slot === "sig" ? "Your signature" : "Your initials" }) : h("span", { "class": "faint", text: "Nothing yet" }));
}
function persist() {
  if (!$("#remember").checked) return;
  const pack = k => slots[k].png ? { png: slots[k].png, w: slots[k].w, h: slots[k].h } : null;
  S3.store("sign.saved", { sig: pack("sig"), ini: pack("ini") });
}
function showMode() {
  const m = slot().mode;
  setPressed($("#mode"), m);
  $("#pDraw").hidden = m !== "draw" && m !== "saved"; $("#pType").hidden = m !== "type"; $("#pUpload").hidden = m !== "upload";
  $("#typed").value = slot().text;
  $("#typed").placeholder = st.slot === "sig" ? "e.g. Sara Haddad" : "e.g. SH";
  $("#thr").value = slot().thr; $("#thrVal").textContent = slot().thr;
  sizePad(); drawFonts(); showPreview();
}
seg($("#slot"), "sig", v => {
  st.slot = v;
  const s = slot(), sig = slots.sig;
  if (v === "ini" && !s.text && sig.text.trim()) s.text = sig.text.trim().split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase();
  if (v === "ini" && !s.png && s.mode === "draw" && !s.strokes.length && s.text) s.mode = "type";
  if (v === "ini" && s.mode === "type" && s.text && !s.png) { s.font = sig.font; rebuild(s); }
  showMode();
});
seg($("#mode"), "draw", v => { slot().mode = v; rebuild(slot(), true); showMode(); if (v === "type") $("#typed").focus(); });

// pen pad
const pad = $("#pad"), padWrap = $("#padWrap");
let padCss = 0, drawing = null, raf = 0;
function sizePad() {
  if ($("#pDraw").hidden) return;
  const r = padWrap.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  padCss = r.width; pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  paintPad();
}
function paintPad() {
  const x = pad.getContext("2d"), dpr = pad.width / (padCss || 1);
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, pad.width, pad.height); x.setTransform(dpr, 0, 0, dpr, 0, 0);
  paintStrokes(x, slot().strokes, padCss, ink);
  padWrap.classList.toggle("has", slot().strokes.length > 0);
}
function padPoint(e) { const r = pad.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width, t: e.timeStamp || performance.now(), p: e.pointerType === "pen" ? e.pressure : 0 }; }
pad.addEventListener("pointerdown", e => {
  if (e.button > 0) return;
  e.preventDefault(); pad.setPointerCapture(e.pointerId);
  if (slot().mode !== "draw") { slot().mode = "draw"; setPressed($("#mode"), "draw"); }
  drawing = [padPoint(e)]; slot().strokes.push(drawing); paintPad();
});
pad.addEventListener("pointermove", e => {
  if (!drawing) return;
  (e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).forEach(ev => drawing.push(padPoint(ev)));
  if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintPad(); });
});
const endStroke = () => { if (!drawing) return; drawing = null; paintPad(); rebuild(); };
pad.addEventListener("pointerup", endStroke); pad.addEventListener("pointercancel", endStroke);
$("#padUndo").addEventListener("click", () => { slot().strokes.pop(); paintPad(); rebuild(); });
$("#padClear").addEventListener("click", () => { slot().strokes = []; paintPad(); rebuild(); });
window.addEventListener("resize", S3.debounce(sizePad, 150));

// typed
function drawFonts() {
  const box = $("#fonts"), s = slot(), sample = s.text.trim() || (st.slot === "sig" ? "Your Name" : "YN");
  box.innerHTML = "";
  families.forEach((f, i) => {
    const b = h("button", { "class": "sg-font", type: "button", "aria-pressed": String(i === s.font), title: f.split(",")[0].replace(/"/g, "") },
      [h("span", { text: sample, dir: "auto" }), h("small", { text: i === families.length - 1 ? "system" : String(i + 1) })]);
    b.firstChild.style.fontFamily = f;
    b.addEventListener("click", () => { s.font = i; drawFonts(); rebuild(); });
    box.appendChild(b);
  });
}
$("#typed").addEventListener("input", S3.debounce(() => { slot().text = $("#typed").value; drawFonts(); rebuild(); }, 120));

// uploaded
S3.drop($("#upDrop"), files => {
  S3.readFile(files[0], "dataurl").then(url => {
    const im = new Image();
    im.onload = () => { slot().img = im; rebuild(); };
    im.onerror = () => S3.toast("That image couldn't be opened", "error");
    im.src = url;
  });
}, { accept: "image/*", multiple: false });
$("#thr").addEventListener("input", () => { slot().thr = +$("#thr").value; $("#thrVal").textContent = slot().thr; });
$("#thr").addEventListener("change", () => rebuild());

// ink
function setInk(c) {
  ink = c; S3.store("sign.ink", c);
  $$("#inks .sg-ink").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.c === c)));
  ["sig", "ini"].forEach(k => { if (slots[k].mode !== "upload") rebuild(slots[k], true); });
  paintPad();
  const it = selItem(); if (it && it.kind === "text") { it.color = c; drawItems(); }
}
$$("#inks .sg-ink").forEach(b => { b.style.background = b.dataset.c; b.addEventListener("click", () => setInk(b.dataset.c)); });

// remember (only when ticked)
$("#remember").addEventListener("change", () => {
  if ($("#remember").checked) { persist(); S3.toast("Saved in this browser only"); }
  else { S3.store("sign.saved", undefined); S3.toast("Forgotten on this device"); }
});

// ---------- document view ----------
const io = "IntersectionObserver" in window ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); renderPage(+e.target.dataset.i); } }), { rootMargin: "600px" }) : null;
let gen = 0;
function buildPages() {
  const box = $("#pages"); box.innerHTML = "";
  st.infos.forEach((inf, i) => {
    const pg = h("div", { "class": "sg-page", "data-i": i }, [h("div", { "class": "sg-ov", "data-i": i })]);
    pg.style.aspectRatio = inf.W + " / " + inf.H;
    box.appendChild(h("div", { "class": "sg-pagebox" }, [pg, h("span", { "class": "sg-plabel", text: "Page " + (i + 1) + " of " + st.infos.length })]));
    if (io) io.observe(pg); else renderPage(i);
  });
  fitK(); drawItems();
}
async function renderPage(i) {
  const g = gen, pg = $('.sg-page[data-i="' + i + '"]'); if (!pg || !st.js) return;
  try {
    const page = await st.js.getPage(i + 1), w = pg.getBoundingClientRect().width || 700, dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: (w * dpr) / st.infos[i].W }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (g === gen && pg.isConnected) pg.insertBefore(c, pg.firstChild);
  } catch (e) { /* a page that fails to draw still takes marks */ }
}
function pageK(i) { const pg = $('.sg-page[data-i="' + i + '"]'); return pg ? pg.getBoundingClientRect().width / st.infos[i].W : 1; }
function fitK() { $$(".sg-page").forEach(pg => pg.style.setProperty("--k", String(pg.getBoundingClientRect().width / st.infos[+pg.dataset.i].W))); }
if ("ResizeObserver" in window) new ResizeObserver(S3.debounce(fitK, 30)).observe($("#pages"));

// ---------- marks on the page ----------
const selItem = () => st.items.find(x => x.id === st.sel);
const itemEl = it => $('.sg-item[data-id="' + it.id + '"]');
function place(it, el) {
  const inf = st.infos[it.page];
  el.style.left = (it.x / inf.W * 100) + "%"; el.style.top = (it.y / inf.H * 100) + "%";
  if (it.kind === "image") { el.style.width = (it.w / inf.W * 100) + "%"; el.style.height = (it.h / inf.H * 100) + "%"; }
  else { el.firstChild.style.fontSize = "calc(var(--k) * " + it.pt + "px)"; el.firstChild.style.color = it.color; }
}
function drawItems() {
  $$(".sg-ov").forEach(o => { o.innerHTML = ""; });
  st.items.forEach(it => {
    const ov = $('.sg-ov[data-i="' + it.page + '"]'); if (!ov) return;
    const body = it.kind === "image" ? h("img", { src: it.src, alt: it.label || "mark", draggable: "false" }) : h("div", { "class": "sg-txt", dir: "auto", text: it.text });
    const el = h("div", { "class": "sg-item" + (it.id === st.sel ? " sel" : ""), "data-id": it.id, tabindex: "0", role: "button", "aria-label": (it.kind === "image" ? it.label : "Text: " + it.text) + " on page " + (it.page + 1) }, [
      body,
      h("button", { "class": "sg-all", type: "button", title: "Copy to every page", "aria-label": "Copy to every page", text: "⧉" }),
      h("button", { "class": "sg-x", type: "button", title: "Remove", "aria-label": "Remove", text: "✕" }),
      h("span", { "class": "sg-rs", title: "Drag to resize", "aria-hidden": "true" })
    ]);
    place(it, el); ov.appendChild(el);
  });
  const n = st.items.length;
  $("#count").textContent = n ? n + " mark" + (n > 1 ? "s" : "") + " placed" : "Nothing placed yet";
  $("#count").className = "chip" + (n ? " accent" : "");
  $("#save").disabled = !n; $("#clearAll").disabled = !n;
}
function select(id) { st.sel = id; $$(".sg-item").forEach(e => e.classList.toggle("sel", +e.dataset.id === id)); }
function clampItem(it) {
  const inf = st.infos[it.page], el = itemEl(it), k = pageK(it.page);
  const w = it.kind === "image" ? it.w : (el ? el.offsetWidth / k : 20), hh = it.kind === "image" ? it.h : (el ? el.offsetHeight / k : it.pt * LH);
  it.x = Math.max(0, Math.min(inf.W - Math.min(w, inf.W), it.x)); it.y = Math.max(0, Math.min(inf.H - Math.min(hh, inf.H), it.y));
}
function removeItem(id) { st.items = st.items.filter(x => x.id !== id); if (st.sel === id) st.sel = null; drawItems(); }

function dateText() {
  const d = new Date(), p = n => String(n).padStart(2, "0"), f = $("#dateFmt").value;
  if (f === "iso") return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  if (f === "us") return p(d.getMonth() + 1) + "/" + p(d.getDate()) + "/" + d.getFullYear();
  if (f === "long") return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  if (f === "longus") return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
}
(function fillDates() {
  const sel = $("#dateFmt"), saved = S3.store("sign.datefmt") || "dmy";
  [["dmy", "dd/mm/yyyy"], ["us", "mm/dd/yyyy"], ["iso", "yyyy-mm-dd"], ["long", "26 October 2026"], ["longus", "October 26, 2026"]].forEach(([v]) => sel.appendChild(h("option", { value: v })));
  $$("option", sel).forEach(o => { sel.value = o.value; o.textContent = dateText(); });
  sel.value = saved;
  sel.addEventListener("change", () => S3.store("sign.datefmt", sel.value));
})();

function makeItem(kind, page, cx, cy) {
  const inf = st.infos[page], id = st.nid++;
  if (kind === "sig" || kind === "ini") {
    const s = slots[kind]; if (!s.png) return null;
    const w = Math.min(kind === "sig" ? 170 : 64, inf.W * (kind === "sig" ? 0.34 : 0.14)), hh = w * s.h / s.w;
    return { id, page, kind: "image", label: kind === "sig" ? "Signature" : "Initials", src: s.png, w, h: hh, x: cx - w / 2, y: cy - hh / 2 };
  }
  const pt = 12, text = kind === "date" ? dateText() : "Your text";
  return { id, page, kind: "text", text, pt, color: ink, x: cx - (text.length * pt * 0.25), y: cy - pt * LH / 2, fresh: kind === "text" };
}
function arm(kind) {
  if (st.arm === kind) kind = null;
  if (kind === "sig" || kind === "ini") {
    if (!slots[kind].png) {
      S3.toast(kind === "sig" ? "Create your signature first (draw, type or upload)" : "Create your initials first", "error");
      if (st.slot !== kind) $('#slot button[data-v="' + kind + '"]').click();
      return;
    }
  }
  st.arm = kind;
  $$("#tools [data-add]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.add === kind)));
  $("#pages").classList.toggle("sg-arming", !!kind);
  const hint = $("#hint");
  hint.classList.toggle("armed", !!kind);
  hint.textContent = kind ? "Now click on a page where it should go. Esc cancels." : "Pick one, then click on a page where it should go. Drag to move, pull the corner to resize, double-click text to edit.";
}
$$("#tools [data-add]").forEach(b => b.addEventListener("click", () => arm(b.dataset.add)));

function addAt(kind, page, cx, cy) {
  const it = makeItem(kind, page, cx, cy); if (!it) return null;
  st.items.push(it); st.sel = it.id; drawItems(); clampItem(it); place(it, itemEl(it));
  if (it.fresh) { delete it.fresh; setTimeout(() => editText(it), 0); }
  return it;
}
function editText(it) {
  const el = itemEl(it); if (!el) return;
  const t = el.firstChild; st.editing = it.id;
  try { t.contentEditable = "plaintext-only"; } catch (e) { t.contentEditable = "true"; }
  if (t.contentEditable !== "plaintext-only") t.contentEditable = "true";
  t.focus();
  const r = document.createRange(); r.selectNodeContents(t); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  const done = () => {
    t.removeEventListener("blur", done); t.contentEditable = "false"; st.editing = null;
    const v = t.innerText.replace(/\r/g, "").replace(/\n+$/, "");
    if (!v.trim()) { removeItem(it.id); return; }
    it.text = v; drawItems(); clampItem(it); place(it, itemEl(it));
  };
  t.addEventListener("blur", done);
  t.addEventListener("keydown", e => { if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) { e.preventDefault(); t.blur(); } e.stopPropagation(); });
}

const pagesEl = $("#pages");
let drag = null;
pagesEl.addEventListener("pointerdown", e => {
  const el = e.target.closest(".sg-item");
  if (st.arm && !el) {
    const pg = e.target.closest(".sg-page"); if (!pg) return;
    e.preventDefault();
    const i = +pg.dataset.i, r = pg.getBoundingClientRect(), k = r.width / st.infos[i].W;
    addAt(st.arm, i, (e.clientX - r.left) / k, (e.clientY - r.top) / k); arm(null);
    return;
  }
  if (!el) { if (st.sel != null && !st.editing) select(null); return; }
  if (e.target.closest("button")) return;
  const it = st.items.find(x => x.id === +el.dataset.id); if (!it || st.editing === it.id) return;
  e.preventDefault(); select(it.id); el.focus({ preventScroll: true });
  const k = pageK(it.page);
  drag = { it, el, k, x0: e.clientX, y0: e.clientY, ix: it.x, iy: it.y, rs: !!e.target.closest(".sg-rs"), w0: it.kind === "image" ? it.w : el.offsetWidth / k, pt0: it.pt };
  el.setPointerCapture(e.pointerId);
});
pagesEl.addEventListener("pointermove", e => {
  if (!drag) return;
  const { it, el, k } = drag, dx = (e.clientX - drag.x0) / k, dy = (e.clientY - drag.y0) / k, inf = st.infos[it.page];
  if (drag.rs) {
    const w = Math.max(14, Math.min(inf.W - it.x, drag.w0 + dx)), f = w / drag.w0;
    if (it.kind === "image") { const ar = it.h / it.w; it.w = w; it.h = w * ar; } else it.pt = Math.max(5, Math.min(144, drag.pt0 * f));
  } else { it.x = drag.ix + dx; it.y = drag.iy + dy; clampItem(it); }
  place(it, el);
});
const endDrag = () => { if (drag) { clampItem(drag.it); place(drag.it, drag.el); } drag = null; };
pagesEl.addEventListener("pointerup", endDrag); pagesEl.addEventListener("pointercancel", endDrag);
pagesEl.addEventListener("click", e => {
  const el = e.target.closest(".sg-item"); if (!el) return;
  const it = st.items.find(x => x.id === +el.dataset.id); if (!it) return;
  if (e.target.closest(".sg-x")) removeItem(it.id);
  else if (e.target.closest(".sg-all")) copyToAll(it);
});
pagesEl.addEventListener("dblclick", e => {
  const el = e.target.closest(".sg-item"); if (!el) return;
  const it = st.items.find(x => x.id === +el.dataset.id); if (it && it.kind === "text") editText(it);
});
pagesEl.addEventListener("keydown", e => {
  const el = e.target.closest(".sg-item"); if (!el || st.editing) return;
  const it = st.items.find(x => x.id === +el.dataset.id); if (!it) return;
  const step = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (mv) { e.preventDefault(); select(it.id); it.x += mv[0]; it.y += mv[1]; clampItem(it); place(it, el); }
  else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeItem(it.id); }
  else if (e.key === "Enter" && it.kind === "text") { e.preventDefault(); editText(it); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && st.arm) arm(null); });
function copyToAll(it) {
  const inf = st.infos[it.page]; let n = 0;
  st.infos.forEach((o, i) => {
    if (i === it.page) return;
    const c = Object.assign({}, it, { id: st.nid++, page: i, x: it.x / inf.W * o.W, y: it.y / inf.H * o.H });
    if (c.kind === "image") { c.x = Math.min(c.x, o.W - c.w); c.y = Math.min(c.y, o.H - c.h); }
    st.items.push(c); n++;
  });
  drawItems();
  S3.toast(n ? "Copied to " + n + " more page" + (n > 1 ? "s" : "") : "This PDF has only one page");
}
$("#clearAll").addEventListener("click", () => { st.items = []; st.sel = null; drawItems(); });

// ---------- open + save ----------
async function openFile(file) {
  try {
    const bytes = new Uint8Array(await S3.readFile(file));
    await loadLib(bytes); // fail early on encrypted / broken files
    const js = await openJs(bytes), infos = await pageInfos(js);
    if (st.js) st.js.destroy();
    gen++;
    Object.assign(st, { file, base: file.name.replace(/\.pdf$/i, "") || "document", bytes, js, infos, items: [], sel: null, editing: null });
    $("#fname").textContent = file.name;
    $("#fmeta").textContent = infos.length + " page" + (infos.length > 1 ? "s" : "") + " · " + S3.fmtBytes(file.size);
    $("#dropCard").hidden = true; $("#work").hidden = false;
    sizePad(); buildPages();
  } catch (e) { S3.toast(e.message || "This file couldn't be opened", "error"); }
}
const fileInput = S3.drop($("#drop"), files => openFile(files[0]), { accept: ".pdf,application/pdf", multiple: false });
$("#change").addEventListener("click", () => fileInput.click());
window.addEventListener("beforeunload", e => { if (st.items.length && !st.saved) { e.preventDefault(); e.returnValue = ""; } });

$("#save").addEventListener("click", async () => {
  if (!st.items.length) return;
  if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur();
  const b = $("#save"); b.disabled = true;
  try {
    const out = await buildSigned(st.bytes, st.items, st.infos);
    S3.download(new Blob([out], { type: "application/pdf" }), st.base + "-signed.pdf");
    st.saved = true; S3.toast("Signed PDF saved"); S3.done();
  } catch (e) { S3.toast("Couldn't save: " + (e && e.message || e), "error"); }
  b.disabled = false;
});

// ---------- start-up ----------
families = HANDS.filter(hasFont).slice(0, 6).map(f => '"' + f + '", cursive').concat(["cursive"]);
(function restore() {
  const saved = S3.store("sign.saved");
  if (saved && (saved.sig || saved.ini)) {
    $("#remember").checked = true;
    ["sig", "ini"].forEach(k => { if (saved[k] && saved[k].png) Object.assign(slots[k], { png: saved[k].png, w: saved[k].w, h: saved[k].h, mode: "saved" }); });
  }
  setInk(ink); showMode();
})();

// ---------- sample + self-test ----------
async function samplePdf() {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), fb = await d.embedFont(StandardFonts.HelveticaBold);
  const ink2 = rgb(0.16, 0.18, 0.22), grey = rgb(0.55, 0.58, 0.62), line = rgb(0.75, 0.77, 0.8);
  for (let n = 1; n <= 2; n++) {
    const p = d.addPage([595.28, 841.89]), H = p.getHeight();
    p.drawRectangle({ x: 0, y: H - 8, width: 595.28, height: 8, color: rgb(0.05, 0.62, 0.6) });
    if (n === 1) {
      p.drawText("Service Agreement", { x: 56, y: H - 84, size: 24, font: fb, color: ink2 });
      p.drawText("Between Nour Studio and Sara Haddad", { x: 56, y: H - 108, size: 12, font: f, color: grey });
      const para = ["1. Scope. The studio will design and build a five-page website with a booking form,",
        "   delivered within six weeks of the start date.", "2. Payment. 40% on signing, 60% on delivery. Invoices are due within 14 days.",
        "3. Ownership. On full payment, all rights in the final design pass to the client.", "4. Changes. Two rounds of revisions are included; more are billed hourly."];
      para.forEach((t, i) => p.drawText(t, { x: 56, y: H - 150 - i * 22, size: 11, font: f, color: ink2 }));
      [0, 1].forEach(c => {
        const x = 56 + c * 260, y = H - 400;
        p.drawLine({ start: { x, y }, end: { x: x + 210, y }, thickness: 0.8, color: line });
        p.drawText(c ? "Client signature" : "Studio signature", { x, y: y - 16, size: 9, font: f, color: grey });
        p.drawLine({ start: { x, y: y - 56 }, end: { x: x + 120, y: y - 56 }, thickness: 0.8, color: line });
        p.drawText("Date", { x, y: y - 72, size: 9, font: f, color: grey });
      });
    } else {
      p.drawText("Schedule A: milestones", { x: 56, y: H - 84, size: 18, font: fb, color: ink2 });
      for (let i = 0; i < 12; i++) p.drawRectangle({ x: 56, y: H - 130 - i * 30, width: 483 - (i * 41) % 140, height: 10, color: rgb(0.9, 0.91, 0.93) });
    }
    p.drawText("Page " + n + " of 2", { x: 270, y: 30, size: 9, font: f, color: grey });
    p.drawRectangle({ x: 500, y: 24, width: 50, height: 22, borderColor: line, borderWidth: 0.8 });
    p.drawText("Initials", { x: 507, y: 50, size: 7, font: f, color: grey });
  }
  return d.save();
}
function demoStrokes() { // a flowing made-up signature, as pen points
  const pts = [], t0 = 0; let t = t0;
  const add = (fn, n, from, to, dt) => { const s = []; for (let i = 0; i <= n; i++) { const u = from + (to - from) * i / n, q = fn(u); s.push({ x: q[0], y: q[1], t: (t += dt), p: 0 }); } pts.push(s); };
  add(u => [0.16 + 0.07 * Math.sin(u * 6.6) * (1 - u) + u * 0.06, 0.2 - 0.11 * Math.cos(u * 3.3) + u * 0.05], 70, 0, 1, 7);
  add(u => [0.24 + u * 0.3 + 0.03 * Math.sin(u * 19), 0.27 - (0.035 + 0.05 * Math.abs(Math.sin(u * 4.7))) * Math.sin(u * 19 + 0.5) + u * 0.01], 150, 0, 1, 5);
  add(u => [0.56 + u * 0.26, 0.27 + 0.045 * Math.sin(u * 12) * (1 - u * 0.6) - u * 0.03], 80, 0, 1, 5);
  add(u => [0.1 + u * 0.75, 0.33 - u * 0.04 + 0.006 * Math.sin(u * 9)], 50, 0, 1, 3);
  return pts;
}
window.S3_DEMO = async () => {
  const s = slots.sig; s.mode = "draw"; s.strokes = demoStrokes(); rebuild(s);
  const i = slots.ini; i.mode = "type"; i.text = "SH"; i.font = 0; rebuild(i);
  await openFile(new File([await samplePdf()], "Service agreement.pdf", { type: "application/pdf" }));
  showMode();
  const inf = st.infos[0];
  addAt("sig", 0, 316 + 100, 400 - 30);
  const d = addAt("date", 0, 356, 448); d.x = 318; d.y = 456 - 17; place(d, itemEl(d));
  addAt("ini", 0, 525, inf.H - 35);
  select(st.items[0].id); drawItems();
  await new Promise(r => setTimeout(r, 900));
};

window.S3_SELFTEST = async () => {
  const fails = [];
  const ok = (c, m) => { if (!c) fails.push(m); };
  // geometry: corners of a 100x200 box at (10,20), shown rotated
  const B = { x: 10, y: 20, w: 100, h: 200 };
  ok(toUser(B, 0, 0, 0).join() === "10,20" && toUser(B, 90, 0, 0).join() === "110,20" && toUser(B, 180, 0, 0).join() === "110,220" && toUser(B, 270, 0, 0).join() === "10,220", "toUser corners");
  // three pages: A4, landscape letter, and a rotated page whose media box doesn't start at 0,0
  const d = await PDFDocument.create();
  d.addPage([595.28, 841.89]); d.addPage([792, 612]);
  const p3 = d.addPage([400, 600]); p3.setMediaBox(20, 30, 400, 600); p3.setRotation(degrees(90));
  const bytes = await d.save(), js0 = await openJs(bytes), infos = await pageInfos(js0);
  ok(infos[2].W === 600 && infos[2].H === 400 && infos[2].rot === 90 && infos[2].box.x === 20, "page info of rotated page");
  const red = document.createElement("canvas"); red.width = 40; red.height = 20; const rx = red.getContext("2d"); rx.fillStyle = "#ff0000"; rx.fillRect(0, 0, 40, 20);
  const src = red.toDataURL("image/png");
  const items = [
    { page: 0, kind: "image", src, x: 100, y: 200, w: 120, h: 60 },
    { page: 2, kind: "image", src, x: 50, y: 40, w: 150, h: 75 },
    { page: 1, kind: "text", text: "Hello PDF", x: 72, y: 72, pt: 14, color: "#000000" },
    { page: 1, kind: "text", text: "مرحبا بكم", x: 300, y: 300, pt: 24, color: "#000000" }
  ];
  const out = await buildSigned(bytes, items, infos);
  const lib = await PDFDocument.load(out);
  ok(lib.getPageCount() === 3 && lib.getPage(2).getRotation().angle === 90, "page count / rotation kept");
  const js = await openJs(out);
  async function pixels(n) {
    const page = await js.getPage(n), vp = page.getViewport({ scale: 1 }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const x = c.getContext("2d"); await page.render({ canvasContext: x, viewport: vp }).promise;
    return (px, py) => Array.from(x.getImageData(Math.round(px), Math.round(py), 1, 1).data);
  }
  const isRed = p => p[0] > 200 && p[1] < 70 && p[2] < 70, isWhite = p => p[0] > 240 && p[1] > 240 && p[2] > 240;
  const a = await pixels(1);
  ok(isRed(a(160, 230)) && isRed(a(105, 205)) && isRed(a(215, 255)) && isWhite(a(95, 230)) && isWhite(a(160, 266)), "image on page 1 lands where placed");
  const c3 = await pixels(3);
  ok(isRed(c3(125, 77)) && isRed(c3(195, 45)) && isRed(c3(55, 110)) && isWhite(c3(55, 125)) && isWhite(c3(205, 60)) && isWhite(c3(500, 350)), "image on rotated page lands upright where placed");
  const p2 = await js.getPage(2), tc = await p2.getTextContent(), vp2 = p2.getViewport({ scale: 1 });
  const hello = tc.items.find(t => t.str.indexOf("Hello PDF") >= 0);
  ok(!!hello, "text is real, searchable text");
  if (hello) { const [vx, vy] = vp2.convertToViewportPoint(hello.transform[4], hello.transform[5]); ok(Math.abs(vx - 72) < 1 && Math.abs(vy - (72 + BASE * 14)) < 1, "text baseline position " + vx + "," + vy); }
  const b2 = await pixels(2); let dark = 0;
  for (let yy = 302; yy < 330; yy += 2) for (let xx = 300; xx < 420; xx += 2) { const p = b2(xx, yy); if (p[0] < 120) dark++; }
  ok(dark > 15, "Arabic text drawn as an image (" + dark + " dark px)");
  // pen + trim
  const pen = strokesPng([[{ x: 0.2, y: 0.1, t: 0, p: 0 }, { x: 0.5, y: 0.2, t: 30, p: 0 }, { x: 0.7, y: 0.1, t: 60, p: 0 }]], "#000000");
  ok(pen && pen.width > 760 && pen.width < 810 && pen.height > 100 && pen.height < 200, "pen stroke trimmed to its ink " + (pen && pen.width + "x" + pen.height));
  ok(families.length >= 1 && families[families.length - 1] === "cursive", "handwriting fonts");
  js0.destroy(); js.destroy();
  return fails.length ? fails : true;
};
