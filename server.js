const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  try {
    const files = fs.readdirSync(__dirname);
    const htmlFile = files.find(file => file.toLowerCase().endsWith('.html'));
    if (htmlFile) {
      res.sendFile(path.join(__dirname, htmlFile));
    } else {
      res.status(404).send("Error: No HTML file found!");
    }
  } catch (err) {
    res.status(500).send("Server Error.");
  }
});

const rooms = {};

const rjWordPool = [
  { category: "ANIMALS", word: "LION" }, { category: "ANIMALS", word: "TIGER" }, { category: "ANIMALS", word: "ELEPHANT" }, { category: "ANIMALS", word: "GIRAFFE" }, { category: "ANIMALS", word: "MONKEY" },
  { category: "FOOD & DRINK", word: "PIZZA" }, { category: "FOOD & DRINK", word: "BURGER" }, { category: "FOOD & DRINK", word: "PASTA" }, { category: "FOOD & DRINK", word: "SUSHI" }, { category: "FOOD & DRINK", word: "TACO" },
  { category: "VEHICLES & TRANSPORT", word: "BICYCLE" }, { category: "VEHICLES & TRANSPORT", word: "MOTORCYCLE" }, { category: "VEHICLES & TRANSPORT", word: "AUTOMOBILE" }, { category: "VEHICLES & TRANSPORT", word: "SPACESHIP" }, { category: "VEHICLES & TRANSPORT", word: "SUBMARINE" },
  { category: "PLACES & BUILDINGS", word: "SCHOOL" }, { category: "PLACES & BUILDINGS", word: "COLLEGE" }, { category: "PLACES & BUILDINGS", word: "HOSPITAL" }, { category: "PLACES & BUILDINGS", word: "HOTEL" }, { category: "PLACES & BUILDINGS", word: "CASTLE" }
];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function getCardNumericValue(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J') return 11;
  if (rank === 'Q') return 12;
  if (rank === 'K') return 13;
  return parseInt(rank);
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

io.on('connection', (socket) => {
  console.log(`Connected client: ${socket.id}`);

  socket.on('createRoom', ({ playerName, gameMode }) => {
    const code = generateRoomCode();
    rooms[code] = {
      code: code,
      hostId: socket.id,
      gameMode: gameMode,
      phase: 'lobby',
      round: 1,
      players: [{ id: socket.id, name: playerName }],
      roles: {},
      theNumber: null,
      currentCategory: "",
      turnOrder: [],
      answers: {},
      voteTally: {},
      readyPlayers: {},
      continueVotes: {},
      failedImposterGuess: null,
      gameOverReason: "",
      playerHands: {},
      boardLayout: {
        Clubs: { min: null, max: null },
        Diamonds: { min: null, max: null },
        Hearts: { min: null, max: null },
        Spades: { min: null, max: null }
      },
      currentTurnIndex: 0,
      standingsList: []
    };

    socket.join(code);
    socket.emit('roomUpdated', rooms[code]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];

    if (!room) return socket.emit('errorMsg', 'Room workspace not discovered.');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Game session already running.');

    room.players.push({ id: socket.id, name: playerName });
    socket.join(cleanedCode);
    io.to(cleanedCode).emit('roomUpdated', room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.hostId !== socket.id) return;

    if (room.players.length < 2) {
      return socket.emit('errorMsg', 'You need at least 2 players to start.');
    }

    if (room.gameMode === 'seven') {
      const suits = ['Clubs', 'Diamonds', 'Hearts', 'Spades'];
      const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
      let deck = [];
      suits.forEach(s => {
        ranks.forEach(r => {
          deck.push({ rank: r, suit: s });
        });
      });
      deck.sort(() => Math.random() - 0.5);

      room.players.forEach(p => room.playerHands[p.id] = []);
      let playerIdx = 0;
      while (deck.length > 0) {
        const card = deck.pop();
        const pId = room.players[playerIdx].id;
        room.playerHands[pId].push(card);
        playerIdx = (playerIdx + 1) % room.players.length;
      }

      let startingTurn = 0;
      room.players.forEach((p, idx) => {
        const hand = room.playerHands[p.id];
        const holds7Clubs = hand.some(c => c.rank === '7' && c.suit === 'Clubs');
        if (holds7Clubs) startingTurn = idx;
      });

      room.currentTurnIndex = startingTurn;
      room.phase = 'sevenClubsBoard';
      room.boardLayout = {
        Clubs: { min: null, max: null },
        Diamonds: { min: null, max: null },
        Hearts: { min: null, max: null },
        Spades: { min: null, max: null }
      };
      room.standingsList = [];

      io.to(cleanedCode).emit('sevenClubsUpdateBoard', room);
    } else {
      room.phase = 'role';
      if (room.gameMode === 'rj') {
        const entry = rjWordPool[Math.floor(Math.random() * rjWordPool.length)];
        room.currentCategory = entry.category;
        room.theNumber = entry.word;
      } else {
        room.theNumber = Math.floor(Math.random() * 10) + 1;
      }

      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
      });

      io.to(cleanedCode).emit('goToRoleScreen', room);
    }
  });

  socket.on('playerReady', ({ roomCode }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(cleanedCode).emit('readyListUpdated', room.readyPlayers);

    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
      io.to(cleanedCode).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    if (!room.answers[room.round]) room.answers[room.round] = {};

    io.to(cleanedCode).emit('goToAnswerScreen', room);
    handleNextTurnIndex(cleanedCode);
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room) return;

    const roundAnswers = room.answers[room.round];
    roundAnswers[socket.id] = clueWord;

    io.to(cleanedCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: room.players.find(p => p.id === socket.id)?.name || "Unknown",
      clueWord: clueWord,
      roundAnswers: roundAnswers
    });

    handleNextTurnIndex(cleanedCode);
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(cleanedCode).emit('promptContinueVote');
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    if (Object.keys(room.continueVotes).length === room.players.length) {
      const moreVotes = Object.values(room.continueVotes).filter(v => v === 'more').length;
      if (moreVotes > room.players.length / 2) {
        room.round += 1;
        room.answers[room.round] = {};
        io.to(cleanedCode).emit('goToAnswerScreen', room);
        handleNextTurnIndex(cleanedCode);
      } else {
        room.phase = 'vote';
        io.to(cleanedCode).emit('goToVoteScreen', room);
      }
    }
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room) return;

    room.voteTally[targetPlayerId] = (room.voteTally[targetPlayerId] || 0) + 1;
    io.to(cleanedCode).emit('voteStatusUpdated', { [socket.id]: true });

    const totalVotes = Object.values(room.voteTally).reduce((a, b) => a + b, 0);
    if (totalVotes === room.players.length) {
      const entries = Object.entries(room.voteTally);
      let max = -1;
      let winners = [];
      entries.forEach(([id, qty]) => {
        if (qty > max) { max = qty; winners = [id]; }
        else if (qty === max) { winners.push(id); }
      });

      room.phase = 'result';
      if (winners.length > 1) {
        room.gameOverReason = "⚠️ EMERGENCY TIE! Ballots deadlocked.";
      } else {
        const targetId = winners[0];
        const targetName = room.players.find(p => p.id === targetId)?.name || "Target";
        if (room.roles[targetId] === 'imposter') {
          room.gameOverReason = `🎉 CREWMATE VICTORY! The Imposter (${targetName}) was exiled. The secret target value was "${room.theNumber}".`;
        } else {
          room.gameOverReason = `💥 IMPOSTER VICTORY! Innocent Crewmate (${targetName}) was exiled. The secret target value was "${room.theNumber}".`;
        }
      }
      io.to(cleanedCode).emit('goToResultScreen', room);
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room) return;

    room.phase = 'result';
    const isCorrect = String(guessedNumber).trim().toUpperCase() === String(room.theNumber).trim().toUpperCase();
    if (isCorrect) {
      room.gameOverReason = `💥 IMPOSTER VICTORY! The Imposter guessed the secret perfectly: "${room.theNumber}"!`;
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = `🎉 CREWMATE VICTORY! The Imposter guessed incorrectly ("${guessedNumber}"). The real element value was "${room.theNumber}".`;
    }
    io.to(cleanedCode).emit('goToResultScreen', room);
  });

  /* SEVEN OF CLUBS ENGINE ROUTINES */
  socket.on('sevenClubsPlayCard', ({ roomCode, rank, suit }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) return socket.emit('errorMsg', "It is not your turn!");

    const hand = room.playerHands[socket.id] || [];
    const cardIdx = hand.findIndex(c => c.rank === rank && c.suit === suit);
    if (cardIdx === -1) return socket.emit('errorMsg', "Card elements not found in your inventory hand layout.");

    const val = getCardNumericValue(rank);
    const layout = room.boardLayout[suit];

    let moveValid = false;
    if (rank === '7') {
      if (layout.min === null) {
        layout.min = 7;
        layout.max = 7;
        moveValid = true;
      }
    } else {
      if (layout.min !== null) {
        if (val === layout.min - 1) {
          layout.min = val;
          moveValid = true;
        } else if (val === layout.max + 1) {
          layout.max = val;
          moveValid = true;
        }
      }
    }

    if (!moveValid) return socket.emit('errorMsg', "Illegal move layout boundaries!");

    hand.splice(cardIdx, 1);

    if (hand.length === 0 && !room.standingsList.includes(activePlayer.name)) {
      room.standingsList.push(activePlayer.name);
    }

    const dynamicPlayersWithCards = room.players.filter(p => room.playerHands[p.id].length > 0);
    if (dynamicPlayersWithCards.length <= 1) {
      dynamicPlayersWithCards.forEach(p => {
        if (!room.standingsList.includes(p.name)) room.standingsList.push(p.name);
      });
      room.phase = 'result';
      room.gameOverReason = `🎉 Seven of Clubs completed! Winner: ${room.standingsList[0] || 'Unknown'}`;
      io.to(cleanedCode).emit('goToResultScreen', room);
    } else {
      do {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      } while (room.playerHands[room.players[room.currentTurnIndex].id].length === 0);

      io.to(cleanedCode).emit('sevenClubsUpdateBoard', room);
    }
  });

  socket.on('sevenClubsPassAction', ({ roomCode }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) return socket.emit('errorMsg', "It is not your turn!");

    do {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    } while (room.playerHands[room.players[room.currentTurnIndex].id].length === 0);

    io.to(cleanedCode).emit('sevenClubsUpdateBoard', room);
  });

  socket.on('resetGame', ({ roomCode }) => {
    const cleanedCode = roomCode.trim().toUpperCase();
    const room = rooms[cleanedCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.round = 1;
    room.roles = {};
    room.theNumber = null;
    room.currentCategory = "";
    room.turnOrder = [];
    room.answers = {};
    room.voteTally = {};
    room.readyPlayers = {};
    room.continueVotes = {};
    room.failedImposterGuess = null;
    room.gameOverReason = "";
    room.playerHands = {};
    room.boardLayout = {
      Clubs: { min: null, max: null },
      Diamonds: { min: null, max: null },
      Hearts: { min: null, max: null },
      Spades: { min: null, max: null }
    };
    room.currentTurnIndex = 0;
    room.standingsList = [];

    io.to(cleanedCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        if (room.hostId === socket.id) room.hostId = room.players[0].id;
        io.to(code).emit('roomUpdated', room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server executing cleanly on port: ${PORT}`);
});
