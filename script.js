"use strict";

// =============================================================================
// 状態
// =============================================================================
const state = {
  sources: [],      // ★[A, B] 各 {name, joints, tracks, loopDur, scale}
  active: [],       // ★頂点に使う種のインデックス列（順=角の順）
  phase: 0,         // ★0..1 の位相クロック
  weights: [1, 0, 0],   // ★各ソースの重み [bat, human, penguin]（内部で合計1に正規化）
  playing: true,

  offset: { x: 0, y: 0 },   // 正規化空間でのオフセット（トルソ長=1）
  jointAdjust: {},          // 関節ごとの微調整（正規化空間）
  smooth: true,
  showLines: true,
  morph: null,      // 角数変化のモーフ中の状態
   nameMode: "sci",   // ラベル表示: "sci"=学名 / "wa"=和名
};

// DOM
  const canvas  = document.getElementById("view");
  const ctx     = canvas.getContext("2d");
  const elEmpty = document.getElementById("empty");
  const elPad   = document.getElementById("pad");
  const elPadW  = document.getElementById("padW");

  const suN    = document.getElementById("suN");
  const suList = document.getElementById("suList");
  const suInc  = document.getElementById("suInc");
  const suDec  = document.getElementById("suDec");

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

//list.json読み込み
  fetch("data/list.json")
    .then(r => r.json())
    .then(list =>
      Promise.all(list.map(item =>
        fetch("data/" + item.file).then(r => r.json()).then(data => ({ item, data }))
      ))
    ) 
    .then(loaded => {
      state.sources = loaded.map(({ item, data }) => {
        const src = buildSource(data);
        src.speed   = item.speed   ?? 1;      // 種ごとのカデンス
        src.flipX   = item.flipX   ?? false;  // 向き反転
        src.offsetY = item.offsetY ?? 0;      // 縦位置補正
        src.sizeMul = item.sizeMul ?? 1;      // 見た目サイズ補正
          src.waname  = item.waname  ?? null;   // ★和名（list.jsonから）
        return src; 
      });
      state.active = state.sources.map((_, i) => i);   // 初期は全種
      initAfterLoad();
    })
    .catch(err => { elEmpty.textContent = "読み込みエラー: " + err.message; });


 function initAfterLoad() {
    fitCanvas();
    syncPadSize();                 // オーバーレイcanvasを画面サイズに合わせる
    elEmpty.style.display = "none";
    state.phase = 0; state.playing = true;
    // 多角形の初期位置・大きさ（左下寄りに小さく配置）
    state.padR = Math.min(elPad.clientWidth, elPad.clientHeight) * 0.16;
   state.padCenter = { x: state.padR + 48, y: state.padR + 56 };
    // 初期ブレンド点 = 先頭の種の頂点（＝先頭種がほぼ1）
    const v0 = padVertices()[0];
    state.padLocal = { x: (v0.x - state.padCenter.x) / state.padR,
                       y: (v0.y - state.padCenter.y) / state.padR };
    state.weights = padToWeights(v0.x, v0.y);
    elPadW.textContent = state.weights.map(w => w.toFixed(2)).join(" / ");
    drawPad(); 
    rebuildShapeUI();
  }




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

 
    // アクティブな種（＝多角形の各頂点）をソース配列で返す
  function activeSources() {
    return state.active.map(i => state.sources[i]);
  }
   // 全ソースの正規化ポーズを、重み weights で加重平均。微調整もここで足す
    // 各ソースを1回ずつ正規化（腰=原点・トルソ長=1）
    function blendedPose(phase, weights) {
    const act = activeSources();
    const poses = act.map(s => normalizedPose(s, phase));
    const joints = act[0].joints;                 // 基準の関節集合＝先頭のアクティブ種
    const out = {};
    for (const j of joints) {
      let x = 0, y = 0, wsum = 0;
      for (let i = 0; i < act.length; i++) {
        const p = poses[i][j.name];
        if (!p) continue;
        const w = weights[i] || 0;
        x += p.x * w; y += p.y * w; wsum += w;
      }
      if (wsum > 0) { x /= wsum; y /= wsum; }
      const adj = state.jointAdjust[j.name];
      if (adj) { x += adj.x; y += adj.y; }
      out[j.name] = { x, y };
    }
    return out;
  }
  

// 正規化座標（トルソ長=1基準）→ 画面座標。中央に置き、offsetでずらす
function normToScreen(x, y, cx, cy) {
    const ds = Math.min(canvas.clientWidth, canvas.clientHeight) * 0.234;
    return [ cx + (x + state.offset.x) * ds,
             cy + (y + state.offset.y) * ds ];
  }

// =============================================================================
// 描画
// =============================================================================

 // 1体ぶんのポーズを、画面上の中心 (cx, cy) に描く
  function drawPose(pose, joints, cx, cy) {
    if (state.showLines) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255,255,255,0.7)";
      for (const j of joints) {
        if (!j.parent) continue;
        const a = pose[j.name], b = pose[j.parent];
        if (!a || !b) continue;
        const [ax, ay] = normToScreen(a.x, a.y, cx, cy);
        const [bx, by] = normToScreen(b.x, b.y, cx, cy);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      }
    }
    ctx.fillStyle = "#fff";
    for (const j of joints) {
      const p = pose[j.name];
      const [sx, sy] = normToScreen(p.x, p.y, cx, cy);
      ctx.beginPath(); ctx.arc(sx, sy, 3, 0, Math.PI * 2); ctx.fill();
    }
  }

function render(phase) {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch);
    if (!state.sources.length) return;
    
    const pose = blendedPose(phase, state.weights);
      const joints = activeSources()[0].joints;
    
   const COPIES = 3;              // ★横に並べる複製数
    const STEP   = cw * 0.32;      // ★複製どうしの間隔（中心間の距離px）。増やすと広がる
    const cy = ch * 0.58;          // ★やや下（0.5=中央。大きいほど下）
    const cx0 = cw / 2 - STEP * (COPIES - 1) / 2;   // 群全体を中央寄せ
    for (let k = 0; k < COPIES; k++) {
      const cx = cx0 + STEP * k;
      drawPose(pose, joints, cx, cy);
    }
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
        const act = activeSources();
        let rate = 0, wsum = 0;
        for (let i = 0; i < act.length; i++) {
          const s = act[i]; 
          const w = state.weights[i] || 0;
          rate += ((s.speed || 1) / s.loopDur) * w; wsum += w;
        }
        if (wsum > 0) rate /= wsum;
        state.phase += dt * rate;
        state.phase %= 1; if (state.phase < 0) state.phase += 1;
      } 
    render(state.phase);
  }
  lastTs = ts;
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick); 

  window.addEventListener("resize", () => {
    if (!state.sources.length) return;
    fitCanvas();
    syncPadSize(); drawPad();   // ブラウザリサイズ・DPR変化にも追従
  });


     // =============================================================================
    // ブレンドパッド：種の多角形そのものがフレーム
    //   角(頂点)を掴む → 拡大縮小 / 辺を掴む → 移動 / 内側 → ブレンド点
    //   画面全体の透明オーバーレイに描画（背景のBMが透ける）
    // =============================================================================
  
    const padCtx = elPad.getContext("2d");

    // オーバーレイcanvasの内部解像度を画面サイズ×DPRに合わせる
    function syncPadSize() {
      const dpr = window.devicePixelRatio || 1;
      const w = elPad.clientWidth, h = elPad.clientHeight;
      elPad.width  = Math.max(1, Math.round(w * dpr));
      elPad.height = Math.max(1, Math.round(h * dpr));
      padCtx.setTransform(dpr, 0, 0, dpr, 0, 0);  // 以降は論理px(CSS px)で描ける
    }
  
    // 中心 state.padCenter・半径 state.padR から正N角形の頂点（頂点0=真上）
 function padVertices() {
  if (!state.padCenter) return [];        // ★ロード前は空を返してクラッシュ防止
        const n = state.active.length || 1;
        const { x: cx, y: cy } = state.padCenter;
        const R = state.padR;   
        // 偶数角形は半ステップ回して辺を水平に（地面と平行）。奇数は頂点が上＝底辺が水平
        const rot = (n % 2 === 0) ? Math.PI / n : 0;
        const verts = [];
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + rot + (i / n) * Math.PI * 2;
          verts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
        }
        return verts; 
      }


    // 点(px,py) → N重み。各頂点までの距離の逆二乗で加重し、合計1に正規化
    function padToWeights(px, py) {
      const verts = padVertices(); 
      const raw = verts.map(v => 1 / Math.max((px - v.x) ** 2 + (py - v.y) ** 2, 1e-6));
      const s = raw.reduce((a, b) => a + b, 0) || 1;
      return raw.map(w => w / s);
    }

    // ブレンド操作点の画面座標（中心＋ローカル×半径）。移動・リサイズに追従
    function padPointScreen() {
      if (!state.padLocal) return null;
      return { x: state.padCenter.x + state.padLocal.x * state.padR,
               y: state.padCenter.y + state.padLocal.y * state.padR };
    }

    // "Aptenodytes forsteri" / "Homo_sapience" → "A. forsteri" / "H. sapience"
      function abbrevName(name) {
        const parts = (name || "").trim().split(/[\s_]+/).filter(Boolean);
        if (parts.length >= 2) return parts[0][0].toUpperCase() + ". " + parts[1];
        return parts[0] || "?";
      }

      function sourceLabel(src) {
        if (!src) return "?";
        if (state.nameMode === "wa" && src.waname) return src.waname;
        return abbrevName(src.name);
      }

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

      // モーフ中の表示頂点（from→to をイーズ補間）
      function morphVerts() {
        let t = (performance.now() - state.morph.start) / state.morph.dur;
        t = easeInOut(Math.max(0, Math.min(1, t)));
        const { from, to } = state.morph;
        return to.map((v, i) => ({ x: lerp(from[i].x, v.x, t), y: lerp(from[i].y, v.y, t)
  }));
      }

    function drawPad() {
        padCtx.clearRect(0, 0, elPad.clientWidth, elPad.clientHeight);
        const verts = padVertices();

        // 多角形の輪郭
        padCtx.strokeStyle = "rgba(255,255,255,0.6)"; padCtx.lineWidth = 1;
        padCtx.beginPath();
        verts.forEach((v, i) => i ? padCtx.lineTo(v.x, v.y) : padCtx.moveTo(v.x, v.y));
        padCtx.closePath(); padCtx.stroke();

        // 頂点＝白点（＋掴みリング）。種名はモーフ中は省略（頂点数が過渡的に合わないため）
        const act = activeSources();
         padCtx.font = "100 10px 'm-plus-2c', sans-serif"; padCtx.textAlign = "center";
        verts.forEach((v, i) => {
          padCtx.strokeStyle = "rgba(255,255,255,0.18)"; padCtx.lineWidth = 1;
          padCtx.beginPath(); padCtx.arc(v.x, v.y, VERTEX_GRAB, 0, Math.PI * 2);
  padCtx.stroke();
          padCtx.fillStyle = "#fff";
          padCtx.beginPath(); padCtx.arc(v.x, v.y, 4, 0, Math.PI * 2); padCtx.fill();
          padCtx.fillStyle = "#aaa";
           padCtx.fillText(sourceLabel(act[i]), v.x, v.y - 9);
        });
  
        // ブレンド操作点（白）
        const p = padPointScreen();
        if (p) {
          padCtx.fillStyle = "#fff";
          padCtx.beginPath(); padCtx.arc(p.x, p.y, 5, 0, Math.PI * 2); padCtx.fill();
        }
      }


    // ---- ヒットテスト用の幾何 ----
    function padXY(ev) { const r = elPad.getBoundingClientRect(); return { x: ev.clientX -
  r.left, y: ev.clientY - r.top }; }
  
    function distToSegment(p, a, b) {           // 点pと線分ab の距離
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1e-6;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    // 点pに最も近い、線分ab上の点を返す
      function closestOnSegment(p, a, b) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1e-6;
        let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return { x: a.x + t * dx, y: a.y + t * dy };
      }

      // pが多角形の外なら、最も近い辺上の点に丸めて返す（内ならそのまま）
      function clampToPoly(p, verts) {
        if (pointInPoly(p, verts)) return p;
        let best = p, bd = Infinity;
        for (let i = 0; i < verts.length; i++) {
          const c = closestOnSegment(p, verts[i], verts[(i + 1) % verts.length]);
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (d < bd) { bd = d; best = c; }        // return値は同じ行、の原則を維持
        }
        return best;
      }

    function pointInPoly(p, verts) {            // 多角形の内外判定（レイキャスト）
      let inside = false;
      for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const a = verts[i], b = verts[j];
        if (((a.y > p.y) !== (b.y > p.y)) &&
            (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
      }
      return inside;  
    }

    // マウス位置から操作モードを判定: 'resize' | 'move' | 'blend' | null
      const VERTEX_GRAB = 30, EDGE_GRAB = 24;

      function padHit(p) {
          const verts = padVertices();
          if (verts.length < 2) return null;
          // 角 → resize（最優先）
          for (const v of verts)
            if (Math.hypot(p.x - v.x, p.y - v.y) <= VERTEX_GRAB) return "resize";
          // 2頂点＝線分は内側が無いので、線の近く＝ブレンド（線上に投影される）
          if (verts.length === 2) {
            return distToSegment(p, verts[0], verts[1]) <= EDGE_GRAB * 2 ? "blend" : null;
          }
          // 辺 → move
          for (let i = 0; i < verts.length; i++)
            if (distToSegment(p, verts[i], verts[(i + 1) % verts.length]) <= EDGE_GRAB)
  return "move";
          // 内側 → blend
          if (pointInPoly(p, verts)) return "blend";
          return null;
        }

   function setBlend(p) {
        const q = clampToPoly(p, padVertices());   // ★図形の外に出さない
        state.padLocal = { x: (q.x - state.padCenter.x) / state.padR,
                           y: (q.y - state.padCenter.y) / state.padR };
        state.weights = padToWeights(q.x, q.y);
        elPadW.textContent = state.weights.map(w => w.toFixed(2)).join(" / ");
        drawPad();
      }


      // 左下UI：角数と各角の種セレクトを組み立て直す
      function rebuildShapeUI() {
        suN.textContent = state.active.length;
        suList.innerHTML = "";
        state.active.forEach((srcIdx, corner) => {
          const row = document.createElement("div");
          row.className = "su-item";
          const dot = document.createElement("span");
          dot.className = "su-dot";
          const sel = document.createElement("select");
          sel.className = "su-sel";
          state.sources.forEach((s, si) => {
            const o = document.createElement("option");
            o.value = si; o.textContent = sourceLabel(s);
            if (si === srcIdx) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener("change", () => {
            state.active[corner] = parseInt(sel.value, 10);   // その角の種を差し替え
            applyShapeChange();
          });
          row.appendChild(dot); row.appendChild(sel);
          suList.appendChild(row);
        });
      }
  
      // 頂点集合が変わったら重みを取り直して再描画（操作点は維持）＋UI再構築
      function applyShapeChange() {
        const verts = padVertices();
        setBlend(padPointScreen() || verts[0]);   // clamp込みで padLocal/weights/描画を更新
        rebuildShapeUI();
      }

      const nameSci = document.getElementById("nameSci");
      const nameWa  = document.getElementById("nameWa");
      function setNameMode(mode) {
        state.nameMode = mode;
        nameSci.classList.toggle("active", mode === "sci");
        nameWa.classList.toggle("active",  mode === "wa");
        drawPad();          // パッドのラベル更新
        rebuildShapeUI();   // セレクトのラベル更新
      }
      nameSci.addEventListener("click", () => setNameMode("sci"));
      nameWa.addEventListener("click",  () => setNameMode("wa"));

      function shapeInc() {
          if (state.active.length >= state.sources.length) return;
          let idx = state.sources.findIndex((_, i) => !state.active.includes(i));
          if (idx < 0) idx = 0;
          state.active.push(idx);
          applyShapeChange();
        } 
        function shapeDec() {
          if (state.active.length <= 2) return;
          state.active.pop();
          applyShapeChange();
        }

      
      // 角数変化：旧→新の頂点をイーズ補間。増減で足りない頂点は中心で出入りさせる
      function onCornerCountChange(oldVerts) {
        const newVerts = padVertices();                 // 新しい角数の頂点
        const c = state.padCenter;
        const M = Math.max(oldVerts.length, newVerts.length);
        const pad = (arr) => Array.from({ length: M }, (_, i) => arr[i] || { x: c.x, y: c.y
  });   
        state.morph = { from: pad(oldVerts), to: pad(newVerts), start: performance.now(),
  dur: 350 };
        setBlend(padPointScreen() || newVerts[0]);      // 重み・操作点は新形状で更新
        rebuildShapeUI();
        requestAnimationFrame(morphTick);
      } 
      
      // モーフ中だけ回す描画ループ
      function morphTick() {
        if (!state.morph) return;
        drawPad();
        if (performance.now() - state.morph.start >= state.morph.dur) {
          state.morph = null; 
          drawPad();                                    // 最終形状で確定描画（ラベル復帰）
        } else {
          requestAnimationFrame(morphTick);
        }
      }


  
     // ---- 操作 ----
      let padMode = null, moveGrab = null;
      elPad.addEventListener("pointerdown", (e) => {
        e.preventDefault();            // ★ネイティブのドラッグ/選択を止める
        const p = padXY(e);            
        padMode = padHit(p);
        // console.log("[pad] down:", padMode);   // ★診断（後で消す）
        if (!padMode) return;                       // 図形の外 → 何もしない
        elPad.setPointerCapture(e.pointerId);       
        if (padMode === "move") moveGrab = { dx: p.x - state.padCenter.x, dy: p.y -
  state.padCenter.y };
        if (padMode === "blend") setBlend(p);


    });
    elPad.addEventListener("pointermove", (e) => {
      const p = padXY(e);
        // console.log("[pad] move padMode=", padMode);   // ★診断
      if (!padMode) {                             // 非ドラッグ時 → カーソル形状だけ更新
        const hit = padHit(p);
        elPad.style.cursor = hit === "resize" ? "nwse-resize"
                           : hit === "move"   ? "move"
                           : hit === "blend"  ? "crosshair" : "default";
        return;
      }
      if (padMode === "resize") {                 // 角ドラッグ → 中心からの距離を半径に
          // console.log("[pad] resize drag");         // ★診断（後で消す）
          state.padR = Math.max(30, Math.hypot(p.x - state.padCenter.x, p.y -
  state.padCenter.y));
          drawPad();
      } else if (padMode === "move") {            // 辺ドラッグ → 図形ごと平行移動
        state.padCenter = { x: p.x - moveGrab.dx, y: p.y - moveGrab.dy };
        drawPad();
      } else if (padMode === "blend") {           // 内側ドラッグ → ブレンド点
        setBlend(p);
      }
    });
    elPad.addEventListener("pointerup", () => { padMode = null; });

    suInc.addEventListener("click", shapeInc);
      suDec.addEventListener("click", shapeDec);

       // 図形設定パネルを左下の角ドラッグでスケール（右上基準）
      const shapeUI  = document.getElementById("shapeUI");
      const suResize = document.getElementById("su-resize");
      let shapeScale = 1, suRez = null;

      suResize.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = shapeUI.getBoundingClientRect();
        suRez = { anchorX: r.right, anchorY: r.top,
                  d0: Math.hypot(e.clientX - r.right, e.clientY - r.top) || 1, s0: shapeScale
  };              
      });
      window.addEventListener("pointermove", (e) => {
        if (!suRez) return;
        const d = Math.hypot(e.clientX - suRez.anchorX, e.clientY - suRez.anchorY);
        shapeScale = Math.max(0.6, Math.min(2.5, suRez.s0 * d / suRez.d0));
        shapeUI.style.transform = `scale(${shapeScale})`; 
      });
      window.addEventListener("pointerup", () => { suRez = null; });
  