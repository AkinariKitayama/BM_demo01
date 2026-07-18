# CLAUDE.md — BM (Biological Motion) Blend Project

このリポジトリを引き継ぐ人（および Claude Code）向けの作業ガイド。
プロジェクトの目的・データ規約・各処理の「なぜ」・現状の実装・既知の課題・次の一手をまとめる。

---

## 0. プロジェクト概要

立体系統樹 × バイオロジカルモーション（点光源ディスプレイ, Johansson 型）のアート作品。

パイプラインは2段階:

1. **AE（After Effects）側** — 各種の歩行/羽ばたきを手付けアニメーションし、各関節の座標を JSON で書き出す。
2. **Web 側** — その JSON を読み込み、補間・正規化して再生し、種どうしのモーションを**ブレンド（モーフ）**する。系統樹上で「種の間の運動」を見せるのが最終目的。

設計の中心思想:
- **AE 側は測定値をそのまま吐く層に徹する**（加工しない）。解釈・補間・正規化はすべて Web 側に寄せる。方針変更のたびに AE に戻らないため。
- 関節は**相同性ベースで種をまたいで対応**させる。だから関節命名規則を固定する（`vertebrate_v1`）。

---

## 1. ファイル構成

```
/ (web root, ※ http配信が必須。file:// では fetch がブロックされる)
  index.html          … UI（黒背景・白線・白点。右に操作パネル）
  script.js           … 本体（ESモジュール）
  style.css           … スタイル
  /data/
    bat.json          … コウモリ Pipistrellus_abramus
    Homo_sapience.json… ヒト（※ファイル名の "sapience" は誤綴りだが現状そのまま）

AE 用スクリプト（リポジトリ外。別途配布）:
  bm_panel.jsx        … ScriptUIパネル。関節シェイプ追加 + JSON書き出しの2機能
```

起動方法（重要）: 配信しないと `fetch("/data/...")` が失敗する。
```
そのフォルダで:  python3 -m http.server   →  http://localhost:8000
（VSCode Live Server でも可）
```

---

## 2. 関節語彙（vertebrate_v1）— 最重要規約

レイヤー名 = 関節名 = JSON のキー。**綴りも順序も固定**。AE のシェイプレイヤー名はこれと完全一致させる。

並び順（近位→遠位）:
```
head, neck,
Lshoulder, Rshoulder,
Lelbow, Relbow,
Lwrist, Rwrist,
Lfinger, Rfinger,
hipjoint,
Lhip, Rhip,
Lknee, Rknee,
Lankle, Rankle,
Ltoe, Rtoe
```
- 左右は `L`/`R` 前置、正中（head/neck/hipjoint）は接頭辞なし。
- 任意関節 `tail`（尻尾の先）。Web の補間時は hipjoint と統合する想定（※未実装）。
- 進化的に特殊な骨が出たら別途追加していく方針。

親子関係（ボーン構造。Web でボーン長保存などに使える）:
```
head→neck, neck→hipjoint,
Lshoulder→neck, Rshoulder→neck,
Lelbow→Lshoulder, Relbow→Rshoulder,
Lwrist→Lelbow, Rwrist→Relbow,
Lfinger→Lwrist, Rfinger→Rwrist,
hipjoint→(root), Lhip→hipjoint, Rhip→hipjoint,
Lknee→Lhip, Rknee→Rhip,
Lankle→Lknee, Rankle→Rknee,
Ltoe→Lankle, Rtoe→Rankle,
tail→hipjoint
```
親子は JSON の `joints[].parent` にも入っている。

---

## 3. JSON スキーマ（AE 書き出し）

```jsonc
{
  "schema_version": "1.0",
  "joint_definition": "vertebrate_v1",
  "species": { "name": "<comp名>", "name_sci": null, "taxon_id": null },
  "capture": {
    "fps": 23.976,            // 撮影fps（種ごとに異なる）
    "frame_count": 45,
    "duration_sec": 1.877,    // = frame_count / fps。ループ周期の基準
    "coordinate_system": "AE_raw",  // 原点=左上 / Y下向き
    "view": null, "direction": null, "scale_ref_px": null
  },
  "joints": [ { "name": "head", "parent": "neck", "in_vocabulary": true, "source": "measured" }, ... ],
  "frames": [
    { "f": 0, "coords": {
        "head": { "x": 870.4, "y": 558.9, "tracked": true },
        "Relbow": { "x": 637.5, "y": 531.7, "tracked": false, "reason": "no_key" }
    }}, ...
  ],
  "warnings": [ "..." ]
}
```

### tracked フラグの意味（最重要）
- AE 側は **「そのフレームに position キーフレームがあるか」で tracked を決める**。
  - キーあり → `tracked: true`（=実観測フレーム）
  - キーなし（AEの補間値が入っている） → `tracked: false`, `reason: "no_key"`
- 運用は「観測できたフレームにだけキーを打つ」。隠れて追えない区間はキーを飛ばす。
- **Web 側は `tracked:false` の x,y を捨て、`tracked:true` のキーだけを根拠に独自補間する。**
- `hipjoint` はレイヤーが無ければ AE 側で Lhip/Rhip の中点から生成（`source:"derived"`）。

### 座標系
- AE も HTML Canvas も「原点=左上・Y下向き」なので **Canvas 描画では Y 反転不要**。
- 将来 Three.js（Y上向き）へ移す場合は Y 反転が必要になる。

---

## 4. AE スクリプト（bm_panel.jsx）の仕様

ScriptUI パネル。ドッキング（ScriptUI Panels フォルダに置く）または単発実行。

- **① 関節シェイプを追加**: 19関節（+任意 tail）の円シェイプを一括生成。
  - 横向き骨格のラフ配置。半径・色指定可。左右色分け（L=赤/R=青/正中=黄）可。
  - **追加する円は不透明度0%**（位置トラッカーとして使い、見た目は出さない）。
  - アンカーをローカル原点に合わせてあるので `position` がそのまま点座標になる。
- **② JSON 書き出し**: アクティブコンポの各シェイプレイヤーの position を全フレーム読み、上記スキーマで保存。
  - 非表示レイヤーはスキップ。シェイプレイヤーのみ対象。
  - 語彙順にソート。語彙外の名前は警告のみ（出力はする）。
  - 欠損判定 = キーフレーム有無（前述）。

---

## 5. Web 側アーキテクチャ（script.js）

### 状態（state）
```js
{
  sources: [],            // [A, B] 各ソース（下記 buildSource の戻り値 + speed）
  phase: 0,               // 0..1 の位相クロック（全ソース共通）
  blend: 0,               // A↔B ブレンド量（0=A, 1=B）
  playing: true,
  offset: {x,y},          // 正規化空間（トルソ長=1）でのオフセット
  jointAdjust: {},        // name -> {x,y}（正規化空間での関節微調整）
  smooth: true,           // 補間方式（true=Catmull-Rom, false=線形）
  showLines: true
}
```
※ 速度は state ではなく **各ソースが `speed` を持つ**（種ごとに別カデンス）。bat=11, human=1。

### 処理の流れと「なぜ」

1. **読み込み** `Promise.all` で2種を fetch → `buildSource()` で前処理。
2. **buildSource(data)** → `{ name, joints, tracks, loopDur, scale }`
   - `tracks`: 関節ごとに `tracked:true` のキーだけ集め、`buildTrack()` でループ用の折り返し点（前後±2点）を付与。
   - `loopDur = frames.length / fps`（ループ周期）。
   - `scale`: **トルソ長（hipjoint-neck）の平均**。正規化のサイズ基準。bat/human とも約205-213でほぼ等しいのでブレンド時のサイズが揃う。
3. **sampleTrack(track, t, smooth)**: 時刻 t の位置。区間を二分探索し、
   - 線形 or **時間対応 Catmull-Rom（hermite）**で補間。接線を「隣点の差÷時間差」で出すのでキー間隔が不均一でも速度が正しい。
   - これにより **元fps（24/25）に縛られず、画面リフレッシュ（60/120Hz）でサンプリング→自動的に60fps以上**になる。
4. **normalizedPose(src, phase)**: 位置合わせ。
   - **腰(hipjoint)を毎フレーム原点に**（根の絶対移動を除去＝その場ループ）。
   - **トルソ長(scale)で割る**（体サイズを1に）。
   - → 異種が共通座標枠に乗り、ブレンド可能になる。
5. **blendedPose(phase, w)**: 各関節で `lerp(normA, normB, w)`。`jointAdjust` もここで加算。
6. **normToScreen(x,y)**: 正規化座標→画面。`ds = min(cw,ch)*0.18` で中央配置 + `offset`。
7. **tick(ts)**: 位相クロック。
   - `rate = lerp(speedA/loopDurA, speedB/loopDurB, blend)`（**ブレンド量で速度も補間**）。
   - `phase += dt * rate; phase %= 1`（ループ）。
   - ⚠ ループ起動の `requestAnimationFrame(tick)` を tick 定義直後に1回呼ぶこと（これが無いと一度も描画されず黒画面になる。過去に実際に踏んだ）。

### UI コントロール
- Play/Pause、frame スライダー（位相シーク。再生中は自走しない）
- Smoothing（補間方式トグル）、Line（骨線トグル）
- Blend（A↔B）
- Speed A / Speed B（種ごとの速度。0–20倍）
- Offset X/Y（正規化空間 -3..3）
- Joint adjust（関節を選んで X/Y を微調整 -1.5..1.5、Reset）

### ルック
- 黒背景・白点（半径3px）・細い白線（1px）。等幅フォントの計器的UI。
- 仕様: 白点で BM、骨線は ON/OFF 可。

---

## 6. 既知の課題・未実装（次の一手の候補）

- **位相オフセット未実装**: A/B を 0..1 で素直に対応づけただけ。羽ばたきの頂点とヒトの接地など**サイクル内の位相ズレは未調整**。中間ブレンドが不自然なら、片方の位相に定数オフセットを足す機能が効く。
- **腰固定の副作用**: 毎フレーム hipjoint を原点に固定するため、腰の上下動（bob）が消える。必要なら「周期平均の中心で固定」など別正規化を検討。
- **tail の hipjoint 統合**が Web 側で未実装。
- **関節対応は完全一致前提**。種で関節集合が違う場合のフェードイン/アウトは未対応（現状は A の joints を基準に、B に無ければ A 値で代替）。
- **Load JSON ボタン（#file）は死にコード**（削除済みの setMotion を呼ぶ）。自動 fetch に移行済みなので削除してよい。
- **多種ブレンド・系統樹連動は未着手**（現状2ソースのみ）。最終的には系統樹のノード/枝に種を割り当て、複数種の重み付き合成へ拡張する想定。
- 表示倍率 `0.18` は固定。種によりはみ出す場合あり。zoom スライダー追加が楽。

---

## 7. 作業の進め方（このプロジェクトでの合意事項）

ユーザーの希望:
- **一気に実装せず1段階ずつ**進める。
- 処理が**ブラックボックス化しないよう、各処理の中身を都度わかりやすく解説**する。
- 修正は原則**ファイル丸ごとでなく「変更部のコード」を分けて**渡す（HTML/JS/CSS のどこを置換/削除/追加するか明示）。
- ユーザーは JS を多少扱える。
- コードを書くのは必ずユーザー。claude側でファイルに直接書き込むことはしない。

過去のステップ:
- Step1 読み込み+静止描画 / Step2 再生+補間（位相未導入, 絶対時間） / Step3 速度・オフセット・関節微調整 / Step4 2種ブレンド（位相正規化導入）。

デバッグの定石（過去に踏んだもの）:
- `Cannot set properties of null` / `addEventListener of null` → **HTML 側の対応する要素IDが未追加/消失**。HTMLとJSの取りこぼしを疑う。
- 黒画面のまま無エラー → **`requestAnimationFrame(tick)` の初回キック漏れ**、または fetch パス不一致。
- コンソールのエラー行番号と、その行が触っている要素IDを照合すると HTML/JS どちらの問題か即わかる。

---

## 8. クイックリファレンス（関数マップ / script.js）

```
buildSource(data)        前処理 → {name, joints, tracks, loopDur, scale}
buildTrack(pts, loopDur) キー列にループ折り返し点を付与
sampleTrack(tr, t, sm)   時刻tの位置（線形 or Catmull-Rom）
hermite(...)             時間対応エルミート補間（スムージングの中身）
normalizedPose(src, ph)  腰=原点・トルソ長=1 に正規化
centroid(raw, joints)    hipjoint 欠如時の原点フォールバック
blendedPose(ph, w)       A/B を関節ごとに lerp + jointAdjust 加算
normToScreen(x, y)       正規化座標 → 画面座標（中央 + offset, ds=min*0.18）
render(phase)            1フレーム描画（線→点）
tick(ts)                 位相を進めて render。rate は速度ブレンド
fitCanvas()              高DPI対応のキャンバス解像度設定
```
