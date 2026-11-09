# Firebase Security Rules 收緊版執行手冊

## 本次候選檔案

`database.rules.hardened.json` 是目標安全版，**目前未部署**。

它的核心原則是：

- 公開讀取只保留口味、菜單、店家設定、公告、營業時間與點數活動公告等非個資內容。
- `orders`、`members`、`wishlist` 只允許已登入且具有 POS custom claims 的帳號直接讀取。
- `memberPoints`、`dailyPickupCounters`、`dailyPickupCodes` 完全禁止前端直接讀寫，只由 Vercel Firebase Admin SDK 操作。
- 所有未列出的節點一律拒絕。

## 套用前必要條件

### 1. POS Google 帳號必須有 custom claims

Rules 不應依賴 POS 前端的 email 白名單。每個可以使用 POS 的 Google Firebase Auth 帳號必須具有：

```json
{
  "posStaff": true,
  "posAdmin": true
}
```

只有需要修改菜單、公告、店家設定的人才需要 `posAdmin: true`；一般接單與營運操作使用 `posStaff: true` 即可。

目前 POS 程式雖然使用 Google 登入，但尚未確認帳號已具有上述 claims，所以不能直接套用目標 Rules。

### 2. LIFF 訂單與會員讀取要改走後端 API

目前 LIFF 仍直接讀取：

- `orders`
- `memberPoints`
- `pointCampaigns`

`pointCampaigns` 可以繼續公開讀取，但 `orders` 與 `memberPoints` 不應公開讀取。正式套用前應建立：

- `/api/orders`：後端依 LINE Access Token 只回傳該會員自己的訂單
- `/api/member/points`：後端依 LINE Access Token 回傳該會員自己的點數

完成後移除 LIFF 直接 Firebase listener。

### 3. POS 讀寫路徑先測試

在 Firebase Rules Simulator 或測試資料庫，至少測試：

| 身份 | 路徑 | 動作 | 預期 |
|---|---|---|---|
| 未登入 | `todayFlavors` | read | Allow |
| 未登入 | `todayFlavors` | write | Deny |
| 未登入 | `orders` | read | Deny |
| 未登入 | `orders` | write | Deny |
| `posStaff` | `orders` | read/write | Allow |
| `posStaff` | `todayFlavors` | read/write | Allow |
| `posStaff` | `menu` | write | Deny |
| `posAdmin` | `menu` | write | Allow |
| `posStaff` | `memberPoints` | read/write | Deny |
| `posStaff` | `wishlist` | read | Allow |
| `posStaff` | `wishlist` | write | Deny |
| Vercel Admin SDK | `orders`、`memberPoints` | read/write | Allow（Admin SDK 繞過 Rules） |

## 切換順序

1. 保留目前 `database.rules.json` 作為回滾備份。
2. 設定並驗證 POS Firebase Auth custom claims。
3. 完成 LIFF 訂單與點數讀取 API。
4. 在 Rules Simulator 執行上方矩陣。
5. 先在測試 Firebase 專案套用 `database.rules.hardened.json`。
6. 測試 POS 登入、接單、拒單、修改口味、營業時間、公告、許願池查詢。
7. 測試 LIFF 訂單足跡、會員點數、點餐與取消。
8. 正式資料庫低流量時套用 Rules。
9. 觀察 Firebase denied requests 與 Vercel logs。

## 目前不能做的事

在 LIFF 讀取 API 與 POS custom claims 尚未完成前，不要直接把本檔案貼到 Firebase Production。否則：

- LIFF 訂單足跡會讀不到訂單。
- LIFF 會員點數會顯示載入失敗。
- POS 若沒有 custom claims，會無法讀取訂單與口味。

本次只建立候選 Rules，不會自動部署到 Firebase。
