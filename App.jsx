import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  doc,
  getDoc,
  onSnapshot,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage, ensureSignedIn } from "./firebase.js";

// いらすとや（https://www.irasutoya.com）のフリー素材。非営利イベントで規約に沿って使用。
import detectiveImg from "./assets/detective.png";
import mapImg from "./assets/map.png";
import chestImg from "./assets/chest.png";
import cameraImg from "./assets/camera.png";
import envelopeImg from "./assets/envelope.png";

// ============================================================
// 1. 定数・データ定義
// ============================================================

const TEAMS = [
  { key: "risa", name: "チームりさ" },
  { key: "tsubasa", name: "チームつばさ" },
  { key: "muta", name: "チームむた" },
  { key: "koharu", name: "チームこはる" },
  { key: "eito", name: "チームえいと" },
  { key: "shiori", name: "チームしおり" },
];
const TEAM_KEYS = TEAMS.map((t) => t.key);

// 合言葉 → 獲得する文字パーツ。各パーツの id は正解の並び順(1〜7)。
// 1つの暗号で得る2文字は正解順で隣接しない組み合わせ（並び順のヒントにしないため）。
// 正解順 = id昇順 → み(1) な(2) み(3) な(4) が(5) さ(6) き(7) = 「みなみながさき」
const CODE_MAP = {
  ハナレ: { chars: [{ id: 1, char: "み" }, { id: 6, char: "さ" }] },
  フーチークーチー: { chars: [{ id: 2, char: "な" }, { id: 5, char: "が" }] },
  ムッシュ: { chars: [{ id: 3, char: "み" }, { id: 7, char: "き" }] },
  マサラハット: { chars: [{ id: 4, char: "な" }] },
};

const TOTAL_CHARS = 7;
const PHOTO_SLOTS = 4;
const CHAR_BY_ID = { 1: "み", 2: "な", 3: "み", 4: "な", 5: "が", 6: "さ", 7: "き" };

// ============================================================
// 2. ヘルパー
// ============================================================

// 入力正規化: trim → 全角→半角 → toUpperCase → ひらがな→カタカナ
function normalizeCipher(input) {
  let s = input.trim();
  s = s.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  s = s.toUpperCase();
  s = s.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
  return s;
}

// 表示用シャッフル（獲得した複数文字の並びで正解順を見せないため）
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Canvas APIで長辺600px以下にリサイズ、JPEG品質0.7のBlobに変換
function resizeImageToBlob(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxSize = 600;
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))),
          "image/jpeg",
          0.7
        );
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getTeamFromUrl() {
  const t = new URLSearchParams(window.location.search).get("team");
  return t && TEAM_KEYS.includes(t) ? t : null;
}

function initialTeamData(teamKey) {
  const t = TEAMS.find((x) => x.key === teamKey);
  return {
    teamName: t ? t.name : "",
    unlockedChars: [],
    order: [],
    phase: "collecting",
    photos: Array(PHOTO_SLOTS).fill(null),
  };
}

// ============================================================
// 3. 共通UIコンポーネント
// ============================================================

function Toast({ toast }) {
  if (!toast) return null;
  return <div className={`toast ${toast.type}`}>{toast.message}</div>;
}

function ImageModal({ src, onClose }) {
  if (!src) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <img
        className="modal-img"
        src={src}
        alt="しゃしん"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// 文字獲得の演出（シャッフルした並びで表示）
function CharRevealModal({ reveal, onClose }) {
  if (!reveal) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="char-reveal" onClick={(e) => e.stopPropagation()}>
        <img className="reveal-img" src={chestImg} alt="" />
        <div className="got-label">{reveal.length}もじ ゲット！</div>
        <div className="chars">
          {reveal.map((c, i) => (
            <div key={i} className="big-char">
              {c}
            </div>
          ))}
        </div>
        <button className="btn full" onClick={onClose}>
          やったー！
        </button>
      </div>
    </div>
  );
}

// ============================================================
// 4. チーム選択画面
// ============================================================

function TeamSelectScreen({ onSelect }) {
  const [savedKeys, setSavedKeys] = useState([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 厳格ルールに合わせ、既知の各チームを個別に getDoc で確認する
      // （コレクション一括クエリはルールで拒否されるため）。
      const results = await Promise.all(
        TEAMS.map((t) =>
          getDoc(doc(db, "teams", t.key))
            .then((snap) => {
              const d = snap.exists() ? snap.data() : null;
              const has =
                d &&
                ((d.unlockedChars && d.unlockedChars.length > 0) ||
                  (d.photos && d.photos.some(Boolean)));
              return has ? t.key : null;
            })
            .catch(() => null)
        )
      );
      if (!alive) return;
      setSavedKeys(results.filter(Boolean));
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="app">
      <img className="hero" src={detectiveImg} alt="" />
      <h1 className="title">なぞとき たんけんたい</h1>
      <p className="subtitle">じぶんの チームを えらんでね</p>
      <img className="deco" src={mapImg} alt="" />
      <div className="team-grid">
        {TEAMS.map((t) => (
          <button key={t.key} className="team-btn" onClick={() => onSelect(t.key)}>
            {savedKeys.includes(t.key) && <span className="badge">つづきから</span>}
            {t.name}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// 5. メイン画面（暗号入力・文字あつめ・写真）
// ============================================================

function MainScreen({
  data,
  teamKey,
  onUpdate,
  onGoArrange,
  onChangeTeam,
  showToast,
  showModal,
  showReveal,
}) {
  const [cipherInput, setCipherInput] = useState("");
  const [uploadingSlot, setUploadingSlot] = useState(null);
  const fileRefs = useRef([]);

  const unlockedIds = data.unlockedChars.map((c) => c.id);
  const gotCount = data.unlockedChars.length;

  const handleSubmitCipher = async () => {
    const value = cipherInput.trim();
    if (!value) return;
    const norm = normalizeCipher(value);
    const entry = CODE_MAP[norm];
    if (!entry) {
      showToast("ちがうみたい。もういちど さがしてみよう！", "error");
      return;
    }
    const newOnes = entry.chars.filter((c) => !unlockedIds.includes(c.id));
    if (newOnes.length === 0) {
      showToast("この あいことばは もうゲットしてるよ", "info");
      setCipherInput("");
      return;
    }
    const newChars = [...data.unlockedChars, ...newOnes];
    const becameComplete = newChars.length >= TOTAL_CHARS;
    const order =
      becameComplete && data.order.length < TOTAL_CHARS
        ? newChars.map((c) => c.id)
        : data.order;
    const phase = becameComplete ? "arranging" : "collecting";

    try {
      await onUpdate({ unlockedChars: newChars, order, phase });
      setCipherInput("");
      // 獲得した文字を並び順が分からないようシャッフルして見せる
      showReveal(shuffled(newOnes.map((c) => c.char)));
      if (becameComplete) {
        showToast("ぜんぶ あつまった！ ならべかえへ すすもう", "success");
      }
    } catch {
      showToast("ほぞんに しっぱいしたよ。もういちど", "error");
    }
  };

  const handlePhotoUpload = async (slot, e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingSlot(slot);
    try {
      const blob = await resizeImageToBlob(file);
      const path = `photos/${teamKey}/${slot}.jpg`;
      const r = storageRef(storage, path);
      await uploadBytes(r, blob, { contentType: "image/jpeg" });
      const url = await getDownloadURL(r);
      const newPhotos = [...data.photos];
      newPhotos[slot] = { url, path };
      await onUpdate({ photos: newPhotos });
      showToast("しゃしんを ほぞんしたよ", "success");
    } catch {
      showToast("しゃしんの ほぞんに しっぱいしたよ", "error");
    } finally {
      setUploadingSlot(null);
    }
  };

  return (
    <div className="app">
      <div className="header">
        <span className="team-name">{data.teamName}</span>
        <button className="btn ghost" onClick={onChangeTeam}>
          チームを かえる
        </button>
      </div>

      {/* 暗号入力 */}
      <div className="card">
        <h2 className="card-title">
          <img className="icon" src={envelopeImg} alt="" />
          あいことばを いれよう
        </h2>
        <input
          className="cipher-input"
          type="text"
          value={cipherInput}
          onChange={(e) => setCipherInput(e.target.value)}
          placeholder="ふうとうの あいことば"
          onKeyDown={(e) => e.key === "Enter" && handleSubmitCipher()}
        />
        <button className="btn full" onClick={handleSubmitCipher}>
          そうしん
        </button>
      </div>

      {/* 文字あつめ */}
      <div className="card">
        <h2 className="card-title">あつめた もじ</h2>
        <div className="count">
          {gotCount} / {TOTAL_CHARS} もじ
        </div>
        <div className="char-progress">
          {Array.from({ length: TOTAL_CHARS }).map((_, i) => {
            const got = data.unlockedChars[i];
            return (
              <div key={i} className={`char-chip ${got ? "got" : ""}`}>
                {got ? got.char : "?"}
              </div>
            );
          })}
        </div>
      </div>

      {/* 記念写真 */}
      <div className="card">
        <h2 className="card-title">きねん しゃしん（{PHOTO_SLOTS}まい）</h2>
        <div className="photo-grid">
          {Array.from({ length: PHOTO_SLOTS }).map((_, slot) => {
            const photo = data.photos[slot];
            return (
              <div
                key={slot}
                className={`photo-slot ${uploadingSlot === slot ? "uploading" : ""}`}
                onClick={() => {
                  if (uploadingSlot === slot) return;
                  if (photo) showModal(photo.url);
                  else fileRefs.current[slot]?.click();
                }}
              >
                {uploadingSlot === slot ? (
                  <div className="photo-hint">ほぞんちゅう…</div>
                ) : photo ? (
                  <img src={photo.url} alt="きねんしゃしん" />
                ) : (
                  <div className="photo-hint">
                    <img className="cam-icon" src={cameraImg} alt="" />
                    <br />
                    タップして さつえい
                  </div>
                )}
                <input
                  ref={(el) => (fileRefs.current[slot] = el)}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  style={{ display: "none" }}
                  onChange={(e) => handlePhotoUpload(slot, e)}
                />
              </div>
            );
          })}
        </div>
      </div>

      {data.phase === "arranging" && (
        <button className="btn blue full" onClick={onGoArrange}>
          もじを ならべかえる
        </button>
      )}
    </div>
  );
}

// ============================================================
// 6. 並べ替え画面（touchベースのドラッグ&ドロップ）
// ============================================================

function ArrangeScreen({ data, onUpdate, onBack, showToast }) {
  const [order, setOrder] = useState(data.order);
  const [confirmed, setConfirmed] = useState(false);

  const dragStateRef = useRef({
    active: false,
    dragIndex: -1,
    startY: 0,
    currentY: 0,
    itemHeight: 0,
  });
  const listRef = useRef(null);
  const itemRefs = useRef([]);
  const orderRef = useRef(order);
  orderRef.current = order;

  // 他端末でorderが変わったら追従（ドラッグ中でなければ）
  useEffect(() => {
    if (!dragStateRef.current.active) {
      setOrder(data.order);
    }
  }, [data.order]);

  const onHandleTouchStart = (e, index) => {
    e.stopPropagation();
    const touch = e.touches[0];
    const items = itemRefs.current;
    const rect = items[index]?.getBoundingClientRect();
    if (!rect) return;

    dragStateRef.current = {
      active: true,
      dragIndex: index,
      startY: touch.clientY,
      currentY: touch.clientY,
      itemHeight: rect.height + 10, // gap=10px
    };

    if (items[index]) {
      items[index].style.transform = "scale(1.04)";
      items[index].style.opacity = "0.9";
      items[index].style.boxShadow = "0 10px 28px rgba(0,0,0,0.25)";
      items[index].style.zIndex = "10";
      items[index].style.transition = "none";
    }
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const onMove = (e) => {
      const ds = dragStateRef.current;
      if (!ds.active) return;
      e.preventDefault();

      const touch = e.touches[0];
      ds.currentY = touch.clientY;
      const deltaY = ds.currentY - ds.startY;
      const items = itemRefs.current;
      const dragIdx = ds.dragIndex;

      if (items[dragIdx]) {
        items[dragIdx].style.transform = `translateY(${deltaY}px) scale(1.04)`;
      }

      const shiftCount = Math.round(deltaY / ds.itemHeight);
      const newIndex = Math.max(
        0,
        Math.min(orderRef.current.length - 1, dragIdx + shiftCount)
      );

      for (let i = 0; i < orderRef.current.length; i++) {
        if (i === dragIdx || !items[i]) continue;
        items[i].style.transition = "transform 200ms ease";
        if (
          (shiftCount > 0 && i > dragIdx && i <= newIndex) ||
          (shiftCount < 0 && i < dragIdx && i >= newIndex)
        ) {
          const dir = shiftCount > 0 ? -1 : 1;
          items[i].style.transform = `translateY(${dir * ds.itemHeight}px)`;
        } else {
          items[i].style.transform = "translateY(0)";
        }
      }
    };

    const onEnd = () => {
      const ds = dragStateRef.current;
      if (!ds.active) return;

      const deltaY = ds.currentY - ds.startY;
      const shiftCount = Math.round(deltaY / ds.itemHeight);
      const dragIdx = ds.dragIndex;
      const newIndex = Math.max(
        0,
        Math.min(orderRef.current.length - 1, dragIdx + shiftCount)
      );

      itemRefs.current.forEach((item) => {
        if (item) {
          item.style.transform = "";
          item.style.opacity = "";
          item.style.boxShadow = "";
          item.style.zIndex = "";
          item.style.transition = "";
        }
      });

      if (newIndex !== dragIdx) {
        const newOrder = [...orderRef.current];
        const [moved] = newOrder.splice(dragIdx, 1);
        newOrder.splice(newIndex, 0, moved);
        orderRef.current = newOrder;
        setOrder(newOrder);
        setConfirmed(false);
        onUpdate({ order: newOrder }).catch(() => {});
      }

      ds.active = false;
      ds.dragIndex = -1;
    };

    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    return () => {
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
    };
  }, [onUpdate]);

  return (
    <div className="app">
      <div className="header">
        <span className="team-name">{data.teamName}</span>
        <button className="btn ghost" onClick={onBack}>
          もじあつめに もどる
        </button>
      </div>

      <div className="card">
        <h2 className="card-title">ただしい じゅんばんに ならべよう！</h2>
        <p className="subtitle" style={{ margin: "4px 0 0" }}>
          右の とってを ながおしして うごかせるよ
        </p>
      </div>

      <div className="arrange-list" ref={listRef}>
        {order.map((id, index) => (
          <div
            key={`slot-${index}`}
            ref={(el) => (itemRefs.current[index] = el)}
            className="arrange-item"
          >
            <div className="arrange-char">{CHAR_BY_ID[id]}</div>
            <div
              className="arrange-handle"
              onTouchStart={(e) => onHandleTouchStart(e, index)}
            >
              <span />
              <span />
              <span />
            </div>
          </div>
        ))}
      </div>

      <button
        className="btn full"
        style={{ marginTop: 16 }}
        onClick={() => {
          setConfirmed(true);
          showToast("おとなのひとに みせてね！", "success");
        }}
      >
        これで けってい！
      </button>
      {confirmed && (
        <p className="count" style={{ marginTop: 12 }}>
          おとなのひとに みせてね！
        </p>
      )}
    </div>
  );
}

// ============================================================
// 7. App ルート
// ============================================================

export default function App() {
  const [teamKey, setTeamKey] = useState(() => getTeamFromUrl());
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [data, setData] = useState(null);
  const [screen, setScreen] = useState("main"); // "main" | "arrange"

  const [toast, setToast] = useState(null);
  const [modalImage, setModalImage] = useState(null);
  const [reveal, setReveal] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((message, type = "info") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);
  const showModal = useCallback((src) => setModalImage(src), []);
  const showReveal = useCallback((chars) => setReveal(chars), []);

  // 匿名認証
  useEffect(() => {
    ensureSignedIn()
      .then(() => setAuthReady(true))
      .catch(() => setAuthError(true));
  }, []);

  // チームドキュメントの購読（リアルタイム同期）
  useEffect(() => {
    if (!authReady || !teamKey) return;
    const refDoc = doc(db, "teams", teamKey);
    const unsub = onSnapshot(
      refDoc,
      (snap) => {
        if (!snap.exists()) {
          setDoc(refDoc, initialTeamData(teamKey)).catch(() => {});
        } else {
          setData(snap.data());
        }
      },
      () => showToast("つうしんエラーが おきたよ", "error")
    );
    return unsub;
  }, [authReady, teamKey, showToast]);

  // phaseに応じて初期画面を合わせる
  useEffect(() => {
    if (data?.phase === "arranging") setScreen("arrange");
    else setScreen("main");
  }, [data?.phase]);

  const handleUpdate = useCallback(
    (partial) => {
      if (!teamKey) return Promise.reject();
      return updateDoc(doc(db, "teams", teamKey), partial);
    },
    [teamKey]
  );

  const selectTeam = (key) => {
    window.history.replaceState(null, "", `?team=${key}`);
    setData(null);
    setTeamKey(key);
  };
  const changeTeam = () => {
    window.history.replaceState(null, "", window.location.pathname);
    setData(null);
    setTeamKey(null);
  };

  let body;
  if (authError) {
    body = (
      <div className="loading">
        <div>つうしんの じゅんびに しっぱいしたよ</div>
        <div className="subtitle">
          おとなのひとに きいてみてね（Firebaseのせってい）
        </div>
      </div>
    );
  } else if (!authReady) {
    body = (
      <div className="loading">
        <div className="spinner" />
        <div>よみこみちゅう…</div>
      </div>
    );
  } else if (!teamKey) {
    body = <TeamSelectScreen onSelect={selectTeam} />;
  } else if (!data) {
    body = (
      <div className="loading">
        <div className="spinner" />
        <div>よみこみちゅう…</div>
      </div>
    );
  } else if (screen === "arrange") {
    body = (
      <ArrangeScreen
        data={data}
        onUpdate={handleUpdate}
        onBack={() => setScreen("main")}
        showToast={showToast}
      />
    );
  } else {
    body = (
      <MainScreen
        data={data}
        teamKey={teamKey}
        onUpdate={handleUpdate}
        onGoArrange={() => setScreen("arrange")}
        onChangeTeam={changeTeam}
        showToast={showToast}
        showModal={showModal}
        showReveal={showReveal}
      />
    );
  }

  return (
    <>
      {body}
      <Toast toast={toast} />
      <ImageModal src={modalImage} onClose={() => setModalImage(null)} />
      <CharRevealModal reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}
