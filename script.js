"use strict";

// =============================================================================
// 状態
// =============================================================================
const state = {
  sources: [],      // ★[A, B] 各 {name, joints, tracks, loopDur, scale}
  phase: 0,         // ★0..1 の位相クロック
  weights: [1, 0, 0],   // ★各ソースの重み [bat, human, penguin]（内部で合計1に正規化）
  playing: true,

  offset: { x: 0, y: 0 },   // 正規化空間でのオフセット（トルソ長=1）
  jointAdjust: {},          // 関節ごとの微調整（正規化空間）
  smooth: true,
  showLines: true,
};

// DOM
const canvas   = document.getElementById("view");
const ctx      = canvas.getContext("2d");
const elEmpty  = document.getElementById("empty");
const elFile   = document.getElementById("file");
const elFrame  = document.getElementById("frame");
const elFrameNo   = document.getElementById("frameNo");
const elFrameTime = document.getElementById("frameTime");
const elLines  = document.getElementById("lines");
const elPlay   = document.getElementById("play");
const elSmooth = document.getElementById("smooth");
const elOffX     = document.getElementById("offX");
const elOffY     = document.getElementById("offY");
const elJointSel = document.getElementById("jointSel");
const elJx       = document.getElementById("jx");
const elJy       = document.getElementById("jy");
const elResetAdj = document.getElementById("resetAdj");
const elPad    = document.getElementById("pad");
const elPadW   = document.getElementById("padW");
const elSpeedA  = document.getElementById("speedA");
const elSpeedB  = document.getElementById("speedB");
const elSpAName = document.getElementById("spAName");
const elSpBName = document.getElementById("spBName");
const elSpAVal  = document.getElementById("spAVal");
const elSpBVal  = document.getElementById("spBVal");
const elSpeedC  = document.getElementById("speedC");
const elSpCName = document.getElementById("spCName");
const elSpCVal  = document.getElementById("spCVal");

// =============================================================================
// 読み込み
//   - テスト時: ファイル選択で読み込む（ブラウザはローカルfetchを禁じるため）
//   - 本番(自分のサーバ上): 下のfetch例に置き換えれば同じsetMotion()に流れる
//       fetch("bat.json").then(r => r.json()).then(setMotion);
// =============================================================================

// 1つのJSONを「ソース」に前処理する（トラック・周期・体サイズ）
function buildSource(data) {
  const joints = data.joints || [];
  const fps = (data.capture && data.capture.fps) || 24;
  const loopDur = data.frames.length / fps;

  // 関節ごとに「本物キーだけ」の補間トラック（Step2と同じ）
  const tracks = {};
  for (const j of joints) {
    const pts = [];
    for (let f = 0; f < data.frames.length; f++) {
      const c = data.frames[f].coords[j.name];
      if (c && c.tracked) pts.push({ t: f / fps, x: c.x, y: c.y });
    }
    if (pts.length === 0) {
      for (let f = 0; f < data.frames.length; f++) {
        const c = data.frames[f].coords[j.name];
        if (c) pts.push({ t: f / fps, x: c.x, y: c.y });
      }
    }
    tracks[j.name] = buildTrack(pts, loopDur);
  }

  // 体サイズ = トルソ長(hipjoint-neck)の平均。正規化のスケールに使う
  let sum = 0, cnt = 0;
  for (let f = 0; f < data.frames.length; f++) {
    const h = data.frames[f].coords["hipjoint"], n = data.frames[f].coords["neck"];
    if (h && n) { sum += Math.hypot(h.x - n.x, h.y - n.y); cnt++; }
  }
  const scale = cnt ? sum / cnt : 1;

  return { name: (data.species && data.species.name) || "?", joints, tracks, loopDur, scale };
}

// 起動時に2種を読み込む
  Promise.all([
    fetch("/data/bat.json").then(r => r.json()),
    fetch("/data/Homo_sapience.json").then(r => r.json()),
    fetch("/data/Aptenodytes_forsteri.json").then(r => r.json()),  // ペンギン追加
  ]).then(([a, b, c]) => {
    state.sources = [buildSource(a), buildSource(b), buildSource(c)];
    state.sources[0].speed = 11;  // ★コウモリ
    state.sources[1].speed = 1;   // ★ヒト
    state.sources[2].speed = 1;   // ★ペンギン
    state.sources[2].flipX = true;    // ★ペンギンは向きが逆 → 左右反転
    state.sources[2].offsetY = 0.5;   // ★腰が体の下寄り → 少し下げて高さを揃える（+ = 下）
    state.sources[2].sizeMul = 1.65;  // ★全高が小さい → 拡大して他種と揃える(2.47/1.51≈1.64)
    initAfterLoad();
  }).catch(err => { elEmpty.textContent = "読み込みエラー: " + err.message; });

function initAfterLoad() {
  fitCanvas();
  populateJointSelect();
  updatePanel();
  elEmpty.style.display = "none";
  elFrame.disabled = false;
  state.phase = 0; state.playing = true; elPlay.textContent = "Pause";
  
  elSpeedA.value = state.sources[0].speed; elSpAVal.textContent = state.sources[0].speed;
  elSpAName.textContent = state.sources[0].name;
  if (state.sources[1]) {
    elSpeedB.value = state.sources[1].speed; elSpBVal.textContent = state.sources[1].speed;
    elSpBName.textContent = state.sources[1].name;
  }

  if (state.sources[2]) {
      elSpeedC.value = state.sources[2].speed; elSpCVal.textContent =
  state.sources[2].speed;
      elSpCName.textContent = state.sources[2].name;
    }
    elPadW.textContent = state.weights.map(w => w.toFixed(2)).join(" / ");
    drawPad();
  }

// =============================================================================
// 座標変換: AE生座標 → 画面座標
//   AEもCanvasも「原点=左上 / Y下向き」なのでY反転は不要。
//   全フレーム・全関節のバウンディングボックスを一様拡大して中央に収める。
// =============================================================================

const lerp = (a, b, u) => a + (b - a) * u;

// ループ境界をまたいで補間できるよう、前後に2点ずつ“折り返し”を足す
function buildTrack(pts, loopDur) {
  if (pts.length <= 1) return { single: true, p: pts[0] || { x: 0, y: 0 } };
  const n = pts.length;
  const sh = (p, d) => ({ t: p.t + d, x: p.x, y: p.y });
  return {
    aug: [
      sh(pts[n - 2], -loopDur), sh(pts[n - 1], -loopDur),
      ...pts,
      sh(pts[0], +loopDur),     sh(pts[1], +loopDur),
    ],
  };
}

// 時刻 t のときの、この関節の位置を返す
function sampleTrack(tr, t, smooth) {
  if (tr.single) return tr.p;
  const a = tr.aug;
  // a[i].t <= t < a[i+1].t となる区間 i を二分探索
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; (a[mid].t <= t) ? lo = mid : hi = mid; }
  const i = lo, p1 = a[i], p2 = a[i + 1];
  const h = (p2.t - p1.t) || 1e-6;
  const s = (t - p1.t) / h;                 // 区間内の進み具合 0..1

  if (!smooth) {                            // 線形補間
    return { x: lerp(p1.x, p2.x, s), y: lerp(p1.y, p2.y, s) };
  }
  // スムージング: 前後の点 p0,p3 から接線を作るエルミート補間（時間対応Catmull-Rom）
  const p0 = a[i - 1], p3 = a[i + 2];
  return {
    x: hermite(p0.x, p1.x, p2.x, p3.x, p0.t, p1.t, p2.t, p3.t, s, h),
    y: hermite(p0.y, p1.y, p2.y, p3.y, p0.t, p1.t, p2.t, p3.t, s, h),
  };
}

function hermite(v0, v1, v2, v3, t0, t1, t2, t3, s, h) {
  const m1 = (v2 - v0) / (t2 - t0);         // p1での接線（速度）
  const m2 = (v3 - v1) / (t3 - t1);         // p2での接線
  const s2 = s * s, s3 = s2 * s;
  return (2*s3 - 3*s2 + 1) * v1            // 基底関数で v1,v2 を必ず通りつつ滑らかに
       + (s3 - 2*s2 + s)   * h * m1
       + (-2*s3 + 3*s2)    * v2
       + (s3 - s2)         * h * m2;
}

// =============================================================================
// キャンバス解像度（高DPI対応）
// =============================================================================
function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  canvas.width  = Math.round(cw * dpr);
  canvas.height = Math.round(ch * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 以降は論理px(=CSS px)で描ける
}

// ある種を、位相 phase の「正規化ポーズ」にする（腰=原点・トルソ長=1）
function normalizedPose(src, phase) {
  const t = phase * src.loopDur;
  const raw = {};
  for (const j of src.joints) raw[j.name] = sampleTrack(src.tracks[j.name], t, state.smooth);

  const c = raw["hipjoint"] || centroid(raw, src.joints);   // 原点 = 腰
    const s = src.scale || 1;                                 // 体サイズで割る
    const fx = src.flipX ? -1 : 1;                            // ★左右反転（向き揃え）
    const m  = src.sizeMul || 1;                              // ★見た目サイズ補正
    const out = {};
    for (const j of src.joints) {
      const p = raw[j.name];
       out[j.name] = { x: fx * (p.x - c.x) / s * m, y: (p.y - c.y) / s * m + (src.offsetY || 0) };
    } 
    return out;
}

function centroid(raw, joints) {
  let x = 0, y = 0, n = 0;
  for (const j of joints) { const p = raw[j.name]; if (p) { x += p.x; y += p.y; n++; } }
  return n ? { x: x / n, y: y / n } : { x: 0, y: 0 };
}

  // 全ソースの正規化ポーズを、重み weights で加重平均。微調整もここで足す
    // 各ソースを1回ずつ正規化（腰=原点・トルソ長=1）
    function blendedPose(phase, weights) {
    const poses = state.sources.map(s => normalizedPose(s, phase));
    const joints = state.sources[0].joints;   // 描画の基準は先頭ソースの関節集合（19共通）  
    const out = {};
    for (const j of joints) {
      let x = 0, y = 0, wsum = 0;
      for (let i = 0; i < state.sources.length; i++) {
        const p = poses[i][j.name];
        if (!p) continue;                     // その種がこの関節を持たない → 数に入れない
        const w = weights[i] || 0;
        x += p.x * w; y += p.y * w; wsum += w;
      } 
      if (wsum > 0) { x /= wsum; y /= wsum; } // その関節を持つ種だけで重みを再正規化
      const adj = state.jointAdjust[j.name];
      if (adj) { x += adj.x; y += adj.y; }
      out[j.name] = { x, y };
    }
    return out;
  }
  

// 正規化座標（トルソ長=1基準）→ 画面座標。中央に置き、offsetでずらす
function normToScreen(x, y) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const ds = Math.min(cw, ch) * 0.18;          // 表示倍率（必要なら調整）
  return [ cw / 2 + (x + state.offset.x) * ds,
           ch / 2 + (y + state.offset.y) * ds ];
}

// =============================================================================
// 描画
// =============================================================================

function render(phase) {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
  if (!state.sources.length) return;

  const pose = blendedPose(phase, state.weights);
  const joints = state.sources[0].joints;

  if (state.showLines) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    for (const j of joints) {
      if (!j.parent) continue;
      const a = pose[j.name], b = pose[j.parent];
      if (!a || !b) continue;
      const [ax, ay] = normToScreen(a.x, a.y);
      const [bx, by] = normToScreen(b.x, b.y);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
  }

  ctx.fillStyle = "#fff";
  for (const j of joints) {
    const p = pose[j.name];
    const [sx, sy] = normToScreen(p.x, p.y);
    ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
  }
}

// =============================================================================
// パネル更新
// =============================================================================

function populateJointSelect() {
  elJointSel.innerHTML = "";
  for (const j of state.sources[0].joints) {
    const o = document.createElement("option");
    o.value = j.name; o.textContent = j.name;
    elJointSel.appendChild(o);
  }
  loadJointSliders();
}

function loadJointSliders() {
  const a = state.jointAdjust[elJointSel.value] || { x: 0, y: 0 };
  elJx.value = a.x; elJy.value = a.y;
}

function updatePanel() {
  const A = state.sources[0], B = state.sources[1];
  document.getElementById("m-name").textContent   = A.name + (B ? " ⇄ " + B.name : "");
  document.getElementById("m-fps").textContent    = "—";
  document.getElementById("m-frames").textContent = A.joints.length + " joints";
  document.getElementById("m-joints").textContent = state.sources.length + " sources";
  document.getElementById("m-untracked").textContent = "—";
  syncReadout();
}

function syncReadout() {
  elFrameNo.textContent   = "phase " + state.phase.toFixed(3);
  elFrameTime.textContent = "w " + state.weights.map(w => w.toFixed(2)).join("/");
}

// =============================================================================
// 入力
// =============================================================================

// 再生ループ（毎フレーム = 画面リフレッシュごとに時計を進めて描画）
let lastTs = 0;
function tick(ts) {
  if (state.sources.length) {
   if (state.playing && lastTs) {
        const dt = (ts - lastTs) / 1000;
        // 各種の「毎秒サイクル数」を重みで加重平均 → ブレンド中の再生レート
        let rate = 0, wsum = 0;
        for (let i = 0; i < state.sources.length; i++) {
          const s = state.sources[i];
          const w = state.weights[i] || 0;
          rate += ((s.speed || 1) / s.loopDur) * w; wsum += w;
        } 
        if (wsum > 0) rate /= wsum;
        state.phase += dt * rate;
        state.phase %= 1; if (state.phase < 0) state.phase += 1;
      } 
    render(state.phase);
    syncReadout();
  }
  lastTs = ts;
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick); 

elPlay.addEventListener("click", () => {
  state.playing = !state.playing;
  elPlay.textContent = state.playing ? "Pause" : "Play";
});
elSpeedC.addEventListener("input", () => {
    if (!state.sources[2]) return;
    state.sources[2].speed = parseFloat(elSpeedC.value);
    elSpCVal.textContent = state.sources[2].speed.toFixed(1);
  });
elFrame.addEventListener("input", () => {                 // スクラブ＝位相シーク
  state.playing = false; elPlay.textContent = "Play";
  state.phase = parseInt(elFrame.value, 10) / 1000;
});



elSpeedA.addEventListener("input", () => {
  state.sources[0].speed = parseFloat(elSpeedA.value);
  elSpAVal.textContent = state.sources[0].speed.toFixed(1);
});
elSpeedB.addEventListener("input", () => {
  if (!state.sources[1]) return;
  state.sources[1].speed = parseFloat(elSpeedB.value);
  elSpBVal.textContent = state.sources[1].speed.toFixed(1);
});

elSmooth.addEventListener("change", () => { state.smooth = elSmooth.checked; });
elLines.addEventListener("change",  () => { state.showLines = elLines.checked; });

elOffX.addEventListener("input", () => { state.offset.x = parseFloat(elOffX.value); });
elOffY.addEventListener("input", () => { state.offset.y = parseFloat(elOffY.value); });

elJointSel.addEventListener("change", loadJointSliders);
function applyJointAdjust() {
  state.jointAdjust[elJointSel.value] = { x: parseFloat(elJx.value), y: parseFloat(elJy.value) };
}
elJx.addEventListener("input", applyJointAdjust);
elJy.addEventListener("input", applyJointAdjust);

elResetAdj.addEventListener("click", () => {
  state.offset = { x: 0, y: 0 };
  state.jointAdjust = {};
  elOffX.value = 0; elOffY.value = 0;
  elJx.value = 0; elJy.value = 0;
});

window.addEventListener("resize", () => { if (state.sources.length) fitCanvas(); });


  // =============================================================================
  // 三角ブレンドパッド（重心座標で3種の重みを出す）
  //   頂点0=左下, 頂点1=右下, 頂点2=上。並びは state.sources [bat, human, penguin]
  // =============================================================================

  const padCtx = elPad.getContext("2d");
  const PAD_W = elPad.width, PAD_H = elPad.height, PAD_PAD = 24;
  const padVerts = [
    { x: PAD_PAD,         y: PAD_H - PAD_PAD },  // 0: 左下
    { x: PAD_W - PAD_PAD, y: PAD_H - PAD_PAD },  // 1: 右下
    { x: PAD_W / 2,       y: PAD_PAD },          // 2: 上
  ];

  // 点(px,py) → 3重み。三角の外は負が出るので0にクランプして再正規化＝常に合計1
  function padToWeights(px, py) {
    const [A, B, C] = padVerts;
    const den = (B.y - C.y) * (A.x - C.x) + (C.x - B.x) * (A.y - C.y);
    let w0 = ((B.y - C.y) * (px - C.x) + (C.x - B.x) * (py - C.y)) / den;
    let w1 = ((C.y - A.y) * (px - C.x) + (A.x - C.x) * (py - C.y)) / den;
    let w2 = 1 - w0 - w1;
    w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2);
    const s = w0 + w1 + w2 || 1;
    return [w0 / s, w1 / s, w2 / s];
  }

  // 3重み → 点（表示用）: w0·V0 + w1·V1 + w2·V2
  function weightsToPad(w) {
    return {
      x: w[0]*padVerts[0].x + w[1]*padVerts[1].x + w[2]*padVerts[2].x,
      y: w[0]*padVerts[0].y + w[1]*padVerts[1].y + w[2]*padVerts[2].y,
    };
  }
  
  function drawPad() {
    padCtx.fillStyle = "#000"; padCtx.fillRect(0, 0, PAD_W, PAD_H);
    padCtx.strokeStyle = "rgba(255,255,255,0.5)"; padCtx.lineWidth = 1;
    padCtx.beginPath();
    padCtx.moveTo(padVerts[0].x, padVerts[0].y);
    padCtx.lineTo(padVerts[1].x, padVerts[1].y);
    padCtx.lineTo(padVerts[2].x, padVerts[2].y);
    padCtx.closePath(); padCtx.stroke();

    padCtx.fillStyle = "#aaa"; padCtx.font = "10px monospace";
    const nm = state.sources.map(s => s.name.slice(0, 6));
    padCtx.textAlign = "left";   padCtx.fillText(nm[0] || "A", 2, PAD_H - 6);
    padCtx.textAlign = "right";  padCtx.fillText(nm[1] || "B", PAD_W - 2, PAD_H
  - 6);
    padCtx.textAlign = "center"; padCtx.fillText(nm[2] || "C", PAD_W / 2,
  PAD_PAD - 8);

    const p = weightsToPad(state.weights);
    padCtx.fillStyle = "#fff";
    padCtx.beginPath(); padCtx.arc(p.x, p.y, 4, 0, Math.PI * 2); padCtx.fill();
  }

  // ドラッグで重みを設定（CSS拡大されていても内部解像度に変換）
  function padSet(ev) {
    const r = elPad.getBoundingClientRect();
    const px = (ev.clientX - r.left) * (PAD_W / r.width);
    const py = (ev.clientY - r.top)  * (PAD_H / r.height);
    state.weights = padToWeights(px, py);
    elPadW.textContent = state.weights.map(w => w.toFixed(2)).join(" / ");
    drawPad();
  }
  
  let padDragging = false;
  elPad.addEventListener("pointerdown", (e) => { padDragging = true;
  elPad.setPointerCapture(e.pointerId); padSet(e); });
  elPad.addEventListener("pointermove", (e) => { if (padDragging) padSet(e); });
  elPad.addEventListener("pointerup",   () => { padDragging = false; });