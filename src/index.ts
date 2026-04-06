import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;

interface Player {
  id: string;
  nickname: string;
  isAlive: boolean;
  score: number;
  totalScore: number;
}

interface Room {
  id: string;
  adminId: string;
  players: Map<string, Player>;
  isPlaying: boolean;
  isPaused: boolean;
  config: { baseSpeed: number };
}

const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, string>();

const emitRoomUpdate = (roomId: string) => {
  const room = rooms.get(roomId);
  if (!room) return;
  const playersList = Array.from(room.players.values());
  io.to(roomId).emit("room_update", {
    id: room.id,
    adminId: room.adminId,
    players: playersList,
    isPlaying: room.isPlaying,
    isPaused: room.isPaused,
    config: room.config,
  });
};

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("join_room", ({ roomId, nickname }, callback) => {
    if (!roomId || typeof roomId !== 'string') return;
    const cleanRoomId = roomId.trim().toLowerCase();
    
    let room = rooms.get(cleanRoomId);

    if (!room) {
      // Create room
      room = {
        id: cleanRoomId,
        adminId: socket.id,
        players: new Map(),
        isPlaying: false,
        isPaused: false,
        config: { baseSpeed: 1000 },
      };
      rooms.set(roomId, room);
    }

    if (room.players.size >= 4) {
      return callback({ error: "Sala cheia. Máximo de 4 jogadores." });
    }

    if (room.isPlaying) {
      return callback({ error: "A partida já começou nesta sala." });
    }

    room.players.set(socket.id, {
      id: socket.id,
      nickname,
      isAlive: true,
      score: 0,
      totalScore: 0
    });

    socket.join(cleanRoomId);
    socketToRoom.set(socket.id, cleanRoomId);
    
    callback({ success: true });
    emitRoomUpdate(cleanRoomId);
  });

  socket.on("kick_player", (playerId) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    // only admin can kick, and can't kick themselves
    if (room && room.adminId === socket.id && playerId !== socket.id) {
      room.players.delete(playerId);
      const targetSocket = io.sockets.sockets.get(playerId);
      if (targetSocket) {
        targetSocket.leave(roomId);
        targetSocket.emit("kicked");
      }
      socketToRoom.delete(playerId);
      emitRoomUpdate(roomId);
    }
  });

  socket.on("update_config", (config) => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.adminId === socket.id) {
        room.config = { ...room.config, ...config };
        emitRoomUpdate(roomId);
      }
    }
  });

  socket.on("start_game", () => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.adminId === socket.id) {
        room.isPlaying = true;
        room.isPaused = false;
        room.players.forEach(p => { p.isAlive = true; p.score = 0; p.totalScore = 0; });
        io.to(roomId).emit("game_started");
        emitRoomUpdate(roomId);
      }
    }
  });

  socket.on("toggle_pause", () => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room && room.adminId === socket.id) {
        room.isPaused = !room.isPaused;
        io.to(roomId).emit("game_paused", room.isPaused);
        emitRoomUpdate(roomId);
      }
    }
  });

  socket.on("update_board", (data) => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      socket.to(roomId).emit("board_updated", { id: socket.id, ...data });
    }
  });

  socket.on("score_lines", (numLines: number) => {
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        const p = room.players.get(socket.id);
        if (p) {
          const oldScore = p.totalScore;
          p.score += numLines * 100;
          p.totalScore += numLines * 100;
          
          // Garbage every 400 points
          const oldGate = Math.floor(oldScore / 400);
          const newGate = Math.floor(p.totalScore / 400);
          if (newGate > oldGate) {
            socket.to(roomId).emit("receive_garbage", { id: socket.id, lines: newGate - oldGate });
          }
        }
        
        io.to(roomId).emit("score_updated", { id: socket.id, score: p?.score });
      }
    }
  });

  socket.on("use_power", ({ type, cost, targetId }: { type: string, cost: number, targetId?: string }) => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const p = room.players.get(socket.id);
    if (p) {
      p.score -= cost;
      io.to(roomId).emit("score_updated", { id: socket.id, score: p.score });
    }

    if (type === "share_wealth") {
        // Find an opponent to give 200 pts
        const opponents = Array.from(room.players.values()).filter(player => player.id !== socket.id);
        if (opponents.length > 0) {
            const target = opponents[Math.floor(Math.random() * opponents.length)];
            target.score += 200;
            target.totalScore += 200;
            io.to(roomId).emit("score_updated", { id: target.id, score: target.score });
        }
    } else if (type === "gift_box") {
        const isSelf = Math.random() > 0.5;
        const randomPower = ["fog", "mirror", "concrete", "frozen", "flicker", "curse"][Math.floor(Math.random() * 6)];
        if (isSelf) {
            socket.emit("receive_power", { type: randomPower, id: "gift_box_system" });
        } else {
            socket.to(roomId).emit("receive_power", { type: randomPower, id: "gift_box_system" });
        }
    } else {
        // Default relay
        socket.to(roomId).emit("receive_power", { id: socket.id, type, targetId });
    }
  });

  socket.on("game_over", () => {
    const roomId = socketToRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    
    const p = room.players.get(socket.id);
    if (p) {
      p.isAlive = false;
      socket.to(roomId).emit("player_died", socket.id);
      
      let aliveCount = 0;
      let winnerId = null;
      room.players.forEach((player, pid) => {
        if (player.isAlive) {
          aliveCount++;
          winnerId = pid;
        }
      });

      if (room.players.size > 1 && aliveCount === 1) {
        io.to(roomId).emit("victory", winnerId);
        room.isPlaying = false;
      } else if (aliveCount === 0) {
        io.to(roomId).emit("game_ended_draw");
        room.isPlaying = false;
      }
      emitRoomUpdate(roomId);
    }
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
    const roomId = socketToRoom.get(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        room.players.delete(socket.id);
        socketToRoom.delete(socket.id);
        
        if (room.players.size === 0) {
          rooms.delete(roomId);
        } else {
          // Pass admin rights if admin left
          if (room.adminId === socket.id) {
            const nextAdmin = room.players.keys().next().value;
            if (nextAdmin) room.adminId = nextAdmin;
          }
          socket.to(roomId).emit("player_left", socket.id);
          emitRoomUpdate(roomId);
        }
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
