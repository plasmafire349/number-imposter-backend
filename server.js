const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
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

const RANK_VALUES = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };
const SUITS = [
  { name: 'Clubs', icon: '♣', row: 1 },
  { name: 'Spades', icon: '♠', row: 2 },
  { name: 'Hearts', icon: '♥', row: 3 },
  { name: 'Diamonds', icon: '♦', row: 4 }
];

function initializeSevensGrid() {
  const grid = [];
  SUITS.forEach(suit => {
    grid.push({ row: suit.row, col: 1, suitName: suit.name, suitIcon: suit.icon, cardsPlayed: [], type: 'left', display: '6-A' });
    grid.push({ row: suit.row, col: 2, suitName: suit.name, suitIcon: suit.icon, cardsPlayed: [], type: 'center', display: '—' });
    grid.push({ row: suit.row, col: 3, suitName: suit.name, suitIcon: suit.icon, cardsPlayed: [], type: 'right', display: '8-K' });
  });
  return grid;
}

io.on('connection', (socket) => {

  socket.on('createRoom', ({ playerName, gameMode }) => {
    if (!playerName || !playerName.trim()) return socket.emit('errorMsg', 'Identity parameters are mandatory.');
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      code: roomCode, hostId: socket.id, gameMode: gameMode || 'number', phase: 'lobby',
      players: [{ id: socket.id, name: playerName.trim(), hand: [] }], roles: {}, theNumber: null,
      round: 1, turnOrder: [], currentTurnIndex: 0, readyPlayers: {}, answers: {},
      continueVotes: {}, votes: {}, voteTally: {}, failedImposterGuess: null, tieBreakerActive: false,
      sevensGrid: [], sevensActivePlayerIdx: 0
    };
    socket.join(roomCode);
    io.to(roomCode).emit('roomUpdated', rooms[roomCode]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const cleanedCode = roomCode ? roomCode.trim().toUpperCase() : '';
    const room = rooms[cleanedCode];
    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Match already in progress.');
    if (!playerName || !playerName.trim()) return socket.emit('errorMsg', 'Invalid name.');

    room.players.push({ id: socket.id, name: playerName.trim(), hand: [] });
    socket.join(cleanedCode);
    io.to(cleanedCode).emit('roomUpdated', room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return socket.emit('errorMsg', 'Requires a minimum of 3 players.');

    room.failedImposterGuess = null;
    room.tieBreakerActive = false;
    room.round = 1;
    room.answers = {};
    room.votes = {};

    if (room.gameMode === 'card') {
      room.phase = 'sevenClubsBoard';
      room.sevensGrid = initializeSevensGrid();
      
      let fullDeck = [];
      SUITS.forEach(s => {
        Object.keys(RANK_VALUES).forEach(r => {
          fullDeck.push({ suit: s.name, suitIcon: s.icon, rank: r, row: s.row });
        });
      });

      for (let i = fullDeck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [fullDeck[i], fullDeck[j]] = [fullDeck[j], fullDeck[i]];
      }

      room.players.forEach(p => p.hand = []);
      let playerIdx = 0;
      while(fullDeck.length > 0) {
        room.players[playerIdx % room.players.length].hand.push(fullDeck.pop());
        playerIdx++;
      }

      let startingPlayerIdx = 0;
      room.players.forEach((p, idx) => {
        if (p.hand.some(c => c.suit === 'Clubs' && c.rank === '7')) {
          startingPlayerIdx = idx;
        }
      });

      room.sevensActivePlayerIdx = startingPlayerIdx;
      sendSevensStateUpdate(room);
    } else {
      room.phase = 'role';
      room.readyPlayers = {};
      room.theNumber = room.gameMode === 'rj' ? 
        ["SYNAPSE", "QUANTUM", "COMPILER", "MAINFRAME"][Math.floor(Math.random() * 4)] : 
        Math.floor(Math.random() * 10) + 1;

      const imposterIndex = Math.floor(Math.random() * room.players.length);
      room.roles = {};
      room.players.forEach((p, idx) => {
        room.roles[p.id] = (idx === imposterIndex) ? 'imposter' : 'crewmate';
      });
      io.to(roomCode).emit('goToRoleScreen', room);
    }
  });

  socket.on('sevenClubsPlayCard', ({ roomCode, suit, rank }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.sevensActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    const cardIndex = activePlayer.hand.findIndex(c => c.suit === suit && c.rank === rank);
    if (cardIndex === -1) return;
    const cardPlayed = activePlayer.hand[cardIndex];
    const cardVal = RANK_VALUES[rank];

    let targetCell = null;
    let isValid = false;

    if (cardVal === 7) {
      targetCell = room.sevensGrid.find(cell => cell.suitName === suit && cell.type === 'center');
      if (targetCell && targetCell.cardsPlayed.length === 0) isValid = true;
    } else if (cardVal < 7) {
      targetCell = room.sevensGrid.find(cell => cell.suitName === suit && cell.type === 'left');
      const centerCell = room.sevensGrid.find(cell => cell.suitName === suit && cell.type === 'center');
      
      if (centerCell && centerCell.cardsPlayed.length > 0) {
        if (targetCell.cardsPlayed.length === 0 && cardVal === 6) {
          isValid = true;
        } else if (targetCell.cardsPlayed.length > 0) {
          const highestValueOnLeft = RANK_VALUES[targetCell.cardsPlayed[0]]; 
          if (cardVal === highestValueOnLeft - 1) isValid = true;
        }
      }
    } else if (cardVal > 7) {
      targetCell = room.sevensGrid.find(cell => cell.suitName === suit && cell.type === 'right');
      const centerCell = room.sevensGrid.find(cell => cell.suitName === suit && cell.type === 'center');

      if (centerCell && centerCell.cardsPlayed.length > 0) {
        if (targetCell.cardsPlayed.length === 0 && cardVal === 8) {
          isValid = true;
        } else if (targetCell.cardsPlayed.length > 0) {
          const highestValueOnRight = RANK_VALUES[targetCell.cardsPlayed[targetCell.cardsPlayed.length - 1]];
          if (cardVal === highestValueOnRight + 1) isValid = true;
        }
      }
    }

    if (!isValid) return socket.emit('errorMsg', "Sequence Error: Missing prerequisite elements!");

    activePlayer.hand.splice(cardIndex, 1);

    if (cardVal === 7) {
      targetCell.cardsPlayed.push(rank);
      targetCell.display = `7${cardPlayed.suitIcon}`;
    } else if (cardVal < 7) {
      targetCell.cardsPlayed.unshift(rank); 
      targetCell.display = `${targetCell.cardsPlayed.join(' ')}${cardPlayed.suitIcon}`;
    } else {
      targetCell.cardsPlayed.push(rank);
      targetCell.display = `${targetCell.cardsPlayed.join(' ')}${cardPlayed.suitIcon}`;
    }

    io.to(roomCode).emit('clueActionLogged', { text: `${activePlayer.name} placed down card: [${rank}${cardPlayed.suitIcon}]` });

    if (activePlayer.hand.length === 0) {
      room.gameOverReason = `Victory! "${activePlayer.name}" cleared their entire hand deck configuration and won Sevens!`;
      room.phase = 'result';
      room.voteTally = {};
      io.to(roomCode).emit('goToResultScreen', room);
      return;
    }

    room.sevensActivePlayerIdx = (room.sevensActivePlayerIdx + 1) % room.players.length;
    sendSevensStateUpdate(room);
  });

  socket.on('sevenClubsPickFromNeighbor', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'sevenClubsBoard') return;

    const activePlayer = room.players[room.sevensActivePlayerIdx];
    if (socket.id !== activePlayer.id) return;

    const nextSeatIdx = (room.sevensActivePlayerIdx + 1) % room.players.length;
    const neighborPlayer = room.players[nextSeatIdx];

    if (neighborPlayer && neighborPlayer.hand.length > 0) {
      const randIdx = Math.floor(Math.random() * neighborPlayer.hand.length);
      const drawnCard = neighborPlayer.hand.splice(randIdx, 1)[0];
      activePlayer.hand.push(drawnCard);

      io.to(roomCode).emit('clueActionLogged', { text: `${activePlayer.name} passed turn and pulled a card from ${neighborPlayer.name}.` });
      
      if (neighborPlayer.hand.length === 0) {
        room.gameOverReason = `Hand depletion milestone met! "${neighborPlayer.name}" cleared their hand and won!`;
        room.phase = 'result';
        room.voteTally = {};
        io.to(roomCode).emit('goToResultScreen', room);
        return;
      }
    }

    room.sevensActivePlayerIdx = (room.sevensActivePlayerIdx + 1) % room.players.length;
    sendSevensStateUpdate(room);
  });

  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode]; if (!room) return;
    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);
    if (Object.keys(room.readyPlayers).length === room.players.length) {
      room.phase = 'turnReveal';
      room.turnOrder = [...room.players].sort(() => Math.random() - 0.5);
      room.currentTurnIndex = 0;
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode]; if (!room) return;
    room.phase = 'answer'; room.answers[room.round] = {};
    io.to(roomCode).emit('goToAnswerScreen', room);
    const activeUser = room.turnOrder[room.currentTurnIndex];
    io.to(roomCode).emit('nextTurnIndex', { activePlayerId: activeUser.id, activePlayerName: activeUser.name });
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode]; if (!room) return;
    const currentActiveExpectedPlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== currentActiveExpectedPlayer.id) return;

    const sanitizedClue = clueWord ? clueWord.trim() : "PASS";
    room.answers[room.round][socket.id] = sanitizedClue;

    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id, playerName: currentActiveExpectedPlayer.name, clueWord: sanitizedClue, roundAnswers: room.answers[room.round]
    });

    room.currentTurnIndex++;
    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', { activePlayerId: nextUser.id, activePlayerName: nextUser.name });
    } else {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode]; if (!room) return;
    if (targetPhase === 'round2') {
      room.round = 2; room.currentTurnIndex = 0; room.phase = 'answer'; room.answers[room.round] = {};
      io.to(roomCode).emit('goToAnswerScreen', room);
      const activeUser = room.turnOrder[room.currentTurnIndex];
      io.to(roomCode).emit('nextTurnIndex', { activePlayerId: activeUser.id, activePlayerName: activeUser.name });
    } else if (targetPhase === 'askContinue') {
      room.phase = 'continueVote'; room.continueVotes = {}; io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.phase = 'vote'; room.votes = {}; io.to(roomCode).emit('goToVoteScreen', room);
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode]; if (!room) return;
    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);
    if (Object.keys(room.continueVotes).length === room.players.length) {
      let tallyMore = 0, tallyVote = 0;
      Object.values(room.continueVotes).forEach(v => v === 'more' ? tallyMore++ : tallyVote++);
      if (tallyMore > tallyVote) {
        room.round++; room.currentTurnIndex = 0; room.phase = 'answer'; room.answers[room.round] = {};
        io.to(roomCode).emit('goToAnswerScreen', room);
        const activeUser = room.turnOrder[room.currentTurnIndex];
        io.to(roomCode).emit('nextTurnIndex', { activePlayerId: activeUser.id, activePlayerName: activeUser.name });
      } else {
        room.phase = 'vote'; room.votes = {}; io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode]; if (!room) return;
    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);
    if (Object.keys(room.votes).length === room.players.length) {
      evaluateBallotResolutions(roomCode);
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode]; if (!room) return;
    const targetGuessNormalized = guessedNumber ? guessedNumber.toString().trim().toUpperCase() : '';
    const actualSolutionNormalized = room.theNumber ? room.theNumber.toString().trim().toUpperCase() : '';

    room.phase = 'result';
    if (targetGuessNormalized === actualSolutionNormalized) {
      room.gameOverReason = `Victory! The Imposter cracked the hidden code: [${room.theNumber}].`;
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "Defeat! The Imposter entered an incorrect guess configuration parameter.";
    }
    io.to(roomCode).emit('goToResultScreen', room);
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode]; if (!room) return;
    room.phase = 'lobby'; room.roles = {}; room.theNumber = null; room.answers = {}; room.votes = {};
    room.continueVotes = {}; room.readyPlayers = {}; room.failedImposterGuess = null; room.tieBreakerActive = false;
    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const pIdx = room.players.findIndex(p => p.id === socket.id);
      if (pIdx !== -1) {
        room.players.splice(pIdx, 1);
        if (room.players.length === 0) delete rooms[code];
        else { if (room.hostId === socket.id) room.hostId = room.players[0].id; io.to(code).emit('roomUpdated', room); }
      }
    });
  });
});

function evaluateBallotResolutions(roomCode) {
  const room = rooms[roomCode];
  const tally = {}; room.players.forEach(p => tally[p.id] = 0);
  Object.values(room.votes).forEach(tId => { if (tally[tId] !== undefined) tally[tId]++; });
  room.voteTally = tally;

  let maxVotes = -1, highestVotedPlayers = [];
  Object.keys(tally).forEach(pId => {
    if (tally[pId] > maxVotes) { maxVotes = tally[pId]; highestVotedPlayers = [pId]; }
    else if (tally[pId] === maxVotes) { highestVotedPlayers.push(pId); }
  });

  room.phase = 'result';
  if (highestVotedPlayers.length > 1) {
    room.tieBreakerActive = true; room.gameOverReason = "Tied Ballot config matched! Consensus split.";
  } else {
    const target = highestVotedPlayers[0];
    room.gameOverReason = room.roles[target] === 'imposter' ? 
      `Victory! The Crewmates successfully tracked down the Imposter.` : 
      "Defeat! An innocent crewmate asset was exiled, leaving the Imposter to win.";
  }
  io.to(roomCode).emit('goToResultScreen', room);
}

function sendSevensStateUpdate(room) {
  const activePlayer = room.players[room.sevensActivePlayerIdx];
  const nextSeatIdx = (room.sevensActivePlayerIdx + 1) % room.players.length;
  const leftNeighbor = room.players[nextSeatIdx];

  const playerHandCounts = {};
  room.players.forEach(p => {
    playerHandCounts[p.id] = p.hand ? p.hand.length : 0;
  });

  room.players.forEach(p => {
    const dynamicHand = p.hand.map(card => {
      let isPlayable = false;
      if (p.id === activePlayer.id) {
        const val = RANK_VALUES[card.rank];
        if (val === 7) {
          isPlayable = true;
        } else if (val < 7) {
          const targetCell = room.sevensGrid.find(c => c.suitName === card.suit && c.type === 'left');
          const centerCell = room.sevensGrid.find(c => c.suitName === card.suit && c.type === 'center');
          if (centerCell && centerCell.cardsPlayed.length > 0) {
            if (targetCell.cardsPlayed.length === 0 && val === 6) isPlayable = true;
            else if (targetCell.cardsPlayed.length > 0 && val === RANK_VALUES[targetCell.cardsPlayed[0]] - 1) isPlayable = true;
          }
        } else if (val > 7) {
          const targetCell = room.sevensGrid.find(c => c.suitName === card.suit && c.type === 'right');
          const centerCell = room.sevensGrid.find(c => c.suitName === card.suit && c.type === 'center');
          if (centerCell && centerCell.cardsPlayed.length > 0) {
            if (targetCell.cardsPlayed.length === 0 && val === 8) isPlayable = true;
            else if (targetCell.cardsPlayed.length > 0 && val === RANK_VALUES[targetCell.cardsPlayed[targetCell.cardsPlayed.length - 1]] + 1) isPlayable = true;
          }
        }
      }
      return { ...card, isPlayable };
    });

    dynamicHand.sort((a,b) => a.row !== b.row ? a.row - b.row : RANK_VALUES[a.rank] - RANK_VALUES[b.rank]);

    io.to(p.id).emit('sevenClubsUpdateBoard', {
      activePlayerId: activePlayer.id,
      activePlayerName: activePlayer.name,
      gridCells: room.sevensGrid,
      myHand: dynamicHand,
      neighborCardCount: leftNeighbor ? leftNeighbor.hand.length : 0,
      allHandCounts: playerHandCounts
    });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Running layout architecture on: http://localhost:${PORT}`));
