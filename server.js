import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e7
});

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.send("OK"));

/**
 * rooms: roomId -> Map(socketId -> participant)
 * participant: { userId, displayName, streamAllowed, lastSeen }
 */
const rooms = new Map();
/**
 * roomAdmins: roomId -> Set(adminSocketId)
 */
const roomAdmins = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Map());
  if (!roomAdmins.has(roomId)) roomAdmins.set(roomId, new Set());
}

function upsertParticipant(roomId, socketId, patch) {
  ensureRoom(roomId);
  const room = rooms.get(roomId);
  const prev = room.get(socketId) || {};
  room.set(socketId, { ...prev, ...patch, lastSeen: Date.now() });
}

function removeParticipant(roomId, socketId) {
  const room = rooms.get(roomId);
  if (room) room.delete(socketId);
}

function listAdmins(roomId) {
  ensureRoom(roomId);
  return [...roomAdmins.get(roomId).values()];
}

// Admin sees ONLY users who enabled streamAllowed=true
function listStreamEnabledParticipants(roomId) {
  ensureRoom(roomId);
  const room = rooms.get(roomId);
  return [...room.entries()]
    .map(([socketId, p]) => {
      if (!p.streamAllowed) return null;
      return {
        socketId,
        userId: p.userId,
        displayName: p.displayName,
        lastSeen: p.lastSeen
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

function broadcastAdminUpdate(roomId) {
  io.to(`admin:${roomId}`).emit("room:update", listStreamEnabledParticipants(roomId));
}

io.on("connection", (socket) => {
  // Participant join
  socket.on("join", ({ roomId, userId, displayName }) => {
    if (!roomId || !userId) return;

    socket.data.role = "participant";
    socket.data.roomId = roomId;
    socket.data.userId = userId;

    ensureRoom(roomId);
    socket.join(`room:${roomId}`);

    upsertParticipant(roomId, socket.id, {
      userId,
      displayName: displayName || userId,
    });

    // Send current admin list to participant so they can auto-connect if they enable stream
    socket.emit("admin:list", { roomId, admins: listAdmins(roomId) });

    broadcastAdminUpdate(roomId);
  });

  // Heartbeat
  socket.on("ping", () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    upsertParticipant(roomId, socket.id, {});
    broadcastAdminUpdate(roomId);
  });

  // Participant toggles stream permission
  socket.on("stream:consent", ({ roomId, userId, allow }) => {
    if (!roomId || !userId) return;

    upsertParticipant(roomId, socket.id, { userId, streamAllowed: !!allow });

    // Tell participant current admins (useful if they just enabled stream)
    socket.emit("admin:list", { roomId, admins: listAdmins(roomId) });

    // Update admin dashboard list
    broadcastAdminUpdate(roomId);

    // Notify admins that this participant is now available (or removed)
    io.to(`admin:${roomId}`).emit("participant:streamAllowed", {
      socketId: socket.id,
      userId,
      allow: !!allow
    });
  });

  // Admin subscribe (no key)
  socket.on("admin:subscribe", ({ roomId }) => {
    if (!roomId) return;

    socket.data.role = "admin";
    socket.data.roomId = roomId;

    ensureRoom(roomId);
    roomAdmins.get(roomId).add(socket.id);
    socket.join(`admin:${roomId}`);

    // Send list of stream-enabled participants
    socket.emit("room:update", listStreamEnabledParticipants(roomId));

    // Inform participants that an admin is online (so they can auto-connect if allowed)
    io.to(`room:${roomId}`).emit("admin:online", { adminSocketId: socket.id });
  });

  // WebRTC signaling relay (offer/answer/ice)
  socket.on("webrtc:offer", ({ to, sdp }) => {
    io.to(to).emit("webrtc:offer", { from: socket.id, sdp });
  });

  socket.on("webrtc:answer", ({ to, sdp }) => {
    io.to(to).emit("webrtc:answer", { from: socket.id, sdp });
  });

  socket.on("webrtc:ice", ({ to, candidate }) => {
    io.to(to).emit("webrtc:ice", { from: socket.id, candidate });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;

    if (roomId) {
      // If admin, remove and notify participants
      if (socket.data.role === "admin") {
        ensureRoom(roomId);
        roomAdmins.get(roomId).delete(socket.id);
        io.to(`room:${roomId}`).emit("admin:offline", { adminSocketId: socket.id });
      }

      // If participant, remove and update admin list
      if (socket.data.role === "participant") {
        removeParticipant(roomId, socket.id);
      }

      broadcastAdminUpdate(roomId);
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Server listening on :${port}`));
