const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static elements or files from the public root if needed
app.use(express.static(path.join(__dirname)));

// Route root traffic directly to your HTML game board layout
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'number-imposter.html'));
});

// In-Memory Database Structure to manage active game sessions
const rooms = {};

/**
 * Helper to generate a unique 4-character uppercase room identifier string
 */
function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous lookalikes
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
  } while (rooms[code]);
  return code;
}

/**
 * Standard Setup for 7 of Clubs Layout Matrix Table (3 Columns x 4 Rows)
 */
function initializeSevenClubsGrid() {
  const grid = [];
  let index = 1;
  for (let row = 1; row <= 4; row++) {
    for (let col = 1; col <= 3; col++) {
      grid.push({
        id: index++,
        row: row,
        col: col,
        hasSuit: false,
        displayValue: '—'
      });
    }
  }
  return grid;
}

io.on('connection', (socket) => {

  // CREATE ROOM LOBBY
  socket.on('createRoom', ({ playerName, gameMode }) => {
    if (!playerName) {
      return socket.emit('errorMsg', 'Identity parameters are mandatory.');
    }
    
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      gameMode: gameMode || 'number',
      phase: 'lobby',
      players: [{ id: socket.id, name: playerName.trim() }],
      roles: {},
      theNumber: null,
      round: 1,
      turnOrder: [],
      currentTurnIndex: 0,
      readyPlayers: {},
      answers: {}, // Format: { [roundNumber]: { [playerId]: clueWord } }
      continueVotes: {},
      votes: {},
      voteTally: {},
      failedImposterGuess: null,
      tieBreakerActive: false,
      
      // Seven of clubs state attributes
      sevenClubsDeck: [],
      sevenClubsGrid: [],
      sevenClubsActivePlayerIdx: 0
    };

    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', rooms[roomCode]);
  });

  // JOIN EXISTING ROOM LOBBY
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const cleanedCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanedCode];

    if (!room) {
      return socket.emit('errorMsg', 'Target session room code profile not found.');
    }
    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', 'Action denied: Match is already processing active iterations.');
    }
    if (!playerName || !playerName.trim()) {
      return socket.emit('errorMsg', 'Name profile string invalid.');
    }

    room.players.push({ id: socket.id, name: playerName.trim() });
    socket.join(cleanedCode);
    io.to(cleanedCode).emit('roomUpdated', room);
  });

  // START MATCH INSTANCE
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) {
      return socket.emit('errorMsg', 'A workspace simulation requires a minimum lineup configuration of 3 metrics.');
    }

    room.failedImposterGuess = null;
    room.tieBreakerActive = false;
    room.round = 1;
    room.answers = {};
    room.continueVotes = {};
    room.votes = {};

    // Diverge setup routing flow if the mode matches Seven of Clubs variant
    if (room.gameMode === 'card') {
      room.phase = 'sevenClubsBoard';
      room.sevenClubsGrid = initializeSevenClubsGrid();
      
      // Build a miniature deck variant for runtime simulation balance
      const suits = [
        { name: 'Clubs', icon: '♣' },
        { name: 'Spades', icon: '♠' },
        { name: 'Hearts', icon: '♥' },
        { name: 'Diamonds', icon: '♦' }
      ];
      const ranks = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
      let fullDeck = [];
      suits.forEach(s => {
        ranks.forEach(r => {
          fullDeck.push({ suit: s.name, suitIcon: s.icon, rank: r });
        });
      });

      // Fisher-Yates card array randomizer mechanics
      for (let i = fullDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fullDeck[i], fullDeck[j]] = [fullDeck[j], fullDeck[i]];
      }

      // Deal operational card slices down to current connected sockets
      const handSize = Math.floor(fullDeck.length / room.players.length);
      room.players.forEach((p, idx) => {
        p.hand = fullDeck.slice(idx * handSize, (idx + 1) * handSize);
      });

      room.sevenClubsActivePlayerIdx = Math.floor(Math.random() * room.players.length);
      sendSevenClubsStateUpdate(room);
    } else {
      // Standard configuration routing for Imposter Number deduction
      room.phase = 'role';
      room.readyPlayers = {};
      
      // Determine hidden numeric objectives or keywords depending on selection
      if (room.gameMode === 'rj') {
        const structuralKeywords = ["SYNAPSE", "QUANTUM", "COMPILER", "MAINFRAME", "VECTOR", "DATABASE", "FIREWALL", "ROUTER"];
        room.theNumber = structuralKeywords[Math.floor(Math.random() * structuralKeywords.length)];
      } else {
        room.theNumber = Math.floor(Math.random() * 10) + 1; // Number 1-10
      }

      // Roll randomized structural arrays to designate the Imposter
      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.roles = {};
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
      });

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  // PLAYER READINESS RECEPTION
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    // Transition when all records return matching evaluations
    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      
      // Shuffle active sequence paths for turn clue distribution mechanics
      room.turnOrder = [...room.players];
      for (let i = room.turnOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.turnOrder[i], room.turnOrder[j]] = [room.turnOrder[j], room.turnOrder[i]];
      }
      room.currentTurnIndex = 0;
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  // START ANSWER PHASE INTERFACE
  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    if (!room.answers[room.round]) room.answers[room.round] = {};

    io.to(roomCode).emit('goToAnswerScreen', room);
    
    // Broadcast active target instructions down to first processing turn index
    const activeUser = room.turnOrder[room.currentTurnIndex];
    io.to(roomCode).emit('nextTurnIndex', {
      activePlayerId: activeUser.id,
      activePlayerName: activeUser.name
    });
  });

  // SUBMIT TRANSMITTED CLUE
  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const currentActiveExpectedPlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentActiveExpectedPlayer.id) return; // Prevent out-of-order data submission

    const sanitizedClue = clueWord ? clueWord.trim() : "PASS";
    room.answers[room.round][socket.id] = sanitizedClue;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: currentActiveExpectedPlayer.name,
      clueWord: sanitizedClue,
      roundAnswers: room.answers[room.round]
    });

    // Advance iteration indexes down the remaining lineup checklist
    room.currentTurnIndex++;
    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', {
        activePlayerId: nextUser.id,
        activePlayerName: nextUser.name
      });
    } else {
      // Loop execution completed safely for all indices
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  // PHASE PROGRESSION ROUTER CONTROL
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.currentTurnIndex = 0;
      room.phase = 'answer';
      room.answers[room.round] = {};
      
      io.to(roomCode).emit('goToAnswerScreen', room);
      const activeUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', {
        activePlayerId: activeUser.id,
        activePlayerName: activeUser.name
      });
    } else if (targetPhase === 'askContinue') {
      room.phase = 'continueVote';
      room.continueVotes = {};
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      room.votes = {};
      io.to(roomCode).emit('goToVoteScreen', room);
    } else if (targetPhase === 'tiebreakerRound') {
      room.phase = 'answer';
      room.currentTurnIndex = 0;
      if (!room.answers[room.round]) room.answers[room.round] = {};
      
      io.to(roomCode).emit('goToAnswerScreen', room);
      const activeUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', {
        activePlayerId: activeUser.id,
        activePlayerName: activeUser.name
      });
    }
  });

  // PROCESS EXTENSION OPTIONS CONSENSUS CHOICE
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice; // Either 'more' or 'vote'
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (Object.keys(room.continueVotes).length === room.players.length) {
      let tallyMore = 0;
      let tallyVote = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') tallyMore++;
        else tallyVote++;
      });

      // If consensus calls for extra content additions, spin extra round layers
      if (tallyMore > tallyVote) {
        room.round++;
        room.currentTurnIndex = 0;
        room.phase = 'answer';
        room.answers[room.round] = {};
        
        io.to(roomCode).emit('goToAnswerScreen', room);
        const activeUser = room.turnOrder[room.currentTurnIndex];
        io.to(roomCode).emit('nextTurnIndex', {
          activePlayerId: activeUser.id,
          activePlayerName: activeUser.name
        });
      } else {
        // Direct conversion to structural vote screening forms
        room.phase = 'vote';
        room.votes = {};
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  // BALLOT CAST TRACKING 
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    if (Object.keys(room.votes).length === room.players.length) {
      evaluateBallotResolutions(roomCode);
    }
  });

  // EARLY PROFILE EXPOSURE / CLANDESTINE INTERACTION
  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roles[socket.id] !== 'imposter') return; // Enforce authorization layers

    const targetGuessNormalized = guessedNumber ? guessedNumber.toString().trim().toUpperCase() : '';
    const actualSolutionNormalized = room.theNumber ? room.theNumber.toString().trim().toUpperCase() : '';

    if (targetGuessNormalized === actualSolutionNormalized) {
      room.gameOverReason = `Victory declared! The Imposter successfully deciphered the hidden transmission value: [${room.theNumber}].`;
      room.tieBreakerActive = false;
      room.phase = 'result';
      io.to(roomCode).emit('goToResultScreen', room);
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "Defeat recorded. The Imposter attempted an early cryptographic break action but supplied an invalid match configuration value.";
      room.tieBreakerActive = false;
      room.phase = 'result';
      io.to(roomCode).emit('goToResultScreen', room);
    }
  });

  // ♣️ SEVEN OF CLUBS SPECIFIC STRATEGIC ACTION TRIGGERS
  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    // Remove the selected card from the player's hand
    const cardIndex = activePlayer.hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIndex === -1) return;
    const cardPlayed = activePlayer.hand.splice(cardIndex, 1)[0];

    // Place the card onto the matrix board grid layout table
    const emptyCell = room.sevenClubsGrid.find(cell => !cell.hasSuit);
    if (emptyCell) {
      emptyCell.hasSuit = true;
      emptyCell.displayValue = `${cardPlayed.rank}${cardPlayed.suitIcon}`;
    }

    // Trigger an immediate global overlay update notice across all active client views
    io.to(roomCode).emit('sevenClubsCardAlertPopup', {
      player: activePlayer.name,
      card: `${cardPlayed.rank} of ${cardPlayed.suit}`
    });

    // Handle game-over logic when a player runs out of cards
    if (activePlayer.hand.length === 0) {
      room.gameOverReason = `Strategic matrix terminal depth cleared! "${activePlayer.name}" successfully emptied their resource collection first and wins the match!`;
      room.phase = 'result';
      room.roles = {}; // Clear role parameters to prevent dashboard formatting errors
      io.to(roomCode).emit('goToResultScreen', room);
      return;
    }

    // Pass turn control cleanly down to the next adjacent index seat
    room.sevenClubsActivePlayerIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    sendSevenClubsStateUpdate(room);
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    // Identify the adjacent seat index position (acting as left deck workspace target)
    const leftNeighborIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    const neighborPlayer = room.players[leftNeighborIdx];

    if (neighborPlayer && neighborPlayer.hand && neighborPlayer.hand.length > 0) {
      // Pick a random card slice out of the opponent's inventory stack
      const targetRandomSliceIdx = Math.floor(Math.random() * neighborPlayer.hand.length);
      const drawnCard = neighborPlayer.hand.splice(targetRandomSliceIdx, 1)[0];
      
      activePlayer.hand.push(drawnCard);
    }

    // Turn cycles forward automatically upon picking cards
    room.sevenClubsActivePlayerIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    sendSevenClubsStateUpdate(room);
  });

  // RESET LOOPS TO REPLAY
  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.roles = {};
    room.theNumber = null;
    room.turnOrder = [];
    room.answers = {};
    room.votes = {};
    room.voteTally = {};
    room.failedImposterGuess = null;
    room.tieBreakerActive = false;

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    // Locate and purge disconnected client links from active operational rooms
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
        if (room.players.length === 0) {
          delete rooms[code];
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id; // Reassign administrative privileges
          }
          io.to(code).emit('roomUpdated', room);
        }
      }
    });
  });
});

/**
 * Custom logic block built to evaluate ballot tallies, calculate distribution levels, 
 * and manage tiebreaker exceptions.
 */
function evaluateBallotResolutions(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const tally = {};
  room.players.forEach(p => tally[p.id] = 0);

  Object.values(room.votes).forEach(targetId => {
    if (tally[targetId] !== undefined) tally[targetId]++;
  });

  room.voteTally = tally;

  let maxVotes = -1;
  let highestVotedPlayers = [];
  Object.keys(tally).forEach(pId => {
    if (tally[pId] > maxVotes) {
      maxVotes = tally[pId];
      highestVotedPlayers = [pId];
    } else if (tally[pId] === maxVotes) {
      highestVotedPlayers.push(pId);
    }
  });

  // Check if multiple targets received matching high tallies
  if (highestVotedPlayers.length > 1) {
    room.tieBreakerActive = true;
    room.round++;
    room.phase = 'result'; // Route to interstitial screen where host triggers the tiebreaker round
    room.gameOverReason = "Emergency tied configuration matched! Consensus split perfectly across multiple indices.";
    io.to(roomCode).emit('goToResultScreen', room);
  } else {
    // Single highest voted profile found clearly
    const designatedTargetId = highestVotedPlayers[0];
    const isImposterActual = room.roles[designatedTargetId] === 'imposter';

    room.tieBreakerActive = false;
    room.phase = 'result';

    if (isImposterActual) {
      const winnerProfile = room.players.find(p => p.id === designatedTargetId);
      room.gameOverReason = `Victory declared! The Crewmates successfully tracked and eliminated the Imposter profile: [${winnerProfile ? winnerProfile.name : 'Unknown'}].`;
    } else {
      room.gameOverReason = "Defeat recorded. The Crewmate team exiled an innocent operational asset, allowing the Imposter to seize control.";
    }
    io.to(roomCode).emit('goToResultScreen', room);
  }
}

/**
 * Compiles specific individual visibility profiles for Seven of Clubs cards 
 * depending on which client socket is receiving the broadcast state.
 */
function sendSevenClubsStateUpdate(room) {
  const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
  const nextSeatIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
  const leftNeighbor = room.players[nextSeatIdx];

  room.players.forEach(p => {
    // Mark cards as playable or dimmed based on whether it's their turn
    const personalizedHand = p.hand.map(card => {
      return {
        ...card,
        isPlayable: (p.id === activePlayer.id)
      };
    });

    io.to(p.id).emit('sevenClubsUpdateBoard', {
      activePlayerId: activePlayer.id,
      activePlayerName: activePlayer.name,
      gridCells: room.sevenClubsGrid,
      myHand: personalizedHand,
      neighborCardCount: leftNeighbor ? leftNeighbor.hand.length : 0
    });
  });
}

// Bind process to runtime operational port parameters
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Game Engine Running on: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
