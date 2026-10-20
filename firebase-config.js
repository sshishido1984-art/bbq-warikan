// Firebase コンソール →「プロジェクトの設定」→「マイアプリ」のウェブアプリの設定値を貼り付けます。
// この値は公開されても問題ない識別子です。データの保護は firestore.rules で行います。
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};
