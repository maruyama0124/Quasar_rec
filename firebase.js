// ============================================================
// Firebase 初期化
// ============================================================
// 設定値は .env（Vite の VITE_ 接頭辞）から読み込む。
// .env.example をコピーして .env を作り、自分のFirebaseプロジェクトのWeb設定を入れること。
//
// 注意: FirebaseのWeb APIキーはクライアントに露出する前提のもので、秘密情報ではない。
//       不正アクセスの防止は firestore.rules / storage.rules（厳格ルール）で担保する。

import { initializeApp } from "firebase/app";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);

// オフライン永続化を有効化（会場のネットが不安定でも復帰時に同期される）
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager(),
  }),
});

export const storage = getStorage(app);
export const auth = getAuth(app);

// 匿名認証。ログイン完了を待ってから読み書きするために Promise を返す。
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      if (user) {
        unsub();
        resolve(user);
      }
    });
    signInAnonymously(auth).catch((err) => {
      unsub();
      reject(err);
    });
  });
}
