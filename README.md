# 中文會議逐字稿 POC

這是一個與舊 Gemini Live 專案分離的新 POC。它先驗證「Windows 主機 + 單台 USB 會議麥克風 + LAN 即時字幕」的核心風險，舊專案不會被修改。

## 目前可做什麼

- 瀏覽器擷取 USB 麥克風，轉成 16 kHz / mono / PCM16，以二進位 WebSocket 傳到本機伺服器。
- 每 5 分鐘建立一個可播放的 WAV 檔；寫入時使用 `.part`，完成檔頭與同步後才改名。
- SQLite 使用 WAL，保存會議與定稿字幕段落。
- `mock` 模式不需任何雲端帳號，可測試收音、切檔、即時字幕與 LAN 觀看。
- 停止會議後先顯示錄音長度及 AssemblyAI 預估費用；只有管理者按下「開始會後講者修正」並再次確認，才合併、上傳及計費。
- 會後錄音端點使用觀看碼保護並支援 HTTP Range，可拖曳播放；點擊逐字稿會跳至時間戳，播放時同步反白。
- 輸入管理密碼後可修改段落文字，或把同一講者標籤整批改成姓名；更新會透過 WebSocket 同步給其他觀看裝置。
- 講者使用獨立的穩定 ID；辨識標籤與人工姓名分開保存。可新增講者、合併重複講者，或把單一段落重新指派給其他講者。
- 會議結束後可下載 TXT、Markdown、DOCX 與 PDF；四種格式都使用同一份校訂後逐字稿，包含會議資料、講者與時間戳。
- 易讀化採非破壞性雙軌資料：Gemini只產生逐段候選稿，管理者逐段接受或退回；原文修改後舊候選會自動過期。匯出時可選逐字版或已接受的易讀版。
- `cloud` 模式以 Google Cloud STT V2 產生中文文字，AssemblyAI Streaming V3 產生暫定講者標籤。
- Cloud STT 串流每 4 分 45 秒主動輪替，以避開長時間單一串流限制；正式版仍需加入音訊重疊橋接，避免輪替邊界漏字。
- 觀看者輸入會議存取碼；建立及停止會議需管理密碼。主持端 WebSocket 使用隨機權杖，不把管理密碼放在位址列。

## 啟動

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

在 Windows 主機開啟 `http://localhost:5173`。同一區域網路的其他裝置可開啟 `http://<主機區網 IP>:5173`，輸入會議 ID 與觀看碼。

首次啟動會在網頁中設定至少 12 字元的管理密碼；每場新會議會自動產生獨立的 8 碼觀看碼。

production build 可用 `npm run build` 驗證。伺服器啟動後，可另開終端執行 `npm run smoke`，它會建立一場 mock 會議、透過 WebSocket 傳送兩秒 PCM、確認收到字幕後停止會議。

### Windows 桌面程式與安裝包

```powershell
npm install
npm run dist:win
```

會產生兩種 x64 Windows 檔案：

- `中文會議逐字稿-Setup-<version>-x64.exe`：安裝版，會建立桌面與開始功能表捷徑。
- `中文會議逐字稿-Portable-<version>-x64.exe`：免安裝版，可直接雙擊執行。

桌面程式會自動挑選本機連接埠、啟動伺服器並開啟控制視窗。第一次啟動時，會在 Windows 使用者資料夾建立 `.env` 設定檔並顯示其實際位置；請在該檔案填入 Deepgram、AssemblyAI、Gemini 或 Google Cloud 的設定後重新啟動。會議資料和錄音也保存在同一個使用者資料夾，因此更新或重新安裝不會覆蓋既有資料。

也可以把既有錄音轉為相同的 PCM 格式並重播到管線：

```powershell
npm run replay -- "C:\path\meeting.aac" --speed=1
```

`--seconds=60` 可只測前 60 秒。mock 模式可用 `--speed=0` 不限速跑完；任何雲端串流模式都強制使用 `--speed=1`，避免破壞即時 API 的時間假設。

對已保存的完整 WAV 執行 AssemblyAI 會後講者分離：

```powershell
npm run diarize -- ".\data\meetings\<meeting-id>\audio\chunk-00001.wav"
```

工具只在終端輸出模型、講者數、各講者時長與發言段數，不輸出逐字稿內容或 API key。

將 Google 即時段落依時間與 AssemblyAI 會後單字對齊：

```powershell
npm run compare -- <meeting-id> <assembly-transcript-id>
```

### Deepgram A/B test

Keep `TRANSCRIPTION_MODE=cloud` for the existing Google + AssemblyAI path. Run a
Deepgram batch transcription against the same saved WAV, then align it with the
Google transcript by timestamp:

```powershell
npm run deepgram:batch -- ".\data\meetings\<meeting-id>\audio\chunk-00001.wav"
npm run compare:deepgram -- <meeting-id> ".\reports\deepgram-<file>-<timestamp>.json"
```

For an isolated live Deepgram test, set `TRANSCRIPTION_MODE=deepgram`, restart
the server, and use the existing `npm run replay` command. This mode uses Nova-3
with `zh-TW`, live diarization, word timestamps, and the configured keyterms.

The selected production candidate is `TRANSCRIPTION_MODE=deepgram-assembly`:

- Deepgram Nova-3 produces live and final Traditional Chinese text.
- Deepgram produces the live text and provisional live speaker timeline.
- AssemblyAI batch diarization produces the corrected post-meeting speaker
  timeline. It is never submitted automatically: stopping the meeting only
  stores the recording and calculates an estimate. An authenticated admin must
  explicitly approve the upload from the meeting page.
- The batch model is pinned by `ASSEMBLYAI_BATCH_MODEL=universal-3-5-pro` because
  it was the model that matched the human-verified six-speaker result.
- AssemblyAI's Universal Streaming multilingual model does not support Chinese.
`whisper-rt` transcribes Chinese, but the tested stream returned no speaker
  fields despite `speaker_labels=true`, so it is not used for the live timeline.
- `TRANSCRIPTION_MODE=cloud` remains the Google + AssemblyAI rollback path.

易讀候選稿預設使用穩定的 `gemini-3.5-flash-lite` 與結構化 JSON 回應。新專案
不會從舊程式複製金鑰；請由管理者自行在 `.env` 設定 `GEMINI_API_KEY`。
按下「產生易讀候選稿」並再次確認前，不會傳送逐字稿。模型只產生草稿，
不會直接覆蓋人工校訂文字。

估價預設由 `ASSEMBLYAI_BATCH_BASE_USD_PER_HOUR=0.21` 加上
`ASSEMBLYAI_DIARIZATION_USD_PER_HOUR=0.02` 計算。費率是設定值而非由
AssemblyAI 即時查價；官方價格若調整，需同步修改 `.env`。重複點擊會由資料庫
狀態閘門阻擋，失敗的工作則可由管理者明確重試。

## 啟用雲端辨識

1. Google Cloud 專案啟用 Speech-to-Text API，建立 Application Default Credentials。
2. 設定 `.env` 的 `GOOGLE_CLOUD_PROJECT`；本 POC 使用 `asia-southeast1`、`cmn-Hant-TW` 與目前可一般呼叫的 `chirp_2`。
3. 建立 AssemblyAI API key，設定 `ASSEMBLYAI_API_KEY`。
4. 將 `TRANSCRIPTION_MODE` 改為 `cloud`。

只有 Google Cloud 時可用 `cloud-stt-only`；字幕仍會產生，但講者顯示為「講者待確認」。

## POC 架構

```text
USB 麥克風
  -> Web Audio / PCM16
  -> binary WebSocket
  -> WAV 5 分鐘切檔 + SQLite/WAL
  -> Deepgram Nova-3 ------------> 中文段落 + 暫定講者 -> LAN 即時字幕
  -> 停止會議 --------------------> 本機錄音長度 + 預估費用
  -> 管理者確認 ------------------> 合併 WAV -> AssemblyAI U3.5 Pro
                                          -> 修正講者時間軸
```

## 刻意延後的功能

每場新會議會產生獨立的 8 碼觀看碼。首次啟動必須設定至少 12 字元的管理密碼；系統只把密碼雜湊保存在本機 SQLite。錄音在會議結束後保留 30 天（可由 `RECORDING_RETENTION_DAYS` 調整）並自動刪除，逐字稿、講者、易讀候選稿與匯出功能會繼續保留。管理者可提早刪除錄音，或刪除整場會議及其所有資料。

這一版尚未包含詞庫。會後修正目前以「每個 Deepgram 字幕段落依時間重疊選出主要 AssemblyAI 講者」處理；若一個長字幕段落內有極短插話，仍可能無法拆成兩位講者。校訂器可把整段重新指派，但要在一句內精確切開極短插話，仍需保存 Deepgram 單字時間戳。人工姓名與機器標籤已分離；建議操作順序仍是先完成批次修正，再命名與合併講者。

## 安全界線

管理密碼會以雜湊保存在本機 SQLite；觀看碼則為每場會議獨立產生。系統尚未提供登入嘗試鎖定、TLS 或企業身分驗證，仍只應在受信任的區域網路測試，不可直接暴露到網際網路。
