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
// If your html file is right next to server.js instead, use: app.use(express.static(__dirname));

// Game State Database (In-Memory Map structures)
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Convert card rank strings into numerical values for evaluation layout parameters
function getNumericRank(rankStr) {
  if (rankStr === 'A') return 1;
  if (rankStr === 'J') return 11;
  if (rankStr === 'Q') return 12;
  if (rankStr === 'K') return 13;
  return parseInt(rankStr, 10);
}

function assignGameRoles(room) {
  const imposterIndex = Math.floor(Math.random() * room.players.length);
  room.players.forEach((p, idx) => {
    room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
  });
}

function handleNextTurnIndex(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const currentRoundAnswers = room.answers[room.round] || {};
  const nextPlayer = room.turnOrder.find(p => currentRoundAnswers[p.id] === undefined);

  if (nextPlayer) {
    io.to(roomCode).emit('nextTurnIndex', {
      activePlayerId: nextPlayer.id,
      activePlayerName: nextPlayer.name
    });
  } else {
    io.to(roomCode).emit('showAllClues', room);
  }
}

// Custom function to safely loop card game actions while ignoring out-of-game players
function advanceSevenClubsTurn(room) {
  let attempts = 0;
  do {
    room.sevenClubsTurnIndex = (room.sevenClubsTurnIndex + 1) % room.players.length;
    attempts++;
    
    let nextPlayer = room.players[room.sevenClubsTurnIndex];
    let hand = room.playerHands[nextPlayer.id] || [];
    
    if (hand.length > 0) {
      // Valid player found with cards still remaining
      break;
    }
  } while (attempts <= room.players.length);
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
      tieBreakerActive: false,
      // Seven of Clubs State parameters
      playerHands: {},
      standingsList: [],
      sevenClubsTurnIndex: 0
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

  // 3. GAME INITIALIZATION
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    
    // Safety verification check: Allow game to spin up with 2 or more players smoothly!
    if (room.players.length < 2) {
      return socket.emit('errorMsg', 'You need at least 2 players to start a session.');
    }

    if (room.gameMode === 'card') {
      room.phase = 'sevenClubsBoard';
      room.sevenClubsTurnIndex = 0;
      room.standingsList = [];
      room.playerHands = {};
      
      // Setup dynamic board layout grid structure
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

      // Seed player hand decks
      room.players.forEach((p, idx) => {
        room.playerHands[p.id] = [
          { suit: 'Clubs', rank: '7', suitIcon: '♣', isPlayable: true },
          { suit: 'Hearts', rank: 'A', suitIcon: '♥', isPlayable: true },
          { suit: 'Diamonds', rank: 'K', suitIcon: '♦', isPlayable: true }
        ];
      });

      // Update baseline states to match
      room.players.forEach((p) => {
        const activePlayer = room.players[room.sevenClubsTurnIndex];
        const currentHand = room.playerHands[p.id] || [];
        
        io.to(p.id).emit('sevenClubsUpdateBoard', {
          activePlayerId: activePlayer.id,
          activePlayerName: activePlayer.name,
          neighborCardCount: 3, 
          gridCells: layoutGrid,
          myHand: currentHand
        });
      });
    } else {
      room.phase = 'role';
      room.theNumber = room.gameMode === 'rj' ? "SPACE STATION" : Math.floor(Math.random() * 10) + 1;
      assignGameRoles(room);

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  // 4. SEVEN OF CLUBS INTEGRATED GAME ACTIONS
  socket.on('sevenClubsPlayCard', (data) => {
    if (!data || !data.roomCode) return;
    
    const room = rooms[data.roomCode];
    if (!room) return;

    // SAFE ENCAPSULATION WRAPPER - Prevents ReferenceError crashes
    const cardRank = data.rank;
    const cardSuit = data.suit;
    const playerObj = room.players.find(p => p.id === socket.id);
    if (!playerObj) return;

    // Process and filter player hand array modifications
    let userHand = room.playerHands[socket.id] || [];
    room.playerHands[socket.id] = userHand.filter(c => !(c.rank === cardRank && c.suit === cardSuit));

    // Verify special popups for Ace or King card conditions
    let isSpecial = (cardRank === 'A' || cardRank === 'K');

    // Transmit structural card action message directly to client screens
    io.to(data.roomCode).emit('clueActionLogged', {
      text: `${playerObj.name} successfully deployed card element: [${cardRank} of ${cardSuit}]!`,
      isSpecialRank: isSpecial
    });

    // CHECK HAND SIZE SHEDDING: Check placement elimination standings
    if (room.playerHands[socket.id].length === 0) {
      if (!room.standingsList.some(s => s.id === socket.id)) {
        room.standingsList.push({ id: socket.id, name: playerObj.name });
      }
    }

    // CHECK TERMINAL MULTIPLAYER END GAME ROUND CONDITIONS
    let activePlayersRemaining = room.players.filter(p => (room.playerHands[p.id] || []).length > 0);

    if (activePlayersRemaining.length <= 1) {
      // Capture trailing player left inside the final spot matrix array map
      if (activePlayersRemaining.length === 1) {
        const lastPlayer = activePlayersRemaining[0];
        if (!room.standingsList.some(s => s.id === lastPlayer.id)) {
          room.standingsList.push({ id: lastPlayer.id, name: lastPlayer.name });
        }
      }

      room.phase = 'result';
      io.to(data.roomCode).emit('goToResultScreen', room);
    } else {
      // Loop to next eligible candidate with items to place down
      advanceSevenClubsTurn(room);
      
      // Update all tables live
      const nextActivePlayer = room.players[room.sevenClubsTurnIndex];
      room.players.forEach(p => {
        io.to(p.id).emit('sevenClubsUpdateBoard', {
          activePlayerId: nextActivePlayer.id,
          activePlayerName: nextActivePlayer.name,
          neighborCardCount: 3,
          gridCells: [], // Layout updates calculated locally via engine
          myHand: room.playerHands[p.id] || []
        });
      });
    }
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const playerObj = room.players.find(p => p.id === socket.id);
    
    io.to(roomCode).emit('clueActionLogged', {
      text: `${playerObj ? playerObj.name : 'A player'} pulled a deck item from their neighbor's target alignment.`,
      isSpecialRank: false
    });
  });

  // 5. ACTION READY SIGNALING
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  // 6. TURN CYCLING LOGIC
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

  // 7. CLUE EVALUATION SUBMISSIONS
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

    handleNextTurnIndex(roomCode);
  });

  // 8. ROUTING NEXT PHASES & CONSENSUS
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
    }
  });

  // 9. CONTINUE VOTING MECHANICS
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (Object.keys(room.continueVotes).length === room.players.length) {
      const moreVotes = Object.values(room.continueVotes).filter(v => v === 'more').length;
      if (moreVotes > room.players.length / 2) {
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

  // 10. FINAL BALLOT AND VOTE TALLY
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.voteTally[targetPlayerId] = (room.voteTally[targetPlayerId] || 0) + 1;
    io.to(roomCode).emit('voteStatusUpdated', { [socket.id]: true });

    const totalVotesCast = Object.values(room.voteTally).reduce((sum, count) => sum + count, 0);
    if (totalVotesCast === room.players.length) {
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

      if (highestVotedPlayers.length > 1) {
        room.tieBreakerActive = true;
        room.voteTally = {};
        room.gameOverReason = "⚠️ EMERGENCY BALANCING TIE! Ballot counts are deadlocked.";
        io.to(roomCode).emit('goToResultScreen', room);
      } else {
        const eliminatedId = highestVotedPlayers[0];
        const isImposterEliminated = (room.roles[eliminatedId] === 'imposter');
        room.phase = 'result';
        room.tieBreakerActive = false;

        if (isImposterEliminated) {
          room.gameOverReason = "🎉 CREWMATE VICTORY! The Imposter profile was exposed.";
        } else {
          room.gameOverReason = "💥 IMPOSTER VICTORY! Crewmates exiled an innocent profile.";
        }
        io.to(roomCode).emit('goToResultScreen', room);
      }
    }
  });

  // 11. CLANDESTINE BREAK COVER SHORTCUT
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
    room.playerHands = {};
    room.standingsList = [];
    room.sevenClubsTurnIndex = 0;

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
