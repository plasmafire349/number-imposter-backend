const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// FIXED: Routing directly to your correct HTML file name
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'number-imposter.html'));
});

// Master state tracking object for active rooms
const rooms = {};

const SUITS = [
  { name: 'Clubs', icon: '♣' },
  { name: 'Spades', icon: '♠' },
  { name: 'Hearts', icon: '♥' },
  { name: 'Diamonds', icon: '♦' }
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function createShuffledDeck() {
  const deck = [];
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      deck.push({ suit: suit.name, suitIcon: suit.icon, rank });
    });
  });
  // Fisher-Yates Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Matrix path arithmetic for Seven of Clubs
function isCardPlayable(card, boardState) {
  const suitState = boardState[card.suit];
  
  if (card.rank === '7') return true;
  if (!suitState.hasSeven) return false;
  
  const rankIdx = RANKS.indexOf(card.rank);
  
  // Downward path towards Ace
  if (rankIdx < 6) {
    return rankIdx === suitState.lowestPlaced - 1;
  }
  // Upward path towards King
  if (rankIdx > 6) {
    return rankIdx === suitState.highestPlaced + 1;
  }
  return false;
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ playerName, gameMode }) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      gameMode: gameMode || 'number',
      phase: 'lobby',
      players: [{ id: socket.id, name: playerName }],
      round: 1,
      roles: {},
      theNumber: null,
      turnOrder: [],
      activeIndex: 0,
      answers: {},
      continueVotes: {},
      votes: {},
      readyPlayers: {},
      failedImposterGuess: null,
      gameOverReason: '',
      sevenState: null
    };

    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMsg', 'Room workspace not found.');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('errorMsg', 'Game session already in progress.');
      return;
    }

    room.players.push({ id: socket.id, name: playerName });
    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.gameMode === 'card') {
      const deck = createShuffledDeck();
      const playerCount = room.players.length;
      const hands = {};
      
      room.players.forEach(p => { hands[p.id] = []; });
      deck.forEach((card, idx) => {
        const playerObj = room.players[idx % playerCount];
        hands[playerObj.id].push(card);
      });

      room.sevenState = {
        hands: hands,
        winners: [], 
        activeIndex: 0,
        board: {
          Clubs: { hasSeven: false, lowestPlaced: 6, highestPlaced: 6 },
          Spades: { hasSeven: false, lowestPlaced: 6, highestPlaced: 6 },
          Hearts: { hasSeven: false, lowestPlaced: 6, highestPlaced: 6 },
          Diamonds: { hasSeven: false, lowestPlaced: 6, highestPlaced: 6 }
        }
      };

      let starterFoundIdx = 0;
      room.players.forEach((p, pIdx) => {
        const hasSevenClubs = hands[p.id].some(c => c.suit === 'Clubs' && c.rank === '7');
        if (hasSevenClubs) starterFoundIdx = pIdx;
      });
      room.sevenState.activeIndex = starterFoundIdx;
      room.phase = 'sevenClubsBoard';
      
      syncSevenClubsState(room);
    } else {
      room.round = 1;
      room.answers = {};
      room.continueVotes = {};
      room.votes = {};
      room.readyPlayers = {};
      room.failedImposterGuess = null;
      room.gameOverReason = '';

      if (room.gameMode === 'rj') {
        room.theNumber = "SPECTRUM"; 
      } else {
        room.theNumber = Math.floor(Math.random() * 10) + 1;
      }
      
      const imposterIdx = Math.floor(Math.random() * room.players.length);
      room.roles = {};
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIdx) ? 'imposter' : 'crewmate';
      });

      room.phase = 'role';
      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    const allReady = room.players.every(p => room.readyPlayers[p.id]);
    if (allReady) {
      room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
      room.phase = 'turnReveal';
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    room.activeIndex = 0;
    room.answers[room.round] = {};

    io.to(roomCode).emit('goToAnswerScreen', room);
    sendNextActiveClueTurn(room);
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.turnOrder[room.activeIndex];
    if (!activePlayer || activePlayer.id !== socket.id) return;

    room.answers[room.round][socket.id] = clueWord;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: activePlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.activeIndex++;
    if (room.activeIndex < room.turnOrder.length) {
      sendNextActiveClueTurn(room);
    } else {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.phase = 'answer';
      room.activeIndex = 0;
      room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      sendNextActiveClueTurn(room);
    } else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      room.phase = 'continueVote';
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.votes = {};
      room.phase = 'vote';
      io.to(roomCode).emit('goToVoteScreen', room);
    } else if (targetPhase === 'tiebreakerRound') {
      room.round++;
      room.phase = 'answer';
      room.activeIndex = 0;
      room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      sendNextActiveClueTurn(room);
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (room.players.every(p => room.continueVotes[p.id])) {
      const moreVotes = Object.values(room.continueVotes).filter(v => v === 'more').length;
      if (moreVotes > room.players.length / 2) {
        room.round++;
        room.phase = 'answer';
        room.activeIndex = 0;
        room.answers[room.round] = {};
        io.to(roomCode).emit('goToAnswerScreen', room);
        sendNextActiveClueTurn(room);
      } else {
        room.votes = {};
        room.phase = 'vote';
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    if (room.players.every(p => room.votes[p.id])) {
      processImposterVoteResolution(room);
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room || room.roles[socket.id] !== 'imposter') return;

    if (String(guessedNumber).toUpperCase() === String(room.theNumber).toUpperCase()) {
      room.gameOverReason = "💥 Imposter guessed the Target Code accurately! Imposter Victory! 💥";
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "🎉 Incorrect structural guess! Crewmate Victory! 🎉";
    }
    room.phase = 'result';
    io.to(roomCode).emit('goToResultScreen', room);
  });

  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room || !room.sevenState) return;

    const stateObj = room.sevenState;
    const activePlayer = room.players[stateObj.activeIndex];
    if (!activePlayer || activePlayer.id !== socket.id) return;

    const hand = stateObj.hands[socket.id] || [];
    const cardIdx = hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIdx === -1) return;

    const targetCard = hand[cardIdx];
    if (!isCardPlayable(targetCard, stateObj.board)) return;

    hand.splice(cardIdx, 1);

    const rankIdx = RANKS.indexOf(rank);
    if (rank === '7') {
      stateObj.board[suit].hasSeven = true;
    } else if (rankIdx < 6) {
      stateObj.board[suit].lowestPlaced = rankIdx;
    } else if (rankIdx > 6) {
      stateObj.board[suit].highestPlaced = rankIdx;
    }

    // --- POPUP ANNOUNCEMENT TRIGGER FOR KING OR ACE ---
    if (rank === 'K' || rank === 'A') {
      io.to(roomCode).emit('sevenClubsCardAlertPopup', {
        player: activePlayer.name,
        card: `${rank === 'K' ? '👑 King' : '🌟 Ace'} of ${suit}`
      });
    }

    proceedNextSevenClubsTurn(room);
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || !room.sevenState) return;

    const stateObj = room.sevenState;
    if (room.players[stateObj.activeIndex].id !== socket.id) return;

    let leftNeighborIdx = (stateObj.activeIndex - 1 + room.players.length) % room.players.length;
    while (leftNeighborIdx !== stateObj.activeIndex && (stateObj.hands[room.players[leftNeighborIdx].id] || []).length === 0) {
      leftNeighborIdx = (leftNeighborIdx - 1 + room.players.length) % room.players.length;
    }

    if (leftNeighborIdx === stateObj.activeIndex) return; 

    const sourceHand = stateObj.hands[room.players[leftNeighborIdx].id] || [];
    if (sourceHand.length === 0) return;

    const randomIdx = Math.floor(Math.random() * sourceHand.length);
    const stolenCard = sourceHand.splice(randomIdx, 1)[0];

    stateObj.hands[socket.id].push(stolenCard);

    proceedNextSevenClubsTurn(room);
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
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

function sendNextActiveClueTurn(room) {
  const activePlayer = room.turnOrder[room.activeIndex];
  io.to(room.code).emit('nextTurnIndex', {
    activePlayerId: activePlayer.id,
    activePlayerName: activePlayer.name
  });
}

function processImposterVoteResolution(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = 0; });
  Object.values(room.votes).forEach(targetId => {
    if (tally[targetId] !== undefined) tally[targetId]++;
  });

  room.voteTally = tally;

  const maxVotes = Math.max(...Object.values(tally));
  const tiedPlayers = Object.keys(tally).filter(pId => tally[pId] === maxVotes);

  if (tiedPlayers.length > 1) {
    room.tieBreakerActive = true;
    room.gameOverReason = "⚖️ Tied matrix outcome detected! Entering emergency tie-breaker loop.";
    room.phase = 'result';
    io.to(room.code).emit('goToResultScreen', room);
    return;
  }

  const votedOutId = tiedPlayers[0];
  const isImposter = room.roles[votedOutId] === 'imposter';
  room.tieBreakerActive = false;

  if (isImposter) {
    room.gameOverReason = "🎉 Crewmates successfully isolated and captured the Imposter! Crewmate Victory! 🎉";
  } else {
    room.gameOverReason = "💥 Mistaken Profile Isolation! The Imposter slipped through security parameters. Imposter Victory! 💥";
  }

  room.phase = 'result';
  io.to(room.code).emit('goToResultScreen', room);
}

function proceedNextSevenClubsTurn(room) {
  const stateObj = room.sevenState;

  room.players.forEach(p => {
    if ((stateObj.hands[p.id] || []).length === 0 && !stateObj.winners.includes(p.name)) {
      stateObj.winners.push(p.name);
    }
  });

  const remainingPlayers = room.players.filter(p => (stateObj.hands[p.id] || []).length > 0);

  if (remainingPlayers.length <= 1) {
    if (remainingPlayers.length === 1) {
      stateObj.winners.push(remainingPlayers[0].name);
    }
    room.phase = 'result';
    io.to(room.code).emit('goToResultScreen', room);
    return;
  }

  let index = stateObj.activeIndex;
  do {
    index = (index + 1) % room.players.length;
  } while ((stateObj.hands[room.players[index].id] || []).length === 0);

  stateObj.activeIndex = index;
  syncSevenClubsState(room);
}

function syncSevenClubsState(room) {
  const stateObj = room.sevenState;
  const currentActivePlayer = room.players[stateObj.activeIndex];

  let leftNeighborIdx = (stateObj.activeIndex - 1 + room.players.length) % room.players.length;
  while (leftNeighborIdx !== stateObj.activeIndex && (stateObj.hands[room.players[leftNeighborIdx].id] || []).length === 0) {
    leftNeighborIdx = (leftNeighborIdx - 1 + room.players.length) % room.players.length;
  }
  const neighborId = room.players[leftNeighborIdx].id;
  const count = (stateObj.hands[neighborId] || []).length;

  const suitsOrder = ['Clubs', 'Spades', 'Hearts', 'Diamonds'];
  const gridCells = [];

  suitsOrder.forEach((suitName, rowIdx) => {
    const sState = stateObj.board[suitName];
    gridCells.push({
      row: rowIdx + 1,
      col: 1,
      hasSuit: sState.hasSeven,
      displayValue: sState.hasSeven && sState.lowestPlaced < 6 ? RANKS[sState.lowestPlaced] : '—'
    });
    gridCells.push({
      row: rowIdx + 1,
      col: 2,
      hasSuit: sState.hasSeven,
      displayValue: sState.hasSeven ? '7' : '—'
    });
    gridCells.push({
      row: rowIdx + 1,
      col: 3,
      hasSuit: sState.hasSeven,
      displayValue: sState.hasSeven && sState.highestPlaced > 6 ? RANKS[sState.highestPlaced] : '—'
    });
  });

  room.players.forEach(p => {
    const pHand = stateObj.hands[p.id] || [];
    const optimizedHand = pHand.map(card => ({
      ...card,
      isPlayable: p.id === currentActivePlayer.id && isCardPlayable(card, stateObj.board)
    }));

    io.to(p.id).emit('sevenClubsUpdateBoard', {
      activePlayerId: currentActivePlayer.id,
      activePlayerName: currentActivePlayer.name,
      gridCells: gridCells,
      myHand: optimizedHand,
      neighborCardCount: count
    });
  });
}

server.listen(PORT, () => {
  console.log(`Server executing live parameters on port: ${PORT}`);
});
