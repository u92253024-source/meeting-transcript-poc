# 中文會議逐字稿 POC

這是一個與舊 Gemini Live 專案分離的新 POC。它先驗證「Windows 主機 + 單台 USB 會議麥克風 + LAN 即時字幕」的核心風險，舊專案不會被修改。

## 目前可做什麼

- 瀏覽器擷取 USB 麥克風，轉成 16 kHz / mono / PCM16，以二進位 WebSocket 傳到本機伺服器。
- 每 5 分鐘建立一個可播放的 WAV 檔；寫入時使用 `.part`，完成檔頭與同步後才改名。
- SQLite 使用 WAL，保存會議與定稿字幕段落。
- `mock` 模式不需任何雲端帳號，可測試收音、切檔、即時字幕與 LAN 觀看。
- 支援多種即時轉譯模式：
  - **Meta Muse Voice Transcribe**：單次推論結合即時 ASR、即時 20+ 講者分離與語音停頓偵測，費率約 $0.18/小時。
  - **Deepgram Nova-3**：繁體中文即時字幕＋政大專用詞庫＋即時講者標籤。
  - **Google Cloud STT V2**：以 Chirp 2 產生中文文字。
- 停止會議後先顯示錄音長度及 AssemblyAI 預估費用；只有管理者按下「開始會後講者修正」並再次確認，才合併、上傳及計費。
- 會後錄音端點使用觀看碼保護並支援 HTTP Range，可拖曳播放；點擊逐字稿會跳至時間戳，播放時同步反白。
- 輸入管理密碼後可修改段落文字，或把同一講者標籤整批改成姓名；更新會透過 WebSocket 同步給其他觀看裝置。
- 講者使用獨立的穩定 ID；辨識標籤與人工姓名分開保存。可新增講者、合併重複講者，或把單一段落重新指派給其他講者。
- 會議結束後可下載 TXT、Markdown、DOCX 與 PDF；四種格式都使用同一份校訂後逐字稿，包含會議資料、講者與時間戳。
- 易讀化採非破壞性雙軌資料：Gemini（預設 `gemini-3.5-flash-lite`）只產生逐段候選稿，管理者逐段接受或退回；原文修改後舊候選會自動過期。匯出時可選逐字版或已接受的易讀版。

## 啟動

```powershell
Copy-Item .env.example .env
npm ci
npm run dev
```

在 Windows 主機開啟 `http://localhost:5173`。同一區域網路的其他裝置可開啟 `http://<主機區網 IP>:5173`，輸入會議 ID 與觀看碼。

首次啟動必須從 Windows 主機本機的網頁設定至少 12 字元的管理密碼；區域網路裝置不能搶先完成初始設定。每場新會議會自動產生獨立的 8 碼觀看碼。

production build 可用 `npm run build` 驗證。伺服器啟動後，可另開終端執行 `npm run smoke`，它會建立一場 mock 會議、透過 WebSocket 傳送兩秒 PCM、確認收到字幕後停止會議。

### Windows 桌面程式與安裝包

```powershell
npm ci
npm run dist:win
```

會產生兩種 x64 Windows 檔案：

- `中文會議逐字稿-Setup-<version>-x64.exe`：安裝版，會建立桌面與開始功能表捷徑。
- `中文會議逐字稿-Portable-<version>-x64.exe`：免安裝版，可直接雙擊執行。

桌面程式會自動挑選本機連接埠、啟動伺服器並開啟控制視窗。在桌面設定面板中，可直接挑選辨識模式並填入 Muse Voice、Deepgram、AssemblyAI 或 Gemini 的 API 金鑰；金鑰由 Windows 本機安全加密（DPAPI safeStorage）保存，不會以明文儲存。

也可以把既有錄音轉為相同的 PCM 格式並重播到管線：

```powershell
npm run replay -- "C:\path\meeting.aac" --speed=1
```

`--seconds=60` 可只測前 60 秒。mock 模式可用 `--speed=0` 不限速跑完；任何雲端串流模式都強制使用 `--speed=1`，避免破壞即時 API 的時間假設。

對已保存的完整 WAV 執行 AssemblyAI 會後講者分離：

```powershell
npm run diarize -- ".\data\meetings\<meeting-id>\audio\chunk-00001.wav"
```

### 轉譯模式選項

系統支援以下 7 種轉譯模式，可於桌面版設定介面或 `.env` 之 `TRANSCRIPTION_MODE` 設定：

1. `muse-voice`（**Meta Muse Voice Transcribe**）：
   - 使用 Meta `muse-voice-transcribe-1.0` 串流 WebSocket (`wss://api.meta.ai/v1/asr/realtime`)。
   - 單次推論直接產生繁體中文即時字幕與 20+ 講者分離，不需額外後處理。
   - 費率約 $0.18 / 小時 ($3.00 / 1,000 分鐘)。
2. `muse-voice-assembly`：
   - 即時採用 Muse Voice 產生即時字幕與暫定講者標籤。
   - 會後可選擇性由管理者審核並啟動 AssemblyAI U3.5 Pro 進行高精度講者分離修正。
3. `deepgram-assembly`（預設候選）：
   - Deepgram Nova-3 產生即時中文字幕與暫定講者時間軸。
   - 會後由 AssemblyAI batch diarization (`universal-3-5-pro`) 修正講者時間軸。
4. `deepgram`：
   - 僅使用 Deepgram Nova-3，包含繁中即時辨識、即時講者標籤與政大專屬詞庫。
5. `cloud`：
   - Google Cloud STT V2（Chirp 2）產生中文文字 ＋ AssemblyAI Streaming V3 產生暫定講者標籤。
6. `cloud-stt-only`：
   - 僅使用 Google Cloud STT V2，講者顯示為「講者待確認」。
7. `mock`：
   - 完全不使用外部雲端服務，供本機測試麥克風收音、音訊切檔與字幕排版。

### Deepgram A/B test

保留 `TRANSCRIPTION_MODE=cloud` 可用於 Google + AssemblyAI 對比。對同一個 WAV 執行 Deepgram 離線辨識並與 Google 逐字稿時間戳對齊：

```powershell
npm run deepgram:batch -- ".\data\meetings\<meeting-id>\audio\chunk-00001.wav"
npm run compare:deepgram -- <meeting-id> ".\reports\deepgram-<file>-<timestamp>.json"
```

## 啟用雲端辨識設定

在 `.env` 或桌面版設定面板中設定：

1. **Meta Muse Voice**：
   - 設定 `MUSE_VOICE_API_KEY`，模式切換為 `muse-voice` 或 `muse-voice-assembly`。
2. **Deepgram**：
   - 設定 `DEEPGRAM_API_KEY`，模式切換為 `deepgram` 或 `deepgram-assembly`。
3. **Google Cloud STT**：
   - 設定 `GOOGLE_CLOUD_PROJECT`，模式切換為 `cloud` 或 `cloud-stt-only`。
4. **AssemblyAI**：
   - 設定 `ASSEMBLYAI_API_KEY`（供 `cloud` 即時講者或各模式之會後講者修正使用）。
5. **Gemini**：
   - 設定 `GEMINI_API_KEY`（供會後產生非破壞性易讀候選稿使用，全模式共用）。

## 安全界線

管理密碼會以雜湊保存在本機 SQLite；觀看碼則為每場會議獨立產生。同一來源連續 5 次輸入錯誤管理密碼後會暫停嘗試 60 秒。系統尚未提供 TLS 或企業身分驗證，仍只應在受信任的區域網路測試，不可直接暴露到網際網路。
