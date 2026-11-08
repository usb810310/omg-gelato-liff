# Firebase Realtime Database Rules 備份

- Firebase project: `omg-menu-5761a`
- Database: `omg-menu-5761a-default-rtdb`
- Region: `asia-southeast1`
- Rules source: Firebase Console Realtime Database → Rules
- Exported: 2026-11-09 (Asia/Taipei)

原始規則保存於 [`database.rules.json`](../database.rules.json)。`firebase.json` 與 `.firebaserc` 僅用於日後辨識專案與規則檔案，不會自動修改線上 Firebase Rules。

## 重要安全註記

本次備份完全按照 Firebase 線上現況保存，沒有修改規則。匯出時現況包含多個公開讀寫節點，例如 `orders`、`members`、`todayFlavors`、`menu`、`wishlist` 與其他設定節點。這代表此檔案是「現況備份」，不是安全強化後的建議規則；若要收緊權限，應另行規劃、測試並取得確認後再部署，避免影響 POS、LIFF 與既有資料流程。

## 還原指令

需要還原時，先確認檔案內容與資料庫備份，再使用：

```bash
firebase deploy --only database --project omg-menu-5761a
```

執行部署前務必再次檢查 Rules，因為這會直接影響正式 Firebase 資料庫權限。
