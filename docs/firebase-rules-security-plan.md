# Firebase Realtime Database 安全規則規劃

> 本文件是規劃與候選方案，**不代表已部署**。目前線上 Rules 維持原狀，避免直接收緊造成 POS／LIFF 中斷。

## 稽核現況

目前正式 Rules 對 `todayFlavors`、`menu`、`siteConfig`、`globalOverlay`、`announcements`、`orders`、`dailyPickupCounters`、`members`、`wishlist` 多數設定為公開讀寫；未列出的節點由 `$other` 拒絕。現況備份見 [`../database.rules.json`](../database.rules.json)。

目前程式仍有以下直接 Firebase 操作：

- LIFF：直接建立 `orders`、寫入 `members`、寫入 `wishlist`、讀取 `orders`／`todayFlavors`／`siteConfig`／`globalOverlay`／`businessHours`。
- POS：以 Firebase Google Auth 登入，但目前 Rules 沒有使用 POS 管理者 custom claims；POS 直接管理 `orders`、`todayFlavors`、`businessHours`、`announcements`、`wishlist` 等節點。
- Vercel：處理 LINE Pay、取消、會員驗證、會員點數與撤銷；應改用 Firebase Admin SDK／服務帳號，讓後端寫入不依賴公開 `.write`。

## 目標權限模型

### 公開讀取

只保留不含個資的營運內容公開讀取：`todayFlavors`、`menu`、`siteConfig`、`globalOverlay`、`announcements`、`businessHours`。

### POS 管理者

POS Google 帳號必須擁有 Firebase Auth custom claims：

- `posStaff: true`：可讀取與處理營運訂單、口味、營業時間。
- `posAdmin: true`：可管理 POS 設定、公告與會員／許願池後台資料。

Rules 不應只依賴前端 JavaScript 的 email 白名單，因為前端程式可被修改。

### Vercel 後端

Vercel 使用 Firebase Admin SDK 服務帳號，所有後端寫入以 Admin SDK 執行。Admin SDK 會繞過 Realtime Database Rules，因此服務帳號 JSON 必須只放在 Vercel Secret，不能放前端或 GitHub。

後端負責：

- 建立與更新顧客訂單
- LINE Token 驗證
- 會員點數發送與撤銷
- 會員資料讀寫
- 取餐號碼交易
- 顧客取消與 LINE Pay 狀態更新

### 顧客

LIFF 顧客不直接寫入 Firebase：

- 訂單改呼叫 `/api/orders/create`
- 訂單查詢改呼叫 `/api/orders`
- 會員資料改由後端依 LINE Token 處理
- 許願池改呼叫 `/api/wishlist`
- 點數只透過 `/api/member-points` 讀取
- 點數寫入只允許 Vercel 後端

## 分階段切換，避免 POS 中斷

1. **先建立 Firebase Auth custom claims**，並用測試 POS 帳號驗證 `posStaff`／`posAdmin`。
2. **先部署 Vercel Admin SDK 與 API**，保持現有 Firebase Rules 不變。
3. **將 LIFF 的訂單、會員、許願池寫入改走 API**，確認正式下單、取消、LINE Pay、點數流程。
4. **將 POS 讀寫路徑逐一改成 custom claim 能通過的 Rules**，先測試口味、營業時間、接單、拒單、結帳與許願池管理。
5. **套用候選 Rules 到 Firebase Rules Simulator／測試資料庫**，至少測試顧客、POS staff、POS admin、未登入四種身份。
6. **正式部署 Rules 前建立 Firebase 備份與回滾版本**，低流量時切換。
7. **切換後監控 Firebase denied request、Vercel API 錯誤與 POS 操作**；若異常立即回復上一版 Rules。

## 不可直接做的事情

- 不可直接把所有 `.write` 改成 `auth != null`，因為 LIFF 顧客不是 Firebase Auth 使用者。
- 不可直接封鎖 `orders` 寫入，除非 LIFF 建單 API 已先上線。
- 不可直接封鎖 `todayFlavors` 寫入，除非 POS custom claims 已完成。
- 不可把 Firebase service account 放入 `public/`、瀏覽器程式或 GitHub。
- 不可把現況備份直接當成安全版部署。

## 候選 Rules

候選檔案 [`../database.rules.proposed.json`](../database.rules.proposed.json) 只供審核與測試，未部署。它假設 POS 已完成 custom claims、LIFF 已全部改走後端 API、Vercel 已改用 Admin SDK。
