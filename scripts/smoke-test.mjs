import WebSocket from "ws";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3001";
const adminPassword = process.env.ADMIN_PASSWORD ?? "change-me";

const createResponse = await fetch(`${baseUrl}/api/meetings`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-password": adminPassword },
  body: JSON.stringify({ title: "WebSocket smoke test" }),
});
if (!createResponse.ok) throw new Error(`Create failed: ${createResponse.status} ${await createResponse.text()}`);
const created = await createResponse.json();

const wsUrl = new URL(baseUrl.replace(/^http/, "ws"));
wsUrl.pathname = `/ws/meetings/${created.meeting.id}`;
wsUrl.searchParams.set("role", "host");
wsUrl.searchParams.set("credential", created.hostToken);
const socket = new WebSocket(wsUrl);

const segment = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Timed out waiting for a mock transcript segment")), 5_000);
  socket.on("open", () => socket.send(Buffer.alloc(16_000 * 2 * 2)));
  socket.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type !== "segment") return;
    clearTimeout(timeout);
    resolve(event.segment);
  });
  socket.on("error", reject);
});

const stopResponse = await fetch(`${baseUrl}/api/meetings/${created.meeting.id}/stop`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-password": adminPassword },
  body: "{}",
});
if (!stopResponse.ok) throw new Error(`Stop failed: ${stopResponse.status} ${await stopResponse.text()}`);
const stopped = await stopResponse.json();
socket.close();

console.log(JSON.stringify({
  meetingId: created.meeting.id,
  text: segment.text,
  speaker: segment.speaker,
  status: stopped.meeting.status,
}, null, 2));
