const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Standard Fisher-Yates shuffle used ONLY for the initial Round 1 lineup
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = arr[i];
    arr[i] = arr[j];
    arr[j] = temp;
  }
  return arr;
}

function cleanDuplicatePlayers(playersArray) {
  const uniqueMap = {};
  playersArray.forEach(p => {
    if (p && p.id) {
      uniqueMap[p.id] = p;
    }
  });
  return Object.values(uniqueMap);
}

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // 1. HOST CREATES LOBBY
  socket.on('createRoom', ({ playerName }) => {
    const code = generateRoomCode();
    socket.join(code);

    rooms[code] = {
      code: code,
      phase: 'waiting',
      round: 1,
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName }],
      turnOrder: [],
      answers: {}, 
      votes: {},
      readyPlayers: {},
      continueVotes: {},
      turnIndex: 0,
      theNumber: null,
      roles: {},
      gameOverReason: null,
      failedImposterGuess: null
    };

    socket.emit('roomUpdated', rooms[code]);
  });

  // 2. PLAYER JOINS LOBBY
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) {
      socket.emit('errorMsg', 'Room code not found!');
      return;
    }
    if (room.phase !== 'waiting') {
      socket.emit('errorMsg', 'Game has already started!');
      return;
    }

    room.players = room.players.filter(p => p.id !== socket.id && p.name !== playerName);

    socket.join(code);
    room.players.push({ id: socket.id, name: playerName });
    room.players = cleanDuplicatePlayers(room.players);
    
    io.to(code).emit('roomUpdated', room);
  });

  // 3. HOST STARTS THE GAME
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.players = cleanDuplicatePlayers(room.players);

    room.phase = 'role';
    room.round = 1;
    room.theNumber = Math.floor(Math.random() * 10) + 1;
    room.gameOverReason = null;
    room.failedImposterGuess = null;
    
    const imposterIndex = Math.floor(Math.random() * room.players.length);
    const imposterId = room.players[imposterIndex].id;

    room.roles = {};
    room.players.forEach(p => {
      room.roles[p.id] = (p.id === imposterId) ? 'imposter' : 'crewmate';
    });

    room.readyPlayers = {};
    room.answers = { 1: {} };
    room.continueVotes = {};

    io.to(roomCode).emit('goToRoleScreen', room);
  });

  // 4. PLAYER CLICKS "READY" -> Generates the core lineup order
  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(roomCode).emit('readyListUpdated', room.readyPlayers);

    room.players = cleanDuplicatePlayers(room.players);

    if (Object.keys(room.readyPlayers).length >= room.players.length) {
      room.phase = 'turnReveal';
      room.readyPlayers = {}; 
      room.turnIndex = 0;
      
      // Order is locked here randomly once!
      room.turnOrder = shuffleArray(room.players);
      
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    }
  });

  // HOST PRESSES START CLUES BUTTON
  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    io.to(roomCode).emit('goToAnswerScreen', room);
    
    io.to(roomCode).emit('nextTurnIndex', { 
      activePlayerId: room.turnOrder[room.turnIndex].id, 
      activePlayerName: room.turnOrder[room.turnIndex].name 
    });
  });

  // 5. TURN BY TURN SUBMISSION
  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'answer') return;

    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    if (room.answers[room.round][socket.id] !== undefined) return; 

    const currentExpectedPlayer = room.turnOrder[room.turnIndex];
    if (!currentExpectedPlayer || socket.id !== currentExpectedPlayer.id) return; 

    room.answers[room.round][socket.id] = clueWord;
    
    io.to(roomCode).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: currentExpectedPlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.turnIndex++;

    if (room.turnIndex < room.turnOrder.length) {
      io.to(roomCode).emit('nextTurnIndex', { 
        activePlayerId: room.turnOrder[room.turnIndex].id, 
        activePlayerName: room.turnOrder[room.turnIndex].name 
      });
    } else {
      io.to(roomCode).emit('showAllClues', room);
    }
  });

  // 6. PROCEED TO NEXT PHASE
  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.players = cleanDuplicatePlayers(room.players);

    if (targetPhase === 'round2') {
      room.round = 2;
      room.turnIndex = 0; // Reset index back to Player 1
      room.answers[2] = {};
      room.phase = 'turnReveal';
      // FIXED: Shuffling line removed here to lock original order
      io.to(roomCode).emit('goToTurnRevealScreen', room);
    } else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(roomCode).emit('promptContinueVote');
    } else if (targetPhase === 'vote') {
      room.phase = 'vote';
      room.votes = {};
      io.to(roomCode).emit('goToVoteScreen', room);
    }
  });

  // LOBBY CONSENSUS FOR MORE ROUNDS
  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(roomCode).emit('continueStatusUpdated', room.continueVotes);

    room.players = cleanDuplicatePlayers(room.players);

    if (Object.keys(room.continueVotes).length >= room.players.length) {
      let moreCount = 0;
      let voteCount = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') moreCount++;
        else voteCount++;
      });

      if (moreCount >= voteCount) {
        room.round++;
        room.turnIndex = 0; // Reset index back to Player 1
        room.answers[room.round] = {};
        room.phase = 'turnReveal';
        // FIXED: Shuffling line removed here to lock original order
        io.to(roomCode).emit('goToTurnRevealScreen', room);
      } else {
        room.phase = 'vote';
        room.votes = {};
        io.to(roomCode).emit('goToVoteScreen', room);
      }
    }
  });

  // 7. VOTE LOGIC
  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== 'vote') return;

    room.votes[socket.id] = targetPlayerId;
    io.to(roomCode).emit('voteStatusUpdated', room.votes);

    room.players = cleanDuplicatePlayers(room.players);

    if (Object.keys(room.votes).length >= room.players.length) {
      room.phase = 'result';
      const tally = {};
      room.players.forEach(p => tally[p.id] = 0);
      Object.values(room.votes).forEach(target => {
        if (tally[target] !== undefined) tally[target]++;
      });
      room.voteTally = tally;

      const imposter = room.players.find(p => room.roles[p.id] === 'imposter');
      let highestVotedId = room.players[0]?.id || socket.id;
      let maxVotes = -1;
      let tie = false;

      Object.entries(tally).forEach(([id, count]) => {
        if (count > maxVotes) {
          maxVotes = count;
          highestVotedId = id;
          tie = false;
        } else if (count === maxVotes) {
          tie = true;
        }
      });

      if (!tie && imposter && highestVotedId === imposter.id) {
        room.gameOverReason = "Crewmate Victory! The Imposter was executed!";
      } else {
        room.gameOverReason = "Imposter Victory! The Crew failed to vote them out!";
      }

      io.to(roomCode).emit('goToResultScreen', room);
    }
  });

  // IMPOSTER EMERGENCY GUESS
  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.roles[socket.id] !== 'imposter') return;
    if (room.phase === 'waiting' || room.phase === 'role' || room.phase === 'result') return;

    const parsedGuess = parseInt(guessedNumber);
    room.phase = 'result';
    
    const tally = {};
    room.players.forEach(p => tally[p.id] = 0);
    room.voteTally = tally;

    if (parsedGuess === room.theNumber) {
      room.gameOverReason = "💥 IMPOSTER VICTORY! They successfully guessed the Secret Number!";
    } else {
      room.failedImposterGuess = parsedGuess;
      room.gameOverReason = "💀 CREWMATE VICTORY! The Imposter made an incorrect guess and blew their cover!";
    }

    io.to(roomCode).emit('goToResultScreen', room);
  });

  // RESET
  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'waiting';
    room.round = 1;
    room.answers = {};
    room.votes = {};
    room.roles = {};
    room.readyPlayers = {};
    room.continueVotes = {};
    room.theNumber = null;
    room.voteTally = null;
    room.turnIndex = 0;
    room.gameOverReason = null;
    room.failedImposterGuess = null;

    io.to(roomCode).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running with fixed permanent order lineup engine! 🔒`);
});
