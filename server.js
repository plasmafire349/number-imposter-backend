const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Allow any device to safely connect to this server
const io = new Server(server, {
  cors: { origin: "*" }
});

// This object stores all live rooms in your server's memory
const rooms = {};

// Helper to generate a 4-letter room code (e.g. AB3X)
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
      answers: {},
      votes: {}
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
    if (room.players.length >= 10) {
      socket.emit('errorMsg', 'Lobby is full!');
      return;
    }

    socket.join(code);
    room.players.push({ id: socket.id, name: playerName });

    // Broadcast the updated player list to everyone inside the room
    io.to(code).emit('roomUpdated', room);
  });

  // 3. HOST STARTS THE GAME
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'role';
    room.theNumber = Math.floor(Math.random() * 10) + 1; // 1 to 10
    
    // Pick a random player to be the imposter
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    const imposterId = room.players[imposterIndex].id;

    room.roles = {};
    room.players.forEach(p => {
      room.roles[p.id] = (p.id === imposterId) ? 'imposter' : 'crewmate';
    });

    room.readyPlayers = {};
    room.answers[room.round] = {};

    // Tell everyone to go to the role screen
    io.to(roomCode).emit('goToRoleScreen', room);
  });

  // 4. PLAYER CLICKS "READY"
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;

    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    // If everyone is ready, move to the input round automatically
    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'answer';
      room.readyPlayers = {}; // reset for later
      io.to(roomCode).emit('goToAnswerScreen', room);
    }
  });

  // 5. PLAYER SUBMITS NUMERICAL CLUE
  socket.on('submitClue', ({ roomCode, clueNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.answers[room.round][socket.id] = clueNumber;

    io.to(roomCode).emit('clueStatusUpdated', room.answers[room.round]);

    // If all players checked in their numbers, show the results
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
      room.answers[2] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      io.to(roomCode).emit('goToVoteScreen', room);
    }
  });

  // 7. CAST VOTE AGAINST A PLAYER
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    // Tally up when every vote is in
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
    room.answers = {};
    room.votes = {};
    room.roles = {};
    room.theNumber = null;
    room.voteTally = null;

    io.to(roomCode).emit('roomUpdated', room);
  });

  // Handle a player leaving/disconnecting
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

server.listen(3000, () => {
  console.log('Server is alive and listening perfectly on port 3000! 🔥');
});