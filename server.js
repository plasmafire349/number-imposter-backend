const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve public static client assets
app.use(express.static(path.join(__dirname, '../public')));

// In-memory runtime storage mapping for room game states
const rooms = {};

// Helper utilities
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function assignGameRoles(room) {
  // Select one random player index as the Imposter
  const imposterIndex = Math.floor(Math.random() * room.players.length);
  room.players.forEach((p, idx) => {
    room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
  });
}

function handleNextTurnIndex(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const currentRoundAnswers = room.answers[room.round] || {};
  // Find the first player in the randomized turnOrder who hasn't submitted a clue yet
  const nextPlayer = room.turnOrder.find(p => currentRoundAnswers[p.id] === undefined);

  if (nextPlayer) {
    io.to(roomCode).emit('nextTurnIndex', {
      activePlayerId: nextPlayer.id,
      activePlayerName: nextPlayer.name
    });
  } else {
    // Everyone has submitted a clue for this round
    io.to(roomCode).emit('showAllClues', room);
  }
}

io.on('connection', (socket) => {
  console.log(`Connected client: ${socket.id}`);

  // 1. LOBBY CREATION
  socket.on('createRoom', ({ playerName, gameMode }) => {
    const code = generateRoomCode();
    rooms[code] = {
      code: code,
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

    socket.join(code);
    socket.emit('roomUpdated', rooms[code]);
  });

  // 2. LOBBY JOINING
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];

    if (!room) return socket.emit('errorMsg', 'Room workspace not discovered.');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Game session already deployed.');

    room.players.push({ id: socket.id, name: playerName });
    socket.join(cleanedCode);
    io.to(cleanedCode).emit('roomUpdated', room);
  });

  // 3. GAME INTIALIZATION
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.gameMode === 'card') {
      room.phase = 'sevenClubsBoard';
      room.turnOrder = [...room.players]; // Maintain baseline sequence
      
      // Seed mockup table layout grid structure requested by frontend parameters
      const layoutGrid = [];
      for (let r = 1; r <= 4; r++) {
        for (let c = 1; c <= 3; c++) {
          layoutGrid.push({
            row: r,
            col: c,
            hasSuit: (r === 1 && c === 1),
            displayValue: (r === 1 && c === 1) ? "♣7" : "—"
          });
        }
      }

      // Broadcast structural initializations to table loop
      room.players.forEach((p, idx) => {
        io.to(p.id).emit('sevenClubsUpdateBoard', {
          activePlayerId: room.players[0].id,
          activePlayerName: room.players[0].name,
          neighborCardCount: 4,
          gridCells: layoutGrid,
          myHand: [
            { suit: 'Clubs', rank: '7', suitIcon: '♣', isPlayable: true },
            { suit: 'Hearts', rank: 'A', suitIcon: '♥', isPlayable: false },
            { suit: 'Diamonds', rank: 'K', suitIcon: '♦', isPlayable: true }
          ]
        });
      });
    } else {
      // Setup text words or random numbers depending on sub-variant picking logic
      room.phase = 'role';
      room.theNumber = room.gameMode === 'rj' ? "SPACE STATION" : Math.floor(Math.random() * 10) + 1;
      assignGameRoles(room);

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  // 4. ACTION READY SIGNALING
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    // If everyone is flagged ready, advance automatically to turn order layout reveal
    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  // 5. TURN CYCLING LOGIC
  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    io.to(roomCode).emit('goToAnswerScreen', room);
    handleNextTurnIndex(roomCode);
  });

  // 6. CLUE EVALUATION SUBMISSIONS
  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const roundAnswers = room.answers[room.round];
    roundAnswers[socket.id] = clueWord;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: room.players.find(p => p.id === socket.id)?.name || "Unknown",
      clueWord: clueWord,
      roundAnswers: roundAnswers
    });

    // Delegate progression turn targeting mapping calculations
    handleNextTurnIndex(roomCode);
  });

  // 7. ROUTING NEXT PHASES & CONSENSUS
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      handleNextTurnIndex(roomCode);
    } else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      io.to(roomCode).emit('goToVoteScreen', room);
    } else if (targetPhase === 'tiebreakerRound') {
      room.tieBreakerActive = true;
      room.round = (room.round || 2) + 1;
      room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      handleNextTurnIndex(roomCode);
    }
  });

  // 8. CONTINUE VOTING MECHANICS
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    // If consensus tally tracks completely
    if (Object.keys(room.continueVotes).length === room.players.length) {
      const moreVotes = Object.values(room.continueVotes).filter(v => v === 'more').length;
      if (moreVotes > room.players.length / 2) {
        // Build an extra extension round
        room.round += 1;
        room.answers[room.round] = {};
        io.to(roomCode).emit('goToAnswerScreen', room);
        handleNextTurnIndex(roomCode);
      } else {
        room.phase = 'vote';
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  // 9. FINAL BALLOT AND TIE-BREAKER LOGIC
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.voteTally[targetPlayerId] = (room.voteTally[targetPlayerId] || 0) + 1;
    io.to(roomCode).emit('voteStatusUpdated', { [socket.id]: true });

    const totalVotesCast = Object.values(room.voteTally).reduce((sum, count) => sum + count, 0);
    if (totalVotesCast === room.players.length) {
      // Find out who received the maximum votes
      const tallyEntries = Object.entries(room.voteTally);
      let maxVotes = -1;
      let highestVotedPlayers = [];

      tallyEntries.forEach(([playerId, count]) => {
        if (count > maxVotes) {
          maxVotes = count;
          highestVotedPlayers = [playerId];
        } else if (count === maxVotes) {
          highestVotedPlayers.push(playerId);
        }
      });

      // Handle Tied Ballots
      if (highestVotedPlayers.length > 1) {
        room.tieBreakerActive = true;
        room.voteTally = {}; // Wipe for next evaluation
        room.gameOverReason = "⚠️ EMERGENCY BALANCING TIE! Ballot counts are perfectly deadlocked.";
        io.to(roomCode).emit('goToResultScreen', room);
      } else {
        // Single highest voted profile found
        const eliminatedId = highestVotedPlayers[0];
        const isImposterEliminated = (room.roles[eliminatedId] === 'imposter');
        room.phase = 'result';
        room.tieBreakerActive = false;

        if (isImposterEliminated) {
          room.gameOverReason = "🎉 CREWMATE VICTORY! The Imposter profile was exposed and eliminated via vote consensus.";
        } else {
          room.gameOverReason = "💥 IMPOSTER VICTORY! Crewmates exiled an innocent profile, breaking protocol metrics.";
        }
        io.to(roomCode).emit('goToResultScreen', room);
      }
    }
  });

  // 10. CLANDESTINE BREAK COVER SHORTCUT
  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'result';
    room.tieBreakerActive = false;
    const isCorrect = String(guessedNumber).trim().toUpperCase() === String(room.theNumber).trim().toUpperCase();

    if (isCorrect) {
      room.gameOverReason = "💥 IMPOSTER VICTORY! The hidden objective parameter was accurately compromised!";
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "🎉 CREWMATE VICTORY! The Imposter broke coverage parameters with an incorrect guess.";
    }
    io.to(roomCode).emit('goToResultScreen', room);
  });

  // 11. SEVEN OF CLUBS GAME ACTIONS
  socket.on('sevenClubsPlayCard', (data) => {
    if (!data || !data.roomCode) return;
    
    // **SAFE CONTEXT SCOPE FIX**: ReferenceError prevented securely!
    const cardRank = data.rank;
    const cardSuit = data.suit;

    console.log(`Action Log: Card Played -> ${cardRank} of ${cardSuit}`);
    
    // Send message directly to frontend feed without alert screens breaking immersion
    io.to(data.roomCode).emit('clueActionLogged', {
      text: `Card action registered: played the ${cardRank} of ${cardSuit}.`
    });
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    if (!roomCode) return;
    io.to(roomCode).emit('clueActionLogged', {
      text: "Card adjustment metric processed: drew from neighbor deck hand."
    });
  });

  // 12. RESET CYCLE FOR NEW MATCH
  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = 'lobby';
    room.round = 1;
    room.roles = {};
    room.theNumber = null;
    room.turnOrder = [];
    room.answers = {};
    room.voteTally = {};
    room.readyPlayers = {};
    room.continueVotes = {};
    room.failedImposterGuess = null;
    room.tieBreakerActive = false;

    io.to(roomCode).emit('roomUpdated', room);
  });

  // 13. STATE CLEANUP UPON DISCONNECTION
  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
    for (const code in rooms) {
      rooms[code].players = rooms[code].players.filter(p => p.id !== socket.id);
      if (rooms[code].players.length === 0) {
        delete rooms[code];
      } else {
        // If the host drops, assign a new host from remaining players
        if (rooms[code].hostId === socket.id) {
          rooms[code].hostId = rooms[code].players[0].id;
        }
        io.to(code).emit('roomUpdated', rooms[code]);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Deploy Matrix confirmed active on port: ${PORT}`);
});
