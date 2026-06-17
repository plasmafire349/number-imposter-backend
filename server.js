const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 1. Serve static assets safely from the absolute path
const publicPath = path.resolve(__dirname, 'public');
app.use(express.static(publicPath));

// 2. Clear routing fallback to ensure the file is always found
app.get('*', (req, res) => {
  res.sendFile(path.join(publicPath, 'number-imposter.html'), (err) => {
    if (err) {
      console.error("Error sending file:", err);
      res.status(404).send("File not found on disk. Check your folder structure!");
    }
  });
});

const rooms = {};

// Helper assets for Seven of Clubs
const SUITS = [
  { name: 'Clubs', icon: '♣️' },
  { name: 'Diamonds', icon: '♦️' },
  { name: 'Hearts', icon: '♥️' },
  { name: 'Spades', icon: '♠️' }
];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function buildStandardDeck() {
  let deck = [];
  SUITS.forEach(s => {
    RANKS.forEach((r, index) => {
      deck.push({ suit: s.name, suitIcon: s.icon, rank: r, value: index + 1 });
    });
  });
  return deck;
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function syncSevenClubsState(room) {
  const activePlayer = room.players[room.sevenState.activeIndex];
  const leftNeighborIndex = (room.sevenState.activeIndex + 1) % room.players.length;
  const leftNeighbor = room.players[leftNeighborIndex];

  room.players.forEach((p) => {
    const hand = room.sevenState.hands[p.id] || [];
    
    // Evaluate which cards in their hand are legally playable
    const formattedHand = hand.map(card => {
      let isPlayable = false;
      const suitTrack = room.sevenState.board[card.suit];

      if (card.rank === '7') {
        isPlayable = true;
      } else if (suitTrack.placed) {
        if (card.value === suitTrack.min - 1 || card.value === suitTrack.max + 1) {
          isPlayable = true;
        }
      }
      return { ...card, isPlayable };
    });

    const hasNoMoves = !formattedHand.some(c => c.isPlayable);

    // Build the 3x4 Grid Matrix View data for client display
    const gridCells = [];
    let cellIndex = 1;
    SUITS.forEach(s => {
      const track = room.sevenState.board[s.name];
      if (track.placed) {
        gridCells.push({ row: cellIndex, col: 1, hasSuit: true, displayValue: `${track.min === 7 ? '' : '... '}${RANKS[track.min - 1]}` });
        gridCells.push({ row: cellIndex, col: 2, hasSuit: true, displayValue: `7 ${s.icon}` });
        gridCells.push({ row: cellIndex, col: 3, hasSuit: true, displayValue: `${track.max === 7 ? '' : RANKS[track.max - 1]} ...` });
      } else {
        gridCells.push({ row: cellIndex, col: 1, hasSuit: false, displayValue: '—' });
        gridCells.push({ row: cellIndex, col: 2, hasSuit: false, displayValue: `(7 of ${s.name})` });
        gridCells.push({ row: cellIndex, col: 3, hasSuit: false, displayValue: '—' });
      }
      cellIndex++;
    });

    io.to(p.id).emit('sevenClubsUpdateBoard', {
      activePlayerId: activePlayer.id,
      activePlayerName: activePlayer.name,
      myHand: formattedHand,
      gridCells: gridCells,
      hasNoMoves: hasNoMoves,
      neighborCardCount: (room.sevenState.hands[leftNeighbor.id] || []).length
    });
  });
}

function processNextSevenClubsTurn(room) {
  // Check win condition: does any player have 0 cards left?
  for (let p of room.players) {
    if (room.sevenState.hands[p.id] && room.sevenState.hands[p.id].length === 0) {
      room.phase = 'result';
      io.to(room.code).emit('goToResultScreen', {
        gameOverReason: `🏆 CONGRATULATIONS! ${p.name} has played all cards and won the game!`,
        roles: {},
        theNumber: null,
        voteTally: {},
        tieBreakerActive: false
      });
      return;
    }
  }

  // Shift to next index turn cycle
  room.sevenState.activeIndex = (room.sevenState.activeIndex + 1) % room.players.length;
  syncSevenClubsState(room);
}

// ─── SOCKET CONNECTION ROUTER ─────────────────────────────────
io.on('connection', (socket) => {

  socket.on('createRoom', ({ playerName, gameMode }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      gameMode: gameMode || 'number',
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
      sevenState: null
    };
    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('errorMsg', 'Lobby matrix code invalid or missing!');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('errorMsg', 'Deployment currently locked in an active round context.');
      return;
    }
    room.players.push({ id: socket.id, name: playerName });
    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;

    if (room.gameMode === 'card') {
      // Initialize Seven of Clubs State Machine
      let deck = buildStandardDeck();
      deck = shuffleDeck(deck);

      room.sevenState = {
        activeIndex: 0,
        hands: {},
        board: {
          Clubs: { placed: false, min: 7, max: 7 },
          Diamonds: { placed: false, min: 7, max: 7 },
          Hearts: { placed: false, min: 7, max: 7 },
          Spades: { placed: false, min: 7, max: 7 }
        }
      };

      // Deal all 52 cards equally among players
      let pIdx = 0;
      room.players.forEach(p => room.sevenState.hands[p.id] = []);
      while (deck.length > 0) {
        const p = room.players[pIdx % room.players.length];
        room.sevenState.hands[p.id].push(deck.pop());
        pIdx++;
      }

      // Determine who has the 7 of Clubs to set turn index 0
      room.players.forEach((p, index) => {
        const hand = room.sevenState.hands[p.id];
        if (hand.some(c => c.suit === 'Clubs' && c.rank === '7')) {
          room.sevenState.activeIndex = index;
        }
      });

      room.phase = 'sevenClubsBoard';
      syncSevenClubsState(room);

    } else {
      // Initialize Standard Imposter Core Logic Engine
      room.round = 1;
      room.answers = {};
      room.continueVotes = {};
      room.votes = {};
      room.tieBreakerActive = false;

      // Establish core numbers depending on system mode selected
      if (room.gameMode === 'rj') {
        room.theNumber = Math.floor(Math.random() * 50) + 1;
      } else {
        room.theNumber = Math.floor(Math.random() * 10) + 1;
      }

      // Assign Imposter role blindly
      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
      });

      room.readyPlayers = {};
      room.phase = 'role';
      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  /* ♣️ SEVEN OF CLUBS ACTION DRIVERS */
  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.sevenState.activeIndex];
    if (socket.id !== activePlayer.id) return;

    let hand = room.sevenState.hands[socket.id] || [];
    const cardIdx = hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIdx === -1) return;

    const card = hand[cardIdx];
    const suitTrack = room.sevenState.board[suit];
    let legal = false;

    if (card.rank === '7') {
      if (!suitTrack.placed) {
        suitTrack.placed = true;
        suitTrack.min = 7;
        suitTrack.max = 7;
        legal = true;
      }
    } else if (suitTrack.placed) {
      if (card.value === suitTrack.min - 1) {
        suitTrack.min = card.value;
        legal = true;
      } else if (card.value === suitTrack.max + 1) {
        suitTrack.max = card.value;
        legal = true;
      }
    }

    if (legal) {
      hand.splice(cardIdx, 1);
      processNextSevenClubsTurn(room);
    }
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.sevenState.activeIndex];
    if (socket.id !== activePlayer.id) return;

    const leftNeighborIndex = (room.sevenState.activeIndex + 1) % room.players.length;
    const leftNeighbor = room.players[leftNeighborIndex];
    let neighborHand = room.sevenState.hands[leftNeighbor.id] || [];

    if (neighborHand.length > 0) {
      const randIdx = Math.floor(Math.random() * neighborHand.length);
      const stolenCard = neighborHand.splice(randIdx, 1)[0];
      room.sevenState.hands[socket.id].push(stolenCard);

      processNextSevenClubsTurn(room);
    }
  });

  /* 🔢 IMPOSTER MECHANICS TURN ENGINE */
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    if (room.players.every(p => room.readyPlayers[p.id])) {
      room.turnOrder = [...room.players];
      for (let i = room.turnOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.turnOrder[i], room.turnOrder[j]] = [room.turnOrder[j], room.turnOrder[i]];
      }
      room.currentTurnIndex = 0;
      room.answers[room.round] = {};
      room.phase = 'turnReveal';
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.phase = 'answer';
    io.to(roomCode).emit('goToAnswerScreen', room);

    const activePlayer = room.turnOrder[room.currentTurnIndex];
    io.to(roomCode).emit('nextTurnIndex', { activePlayerId: activePlayer.id, activePlayerName: activePlayer.name });
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== activePlayer.id) return;

    room.answers[room.round][socket.id] = clueWord;
    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: activePlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.currentTurnIndex++;
    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextPlayer = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', { activePlayerId: nextPlayer.id, activePlayerName: nextPlayer.name });
    } else {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room || room.roles[socket.id] !== 'imposter') return;

    if (parseInt(guessedNumber) === room.theNumber) {
      room.phase = 'result';
      io.to(roomCode).emit('goToResultScreen', {
        gameOverReason: "💥 IMPOSTER VICTORY! The Imposter intercepted the target sequence code accurately!",
        roles: room.roles,
        theNumber: room.theNumber,
        voteTally: {},
        tieBreakerActive: false
      });
    } else {
      room.phase = 'result';
      io.to(roomCode).emit('goToResultScreen', {
        gameOverReason: "🛡️ CREWMATE VICTORY! The Imposter attempted a blind guess profile hack and failed!",
        roles: room.roles,
        theNumber: room.theNumber,
        voteTally: {},
        tieBreakerActive: false,
        failedImposterGuess: guessedNumber
      });
    }
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || socket.id !== room.hostId) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      room.currentTurnIndex = 0;
      room.answers[room.round] = {};
      room.readyPlayers = {};
      room.phase = 'turnReveal';
      io.to(roomCode).emit('goToTurnRevealScreen', room);
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
      room.currentTurnIndex = 0;
      room.answers[room.round] = {};
      room.phase = 'answer';
      io.to(roomCode).emit('goToAnswerScreen', room);
      const activePlayer = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', { activePlayerId: activePlayer.id, activePlayerName: activePlayer.name });
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    if (room.players.every(p => room.continueVotes[p.id])) {
      const moreCount = Object.values(room.continueVotes).filter(v => v === 'more').length;
      if (moreCount > room.players.length / 2) {
        room.round++;
        room.currentTurnIndex = 0;
        room.answers[room.round] = {};
        room.phase = 'turnReveal';
        io.to(roomCode).emit('goToTurnRevealScreen', room);
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
      const tally = {};
      room.players.forEach(p => tally[p.id] = 0);
      Object.values(room.votes).forEach(target => {
        if (tally[target] !== undefined) tally[target]++;
      });

      let highestVotes = -1;
      let topVotedPlayers = [];
      Object.keys(tally).forEach(pId => {
        if (tally[pId] > highestVotes) {
          highestVotes = tally[pId];
          topVotedPlayers = [pId];
        } else if (tally[pId] === highestVotes) {
          topVotedPlayers.push(pId);
        }
      });

      if (topVotedPlayers.length > 1) {
        room.tieBreakerActive = true;
        room.phase = 'result';
        io.to(roomCode).emit('goToResultScreen', {
          gameOverReason: "⚖️ TIE ENCOUNTERED! Voting metrics split evenly. Initiating host tiebreaker round...",
          roles: room.roles,
          theNumber: room.theNumber,
          voteTally: tally,
          tieBreakerActive: true
        });
      } else {
        const accusedId = topVotedPlayers[0];
        const isImposter = (room.roles[accusedId] === 'imposter');
        room.phase = 'result';
        room.tieBreakerActive = false;

        const reason = isImposter 
          ? "🛡️ CREWMATE VICTORY! The network correctly identified and ejected the profile match imposter!"
          : "💥 IMPOSTER VICTORY! An innocent profile agent was exiled from the station architecture!";

        io.to(roomCode).emit('goToResultScreen', {
          gameOverReason: reason,
          roles: room.roles,
          theNumber: room.theNumber,
          voteTally: tally,
          tieBreakerActive: false
        });
      }
    }
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.phase = 'lobby';
    room.roles = {};
    room.theNumber = null;
    room.turnOrder = [];
    room.answers = {};
    room.votes = {};
    room.continueVotes = {};
    room.tieBreakerActive = false;
    room.sevenState = null;
    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(roomCode => {
      const room = rooms[roomCode];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
        if (room.players.length === 0) {
          delete rooms[roomCode];
        } else {
          if (room.hostId === socket.id) {
            room.hostId = room.players[0].id;
          }
          io.to(roomCode).emit('roomUpdated', room);
        }
      }
    });
  });

});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Game engine operational and logging metrics on port ${PORT}`);
});
