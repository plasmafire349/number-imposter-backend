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

app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'number-imposter.html'));
});

const rooms = {};

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
  } while (rooms[code]);
  return code;
}

// Convert game card ranks to values for mathematical sequencing check
const RANK_VALUES = { '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };

/**
 * Reverts back to your original 4 Rows x 3 Columns grid profile mapping structure.
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
        displayValue: '—',
        suitName: null,
        rank: null
      });
    }
  }
  return grid;
}

io.on('connection', (socket) => {

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
      answers: {},
      continueVotes: {},
      votes: {},
      voteTally: {},
      failedImposterGuess: null,
      tieBreakerActive: false,
      
      sevenClubsDeck: [],
      sevenClubsGrid: [],
      sevenClubsActivePlayerIdx: 0
    };

    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', rooms[roomCode]);
  });

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

    if (room.gameMode === 'card') {
      room.phase = 'sevenClubsBoard';
      room.sevenClubsGrid = initializeSevenClubsGrid();
      
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

      for (let i = fullDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fullDeck[i], fullDeck[j]] = [fullDeck[j], fullDeck[i]];
      }

      const handSize = Math.floor(fullDeck.length / room.players.length);
      room.players.forEach((p, idx) => {
        p.hand = fullDeck.slice(idx * handSize, (idx + 1) * handSize);
      });

      room.sevenClubsActivePlayerIdx = Math.floor(Math.random() * room.players.length);
      sendSevenClubsStateUpdate(room);
    } else {
      room.phase = 'role';
      room.readyPlayers = {};
      
      if (room.gameMode === 'rj') {
        const structuralKeywords = ["SYNAPSE", "QUANTUM", "COMPILER", "MAINFRAME", "VECTOR", "DATABASE", "FIREWALL", "ROUTER"];
        room.theNumber = structuralKeywords[Math.floor(Math.random() * structuralKeywords.length)];
      } else {
        room.theNumber = Math.floor(Math.random() * 10) + 1;
      }

      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.roles = {};
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
      });

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      room.turnOrder = [...room.players];
      for (let i = room.turnOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.turnOrder[i], room.turnOrder[j]] = [room.turnOrder[j], room.turnOrder[i]];
      }
      room.currentTurnIndex = 0;
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    if (!room.answers[room.round]) room.answers[room.round] = {};

    io.to(roomCode).emit('goToAnswerScreen', room);
    
    const activeUser = room.turnOrder[room.currentTurnIndex];
    io.to(roomCode).emit('nextTurnIndex', {
      activePlayerId: activeUser.id,
      activePlayerName: activeUser.name
    });
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const currentActiveExpectedPlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentActiveExpectedPlayer.id) return;

    const sanitizedClue = clueWord ? clueWord.trim() : "PASS";
    room.answers[room.round][socket.id] = sanitizedClue;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: currentActiveExpectedPlayer.name,
      clueWord: sanitizedClue,
      roundAnswers: room.answers[room.round]
    });

    room.currentTurnIndex++;
    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', {
        activePlayerId: nextUser.id,
        activePlayerName: nextUser.name
      });
    } else {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

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

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (Object.keys(room.continueVotes).length === room.players.length) {
      let tallyMore = 0;
      let tallyVote = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') tallyMore++;
        else tallyVote++;
      });

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
        room.phase = 'vote';
        room.votes = {};
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    if (Object.keys(room.votes).length === room.players.length) {
      evaluateBallotResolutions(roomCode);
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roles[socket.id] !== 'imposter') return;

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

  // CARD PLACEMENT ENGINE FOR 3x4 GRID
  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    const cardIndex = activePlayer.hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIndex === -1) return;
    const cardPlayed = activePlayer.hand[cardIndex];

    let isValidPlay = false;

    if (cardPlayed.rank === '7') {
      // 7s can always be placed to open up a suit path on the board
      isValidPlay = true;
    } else {
      // Must check if the exact direct numeric predecessor card of this suit is already on the board grid
      const targetValue = RANK_VALUES[cardPlayed.rank];
      isValidPlay = room.sevenClubsGrid.some(cell => 
        cell.suitName === cardPlayed.suit && 
        cell.hasSuit && 
        RANK_VALUES[cell.rank] === (targetValue - 1)
      );
    }

    if (!isValidPlay) {
      return socket.emit('errorMsg', `Validation Error: You can't lay down the ${rank} of ${suit} yet. Adjacency sequences must build upwards consecutively from 7.`);
    }

    // Valid play, pull from active player hand
    activePlayer.hand.splice(cardIndex, 1);

    // Look for an exact grid spot already housing this card OR find the next empty grid space to display it
    let targetCell = room.sevenClubsGrid.find(cell => cell.suitName === cardPlayed.suit && cell.rank === cardPlayed.rank);
    if (!targetCell) {
      targetCell = room.sevenClubsGrid.find(cell => !cell.hasSuit);
    }

    if (targetCell) {
      targetCell.hasSuit = true;
      targetCell.suitName = cardPlayed.suit;
      targetCell.rank = cardPlayed.rank;
      targetCell.displayValue = `${cardPlayed.rank}${cardPlayed.suitIcon}`;
    }

    io.to(roomCode).emit('clueActionLogged', {
      text: `${activePlayer.name} laid down the ${cardPlayed.rank}${cardPlayed.suitIcon}.`
    });

    if (activePlayer.hand.length === 0) {
      room.gameOverReason = `Strategic matrix terminal depth cleared! "${activePlayer.name}" successfully emptied their hand and wins the match!`;
      room.phase = 'result';
      room.roles = {};
      io.to(roomCode).emit('goToResultScreen', room);
      return;
    }

    room.sevenClubsActivePlayerIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    sendSevenClubsStateUpdate(room);
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    const leftNeighborIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    const neighborPlayer = room.players[leftNeighborIdx];

    if (neighborPlayer && neighborPlayer.hand && neighborPlayer.hand.length > 0) {
      const targetRandomSliceIdx = Math.floor(Math.random() * neighborPlayer.hand.length);
      const drawnCard = neighborPlayer.hand.splice(targetRandomSliceIdx, 1)[0];
      activePlayer.hand.push(drawnCard);

      io.to(roomCode).emit('clueActionLogged', {
        text: `${activePlayer.name} drew a card out of ${neighborPlayer.name}'s side hand.`
      });
    }

    room.sevenClubsActivePlayerIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
    sendSevenClubsStateUpdate(room);
  });

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
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
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

  if (highestVotedPlayers.length > 1) {
    room.tieBreakerActive = true;
    room.round++;
    room.phase = 'result';
    room.gameOverReason = "Emergency tied configuration matched! Consensus split perfectly across multiple indices.";
    io.to(roomCode).emit('goToResultScreen', room);
  } else {
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

function sendSevenClubsStateUpdate(room) {
  const activePlayer = room.players[room.sevenClubsActivePlayerIdx];
  const nextSeatIdx = (room.sevenClubsActivePlayerIdx + 1) % room.players.length;
  const leftNeighbor = room.players[nextSeatIdx];

  room.players.forEach(p => {
    const personalizedHand = p.hand.map(card => {
      let validRuleMatch = false;
      
      if (card.rank === '7') {
        validRuleMatch = true;
      } else {
        const valueNum = RANK_VALUES[card.rank];
        // Ensure the exact numerical neighbor card (rank - 1) of the same suit is present on the board
        validRuleMatch = room.sevenClubsGrid.some(cell => 
          cell.suitName === card.suit && cell.hasSuit && RANK_VALUES[cell.rank] === (valueNum - 1)
        );
      }

      return {
        ...card,
        isPlayable: (p.id === activePlayer.id) && validRuleMatch
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Game Engine Running on: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
