const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve static frontend assets from your project directory
app.use(express.static(path.join(__dirname, '../public'))); 
// Alternatively, if your HTML is right next to server.js, use: app.use(express.static(__dirname));

// Game State Database (In-Memory)
const rooms = {};

// Helper function to generate a random 4-letter room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // 1. CREATE LOBBY
  socket.on('createRoom', ({ playerName, gameMode }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      gameMode: gameMode || 'number',
      phase: 'lobby',
      round: 1,
      players: [{ id: socket.id, name: playerName }],
      roles: {},
      theNumber: null,
      turnOrder: [],
      answers: {},
      voteTally: {},
      readyPlayers: {},
      continueVotes: {},
      failedImposterGuess: null,
      tieBreakerActive: false
    };

    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
    console.log(`Room created: ${roomCode} by ${playerName}`);
  });

  // 2. JOIN LOBBY
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];

    if (!room) {
      return socket.emit('errorMsg', 'Room not found.');
    }
    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', 'Game has already started.');
    }

    room.players.push({ id: socket.id, name: playerName });
    socket.join(cleanedCode);

    // Notify everyone in the room about the new player
    io.to(cleanedCode).emit('roomUpdated', room);
    console.log(`${playerName} joined Room: ${cleanedCode}`);
  });

  // 3. START GAME
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.gameMode === 'card') {
      // Initialize Seven of Clubs specific logic here
      room.phase = 'sevenClubsBoard';
      
      // Mocking card game data distribution for illustration
      io.to(roomCode).emit('sevenClubsUpdateBoard', {
        activePlayerId: room.hostId,
        activePlayerName: room.players[0].name,
        neighborCardCount: 3,
        gridCells: [
          { row: 1, col: 1, hasSuit: true, displayValue: "♣7" },
          { row: 1, col: 2, hasSuit: false, displayValue: "—" },
          { row: 1, col: 3, hasSuit: false, displayValue: "—" }
        ],
        myHand: [
          { suit: 'Clubs', rank: '8', suitIcon: '♣', isPlayable: true },
          { suit: 'Hearts', rank: 'A', suitIcon: '♥', isPlayable: false }
        ]
      });
    } else {
      // Transition setup for Number / RJ Imposter variants
      room.phase = 'role';
      room.theNumber = room.gameMode === 'rj' ? "Secrets" : Math.floor(Math.random() * 10) + 1;
      
      // Assign roles dynamically
      room.players.forEach((p, idx) => {
        room.roles[p.id] = idx === 0 ? 'imposter' : 'crewmate'; // Assigning first player as test imposter
      });

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  // 4. SEVEN OF CLUBS ACTION LISTENERS (FIXED: Safely listening inside socket context)
  socket.on('sevenClubsPlayCard', (data) => {
    // The incoming event parameters are securely encapsulated inside 'data' here
    if (!data) return;
    
    const cardRank = data.rank; // 'A', '2', ..., 'K'
    const cardSuit = data.suit; // 'Clubs', 'Hearts', etc.
    
    console.log(`Player ${socket.id} attempted to play: ${cardRank} of ${cardSuit}`);

    // Broadcast action update back to players safely without crashing
    io.to(data.roomCode).emit('clueActionLogged', { 
      text: `Card action registered: played ${cardRank} of ${cardSuit}` 
    });
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    console.log(`Player ${socket.id} drew a card from neighbor in room ${roomCode}`);
    io.to(roomCode).emit('clueActionLogged', { text: `An opponent card was drawn into a player hand deck.` });
  });

  // 5. IMPOSTER/CREWMATE METRIC LISTENERS
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    
    room.phase = 'answer';
    room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
    
    io.to(roomCode).emit('goToAnswerScreen', room);
    io.to(roomCode).emit('nextTurnIndex', {
      activePlayerId: room.turnOrder[0].id,
      activePlayerName: room.turnOrder[0].name
    });
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.answers[room.round]) room.answers[room.round] = {};
    room.answers[room.round][socket.id] = clueWord;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: room.players.find(p => p.id === socket.id)?.name || "Unknown",
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    // Check if everyone finished submitting clues
    const answeredCount = Object.keys(room.answers[room.round]).length;
    if (answeredCount === room.players.length) {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'askContinue') {
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      io.to(roomCode).emit('goToVoteScreen', room);
    } else if (targetPhase === 'round2') {
      room.round = 2;
      io.to(roomCode).emit('goToAnswerScreen', room);
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.voteTally[targetPlayerId] = (room.voteTally[targetPlayerId] || 0) + 1;
    
    // Simple verification check to mock results if all players voted
    const totalVotes = Object.values(room.voteTally).reduce((a, b) => a + b, 0);
    if (totalVotes >= room.players.length) {
      room.phase = 'result';
      room.gameOverReason = "All ballots cast! Assessment complete.";
      io.to(roomCode).emit('goToResultScreen', room);
    } else {
      socket.emit('voteStatusUpdated', { [socket.id]: true });
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'result';
    if (String(guessedNumber) === String(room.theNumber)) {
      room.gameOverReason = "💥 IMPOSTER VICTORY! The code was deciphered accurately!";
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "🎉 CREWMATE VICTORY! The Imposter broke cover with a flawed code guess.";
    }
    io.to(roomCode).emit('goToResultScreen', room);
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = 'lobby';
    room.round = 1;
    room.roles = {};
    room.answers = {};
    room.voteTally = {};
    room.readyPlayers = {};
    room.continueVotes = {};
    room.failedImposterGuess = null;
    io.to(roomCode).emit('roomUpdated', room);
  });

  // DISCONNECT MANAGEMENT
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    // Clean up room records if empty
    for (const code in rooms) {
      rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
      if (rooms[code].players.length === 0) {
        delete rooms[code];
      } else {
        io.to(code).emit('roomUpdated', rooms[code]);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running smoothly on port ${PORT}`);
});
