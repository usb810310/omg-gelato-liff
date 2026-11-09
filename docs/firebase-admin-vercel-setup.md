# Firebase Admin SDK／Vercel 設定

## 程式狀態

後端 Firebase 存取已改用 Firebase Admin SDK：

- `lib/firebase-admin.ts`：初始化 Admin SDK 與 Realtime Database
- `lib/firebase-server.ts`：訂單、會員、許願與取餐號碼
- `lib/member-points.ts`：會員點數、發點、撤銷與舊點卡移轉
- `lib/linepay.ts`：LINE Pay 訂單查詢、更新與顧客取消

Admin SDK 寫入會繞過 Realtime Database Security Rules，因此之後可以安全地關閉前端公開 `.write`。

## 必須設定的 Vercel Production Secret

建議使用單一加密環境變數：

```text
FIREBASE_SERVICE_ACCOUNT_JSON
```

值為 Firebase Console 下載的服務帳號 JSON 原文。請在 Vercel Environment Variables 設定：

- Type：Sensitive／Secret
- Target：Production（若要測試再額外加入 Preview）
- 不要加入 `NEXT_PUBLIC_`
- 不要提交到 GitHub
- 不要放入 `public/`
- 不要放入 POS 或瀏覽器 JavaScript

程式也支援拆分設定，但不建議優先使用：

```text
FIREBASE_PROJECT_ID
FIREBASE_CLIENT_EMAIL
FIREBASE_PRIVATE_KEY
```

如果使用拆分設定，`FIREBASE_PRIVATE_KEY` 的換行必須以 `\\n` 保存。

## 服務帳號權限

服務帳號只需要對 Firebase Realtime Database 具有必要的伺服器端存取權。不要把服務帳號金鑰分享給其他人，也不要將 JSON 放到聊天訊息或公開儲存庫。

## 設定完成後的驗證

1. 在 Vercel Production 加入 `FIREBASE_SERVICE_ACCOUNT_JSON`。
2. 重新部署 Production。
3. 測試會員資料 API、建立訂單 API、許願 API、POS 發點與訂單取消。
4. 確認 Vercel logs 沒有 Admin SDK 初始化錯誤。
5. 再部署收緊版 Firebase Rules。

在服務帳號設定完成前，**不要部署本次程式到 Production**，避免正式 API 因缺少憑證而中斷。
