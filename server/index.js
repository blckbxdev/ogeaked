import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { v4 as uuidv4 } from "uuid";

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;
const PROD_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";
const NODE_ENV = process.env.NODE_ENV || "development";
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS || 500);
const RANKED_MATCH_MS = Number(process.env.RANKED_MATCH_MS || 45000);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDist = path.join(__dirname, "../client/dist");

app.use(helmet());
app.use(
  cors({
    origin: NODE_ENV === "production" ? PROD_ORIGIN : true,
    credentials: true
  })
);

app.get("/health", (_, res) => res.json({ ok: true }));

if (NODE_ENV === "production") {
  app.use(express.static(clientDist));
  app.get("*", (_, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

const io = new Server(httpServer, {
  cors: {
    origin: NODE_ENV === "production" ? PROD_ORIGIN : "*"
  },
  transports: ["websocket"]
});

/** @type {Map<string, {
 *   peers: [string, string],
 *   peaks: Map<string, number>,
 *   lastScores: Map<string, number>,
 *   endTimer: NodeJS.Timeout,
 *   endsAt: number
 * }>} */
const rankedRooms = new Map();

const rankedQueue = [];

function tierFromMmr(mmr) {
  if (mmr < 800) return { tier: "Iron", division: "IV" };
  if (mmr < 920) return { tier: "Bronze", division: "III" };
  if (mmr < 1040) return { tier: "Silver", division: "II" };
  if (mmr < 1160) return { tier: "Gold", division: "I" };
  if (mmr < 1280) return { tier: "Platinum", division: "I" };
  if (mmr < 1450) return { tier: "Diamond", division: "I" };
  return { tier: "oGeaked Elite", division: "★" };
}

function removeFromRankedQueue(socketId) {
  const i = rankedQueue.indexOf(socketId);
  if (i >= 0) rankedQueue.splice(i, 1);
}

function tryPairFromQueue(socket) {
  const now = Date.now();
  const mmr = socket.data.mmr;
  let bestIdx = -1;
  let bestDiff = Infinity;

  for (let i = 0; i < rankedQueue.length; i++) {
    const oid = rankedQueue[i];
    if (oid === socket.id) continue;
    const other = io.sockets.sockets.get(oid);
    if (!other || other.data.rankedRoomId) continue;

    const waitMs = now - (other.data.queuedAt || now);
    const band = waitMs > 30000 ? 10000 : waitMs > 15000 ? 500 : 220;
    const diff = Math.abs(other.data.mmr - mmr);
    if (diff <= band && diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }

  if (bestIdx === -1) return null;

  const partnerId = rankedQueue[bestIdx];
  const partner = io.sockets.sockets.get(partnerId);
  if (!partner) {
    rankedQueue.splice(bestIdx, 1);
    return tryPairFromQueue(socket);
  }

  rankedQueue.splice(bestIdx, 1);
  removeFromRankedQueue(socket.id);
  return partner;
}

function startRankedMatch(a, b) {
  removeFromRankedQueue(a.id);
  removeFromRankedQueue(b.id);

  const roomId = uuidv4();
  const endsAt = Date.now() + RANKED_MATCH_MS;

  a.join(roomId);
  b.join(roomId);
  a.data.rankedRoomId = roomId;
  b.data.rankedRoomId = roomId;
  a.data.peerId = b.id;
  b.data.peerId = a.id;

  const peaks = new Map([
    [a.id, 0],
    [b.id, 0]
  ]);
  const lastScores = new Map([
    [a.id, 0],
    [b.id, 0]
  ]);

  const endTimer = setTimeout(() => finishRankedRoom(roomId, "time"), RANKED_MATCH_MS);

  rankedRooms.set(roomId, {
    peers: [a.id, b.id],
    peaks,
    lastScores,
    endTimer,
    endsAt
  });

  const tierA = tierFromMmr(a.data.mmr);
  const tierB = tierFromMmr(b.data.mmr);

  io.to(a.id).emit("ranked:match-found", {
    roomId,
    endsAt,
    yourMmr: a.data.mmr,
    yourTier: tierA,
    opponentMmr: b.data.mmr,
    opponentTier: tierB
  });
  io.to(b.id).emit("ranked:match-found", {
    roomId,
    endsAt,
    yourMmr: b.data.mmr,
    yourTier: tierB,
    opponentMmr: a.data.mmr,
    opponentTier: tierA
  });
}

function broadcastRoomScores(roomId) {
  const room = rankedRooms.get(roomId);
  if (!room) return;
  const [id1, id2] = room.peers;
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);
  if (!s1 || !s2) return;

  const emitOne = (me, them) => {
    io.to(me.id).emit("ranked:scores", {
      yourScore: room.lastScores.get(me.id) ?? 0,
      theirScore: room.lastScores.get(them.id) ?? 0,
      yourPeak: room.peaks.get(me.id) ?? 0,
      theirPeak: room.peaks.get(them.id) ?? 0
    });
  };
  emitOne(s1, s2);
  emitOne(s2, s1);
}

function cleanupRoom(roomId) {
  const room = rankedRooms.get(roomId);
  if (!room) return;
  clearTimeout(room.endTimer);
  rankedRooms.delete(roomId);
  for (const pid of room.peers) {
    const s = io.sockets.sockets.get(pid);
    if (s) {
      s.leave(roomId);
      s.data.rankedRoomId = null;
      s.data.peerId = null;
    }
  }
}

function adjustMmr(winnerSocket, loserSocket, tie) {
  const K = 28;
  if (tie) {
    winnerSocket.data.mmr = Math.round(winnerSocket.data.mmr + 4);
    loserSocket.data.mmr = Math.round(loserSocket.data.mmr + 4);
    return { winDelta: 4, lossDelta: 4 };
  }
  const winE = 1 / (1 + 10 ** ((loserSocket.data.mmr - winnerSocket.data.mmr) / 400));
  const lossE = 1 - winE;
  const winDelta = Math.round(K * (1 - winE));
  const lossDelta = Math.round(K * (0 - lossE));
  winnerSocket.data.mmr = Math.max(0, winnerSocket.data.mmr + winDelta);
  loserSocket.data.mmr = Math.max(0, loserSocket.data.mmr + lossDelta);
  return { winDelta, lossDelta };
}

function finishRankedRoom(roomId, reason) {
  const room = rankedRooms.get(roomId);
  if (!room) return;

  const [id1, id2] = room.peers;
  const s1 = io.sockets.sockets.get(id1);
  const s2 = io.sockets.sockets.get(id2);

  const p1 = room.peaks.get(id1) ?? 0;
  const p2 = room.peaks.get(id2) ?? 0;

  let outcome1 = "tie";
  let outcome2 = "tie";
  let tie = true;

  if (s1 && s2) {
    if (p1 > p2) {
      outcome1 = "win";
      outcome2 = "loss";
      tie = false;
    } else if (p2 > p1) {
      outcome1 = "loss";
      outcome2 = "win";
      tie = false;
    }
    const a = s1;
    const b = s2;
    let deltas;
    if (tie) {
      deltas = adjustMmr(a, b, true);
      const t = tierFromMmr(a.data.mmr);
      io.to(a.id).emit("ranked:result", {
        outcome: "tie",
        reason,
        yourPeak: p1,
        theirPeak: p2,
        mmrDelta: deltas.winDelta,
        newMmr: a.data.mmr,
        newTier: t
      });
      io.to(b.id).emit("ranked:result", {
        outcome: "tie",
        reason,
        yourPeak: p2,
        theirPeak: p1,
        mmrDelta: deltas.lossDelta,
        newMmr: b.data.mmr,
        newTier: tierFromMmr(b.data.mmr)
      });
    } else {
      const winner = outcome1 === "win" ? s1 : s2;
      const loser = outcome1 === "win" ? s2 : s1;
      const wPeak = outcome1 === "win" ? p1 : p2;
      const lPeak = outcome1 === "win" ? p2 : p1;
      deltas = adjustMmr(winner, loser, false);

      io.to(winner.id).emit("ranked:result", {
        outcome: "win",
        reason,
        yourPeak: wPeak,
        theirPeak: lPeak,
        mmrDelta: deltas.winDelta,
        newMmr: winner.data.mmr,
        newTier: tierFromMmr(winner.data.mmr)
      });
      io.to(loser.id).emit("ranked:result", {
        outcome: "loss",
        reason,
        yourPeak: lPeak,
        theirPeak: wPeak,
        mmrDelta: deltas.lossDelta,
        newMmr: loser.data.mmr,
        newTier: tierFromMmr(loser.data.mmr)
      });
    }
  } else if (s1) {
    s1.data.mmr = Math.round(s1.data.mmr + 8);
    io.to(s1.id).emit("ranked:result", {
      outcome: "win",
      reason: "forfeit",
      yourPeak: p1,
      theirPeak: p2,
      mmrDelta: 8,
      newMmr: s1.data.mmr,
      newTier: tierFromMmr(s1.data.mmr)
    });
  } else if (s2) {
    s2.data.mmr = Math.round(s2.data.mmr + 8);
    io.to(s2.id).emit("ranked:result", {
      outcome: "win",
      reason: "forfeit",
      yourPeak: p2,
      theirPeak: p1,
      mmrDelta: 8,
      newMmr: s2.data.mmr,
      newTier: tierFromMmr(s2.data.mmr)
    });
  }

  cleanupRoom(roomId);
}

io.use((socket, next) => {
  if (io.engine.clientsCount >= MAX_CONNECTIONS) {
    socket.emit("server:full", { message: "Server is full. Try again soon." });
    return next(new Error("Server is full."));
  }
  return next();
});

io.on("connection", (socket) => {
  socket.data.mmr = 1000;
  socket.data.rankedRoomId = null;
  socket.data.peerId = null;
  socket.data.queuedAt = 0;
  socket.data.scoreRate = { count: 0, ts: Date.now() };

  io.to(socket.id).emit("ranked:welcome", {
    mmr: socket.data.mmr,
    tier: tierFromMmr(socket.data.mmr)
  });

  socket.on("ranked:queue", () => {
    if (socket.data.rankedRoomId) return;
    removeFromRankedQueue(socket.id);

    const partner = tryPairFromQueue(socket);
    if (partner) {
      startRankedMatch(socket, partner);
      return;
    }

    socket.data.queuedAt = Date.now();
    rankedQueue.push(socket.id);
    io.to(socket.id).emit("ranked:queue-update", {
      position: rankedQueue.length,
      hint: "Pairing by skill — wider search after ~15s"
    });

    const buddy = tryPairFromQueue(socket);
    if (buddy) {
      removeFromRankedQueue(socket.id);
      startRankedMatch(socket, buddy);
    }
  });

  socket.on("ranked:cancel-queue", () => {
    removeFromRankedQueue(socket.id);
    socket.data.queuedAt = 0;
  });

  socket.on("score:update", ({ score }) => {
    const roomId = socket.data.rankedRoomId;
    if (!roomId || !rankedRooms.has(roomId)) return;

    const now = Date.now();
    if (now - socket.data.scoreRate.ts >= 1000) {
      socket.data.scoreRate.ts = now;
      socket.data.scoreRate.count = 0;
    }
    socket.data.scoreRate.count += 1;
    if (socket.data.scoreRate.count > 4) return;

    if (typeof score !== "number" || Number.isNaN(score) || score < 0 || score > 10) {
      return;
    }

    const room = rankedRooms.get(roomId);
    room.lastScores.set(socket.id, score);
    const prevPeak = room.peaks.get(socket.id) ?? 0;
    if (score > prevPeak) room.peaks.set(socket.id, score);
    broadcastRoomScores(roomId);
  });

  socket.on("ranked:forfeit", () => {
    const roomId = socket.data.rankedRoomId;
    if (!roomId || !rankedRooms.has(roomId)) return;
    const room = rankedRooms.get(roomId);
    const peerId = socket.data.peerId;
    const peer = peerId ? io.sockets.sockets.get(peerId) : null;

    clearTimeout(room.endTimer);
    rankedRooms.delete(roomId);

    socket.leave(roomId);
    socket.data.rankedRoomId = null;
    socket.data.peerId = null;

    if (peer) {
      peer.data.rankedRoomId = null;
      peer.data.peerId = null;
      peer.leave(roomId);
      peer.data.mmr = Math.round(peer.data.mmr + 18);
      socket.data.mmr = Math.max(0, Math.round(socket.data.mmr - 22));

      io.to(peer.id).emit("ranked:result", {
        outcome: "win",
        reason: "forfeit",
        yourPeak: room.peaks.get(peer.id) ?? 0,
        theirPeak: room.peaks.get(socket.id) ?? 0,
        mmrDelta: 18,
        newMmr: peer.data.mmr,
        newTier: tierFromMmr(peer.data.mmr)
      });
      io.to(socket.id).emit("ranked:result", {
        outcome: "loss",
        reason: "forfeit",
        yourPeak: room.peaks.get(socket.id) ?? 0,
        theirPeak: room.peaks.get(peer.id) ?? 0,
        mmrDelta: -22,
        newMmr: socket.data.mmr,
        newTier: tierFromMmr(socket.data.mmr)
      });
    } else {
      cleanupRoom(roomId);
    }
  });

  socket.on("disconnect", () => {
    removeFromRankedQueue(socket.id);
    const roomId = socket.data.rankedRoomId;
    if (!roomId || !rankedRooms.has(roomId)) return;

    const room = rankedRooms.get(roomId);
    const peerId = socket.data.peerId;
    const peer = peerId ? io.sockets.sockets.get(peerId) : null;

    clearTimeout(room.endTimer);
    rankedRooms.delete(roomId);
    socket.data.rankedRoomId = null;

    if (peer) {
      peer.leave(roomId);
      peer.data.rankedRoomId = null;
      peer.data.peerId = null;
      peer.data.mmr = Math.round(peer.data.mmr + 12);
      io.to(peer.id).emit("ranked:result", {
        outcome: "win",
        reason: "disconnect",
        yourPeak: room.peaks.get(peer.id) ?? 0,
        theirPeak: room.peaks.get(socket.id) ?? 0,
        mmrDelta: 12,
        newMmr: peer.data.mmr,
        newTier: tierFromMmr(peer.data.mmr)
      });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`oGeaked server listening on ${PORT}`);
});
