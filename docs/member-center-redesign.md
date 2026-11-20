# OMG! Gelato LIFF 會員中心重設計規格

## 目標

將目前分散在首頁會員分頁、`/member-center` 與 `/member-v2` 的會員功能統一成一套「會員錢包」體驗。會員只需要理解四件事：目前有多少點、如何累點、有哪些可用兌換券、到店時要出示哪一個 QR。所有既有 LINE 登入、點數 transaction、兌換券 idempotency、POS 會員綁單、POS 兌換券核銷與訂單資料流都保留，不以 UI 改版重寫交易邏輯。

## 建議的唯一入口與頁面角色

- `/` 的「OMG會員」分頁：日常快速入口，顯示點數餘額、門市會員 QR、最近點數、可用兌換券摘要。
- `/member-center`：完整會員錢包，供需要查看詳細紀錄、兌換券與使用說明的會員使用。
- `/member-v2`：相容舊連結，改為導向同一個完整會員錢包，不再維護第二套資料載入與兌換流程。
- `/menu/`：只負責點餐，不在點餐流程中複製會員錢包。
- `/status.html`：只負責營業狀態，不顯示會員交易操作。

## 完整會員中心資訊架構

### 1. 帳戶抬頭

顯示 LINE 頭像、顯示名稱、會員編號、重新整理按鈕與回到今日首頁。載入中只顯示「正在同步會員資料」，不可先顯示舊點數或假設會員已登入。

### 2. 點數總覽卡

- 大字顯示目前點數。
- 顯示「即時同步」狀態與最後同步時間。
- 顯示本次距離最低兌換門檻還差幾點。
- 清楚標示「線上消費與門市 POS 消費皆依指定品項規則累點」，避免讓會員誤以為所有商品都會累點。
- 點數不足時使用中性說明，不使用紅色錯誤語氣。

### 3. 門市快速操作

- 「出示會員 QR」：呼叫 `/api/member/qr`，產生 90 秒短效、單次綁定的會員 QR。
- QR 視窗明確寫出「請在結帳前出示」「POS 掃描後會綁定本次訂單」「失效後可重新產生」。
- 不在前端顯示原始 claim token；只把 token 轉成 QR 圖片。
- QR 逾時後保留重新產生按鈕，不自動大量刷新。

### 4. 兌換券錢包

每張券顯示：券名、兌換所扣點數、狀態、取得時間、永久有效說明與「顯示核銷 QR」。

- `issued`：可使用，按鈕可開啟 5 分鐘短效核銷 QR。
- `redeemed`：只讀顯示核銷時間，不再顯示可操作按鈕。
- 核銷 QR 視窗明確提示「請店員在 POS 掃描」「核銷前請確認券名」「QR 5 分鐘有效，兌換券本身永久有效」。
- 核銷完成由 POS 端回寫，會員端刷新後顯示已核銷；會員端不直接寫入 voucher 狀態。

### 5. 點數兌換

以兩張清楚的獎勵卡呈現目前可兌換與差額：

- 點數不足：顯示「還差 N 點」，按鈕 disabled。
- 點數足夠：開啟確認視窗，顯示扣點前餘額、扣點數與兌換後餘額。
- 送出使用 `crypto.randomUUID()` 作為 idempotency key。
- 成功後直接把 API 回傳的 points account 更新到畫面，避免等待下一次重新整理。
- 失敗時不清空既有畫面資料，只顯示可重試訊息。

### 6. 點數流水

預設顯示最近 5 筆，提供「查看全部」。每筆顯示來源、日期、訂單編號（若有）與正負點數。點數扣除、訂單回收、管理員調整等類型使用不同文字，但不把內部 type 直接暴露給會員。

### 7. 訂單摘要

顯示最近 3 筆線上訂單，提供「查看全部」回到既有訂單頁。會員中心不新增第二套付款、取消或退款邏輯；付款與退款仍由首頁既有流程處理。

### 8. 使用規則與客服入口

用可收合的短段落說明：指定品項、線上／門市累點差異、QR 有效期、兌換券有效期、退款後點數回收、店家保留活動調整權利。底部保留 LINE 官方帳號入口與口味許願功能，但不讓非核心內容搶過點數與兌換券。

## 資料與 API 邊界

### 會員端可呼叫的 API

- `/api/member/profile`：取得 LINE profile 與會員編號。
- `/api/member/points`：取得目前會員的點數帳戶。
- `/api/orders`：取得目前會員的線上訂單。
- `/api/member/qr`：產生門市會員短效 QR。
- `/api/member/rewards/redeem`：以 idempotency key 建立兌換券。
- `/api/member/rewards/qr`：產生單張兌換券的短效核銷 QR。

### 僅 POS／伺服器可做的事

- `/api/pos/member/preview`、`/api/pos/member/earn`：會員 QR 預覽與訂單入點。
- `/api/pos/member/rewards/preview`、`/api/pos/member/rewards/redeem`：兌換券預覽與核銷。
- 會員點數帳戶、流水、兌換券狀態的 Firebase Admin transaction 寫入。
- 管理員測試點數、撤銷點數與訂單退款回收。

會員瀏覽器永遠不直接取得 Firebase Admin credential，也不直接寫入 `memberPoints`、`memberQrClaims` 或 `rewardQrClaims`。

## Firebase Rules 建議分層

正式 Rules 採 fail-closed：根節點 `.read` 與 `.write` 均為 `false`，會員資料與點數資料不開放瀏覽器直接讀寫。需要會員資料的功能一律走 Next.js Route Handler，由 LINE access token 驗證後以 Firebase Admin SDK 讀取；POS 端則以 Firebase ID token 和 `posStaff`／`posAdmin` custom claims 驗證。

- `todayFlavors`：公開讀取；POS staff／admin 可寫。
- `announcements`、`businessHours`：公開讀取；POS staff／admin 可寫。
- `menu`、`siteConfig`、`globalOverlay`、`pointCampaigns`：公開讀取；僅 POS admin 可寫。
- `orders`：僅 POS staff／admin 讀寫；會員訂單查詢走受保護 API。
- `members`、`memberPoints`、`memberQrClaims`、`rewardQrClaims`：Rules 直接禁止讀寫，由 Admin SDK 透過 API 存取。
- `dailyPickupCounters`、`dailyPickupCodes`：Rules 直接禁止讀寫，由受保護伺服器流程處理。
- `wishlist`：若仍由會員端送出，應改成受保護 API；Rules 不直接開放匿名寫入。

這套分層不依會員編號判斷管理員權限。管理員只能由 Firebase Authentication custom claims 與 Google 帳號權限判斷。

## 狀態與錯誤文案

- 初始：`正在同步會員資料…`
- 尚未登入：`使用 LINE 登入後即可查看點數與兌換券`
- 同步失敗：`會員資料暫時無法同步，請重新整理；既有資料未被修改。`
- QR 產生中：`正在準備短效會員 QR…`
- QR 失效：`這組 QR 已失效，請重新產生。`
- 兌換成功：`兌換完成，兌換券已加入你的錢包。`
- 核銷券已使用：`這張兌換券已核銷，不能再次使用。`

## 分批實作與驗收

### 第一批：視覺與入口統一

建立唯一 `MemberWallet` 元件，讓 `/member-center` 與 `/member-v2` 共用；保留現有 API 與事件行為，只調整版型、文案、狀態標籤、QR／兌換券操作位置。首頁會員分頁只保留摘要與入口，不再維護重複的完整流水清單。

### 第二批：安全邊界與狀態測試

確認會員端無法直接讀寫點數節點；驗證短效 QR 過期、重複掃描、兌換券重複核銷、網路重試與退款點數回收。Rules 只產生本地候選檔，需使用者另行確認後才發布 Firebase。

### 第三批：正式驗收

執行 `git diff --check`、`npm run lint`、`npm run build`，以手機窄螢幕檢查底部導覽、safe-area、Dialog focus、QR 失效提示與深色／減少動態偏好；最後才由使用者決定是否推送 GitHub 與部署 Vercel。
