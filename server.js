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
      answers: {}, 
      votes: {},
      readyPlayers: {},
      continueVotes: {},
      turnIndex: 0 // Tracks whose turn it is to type
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
    room.round = 1;
    room.theNumber = Math.floor(Math.random() * 10) + 1;
    
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    const imposterId = room.players[imposterIndex].id;

    room.roles = {};
    room.players.forEach(p => {
      room.roles[p.id] = (p.id === imposterId) ? 'imposter' : 'crewmate';
    });

    room.readyPlayers = {};
    room.answers = { 1: {} };
    room.continueVotes = {};

    io.to(roomCode).emit('goToRoleScreen', room);
  });

  // 4. PLAYER CLICKS "READY"
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'answer';
      room.readyPlayers = {}; 
      room.turnIndex = 0; // Start at the first player
      io.to(roomCode).emit('goToAnswerScreen', room);
      io.to(roomCode).emit('nextTurnIndex', { 
        activePlayerId: room.players[room.turnIndex].id, 
        activePlayerName: room.players[room.turnIndex].name 
      });
    }
  });

  // 5. PLAYER SUBMITS WORD CLUE (Turn-by-turn live broadcast)
  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const currentExpectedPlayer = room.players[room.turnIndex];
    if (socket.id !== currentExpectedPlayer.id) return; // Prevent out-of-turn submissions

    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    // Save clue and instantly broadcast this single clue update to everyone
    room.answers[room.round][socket.id] = clueWord;
    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: currentExpectedPlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    // Move to next player's turn
    room.turnIndex++;

    if (room.turnIndex < room.players.length) {
      // Trigger next person's turn
      io.to(roomCode).emit('nextTurnIndex', { 
        activePlayerId: room.players[room.turnIndex].id, 
        activePlayerName: room.players[room.turnIndex].name 
      });
    } else {
      // Everyone went! Show the navigation layout
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  // 6. PROCEED TO NEXT PHASE OR INTERMEDIATE DECISIONS
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.turnIndex = 0;
      room.answers[2] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      io.to(roomCode).emit('nextTurnIndex', { 
        activePlayerId: room.players[room.turnIndex].id, 
        activePlayerName: room.players[room.turnIndex].name 
      });
    } else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      room.votes = {};
      io.to(roomCode).emit('goToVoteScreen', room);
    }
  });

  // 6b. HANDLE PLAYER VOTES TO CONTINUE OR END CLUES
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (Object.keys(room.continueVotes).length === room.players.length) {
      let moreCount = 0;
      let voteCount = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') moreCount++;
        else voteCount++;
      });

      if (moreCount >= voteCount) {
        room.round++;
        room.turnIndex = 0;
        room.answers[room.round] = {};
        io.to(roomCode).emit('goToAnswerScreen', room);
        io.to(roomCode).emit('nextTurnIndex', { 
          activePlayerId: room.players[room.turnIndex].id, 
          activePlayerName: room.players[room.turnIndex].name 
        });
      } else {
        room.phase = 'vote';
        room.votes = {};
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  // 7. CAST FINAL ACCUSATION VOTE AGAINST A PLAYER
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
    room.answers = {};
    room.votes = {};
    room.roles = {};
    room.readyPlayers = {};
    room.continueVotes = {};
    room.theNumber = null;
    room.voteTally = null;
    room.turnIndex = 0;

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running live with turns! 🔥`);
});
