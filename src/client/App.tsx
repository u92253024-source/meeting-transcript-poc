import { useEffect, useMemo, useRef, useState } from "react";
import type { InterimTranscript, Meeting, MeetingSpeaker, ProviderStatus, ReadableVariant, ServerEvent, TranscriptSegment } from "../shared/types";
import type { DesktopSettingsInput, DesktopSettingsSummary, DesktopTranscriptionMode } from "../shared/desktop-settings";

declare global {
  interface Window {
    desktopSettings?: {
      get: () => Promise<DesktopSettingsSummary>;
      save: (input: DesktopSettingsInput) => Promise<DesktopSettingsSummary>;
    };
  }
}

interface CreateResponse {
  meeting: Meeting;
  accessCode: string;
  hostToken: string;
}

function formatTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":")
    : [minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function postprocessStatusLabel(status: Meeting["postprocess"]["status"]): string {
  if (status === "queued") return "等待處理";
  if (status === "processing") return "AssemblyAI 處理中";
  if (status === "completed") return "講者修正完成";
  if (status === "failed") return "處理失敗，可重新送出";
  return "尚未上傳";
}

function readableStatusLabel(status: Meeting["readable"]["status"]): string {
  if (status === "processing") return "Gemini產生中";
  if (status === "completed") return "候選稿已產生";
  if (status === "failed") return "產生失敗，可重新執行";
  return "尚未產生";
}

export function App() {
  const [title, setTitle] = useState("中文會議測試");
  const [adminPassword, setAdminPassword] = useState("");
  const [initialAdminPassword, setInitialAdminPassword] = useState("");
  const [initialAdminPasswordConfirmation, setInitialAdminPasswordConfirmation] = useState("");
  const [meetingIdInput, setMeetingIdInput] = useState("");
  const [accessCodeInput, setAccessCodeInput] = useState("");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [speakers, setSpeakers] = useState<MeetingSpeaker[]>([]);
  const [readableVariants, setReadableVariants] = useState<ReadableVariant[]>([]);
  const [interim, setInterim] = useState<InterimTranscript | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [providers, setProviders] = useState<ProviderStatus | null>(null);
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettingsSummary | null>(null);
  const [desktopMode, setDesktopMode] = useState<DesktopTranscriptionMode>("mock");
  const [desktopGoogleProject, setDesktopGoogleProject] = useState("");
  const [deepgramApiKey, setDeepgramApiKey] = useState("");
  const [assemblyAiApiKey, setAssemblyAiApiKey] = useState("");
  const [geminiApiKey, setGeminiApiKey] = useState("");
  const [clearDeepgramApiKey, setClearDeepgramApiKey] = useState(false);
  const [clearAssemblyAiApiKey, setClearAssemblyAiApiKey] = useState(false);
  const [clearGeminiApiKey, setClearGeminiApiKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const [playbackMs, setPlaybackMs] = useState(0);
  const [editingSegmentId, setEditingSegmentId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [speakerDrafts, setSpeakerDrafts] = useState<Record<string, string>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [newSpeakerName, setNewSpeakerName] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    void fetch("/api/health")
      .then((response) => response.json())
      .then((data: { providers: ProviderStatus }) => setProviders(data.providers))
      .catch(() => setWarnings((current) => [...current, "無法連線到本機伺服器"]));
    if (window.desktopSettings) {
      void window.desktopSettings.get()
        .then((settings) => {
          setDesktopSettings(settings);
          setDesktopMode(settings.transcriptionMode);
          setDesktopGoogleProject(settings.googleCloudProject);
        })
        .catch((error) => setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]));
    }
    return () => cleanupAudio();
  }, []);

  const shareUrl = useMemo(() => {
    if (!meeting) return "";
    return `${providers?.lanUrl ?? window.location.origin}/?meeting=${meeting.id}`;
  }, [meeting, providers?.lanUrl]);

  const audioUrl = useMemo(() => {
    if (!meeting || meeting.status !== "stopped" || meeting.recording.audioDeletedAt || !accessCode) return "";
    return `/api/meetings/${encodeURIComponent(meeting.id)}/audio?code=${encodeURIComponent(accessCode)}`;
  }, [meeting, accessCode]);

  function exportUrl(format: "txt" | "md" | "docx" | "pdf", version: "verbatim" | "readable"): string {
    if (!meeting) return "#";
    return `/api/meetings/${encodeURIComponent(meeting.id)}/export/${format}?code=${encodeURIComponent(accessCode)}&version=${version}`;
  }

  const activeSegmentId = useMemo(() => (
    segments.find((segment) => playbackMs >= segment.startMs && playbackMs < segment.endMs)?.id ?? null
  ), [segments, playbackMs]);

  useEffect(() => {
    setSpeakerDrafts((current) => Object.fromEntries(speakers.map((speaker) => [speaker.id, current[speaker.id] ?? speaker.displayName])));
    setMergeTargets((current) => Object.fromEntries(speakers.map((speaker) => [speaker.id, current[speaker.id] ?? ""])));
  }, [speakers]);

  async function saveDesktopSettings(): Promise<void> {
    if (!window.desktopSettings || !desktopSettings) return;
    setBusy(true);
    setWarnings([]);
    try {
      const saved = await window.desktopSettings.save({
        adminPassword,
        transcriptionMode: desktopMode,
        googleCloudProject: desktopGoogleProject,
        deepgramApiKey,
        assemblyAiApiKey,
        geminiApiKey,
        clearDeepgramApiKey,
        clearAssemblyAiApiKey,
        clearGeminiApiKey,
      });
      setDesktopSettings(saved);
      setDeepgramApiKey("");
      setAssemblyAiApiKey("");
      setGeminiApiKey("");
      setClearDeepgramApiKey(false);
      setClearAssemblyAiApiKey(false);
      setClearGeminiApiKey(false);
    } catch (error) {
      setWarnings([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function createMeeting(): Promise<void> {
    setBusy(true);
    setWarnings([]);
    try {
      const response = await fetch("/api/meetings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ title }),
      });
      const payload = await response.json() as CreateResponse & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "無法建立會議");
      setMeeting(payload.meeting);
      setSpeakers([]);
      setReadableVariants([]);
      setAccessCode(payload.accessCode);
      setIsHost(true);
      await connectSocket(payload.meeting.id, "host", payload.hostToken);
      await startAudioCapture();
    } catch (error) {
      cleanupAudio();
      setWarnings([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function configureInitialAdminPassword(): Promise<void> {
    if (initialAdminPassword.length < 12) {
      setWarnings(["管理密碼至少需要 12 個字元"]);
      return;
    }
    if (initialAdminPassword !== initialAdminPasswordConfirmation) {
      setWarnings(["兩次輸入的管理密碼不一致"]);
      return;
    }
    setBusy(true);
    setWarnings([]);
    try {
      const response = await fetch("/api/setup/admin-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: initialAdminPassword }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "無法設定管理密碼");
      setAdminPassword(initialAdminPassword);
      setInitialAdminPassword("");
      setInitialAdminPasswordConfirmation("");
      setProviders((current) => current ? { ...current, adminPasswordConfigured: true } : current);
    } catch (error) {
      setWarnings([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function joinMeeting(): Promise<void> {
    setBusy(true);
    setWarnings([]);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(meetingIdInput)}?code=${encodeURIComponent(accessCodeInput)}`);
      const payload = await response.json() as { meeting?: Meeting; segments?: TranscriptSegment[]; speakers?: MeetingSpeaker[]; readableVariants?: ReadableVariant[]; error?: string };
      if (!response.ok || !payload.meeting) throw new Error(payload.error ?? "無法加入會議");
      setMeeting(payload.meeting);
      setSegments(payload.segments ?? []);
      setSpeakers(payload.speakers ?? []);
      setReadableVariants(payload.readableVariants ?? []);
      setAccessCode(accessCodeInput);
      setIsHost(false);
      await connectSocket(payload.meeting.id, "viewer", accessCodeInput);
    } catch (error) {
      setWarnings([error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function connectSocket(id: string, role: "host" | "viewer", credential: string): Promise<void> {
    socketRef.current?.close();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${window.location.host}/ws/meetings/${encodeURIComponent(id)}?role=${role}&credential=${encodeURIComponent(credential)}`;
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => handleServerEvent(JSON.parse(event.data as string) as ServerEvent);
    socket.onclose = () => setWarnings((current) => [...current, "即時連線已中斷"]);
    socketRef.current = socket;
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("無法建立即時連線")), { once: true });
    });
  }

  function handleServerEvent(event: ServerEvent): void {
    if (event.type === "ready") {
      setMeeting(event.meeting);
      setSegments(event.segments);
      setSpeakers(event.speakers);
      setReadableVariants(event.readableVariants);
    } else if (event.type === "interim") {
      setInterim(event.transcript);
    } else if (event.type === "segment") {
      setInterim(null);
      setSegments((current) => [...current, event.segment]);
    } else if (event.type === "segment_updated") {
      setSegments((current) => current.map((segment) => segment.id === event.segment.id ? event.segment : segment));
    } else if (event.type === "status") {
      setMeeting((current) => current ? { ...current, status: event.status } : current);
    } else if (event.type === "meeting_updated") {
      setMeeting(event.meeting);
    } else if (event.type === "speakers_updated") {
      setSpeakers(event.speakers);
    } else if (event.type === "readable_variants_updated") {
      setReadableVariants(event.variants);
    } else if (event.type === "warning") {
      setWarnings((current) => [...current.slice(-4), event.message]);
    }
  }

  async function startAudioCapture(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: 16_000, echoCancellation: true, noiseSuppression: true },
    });
    const context = new AudioContext({ sampleRate: 16_000 });
    await context.audioWorklet.addModule("/pcm-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm-capture");
    const silentGain = context.createGain();
    silentGain.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(event.data);
    };
    source.connect(worklet).connect(silentGain).connect(context.destination);
    mediaStreamRef.current = stream;
    audioContextRef.current = context;
  }

  function cleanupAudio(): void {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  async function stopMeeting(): Promise<void> {
    if (!meeting) return;
    setBusy(true);
    cleanupAudio();
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: "{}",
      });
      const payload = await response.json() as { meeting?: Meeting; error?: string };
      if (!response.ok || !payload.meeting) throw new Error(payload.error ?? "無法停止會議");
      setMeeting(payload.meeting);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function startPostprocess(): Promise<void> {
    if (!meeting) return;
    const confirmed = window.confirm(
      `錄音長度：${formatTime(meeting.postprocess.audioDurationMs)}\n` +
      `AssemblyAI 預估費用：US$${meeting.postprocess.estimatedCostUsd.toFixed(4)}\n\n` +
      (meeting.postprocess.status === "failed"
        ? "前次工作可能已產生部分費用；重新送出可能再次計費。\n\n"
        : "") +
      "確定要上傳錄音並開始會後講者修正嗎？",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/postprocess`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: "{}",
      });
      const payload = await response.json() as { meeting?: Meeting; error?: string };
      if (!response.ok || !payload.meeting) throw new Error(payload.error ?? "無法開始會後講者修正");
      setMeeting(payload.meeting);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteRecording(): Promise<void> {
    if (!meeting) return;
    const confirmed = window.confirm("刪除後無法播放錄音，也無法再執行會後講者修正；逐字稿、講者與匯出功能會保留。確定刪除本機錄音嗎？");
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/audio`, {
        method: "DELETE",
        headers: { "x-admin-password": adminPassword },
      });
      const payload = await response.json() as { meeting?: Meeting; error?: string };
      if (!response.ok || !payload.meeting) throw new Error(payload.error ?? "無法刪除錄音");
      setMeeting(payload.meeting);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntireMeeting(): Promise<void> {
    if (!meeting) return;
    const confirmed = window.confirm("這會永久刪除錄音、逐字稿、講者、易讀候選稿與匯出資料，無法復原。確定刪除整場會議嗎？");
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}`, {
        method: "DELETE",
        headers: { "x-admin-password": adminPassword },
      });
      const payload = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !payload.deleted) throw new Error(payload.error ?? "無法刪除會議");
      socketRef.current?.close();
      cleanupAudio();
      setMeeting(null);
      setSegments([]);
      setSpeakers([]);
      setReadableVariants([]);
      setAccessCode("");
      setIsHost(false);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function startReadableGeneration(): Promise<void> {
    if (!meeting) return;
    const characterCount = segments.reduce((total, segment) => total + segment.text.length, 0);
    const confirmed = window.confirm(
      `將傳送 ${segments.length} 段、約 ${characterCount.toLocaleString()} 個中文字至 Gemini。\n` +
      `模型：${providers?.readableModel ?? "gemini-3.5-flash-lite"}\n\n` +
      "Gemini只會產生候選稿，不會覆蓋原文。確定開始嗎？",
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/readable`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: "{}",
      });
      const payload = await response.json() as { meeting?: Meeting; error?: string };
      if (!response.ok || !payload.meeting) throw new Error(payload.error ?? "無法開始產生易讀版");
      setMeeting(payload.meeting);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function reviewReadableVariant(variant: ReadableVariant, status: "accepted" | "rejected"): Promise<void> {
    if (!meeting) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/readable/${variant.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ status }),
      });
      const payload = await response.json() as { variants?: ReadableVariant[]; error?: string };
      if (!response.ok || !payload.variants) throw new Error(payload.error ?? "無法儲存易讀版審核結果");
      setReadableVariants(payload.variants);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  function seekToSegment(segment: TranscriptSegment): void {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = segment.startMs / 1000;
    setPlaybackMs(segment.startMs);
    void audio.play().catch(() => undefined);
  }

  function beginEditingSegment(segment: TranscriptSegment): void {
    setEditingSegmentId(segment.id);
    setEditingText(segment.text);
  }

  async function saveSegmentText(segmentId: string): Promise<void> {
    if (!meeting || !editingText.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/segments/${segmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ text: editingText }),
      });
      const payload = await response.json() as { segment?: TranscriptSegment; error?: string };
      if (!response.ok || !payload.segment) throw new Error(payload.error ?? "無法儲存逐字稿校訂");
      setSegments((current) => current.map((segment) => segment.id === payload.segment!.id ? payload.segment! : segment));
      setEditingSegmentId(null);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function renameSpeaker(speaker: MeetingSpeaker): Promise<void> {
    if (!meeting) return;
    const newName = speakerDrafts[speaker.id]?.trim();
    if (!newName || newName === speaker.displayName) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/speakers/${speaker.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ name: newName }),
      });
      const payload = await response.json() as { segments?: TranscriptSegment[]; speakers?: MeetingSpeaker[]; error?: string };
      if (!response.ok || !payload.segments) throw new Error(payload.error ?? "無法修改講者姓名");
      const updates = new Map(payload.segments.map((segment) => [segment.id, segment]));
      setSegments((current) => current.map((segment) => updates.get(segment.id) ?? segment));
      if (payload.speakers) setSpeakers(payload.speakers);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function createSpeaker(): Promise<void> {
    if (!meeting || !newSpeakerName.trim()) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/speakers`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ name: newSpeakerName }),
      });
      const payload = await response.json() as { speakers?: MeetingSpeaker[]; error?: string };
      if (!response.ok || !payload.speakers) throw new Error(payload.error ?? "無法新增講者");
      setSpeakers(payload.speakers);
      setNewSpeakerName("");
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function mergeSpeaker(source: MeetingSpeaker): Promise<void> {
    if (!meeting) return;
    const targetSpeakerId = mergeTargets[source.id];
    const target = speakers.find((speaker) => speaker.id === targetSpeakerId);
    if (!target || !window.confirm(`確定把「${source.displayName}」的所有段落合併到「${target.displayName}」嗎？`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/speakers/${source.id}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ targetSpeakerId }),
      });
      const payload = await response.json() as { segments?: TranscriptSegment[]; speakers?: MeetingSpeaker[]; error?: string };
      if (!response.ok || !payload.segments || !payload.speakers) throw new Error(payload.error ?? "無法合併講者");
      const updates = new Map(payload.segments.map((segment) => [segment.id, segment]));
      setSegments((current) => current.map((segment) => updates.get(segment.id) ?? segment));
      setSpeakers(payload.speakers);
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  async function assignSegmentSpeaker(segmentId: string, speakerId: string): Promise<void> {
    if (!meeting) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/meetings/${meeting.id}/segments/${segmentId}/speaker`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-admin-password": adminPassword },
        body: JSON.stringify({ speakerId }),
      });
      const payload = await response.json() as { segment?: TranscriptSegment; error?: string };
      if (!response.ok || !payload.segment) throw new Error(payload.error ?? "無法重新指派講者");
      setSegments((current) => current.map((segment) => segment.id === payload.segment!.id ? payload.segment! : segment));
    } catch (error) {
      setWarnings((current) => [...current, error instanceof Error ? error.message : String(error)]);
    } finally {
      setBusy(false);
    }
  }

  if (!meeting) {
    return (
      <main className="shell">
        <header className="hero">
          <p className="eyebrow">LOCAL MEETING CAPTURE</p>
          <h1>中文會議逐字稿</h1>
          <p>一台 Windows 主機收音，同一區域網路即時觀看。POC 預設為模擬辨識模式。</p>
          <div className="provider-row">
            <span className={`status-dot ${providers?.mode ?? "offline"}`} />
            {providers ? `辨識模式：${providers.mode}` : "正在檢查伺服器…"}
          </div>
        </header>
        {!providers?.adminPasswordConfigured && (
          <form className="panel setup-password" onSubmit={(event) => { event.preventDefault(); void configureInitialAdminPassword(); }}>
            <p className="step">首次啟動</p>
            <h2>設定管理密碼</h2>
            <p>此密碼只會以雜湊形式保存於本機資料庫，不會傳送到雲端。</p>
            <label>管理密碼（至少 12 字元）<input type="password" value={initialAdminPassword} onChange={(event) => setInitialAdminPassword(event.target.value)} /></label>
            <label>再次輸入管理密碼<input type="password" value={initialAdminPasswordConfirmation} onChange={(event) => setInitialAdminPasswordConfirmation(event.target.value)} /></label>
            <button disabled={busy}>{busy ? "設定中…" : "儲存管理密碼"}</button>
          </form>
        )}
        {desktopSettings && (
          <form className="panel desktop-settings" onSubmit={(event) => { event.preventDefault(); void saveDesktopSettings(); }}>
            <div>
              <p className="step">DESKTOP CONFIGURATION</p>
              <h2>桌面版雲端服務設定</h2>
              <p className="desktop-settings-note">API 金鑰只會透過此視窗傳給本機桌面程式，並由 Windows 的加密儲存保護；已設定的金鑰不會顯示。空白欄位代表保持原值。</p>
            </div>
            {!desktopSettings.encryptionAvailable && <p className="warning">這台 Windows 無法使用安全加密儲存，因此不能保存 API 金鑰。</p>}
            <div className="desktop-settings-grid">
              <label>
                辨識模式
                <select value={desktopMode} onChange={(event) => setDesktopMode(event.target.value as DesktopTranscriptionMode)}>
                  <option value="deepgram-assembly">Deepgram 即時字幕＋AssemblyAI 會後講者修正</option>
                  <option value="deepgram">Deepgram 即時字幕</option>
                  <option value="cloud">Google Cloud Speech-to-Text</option>
                  <option value="cloud-stt-only">Google Cloud Speech-to-Text（不啟用會後講者修正）</option>
                  <option value="mock">Mock（不使用付費 API）</option>
                </select>
              </label>
              <label>
                Google Cloud 專案 ID（僅 Google 模式需要）
                <input value={desktopGoogleProject} onChange={(event) => setDesktopGoogleProject(event.target.value)} placeholder="例如 nccuaca-ai" autoComplete="off" />
              </label>
              <label>
                Deepgram API Key {desktopSettings.deepgramConfigured ? <small>已設定</small> : <small>未設定</small>}
                <input type="password" value={deepgramApiKey} onChange={(event) => setDeepgramApiKey(event.target.value)} placeholder={desktopSettings.deepgramConfigured ? "已設定；留空即不變更" : "貼上 Deepgram API Key"} autoComplete="new-password" />
              </label>
              <label>
                AssemblyAI API Key {desktopSettings.assemblyAiConfigured ? <small>已設定</small> : <small>未設定</small>}
                <input type="password" value={assemblyAiApiKey} onChange={(event) => setAssemblyAiApiKey(event.target.value)} placeholder={desktopSettings.assemblyAiConfigured ? "已設定；留空即不變更" : "貼上 AssemblyAI API Key"} autoComplete="new-password" />
              </label>
              <label>
                Gemini API Key {desktopSettings.geminiConfigured ? <small>已設定</small> : <small>未設定</small>}
                <input type="password" value={geminiApiKey} onChange={(event) => setGeminiApiKey(event.target.value)} placeholder={desktopSettings.geminiConfigured ? "已設定；留空即不變更" : "貼上 Gemini API Key"} autoComplete="new-password" />
              </label>
              <label>
                管理密碼（用來確認變更）
                <input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} placeholder="輸入目前管理密碼" autoComplete="current-password" required />
              </label>
            </div>
            <div className="desktop-clear-keys">
              <label><input type="checkbox" checked={clearDeepgramApiKey} onChange={(event) => setClearDeepgramApiKey(event.target.checked)} /> 清除 Deepgram 金鑰</label>
              <label><input type="checkbox" checked={clearAssemblyAiApiKey} onChange={(event) => setClearAssemblyAiApiKey(event.target.checked)} /> 清除 AssemblyAI 金鑰</label>
              <label><input type="checkbox" checked={clearGeminiApiKey} onChange={(event) => setClearGeminiApiKey(event.target.checked)} /> 清除 Gemini 金鑰</label>
            </div>
            <button disabled={busy || !desktopSettings.encryptionAvailable}>{busy ? "儲存中…" : "儲存並重新啟動服務"}</button>
          </form>
        )}
        <section className="setup-grid">
          <form className="panel" onSubmit={(event) => { event.preventDefault(); void createMeeting(); }}>
            <p className="step">主機</p>
            <h2>開始新會議</h2>
            <label>會議名稱<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
            <label>管理密碼<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></label>
            <button disabled={busy || !providers?.adminPasswordConfigured}>{busy ? "正在啟動…" : "啟動麥克風與逐字稿"}</button>
          </form>
          <form className="panel secondary" onSubmit={(event) => { event.preventDefault(); void joinMeeting(); }}>
            <p className="step">區域網路裝置</p>
            <h2>觀看現有會議</h2>
            <label>會議 ID<input value={meetingIdInput} onChange={(event) => setMeetingIdInput(event.target.value)} /></label>
            <label>會議存取碼<input value={accessCodeInput} onChange={(event) => setAccessCodeInput(event.target.value)} /></label>
            <button className="ghost" disabled={busy}>進入觀看頁</button>
          </form>
        </section>
        {warnings.map((warning, index) => <p className="warning" key={`${warning}-${index}`}>{warning}</p>)}
      </main>
    );
  }

  return (
    <main className="meeting-shell">
      <header className="meeting-header">
        <div><p className="eyebrow">{meeting.status === "recording" ? "● LIVE" : "MEETING ENDED"}</p><h1>{meeting.title}</h1></div>
        <div className="meeting-actions">
          {isHost && meeting.status === "recording" && <button className="danger" disabled={busy} onClick={() => void stopMeeting()}>結束會議</button>}
        </div>
      </header>
      <section className="share-strip">
        <span>會議 ID <strong>{meeting.id}</strong></span>
        {isHost && <><span>觀看碼 <strong>{accessCode}</strong></span><span className="share-url">{shareUrl}</span></>}
      </section>
      {meeting.status === "stopped" && (
        <section className="postprocess-card">
          <div>
            <p className="step">會後講者修正</p>
            <h2>{postprocessStatusLabel(meeting.postprocess.status)}</h2>
            <p>
              錄音長度 <strong>{formatTime(meeting.postprocess.audioDurationMs)}</strong>
              <span aria-hidden="true"> · </span>
              預估費用 <strong>US${meeting.postprocess.estimatedCostUsd.toFixed(4)}</strong>
            </p>
            {meeting.postprocess.status === "not_requested" && !meeting.recording.audioDeletedAt && <small>錄音仍只保存在本機；按下按鈕並再次確認後才會上傳與計費。</small>}
            {meeting.postprocess.status === "not_requested" && meeting.recording.audioDeletedAt && <small className="postprocess-error">錄音已刪除，無法再進行會後講者修正。</small>}
            {meeting.postprocess.status === "failed" && <small className="postprocess-error">{meeting.postprocess.error}</small>}
          </div>
          {!meeting.recording.audioDeletedAt && (meeting.postprocess.status === "not_requested" || meeting.postprocess.status === "failed") && (
            <div className="postprocess-actions">
              <label>
                管理密碼
                <input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} />
              </label>
              <button disabled={busy} onClick={() => void startPostprocess()}>
                {busy ? "正在送出…" : "開始會後講者修正"}
              </button>
            </div>
          )}
        </section>
      )}
      {meeting.status === "stopped" && (
        <section className="recording-policy">
          <div>
            <p className="step">錄音保存</p>
            {meeting.recording.audioDeletedAt ? (
              <><h2>錄音已刪除</h2><p>逐字稿、講者與匯出資料仍保留。</p></>
            ) : (
              <><h2>錄音保留 {providers?.recordingRetentionDays ?? 30} 天</h2><p>會後講者修正完成前，請不要刪除錄音。</p></>
            )}
          </div>
          <div className="recording-actions">
            <label>管理密碼<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></label>
            {!meeting.recording.audioDeletedAt && <button className="ghost" disabled={busy || meeting.postprocess.status === "queued" || meeting.postprocess.status === "processing"} onClick={() => void deleteRecording()}>刪除錄音</button>}
            <button className="danger" disabled={busy || meeting.postprocess.status === "queued" || meeting.postprocess.status === "processing" || meeting.readable.status === "processing"} onClick={() => void deleteEntireMeeting()}>刪除整場會議</button>
          </div>
        </section>
      )}
      {meeting.status === "stopped" && (
        <section className="editor-panel">
          <div className="playback-row">
            <div>
              <p className="step">錄音與校訂</p>
              <h2>點擊逐字稿即可跳到錄音位置</h2>
            </div>
            {audioUrl ? <audio
              ref={audioRef}
              controls
              preload="metadata"
              src={audioUrl}
              onTimeUpdate={(event) => setPlaybackMs(event.currentTarget.currentTime * 1000)}
              onSeeked={(event) => setPlaybackMs(event.currentTarget.currentTime * 1000)}
              onError={() => setWarnings((current) => [...current, "錄音載入失敗，請確認錄音檔仍存在"])}
            /> : <p className="audio-unavailable">錄音已刪除；仍可校訂逐字稿與講者。</p>}
          </div>
          <div className="editor-auth">
            <label>校訂管理密碼<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></label>
            <span>
              文字修改及講者改名都會立即保存，並同步到其他觀看裝置。
              {meeting.postprocess.status === "not_requested" && " 若預計執行會後講者修正，請完成修正後再改姓名。"}
            </span>
          </div>
          {speakers.length > 0 && (
            <div className="speaker-editor">
              {speakers.map((speaker) => (
                <div className="speaker-card" key={speaker.id}>
                  <div className="speaker-identity"><strong>{speaker.displayName}</strong><small>辨識標籤：{speaker.sourceLabel.startsWith("manual:") ? "人工建立" : speaker.sourceLabel}</small></div>
                  <div className="speaker-row">
                    <input value={speakerDrafts[speaker.id] ?? speaker.displayName} onChange={(event) => setSpeakerDrafts((current) => ({ ...current, [speaker.id]: event.target.value }))} />
                    <button className="ghost" disabled={busy || (speakerDrafts[speaker.id] ?? speaker.displayName).trim() === speaker.displayName} onClick={() => void renameSpeaker(speaker)}>套用姓名</button>
                  </div>
                  {speakers.length > 1 && (
                    <div className="speaker-row">
                      <select value={mergeTargets[speaker.id] ?? ""} onChange={(event) => setMergeTargets((current) => ({ ...current, [speaker.id]: event.target.value }))}>
                        <option value="">合併到…</option>
                        {speakers.filter((candidate) => candidate.id !== speaker.id).map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.displayName}</option>)}
                      </select>
                      <button className="ghost" disabled={busy || !mergeTargets[speaker.id]} onClick={() => void mergeSpeaker(speaker)}>合併</button>
                    </div>
                  )}
                </div>
              ))}
              <div className="speaker-card new-speaker">
                <div className="speaker-identity"><strong>新增講者</strong><small>供誤判段落重新指派</small></div>
                <div className="speaker-row"><input placeholder="輸入姓名" value={newSpeakerName} onChange={(event) => setNewSpeakerName(event.target.value)} /><button className="ghost" disabled={busy || !newSpeakerName.trim()} onClick={() => void createSpeaker()}>新增</button></div>
              </div>
            </div>
          )}
        </section>
      )}
      {meeting.status === "stopped" && (
        <section className="readable-panel">
          <div className="readable-header">
            <div><p className="step">雙軌逐字稿</p><h2>{readableStatusLabel(meeting.readable.status)}</h2><p>原文永久保留；只有人工接受且未過期的候選稿會進入易讀版匯出。</p></div>
            <div className="readable-action">
              {!providers?.geminiConfigured && <small>請先在 .env 設定 GEMINI_API_KEY 並重新啟動。</small>}
              <label>管理密碼<input type="password" value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} /></label>
              <button disabled={busy || meeting.readable.status === "processing" || !providers?.geminiConfigured} onClick={() => void startReadableGeneration()}>
                {meeting.readable.status === "processing" ? "產生中…" : readableVariants.length > 0 ? "重新產生候選稿" : "產生易讀候選稿"}
              </button>
            </div>
          </div>
          {meeting.readable.error && <p className="postprocess-error">{meeting.readable.error}</p>}
          {readableVariants.length > 0 && (
            <div className="readable-list">
              {readableVariants.map((variant) => {
                const segment = segments.find((candidate) => candidate.id === variant.segmentId);
                if (!segment) return null;
                return (
                  <article className={`readable-review ${variant.status} ${variant.isStale ? "stale" : ""}`} key={variant.id}>
                    <div className="readable-meta"><strong>{segment.speaker} · {formatTime(segment.startMs)}</strong><span>{variant.isStale ? "原文已修改，候選稿過期" : variant.status === "accepted" ? "已接受" : variant.status === "rejected" ? "已退回" : "待審核"}</span></div>
                    <div className="readable-compare"><div><small>逐字原文</small><p>{segment.text}</p></div><div><small>易讀候選</small><p>{variant.text}</p></div></div>
                    {!variant.isStale && <div className="readable-buttons"><button className="ghost" disabled={busy || variant.status === "rejected"} onClick={() => void reviewReadableVariant(variant, "rejected")}>退回</button><button disabled={busy || variant.status === "accepted"} onClick={() => void reviewReadableVariant(variant, "accepted")}>接受候選稿</button></div>}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}
      {meeting.status === "stopped" && accessCode && (
        <section className="export-panel">
          <div><p className="step">匯出</p><h2>下載包含講者與時間戳的逐字稿</h2></div>
          <div className="export-groups">
            <div><strong>逐字版</strong><div className="export-actions">{(["txt", "md", "docx", "pdf"] as const).map((format) => <a href={exportUrl(format, "verbatim")} key={format} download>{format.toUpperCase()}</a>)}</div></div>
            <div><strong>易讀版</strong>{readableVariants.some((variant) => variant.status === "accepted" && !variant.isStale) ? <div className="export-actions">{(["txt", "md", "docx", "pdf"] as const).map((format) => <a href={exportUrl(format, "readable")} key={format} download>{format.toUpperCase()}</a>)}</div> : <small>接受至少一段候選稿後開放</small>}</div>
          </div>
        </section>
      )}
      {warnings.map((warning, index) => <p className="warning" key={`${warning}-${index}`}>{warning}</p>)}
      <section className="transcript" aria-live="polite">
        {segments.length === 0 && !interim && <div className="empty"><span>等待語音</span><p>請對著會議麥克風說話</p></div>}
        {segments.map((segment) => (
          <article className={`utterance ${activeSegmentId === segment.id ? "active" : ""}`} key={segment.id} onClick={() => seekToSegment(segment)}>
            <div className="speaker"><span>{segment.speaker}</span><time>{formatTime(segment.startMs)}</time></div>
            {editingSegmentId === segment.id ? (
              <div className="segment-editor" onClick={(event) => event.stopPropagation()}>
                <label className="segment-speaker-select">講者
                  <select value={segment.speakerId} disabled={busy} onChange={(event) => void assignSegmentSpeaker(segment.id, event.target.value)}>
                    {speakers.map((speaker) => <option value={speaker.id} key={speaker.id}>{speaker.displayName}</option>)}
                  </select>
                </label>
                <textarea value={editingText} onChange={(event) => setEditingText(event.target.value)} rows={4} autoFocus />
                <div><button disabled={busy || !editingText.trim()} onClick={() => void saveSegmentText(segment.id)}>儲存</button><button className="ghost" disabled={busy} onClick={() => setEditingSegmentId(null)}>取消</button></div>
              </div>
            ) : (
              <div className="segment-content"><p>{segment.text}</p>{meeting.status === "stopped" && <button className="edit-button" onClick={(event) => { event.stopPropagation(); beginEditingSegment(segment); }}>校訂</button>}</div>
            )}
          </article>
        ))}
        {interim && <article className="utterance interim"><div className="speaker"><span>{interim.speaker}</span><time>{formatTime(interim.startMs)}</time></div><p>{interim.text}</p></article>}
      </section>
    </main>
  );
}
