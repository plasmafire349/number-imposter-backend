const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 🌟 FIX: This line forces the server to look inside its own folder 
// to automatically serve 'number-imposter.html' and all project assets!
app.use(express.static(__dirname));

// Also serve the root path directly to your HTML game file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'number-imposter.html'));
});

// Game State Database stored in memory
const rooms = {};

// Helper function to generate random 4-letter room codes
function generateRoomCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return code;
}

// Helper to shuffle arrays (Fisher-Yates)
function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 1. CREATE ROOM
  socket.on('createRoom', ({ playerName }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName }],
      phase: 'lobby',
      round: 1,
      roles: {},
      theNumber: null,
      readyPlayers: {},
      turnOrder: [],
      currentTurnIndex: 0,
      answers: {}, 
      continueVotes: {},
      votes: {},
      tieBreakerActive: false,
      failedImposterGuess: null,
      gameOverReason: ""
    };

    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
    console.log(`Room created: ${roomCode} by ${playerName}`);
  });

  // 2. JOIN ROOM
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) {
      return socket.emit('errorMsg', 'Room not found.');
    }
    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', 'Game has already started.');
    }

    room.players.push({ id: socket.id, name: playerName });
    socket.join(code);
    io.to(code).emit('roomUpdated', room);
    console.log(`${playerName} joined room ${code}`);
  });

  // 3. START GAME
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) {
      return socket.emit('errorMsg', 'Need at least 3 players to start!');
    }

    room.phase = 'role';
    room.round = 1;
    room.tieBreakerActive = false;
    room.failedImposterGuess = null;
    room.answers = {};
    room.roles = {};
    room.readyPlayers = {};
    
    room.theNumber = Math.floor(Math.random() * 10) + 1;

    const shuffledPlayers = shuffleArray(room.players);
    const imposter = shuffledPlayers[0];
    
    room.players.forEach(p => {
      room.roles[p.id] = (p.id === imposter.id) ? 'imposter' : 'crewmate';
    });

    io.to(room.code).emit('goToRoleScreen', room);
  });

  // 4. PLAYER READY
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(room.code).emit('readyListUpdated', room.readyPlayers);

    const allReady = room.players.every(p => room.readyPlayers[p.id]);
    if (allReady) {
      room.phase = 'turnReveal';
      room.turnOrder = shuffleArray(room.players);
      io.to(room.code).emit('goToTurnRevealScreen', room);
    }
  });

  // 5. START ANSWERING PHASE
  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    room.currentTurnIndex = 0;
    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    io.to(room.code).emit('goToAnswerScreen', room);

    const firstPlayer = room.turnOrder[0];
    io.to(room.code).emit('nextTurnIndex', {
      activePlayerId: firstPlayer.id,
      activePlayerName: firstPlayer.name
    });
  });

  // 6. SUBMIT CLUE WORD
  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    const activePlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== activePlayer.id) return; 

    room.answers[room.round][socket.id] = clueWord;
    const activePlayerObj = room.players.find(p => p.id === socket.id);

    io.to(room.code).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: activePlayerObj ? activePlayerObj.name : 'Unknown',
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.currentTurnIndex++;

    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextPlayer = room.turnOrder[room.currentTurnIndex];
      io.to(room.code).emit('nextTurnIndex', {
        activePlayerId: nextPlayer.id,
        activePlayerName: nextPlayer.name
      });
    } else {
      io.to(room.code).emit('showAllClues', room);
    }
  });

  // 7. MULTI-PHASE HUB ROUTER
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.turnOrder = shuffleArray(room.players);
      io.to(room.code).emit('goToTurnRevealScreen', room);
    } 
    else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(room.code).emit('promptContinueVote');
    } 
    else if (targetPhase === 'vote') {
      room.votes = {};
      io.to(room.code).emit('goToVoteScreen', room);
    } 
    else if (targetPhase === 'tiebreakerRound') {
      room.tieBreakerActive = true;
      room.round++;
      room.turnOrder = shuffleArray(room.players);
      io.to(room.code).emit('goToTurnRevealScreen', room);
    }
  });

  // 8. EXTEND ROUND OR PROCEED CONSENSUS VOTE
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(room.code).emit('continueStatusUpdated', room.continueVotes);

    const allVoted = room.players.every(p => room.continueVotes[p.id]);
    if (allVoted) {
      let moreCount = 0;
      let voteCount = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') moreCount++;
        if (v === 'vote') voteCount++;
      });

      if (moreCount >= voteCount) {
        room.round++;
        room.turnOrder = shuffleArray(room.players);
        io.to(room.code).emit('goToTurnRevealScreen', room);
      } else {
        room.votes = {};
        io.to(room.code).emit('goToVoteScreen', room);
      }
    }
  });

  // 9. CAST ENFORCE VOTES
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(room.code).emit('voteStatusUpdated', room.votes);

    const allVoted = room.players.every(p => room.votes[p.id]);
    if (allVoted) {
      const voteTally = {};
      room.players.forEach(p => voteTally[p.id] = 0);
      
      Object.values(room.votes).forEach(targetId => {
        if (voteTally[targetId] !== undefined) voteTally[targetId]++;
      });

      let maxVotes = -1;
      let highestVotedPlayers = [];

      Object.entries(voteTally).forEach(([pId, count]) => {
        if (count > maxVotes) {
          maxVotes = count;
          highestVotedPlayers = [pId];
        } else if (count === maxVotes) {
          highestVotedPlayers.push(pId);
        }
      });

      room.voteTally = voteTally;

      if (highestVotedPlayers.length > 1) {
        room.tieBreakerActive = true;
        room.gameOverReason = "VOTING TIE! The group could not reach a consensus.";
        io.to(room.code).emit('goToResultScreen', room);
      } else {
        const exiledId = highestVotedPlayers[0];
        room.tieBreakerActive = false;

        if (room.roles[exiledId] === 'imposter') {
          room.gameOverReason = "VICTORY! The Crewmates successfully voted out the Imposter!";
        } else {
          room.gameOverReason = "DEFEAT! An innocent Crewmate was exiled. The Imposter wins!";
        }
        io.to(room.code).emit('goToResultScreen', room);
      }
    }
  });

  // 10. CLANDESTINE IMPOSTER GUESS ATTEMPT
  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;
    if (room.roles[socket.id] !== 'imposter') return; 

    room.tieBreakerActive = false;
    if (parseInt(guessedNumber) === parseInt(room.theNumber)) {
      room.gameOverReason = "IMPOSTER VICTORY! The Imposter cracked the secret number code!";
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "CREWMATE VICTORY! The Imposter made a blind guess and blew their cover!";
    }
    io.to(room.code).emit('goToResultScreen', room);
  });

  // 11. PLAY AGAIN / RESET ROOM LOBBY
  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.round = 1;
    room.roles = {};
    room.theNumber = null;
    room.readyPlayers = {};
    room.turnOrder = [];
    room.currentTurnIndex = 0;
    room.answers = {};
    room.continueVotes = {};
    room.votes = {};
    room.tieBreakerActive = false;
    room.failedImposterGuess = null;
    room.gameOverReason = "";

    io.to(room.code).emit('roomUpdated', room);
  });

  // CLEAN UP ON LEAVE
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          delete rooms[code]; 
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          io.to(code).emit('roomUpdated', room);
        }
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`Number Imposter Server is live on http://localhost:${PORT}`);
});
