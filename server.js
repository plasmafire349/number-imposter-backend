const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. HOST CREATES LOBBY
  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    socket.join(code);

    rooms[code] = {
      code: code,
      phase: 'waiting',
      round: 1,
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName }],
      answers: { 1: {}, 2: {} },
      votes: {},
      readyPlayers: {}
    };

    socket.emit('roomUpdated', rooms[code]);
  });

  // 2. PLAYER JOINS LOBBY
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit('errorMsg', 'Room code not found!');
      return;
    }
    if (room.phase !== 'waiting') {
      socket.emit('errorMsg', 'Game has already started!');
      return;
    }

    socket.join(code);
    room.players.push({ id: socket.id, name: playerName });
    io.to(code).emit('roomUpdated', room);
  });

  // 3. HOST STARTS THE GAME
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'role';
    room.theNumber = Math.floor(Math.random() * 10) + 1;
    
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    const imposterId = room.players[imposterIndex].id;

    room.roles = {};
    room.players.forEach(p => {
      room.roles[p.id] = (p.id === imposterId) ? 'imposter' : 'crewmate';
    });

    room.readyPlayers = {};
    room.answers = { 1: {}, 2: {} };

    io.to(roomCode).emit('goToRoleScreen', room);
  });

  // 4. PLAYER CLICKS "READY" (Host and Players)
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'answer';
      room.readyPlayers = {}; 
      io.to(roomCode).emit('goToAnswerScreen', room);
    }
  });

  // 5. PLAYER SUBMITS NUMERICAL CLUE (Host and Players)
  socket.on('submitClue', ({ roomCode, clueNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    room.answers[room.round][socket.id] = clueNumber;
    io.to(roomCode).emit('clueStatusUpdated', room.answers[room.round]);

    if (Object.keys(room.answers[room.round]).length === room.players.length) {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  // 6. PROCEED TO ROUND 2 OR VOTING
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      io.to(roomCode).emit('goToAnswerScreen', room);
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      room.votes = {};
      io.to(roomCode).emit('goToVoteScreen', room);
    }
  });

  // 7. CAST VOTE AGAINST A PLAYER
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    if (Object.keys(room.votes).length === room.players.length) {
      room.phase = 'result';
      const tally = {};
      room.players.forEach(p => tally[p.id] = 0);
      Object.values(room.votes).forEach(target => {
        if (tally[target] !== undefined) tally[target]++;
      });
      room.voteTally = tally;

      io.to(roomCode).emit('goToResultScreen', room);
    }
  });

  // 8. PLAY AGAIN RESET
  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'waiting';
    room.round = 1;
    room.answers = { 1: {}, 2: {} };
    room.votes = {};
    room.roles = {};
    room.readyPlayers = {};
    room.theNumber = null;
    room.voteTally = null;

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running live on port ${PORT}! 🔥`);
});
