const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Core State Manager
const rooms = {};

const SUITS = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
const SUIT_ICONS = { Clubs: '♣', Diamonds: '♦', Hearts: '♥', Spades: '♠' };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

// Utility function to generate unique codes
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Full Deck Generation Utility
function createStandardDeck() {
  const deck = [];
  SUITS.forEach(suit => {
    RANKS.forEach(rank => {
      deck.push({ suit, rank, val: RANK_VALUES[rank], suitIcon: SUIT_ICONS[suit] });
    });
  });
  return deck;
}

// Shuffling Utility
function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Helper to determine legitimate plays in Seven of Clubs
function isValidMove(card, boardState) {
  const suitState = boardState[card.suit];
  
  // If the suit hasn't started yet, only the 7 can open it
  if (!suitState.hasSeven) {
    return card.rank === '7';
  }
  
  // If suit is open, card must be exactly 1 lower than min or 1 higher than max
  return (card.val === suitState.min - 1) || (card.val === suitState.max + 1);
}

// Builds the flat 12-item board list optimized for 3x4 layout columns
function compileGridLayout(boardState) {
  const cells = [];
  let currentCellIndex = 1;

  SUITS.forEach(suit => {
    const state = boardState[suit];
    
    // Left Half Sequence Display (Row for each suit)
    cells.push({
      row: currentCellIndex,
      col: 1,
      hasSuit: state.hasSeven,
      displayValue: state.hasSeven ? `A - 6 (${suit.substring(0,1)})` : `Empty ${suit}`
    });
    
    // Middle Center 7s Display
    cells.push({
      row: currentCellIndex,
      col: 2,
      hasSuit: state.hasSeven,
      displayValue: state.hasSeven ? `7 of ${suit}` : `Locked 7♣`
    });

    // Right Half Sequence Display
    cells.push({
      row: currentCellIndex,
      col: 3,
      hasSuit: state.hasSeven,
      displayValue: state.hasSeven ? `8 - K (${suit.substring(0,1)})` : `Empty ${suit}`
    });

    currentCellIndex++;
  });

  return cells;
}

io.on('connection', (socket) => {

  // 1. CREATE LOBBY HANDLER
  socket.on('createRoom', ({ playerName, gameMode }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      gameMode: gameMode || 'number',
      phase: 'lobby',
      players: [{ id: socket.id, name: playerName, hand: [], ready: false }],
      roles: {},
      theNumber: null,
      turnOrder: [],
      activeTurnIndex: 0,
      round: 1,
      answers: {},
      continueVotes: {},
      playerVotes: {},
      failedImposterGuess: null,
      sevenClubsState: {
        board: {
          Clubs: { hasSeven: false, min: 7, max: 7 },
          Diamonds: { hasSeven: false, min: 7, max: 7 },
          Hearts: { hasSeven: false, min: 7, max: 7 },
          Spades: { hasSeven: false, min: 7, max: 7 }
        },
        gameStarted: false
      }
    };

    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
  });

  // 2. JOIN EXISTING LOBBY HANDLER
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('errorMsg', 'Lobby not found. Verify the room code.');
    }
    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', 'Game has already started.');
    }

    room.players.push({ id: socket.id, name: playerName, hand: [], ready: false });
    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', room);
  });

  // 3. START GAME TRIGGER
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.gameMode === 'card') {
      // ♣️ SEVEN OF CLUBS INITIALIZATION
      room.phase = 'sevenClubsBoard';
      
      let deck = createStandardDeck();
      deck = shuffleDeck(deck);

      // Deal all cards evenly to players
      let pIdx = 0;
      while (deck.length > 0) {
        room.players[pIdx % room.players.length].hand.push(deck.pop());
        pIdx++;
      }

      // Determine who starts with the 7 of Clubs
      let startingPlayerIndex = 0;
      room.players.forEach((p, idx) => {
        const hasSevenClubs = p.hand.some(c => c.suit === 'Clubs' && c.rank === '7');
        if (hasSevenClubs) {
          startingPlayerIndex = idx;
        }
      });

      room.activeTurnIndex = startingPlayerIndex;
      broadcastSevenClubsState(room);

    } else {
      // 🔢 STANDARD IMPOSTER SETUP
      room.phase = 'role';
      room.theNumber = Math.floor(Math.random() * 10) + 1;

      // Assign Imposter role randomly
      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
        p.ready = false;
      });

      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  // ♣️ SEVEN OF CLUBS GAMEPLAY EVENT: PLAY CARD
  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.activeTurnIndex];
    if (socket.id !== activePlayer.id) return;

    // Find card in hand
    const cardIndex = activePlayer.hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIndex === -1) return;

    const card = activePlayer.hand[cardIndex];
    const targetSuitState = room.sevenClubsState.board[suit];

    if (!isValidMove(card, room.sevenClubsState.board)) {
      return socket.emit('errorMsg', 'Illegal move sequence placement.');
    }

    // Apply card to board state
    activePlayer.hand.splice(cardIndex, 1);
    let earnedBonusTurn = false;

    if (card.rank === '7') {
      targetSuitState.hasSeven = true;
      targetSuitState.min = 7;
      targetSuitState.max = 7;
    } else if (card.val < 7) {
      targetSuitState.min = card.val;
      if (card.rank === 'A') earnedBonusTurn = true; // Completed lower half bonus
    } else if (card.val > 7) {
      targetSuitState.max = card.val;
      if (card.rank === 'K') earnedBonusTurn = true; // Completed upper half bonus
    }

    // Check Win Condition
    if (activePlayer.hand.length === 0) {
      room.phase = 'result';
      io.to(roomCode).emit('goToResultScreen', {
        gameOverReason: `🎉 ${activePlayer.name} won by running out of cards first!`,
        voteTally: {}
      });
      return;
    }

    // Advance turn if no bonus turn earned
    if (!earnedBonusTurn) {
      room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
    }

    broadcastSevenClubsState(room);
  });

  // ♣️ SEVEN OF CLUBS GAMEPLAY EVENT: NO MOVES PENALTY (DRAW FROM NEIGHBOR ON LEFT)
  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.activeTurnIndex];
    if (socket.id !== activePlayer.id) return;

    // Verify player actually has no moves before letting them draw
    const currentMoves = activePlayer.hand.filter(c => isValidMove(c, room.sevenClubsState.board));
    if (currentMoves.length > 0) {
      return socket.emit('errorMsg', 'You have valid cards you can play!');
    }

    // Neighbor to the left is the next player in index sequence
    const neighborIndex = (room.activeTurnIndex + 1) % room.players.length;
    const neighborPlayer = room.players[neighborIndex];

    if (neighborPlayer.hand.length > 0) {
      // Blindly draw a random card from neighbor's hand
      const randomIdx = Math.floor(Math.random() * neighborPlayer.hand.length);
      const stolenCard = neighborPlayer.hand.splice(randomIdx, 1)[0];
      activePlayer.hand.push(stolenCard);
    }

    // End turn after penalty draw
    room.activeTurnIndex = (room.activeTurnIndex + 1) % room.players.length;
    broadcastSevenClubsState(room);
  });

  // Helper broadcast routine for card state updates
  function broadcastSevenClubsState(room) {
    const activePlayer = room.players[room.activeTurnIndex];
    const neighborIndex = (room.activeTurnIndex + 1) % room.players.length;
    const neighborPlayer = room.players[neighborIndex];

    const gridLayout = compileGridLayout(room.sevenClubsState.board);

    room.players.forEach(p => {
      // Evaluate options relative to each player's specific hand
      const evaluatedHand = p.hand.map(c => ({
        ...c,
        isPlayable: (p.id === activePlayer.id) && isValidMove(c, room.sevenClubsState.board)
      }));

      const activeHasNoMoves = p.id === activePlayer.id && !evaluatedHand.some(c => c.isPlayable);

      io.to(p.id).emit('sevenClubsUpdateBoard', {
        activePlayerId: activePlayer.id,
        activePlayerName: activePlayer.name,
        gridCells: gridLayout,
        myHand: evaluatedHand,
        hasNoMoves: activeHasNoMoves,
        neighborCardCount: neighborPlayer ? neighborPlayer.hand.length : 0
      });
    });
  }

  // 4. IMPOSTER GAME MECHANICS: READY TRANSITION
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.ready = true;

    const readyMap = {};
    room.players.forEach(p => { readyMap[p.id] = p.ready; });
    io.to(roomCode).emit('readyListUpdated', readyMap);

    if (room.players.every(p => p.ready)) {
      room.turnOrder = [...room.players];
      // Shuffle turn ordering for the reveal step
      for (let i = room.turnOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.turnOrder[i], room.turnOrder[j]] = [room.turnOrder[j], room.turnOrder[i]];
      }
      room.phase = 'turnReveal';
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  // 5. PHASE SHIFT EVENT ROUTER
  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    room.activeTurnIndex = 0;
    if (!room.answers[room.round]) room.answers[room.round] = {};

    io.to(roomCode).emit('goToAnswerScreen', room);
    sendActiveTurnNotification(room);
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'answer') return;

    const expectedPlayer = room.turnOrder[room.activeTurnIndex];
    if (socket.id !== expectedPlayer.id) return;

    room.answers[room.round][socket.id] = clueWord;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: expectedPlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.activeTurnIndex++;
    if (room.activeTurnIndex >= room.turnOrder.length) {
      io.to(roomCode).emit('showAllClues', room);
    } else {
      sendActiveTurnNotification(room);
    }
  });

  function sendActiveTurnNotification(room) {
    const target = room.turnOrder[room.activeTurnIndex];
    io.to(room.code).emit('nextTurnIndex', { activePlayerId: target.id, activePlayerName: target.name });
  }

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.phase = 'answer';
      room.activeTurnIndex = 0;
      if (!room.answers[room.round]) room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      sendActiveTurnNotification(room);
    } else if (targetPhase === 'askContinue') {
      room.phase = 'continueVote';
      room.continueVotes = {};
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      initiateVotingPhase(roomCode);
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'continueVote') return;

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
        room.phase = 'answer';
        room.activeTurnIndex = 0;
        room.answers[room.round] = {};
        io.to(roomCode).emit('goToAnswerScreen', room);
        sendActiveTurnNotification(room);
      } else {
        initiateVotingPhase(roomCode);
      }
    }
  });

  function initiateVotingPhase(roomCode) {
    const room = rooms[roomCode];
    room.phase = 'vote';
    room.playerVotes = {};
    io.to(roomCode).emit('goToVoteScreen', room);
  }

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'vote') return;

    room.playerVotes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.playerVotes);

    if (Object.keys(room.playerVotes).length === room.players.length) {
      processVoteResults(room);
    }
  });

  function processVoteResults(room) {
    const tally = {};
    room.players.forEach(p => { tally[p.id] = 0; });
    Object.values(room.playerVotes).forEach(target => {
      if (tally[target] !== undefined) tally[target]++;
    });

    let maxVotes = -1;
    let candidates = [];
    Object.keys(tally).forEach(id => {
      if (tally[id] > maxVotes) {
        maxVotes = tally[id];
        candidates = [id];
      } else if (tally[id] === maxVotes) {
        candidates.push(id);
      }
    });

    room.voteTally = tally;
    room.phase = 'result';

    if (candidates.length > 1) {
      room.tieBreakerActive = true;
      io.to(room.code).emit('goToResultScreen', {
        gameOverReason: "👔 Tie-breaker scenario! Host must initiate an emergency round.",
        voteTally: tally,
        tieBreakerActive: true
      });
    } else {
      const votedOutId = candidates[0];
      const isImposter = room.roles[votedOutId] === 'imposter';
      room.tieBreakerActive = false;

      const msg = isImposter 
        ? "🟢 Crewmates Win! The Imposter was successfully voted out!" 
        : "🔴 Imposter Wins! An innocent Crewmate was voted out!";

      io.to(room.code).emit('goToResultScreen', {
        gameOverReason: msg,
        voteTally: tally,
        roles: room.roles,
        theNumber: room.theNumber,
        tieBreakerActive: false
      });
    }
  }

  // CLANDESTINE IMPOSTER HOTKEYS
  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room || room.roles[socket.id] !== 'imposter' || room.phase === 'result') return;

    const parsed = parseInt(guessedNumber);
    room.phase = 'result';
    room.tieBreakerActive = false;

    if (parsed === room.theNumber) {
      io.to(roomCode).emit('goToResultScreen', {
        gameOverReason: "💥 Imposter Wins via instant precise guess!",
        voteTally: room.voteTally || {},
        roles: room.roles,
        theNumber: room.theNumber,
        tieBreakerActive: false
      });
    } else {
      io.to(roomCode).emit('goToResultScreen', {
        gameOverReason: "🟢 Crewmates Win! The Imposter guessed incorrectly and blew their cover!",
        voteTally: room.voteTally || {},
        roles: room.roles,
        theNumber: room.theNumber,
        failedImposterGuess: parsed,
        tieBreakerActive: false
      });
    }
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = 'lobby';
    room.players.forEach(p => { p.hand = []; p.ready = false; });
    room.roles = {};
    room.answers = {};
    room.continueVotes = {};
    room.playerVotes = {};
    room.failedImposterGuess = null;
    room.sevenClubsState.board = {
      Clubs: { hasSeven: false, min: 7, max: 7 },
      Diamonds: { hasSeven: false, min: 7, max: 7 },
      Hearts: { hasSeven: false, min: 7, max: 7 },
      Spades: { hasSeven: false, min: 7, max: 7 }
    };
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on standard port ${PORT}`);
});
