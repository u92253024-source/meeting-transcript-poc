# 桌面版 API 設定

安裝版與可攜版都在首頁提供「桌面版雲端服務設定」。不需要手動建立或修改 `.env`。

1. 先設定管理密碼（首次執行才需要）。
2. 選擇「Deepgram 即時字幕＋AssemblyAI 會後講者修正」。
3. 貼上 Deepgram、AssemblyAI 與 Gemini API Key；Google 模式才需要填 Google Cloud 專案 ID。
4. 輸入管理密碼，按「儲存並重新啟動服務」。

API Key 只在儲存當下傳給本機 Electron 程式，並以 Windows 的使用者帳戶加密機制保存。已儲存的 Key 不會顯示或傳回瀏覽器。欄位留空表示保留既有值；若要移除 Key，使用下方的清除選項。

開發者以 `npm run dev` 使用瀏覽器版時，仍可使用 `.env`；此設定頁只會在 Windows 桌面版中出現。
