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

// A massive pool of 300 popular words grouped into 15 clear categories (No movies, no anime)
const rjWordPool = [
  // 1. ANIMALS (20)
  { category: "ANIMALS", word: "LION" }, { category: "ANIMALS", word: "TIGER" }, { category: "ANIMALS", word: "ELEPHANT" }, { category: "ANIMALS", word: "GIRAFFE" }, { category: "ANIMALS", word: "MONKEY" },
  { category: "ANIMALS", word: "PENGUIN" }, { category: "ANIMALS", word: "DOLPHIN" }, { category: "ANIMALS", word: "KANGAROO" }, { category: "ANIMALS", word: "PANDA" }, { category: "ANIMALS", word: "CHEETAH" },
  { category: "ANIMALS", word: "OCTOPUS" }, { category: "ANIMALS", word: "SQUIRREL" }, { category: "ANIMALS", word: "HAMSTER" }, { category: "ANIMALS", word: "LEOPARD" }, { category: "ANIMALS", word: "FLAMINGO" },
  { category: "ANIMALS", word: "ALLIGATOR" }, { category: "ANIMALS", word: "GORILLA" }, { category: "ANIMALS", word: "KOALA" }, { category: "ANIMALS", word: "WOLF" }, { category: "ANIMALS", word: "RABBIT" },

  // 2. FOOD & DRINK (20)
  { category: "FOOD & DRINK", word: "PIZZA" }, { category: "FOOD & DRINK", word: "BURGER" }, { category: "FOOD & DRINK", word: "PASTA" }, { category: "FOOD & DRINK", word: "SUSHI" }, { category: "FOOD & DRINK", word: "TACO" },
  { category: "FOOD & DRINK", word: "STEAK" }, { category: "FOOD & DRINK", word: "PANCAKE" }, { category: "FOOD & DRINK", word: "WAFFLE" }, { category: "FOOD & DRINK", word: "SANDWICH" }, { category: "FOOD & DRINK", word: "SALAD" },
  { category: "FOOD & DRINK", word: "CHOCOLATE" }, { category: "FOOD & DRINK", word: "ICECREAM" }, { category: "FOOD & DRINK", word: "DONUT" }, { category: "FOOD & DRINK", word: "COFFEE" }, { category: "FOOD & DRINK", word: "SMOOTHIE" },
  { category: "FOOD & DRINK", word: "POPCORN" }, { category: "FOOD & DRINK", word: "CHEESE" }, { category: "FOOD & DRINK", word: "NUGGETS" }, { category: "FOOD & DRINK", word: "COOKIE" }, { category: "FOOD & DRINK", word: "CUPCAKE" },

  // 3. FRUITS & VEGETABLES (20)
  { category: "FRUITS & VEGETABLES", word: "BANANA" }, { category: "FRUITS & VEGETABLES", word: "APPLE" }, { category: "FRUITS & VEGETABLES", word: "STRAWBERRY" }, { category: "FRUITS & VEGETABLES", word: "WATERMELON" }, { category: "FRUITS & VEGETABLES", word: "MANGO" },
  { category: "FRUITS & VEGETABLES", word: "ORANGE" }, { category: "FRUITS & VEGETABLES", word: "GRAPES" }, { category: "FRUITS & VEGETABLES", word: "PINEAPPLE" }, { category: "FRUITS & VEGETABLES", word: "BLUEBERRY" }, { category: "FRUITS & VEGETABLES", word: "AVOCADO" },
  { category: "FRUITS & VEGETABLES", word: "POTATO" }, { category: "FRUITS & VEGETABLES", word: "TOMATO" }, { category: "FRUITS & VEGETABLES", word: "CARROT" }, { category: "FRUITS & VEGETABLES", word: "BROCCOLI" }, { category: "FRUITS & VEGETABLES", word: "CUCUMBER" },
  { category: "FRUITS & VEGETABLES", word: "GARLIC" }, { category: "FRUITS & VEGETABLES", word: "ONION" }, { category: "FRUITS & VEGETABLES", word: "LEMON" }, { category: "FRUITS & VEGETABLES", word: "PEACH" }, { category: "FRUITS & VEGETABLES", word: "CORN" },

  // 4. SPORTS & GAMES (20)
  { category: "SPORTS & GAMES", word: "SOCCER" }, { category: "SPORTS & GAMES", word: "BASKETBALL" }, { category: "SPORTS & GAMES", word: "FOOTBALL" }, { category: "SPORTS & GAMES", word: "TENNIS" }, { category: "SPORTS & GAMES", word: "BASEBALL" },
  { category: "SPORTS & GAMES", word: "VOLLEYBALL" }, { category: "SPORTS & GAMES", word: "GOLF" }, { category: "SPORTS & GAMES", word: "BOXING" }, { category: "SPORTS & GAMES", word: "BOWLING" }, { category: "SPORTS & GAMES", word: "BILLIARDS" },
  { category: "SPORTS & GAMES", word: "CHESS" }, { category: "SPORTS & GAMES", word: "CHECKERS" }, { category: "SPORTS & GAMES", word: "DOMINOES" }, { category: "SPORTS & GAMES", word: "MONOPOLY" }, { category: "SPORTS & GAMES", word: "MINECRAFT" },
  { category: "SPORTS & GAMES", word: "FORTNITE" }, { category: "SPORTS & GAMES", word: "POKER" }, { category: "SPORTS & GAMES", word: "RUNNING" }, { category: "SPORTS & GAMES", word: "SWIMMING" }, { category: "SPORTS & GAMES", word: "KARATE" },

  // 5. JOBS & OCCUPATIONS (20)
  { category: "JOBS & OCCUPATIONS", word: "DOCTOR" }, { category: "JOBS & OCCUPATIONS", word: "NURSE" }, { category: "JOBS & OCCUPATIONS", word: "POLICE" }, { category: "JOBS & OCCUPATIONS", word: "FIREFIGHTER" }, { category: "JOBS & OCCUPATIONS", word: "TEACHER" },
  { category: "JOBS & OCCUPATIONS", word: "CHEF" }, { category: "JOBS & OCCUPATIONS", word: "PILOT" }, { category: "JOBS & OCCUPATIONS", word: "ASTRONAUT" }, { category: "JOBS & OCCUPATIONS", word: "ENGINEER" }, { category: "JOBS & OCCUPATIONS", word: "SCIENTIST" },
  { category: "JOBS & OCCUPATIONS", word: "ARTIST" }, { category: "JOBS & OCCUPATIONS", word: "ACTOR" }, { category: "JOBS & OCCUPATIONS", word: "SINGER" }, { category: "JOBS & OCCUPATIONS", word: "LAWYER" }, { category: "JOBS & OCCUPATIONS", word: "FARMER" },
  { category: "JOBS & OCCUPATIONS", word: "BAKER" }, { category: "JOBS & OCCUPATIONS", word: "BARBER" }, { category: "JOBS & OCCUPATIONS", word: "DENTIST" }, { category: "JOBS & OCCUPATIONS", word: "JOURNALIST" }, { category: "JOBS & OCCUPATIONS", word: "CAPTAIN" },

  // 6. HOUSEHOLD ITEMS (20)
  { category: "HOUSEHOLD ITEMS", word: "TELEVISION" }, { category: "HOUSEHOLD ITEMS", word: "REFRIGERATOR" }, { category: "HOUSEHOLD ITEMS", word: "MICROWAVE" }, { category: "HOUSEHOLD ITEMS", word: "TOASTER" }, { category: "HOUSEHOLD ITEMS", word: "BLENDER" },
  { category: "HOUSEHOLD ITEMS", word: "SOFA" }, { category: "HOUSEHOLD ITEMS", word: "BEDROOM" }, { category: "HOUSEHOLD ITEMS", word: "WARDROBE" }, { category: "HOUSEHOLD ITEMS", word: "MIRROR" }, { category: "HOUSEHOLD ITEMS", word: "CLOCK" },
  { category: "HOUSEHOLD ITEMS", word: "COMPUTER" }, { category: "HOUSEHOLD ITEMS", word: "TELEPHONE" }, { category: "HOUSEHOLD ITEMS", word: "BLANKET" }, { category: "HOUSEHOLD ITEMS", word: "PILLOW" }, { category: "HOUSEHOLD ITEMS", word: "MATTRESS" },
  { category: "HOUSEHOLD ITEMS", word: "CURTAIN" }, { category: "HOUSEHOLD ITEMS", word: "CARPET" }, { category: "HOUSEHOLD ITEMS", word: "LAMP" }, { category: "HOUSEHOLD ITEMS", word: "VACUUM" }, { category: "HOUSEHOLD ITEMS", word: "CHAIR" },

  // 7. KITCHEN UTENSILS (20)
  { category: "KITCHEN UTENSILS", word: "SPOON" }, { category: "KITCHEN UTENSILS", word: "FORK" }, { category: "KITCHEN UTENSILS", word: "KNIFE" }, { category: "KITCHEN UTENSILS", word: "PLATE" }, { category: "KITCHEN UTENSILS", word: "BOWL" },
  { category: "KITCHEN UTENSILS", word: "GLASS" }, { category: "KITCHEN UTENSILS", word: "TEACUP" }, { category: "KITCHEN UTENSILS", word: "TEAPOT" }, { category: "KITCHEN UTENSILS", word: "FRYINGPAN" }, { category: "KITCHEN UTENSILS", word: "SAUCEPAN" },
  { category: "KITCHEN UTENSILS", word: "SPATULA" }, { category: "KITCHEN UTENSILS", word: "TONGS" }, { category: "KITCHEN UTENSILS", word: "WHISK" }, { category: "KITCHEN UTENSILS", word: "PEELER" }, { category: "KITCHEN UTENSILS", word: "GRATER" },
  { category: "KITCHEN UTENSILS", word: "STRAINER" }, { category: "KITCHEN UTENSILS", word: "COLANDER" }, { category: "KITCHEN UTENSILS", word: "PITCHER" }, { category: "KITCHEN UTENSILS", word: "THERMOS" }, { category: "KITCHEN UTENSILS", word: "CANNISTER" },

  // 8. CLOTHING & APPAREL (20)
  { category: "CLOTHING & APPAREL", word: "SHIRT" }, { category: "CLOTHING & APPAREL", word: "JEANS" }, { category: "CLOTHING & APPAREL", word: "JACKET" }, { category: "CLOTHING & APPAREL", word: "SWEATER" }, { category: "CLOTHING & APPAREL", word: "HOODIE" },
  { category: "CLOTHING & APPAREL", word: "SHORTS" }, { category: "CLOTHING & APPAREL", word: "SKIRT" }, { category: "CLOTHING & APPAREL", word: "DRESS" }, { category: "CLOTHING & APPAREL", word: "SUIT" }, { category: "CLOTHING & APPAREL", word: "SOCKS" },
  { category: "CLOTHING & APPAREL", word: "SHOES" }, { category: "CLOTHING & APPAREL", word: "SNEAKERS" }, { category: "CLOTHING & APPAREL", word: "BOOTS" }, { category: "CLOTHING & APPAREL", word: "SANDALS" }, { category: "CLOTHING & APPAREL", word: "HAT" },
  { category: "CLOTHING & APPAREL", word: "CAP" }, { category: "CLOTHING & APPAREL", word: "GLOVES" }, { category: "CLOTHING & APPAREL", word: "SCARF" }, { category: "CLOTHING & APPAREL", word: "BELT" }, { category: "CLOTHING & APPAREL", word: "PAJAMAS" },

  // 9. VEHICLES & TRANSPORT (20)
  { category: "VEHICLES & TRANSPORT", word: "BICYCLE" }, { category: "VEHICLES & TRANSPORT", word: "MOTORCYCLE" }, { category: "VEHICLES & TRANSPORT", word: "AUTOMOBILE" }, { category: "VEHICLES & TRANSPORT", word: "SUPERCAR" }, { category: "VEHICLES & TRANSPORT", word: "TRUCK" },
  { category: "VEHICLES & TRANSPORT", word: "TRACTOR" }, { category: "VEHICLES & TRANSPORT", word: "TRAIN" }, { category: "VEHICLES & TRANSPORT", word: "SUBWAY" }, { category: "VEHICLES & TRANSPORT", word: "AIRPLANE" }, { category: "VEHICLES & TRANSPORT", word: "HELICOPTER" },
  { category: "VEHICLES & TRANSPORT", word: "JETPLANE" }, { category: "VEHICLES & TRANSPORT", word: "SPACESHIP" }, { category: "VEHICLES & TRANSPORT", word: "ROCKETSHIP" }, { category: "VEHICLES & TRANSPORT", word: "SPEEDBOAT" }, { category: "VEHICLES & TRANSPORT", word: "SUBMARINE" },
  { category: "VEHICLES & TRANSPORT", word: "FERRY" }, { category: "VEHICLES & TRANSPORT", word: "YACHT" }, { category: "VEHICLES & TRANSPORT", word: "SCOOTER" }, { category: "VEHICLES & TRANSPORT", word: "AMBULANCE" }, { category: "VEHICLES & TRANSPORT", word: "FIREENGINE" },

  // 10. PLACES & BUILDINGS (20)
  { category: "PLACES & BUILDINGS", word: "SCHOOL" }, { category: "PLACES & BUILDINGS", word: "COLLEGE" }, { category: "PLACES & BUILDINGS", word: "HOSPITAL" }, { category: "PLACES & BUILDINGS", word: "HOTEL" }, { category: "PLACES & BUILDINGS", word: "RESTAURANT" },
  { category: "PLACES & BUILDINGS", word: "MUSEUM" }, { category: "PLACES & BUILDINGS", word: "LIBRARY" }, { category: "PLACES & BUILDINGS", word: "AIRPORT" }, { category: "PLACES & BUILDINGS", word: "STATION" }, { category: "PLACES & BUILDINGS", word: "SUPERMARKET" },
  { category: "PLACES & BUILDINGS", word: "CASTLE" }, { category: "PLACES & BUILDINGS", word: "PALACE" }, { category: "PLACES & BUILDINGS", word: "CHURCH" }, { category: "PLACES & BUILDINGS", word: "FACTORY" }, { category: "PLACES & BUILDINGS", word: "OFFICE" },
  { category: "PLACES & BUILDINGS", word: "STADIUM" }, { category: "PLACES & BUILDINGS", word: "THEATER" }, { category: "PLACES & BUILDINGS", word: "SKYSCRAPER" }, { category: "PLACES & BUILDINGS", word: "COTTAGE" }, { category: "PLACES & BUILDINGS", word: "HOUSE" },

  // 11. NATURE & GEOGRAPHY (20)
  { category: "NATURE & GEOGRAPHY", word: "MOUNTAIN" }, { category: "NATURE & GEOGRAPHY", word: "VALLEY" }, { category: "NATURE & GEOGRAPHY", word: "CANYON" }, { category: "NATURE & GEOGRAPHY", word: "DESERT" }, { category: "NATURE & GEOGRAPHY", word: "FOREST" },
  { category: "NATURE & GEOGRAPHY", word: "JUNGLE" }, { category: "NATURE & GEOGRAPHY", word: "ISLAND" }, { category: "NATURE & GEOGRAPHY", word: "BEACH" }, { category: "NATURE & GEOGRAPHY", word: "OCEAN" }, { category: "NATURE & GEOGRAPHY", word: "RIVER" },
  { category: "NATURE & GEOGRAPHY", word: "WATERFALL" }, { category: "NATURE & GEOGRAPHY", word: "VOLCANO" }, { category: "NATURE & GEOGRAPHY", word: "GEYSER" }, { category: "NATURE & GEOGRAPHY", word: "ICEBERG" }, { category: "NATURE & GEOGRAPHY", word: "GLACIER" },
  { category: "NATURE & GEOGRAPHY", word: "CAVERN" }, { category: "NATURE & GEOGRAPHY", word: "MEADOW" }, { category: "NATURE & GEOGRAPHY", word: "SWAMP" }, { category: "NATURE & GEOGRAPHY", word: "PRAIRIE" }, { category: "NATURE & GEOGRAPHY", word: "OASIS" },

  // 12. SPACE & ASTRONOMY (20)
  { category: "SPACE & ASTRONOMY", word: "PLANET" }, { category: "SPACE & ASTRONOMY", word: "GALAXY" }, { category: "SPACE & ASTRONOMY", word: "NEBULA" }, { category: "SPACE & ASTRONOMY", word: "METEOR" }, { category: "SPACE & ASTRONOMY", word: "COMET" },
  { category: "SPACE & ASTRONOMY", word: "ASTEROID" }, { category: "SPACE & ASTRONOMY", word: "SATELLITE" }, { category: "SPACE & ASTRONOMY", word: "TELESCOPE" }, { category: "SPACE & ASTRONOMY", word: "SUPERNOVA" }, { category: "SPACE & ASTRONOMY", word: "STARLIGHT" },
  { category: "SPACE & ASTRONOMY", word: "SUNRISE" }, { category: "SPACE & ASTRONOMY", word: "MOONLIGHT" }, { category: "SPACE & ASTRONOMY", word: "GRAVITY" }, { category: "SPACE & ASTRONOMY", word: "ORBIT" }, { category: "SPACE & ASTRONOMY", word: "CONSTELLATION" },
  { category: "SPACE & ASTRONOMY", word: "COSMOS" }, { category: "SPACE & ASTRONOMY", word: "UNIVERSE" }, { category: "SPACE & ASTRONOMY", word: "BLACKHOLE" }, { category: "SPACE & ASTRONOMY", word: "ECLIPSE" }, { category: "SPACE & ASTRONOMY", word: "CRATER" },

  // 13. WEATHER & ELEMENTS (20)
  { category: "WEATHER & ELEMENTS", word: "SUNSHINE" }, { category: "WEATHER & ELEMENTS", word: "RAINDROP" }, { category: "WEATHER & ELEMENTS", word: "SNOWFLAKE" }, { category: "WEATHER & ELEMENTS", word: "LIGHTNING" }, { category: "WEATHER & ELEMENTS", word: "THUNDER" },
  { category: "WEATHER & ELEMENTS", word: "HURRICANE" }, { category: "WEATHER & ELEMENTS", word: "TORNADO" }, { category: "WEATHER & ELEMENTS", word: "BLIZZARD" }, { category: "WEATHER & ELEMENTS", word: "RAINBOW" }, { category: "WEATHER & ELEMENTS", word: "WILDFIRE" },
  { category: "WEATHER & ELEMENTS", word: "EARTHQUAKE" }, { category: "WEATHER & ELEMENTS", word: "TSUNAMI" }, { category: "WEATHER & ELEMENTS", word: "AVALANCHE" }, { category: "WEATHER & ELEMENTS", word: "WEATHERMIST" }, { category: "WEATHER & ELEMENTS", word: "SANDSTORM" },
  { category: "WEATHER & ELEMENTS", word: "MONSOON" }, { category: "WEATHER & ELEMENTS", word: "BREEZE" }, { category: "WEATHER & ELEMENTS", word: "PUDDLE" }, { category: "WEATHER & ELEMENTS", word: "CYCLONE" }, { category: "WEATHER & ELEMENTS", word: "TYPHOON" },

  // 14. TECH & DEVICES (20)
  { category: "TECH & DEVICES", word: "SMARTPHONE" }, { category: "TECH & DEVICES", word: "LAPTOP" }, { category: "TECH & DEVICES", word: "KEYBOARD" }, { category: "TECH & DEVICES", word: "MOUSE" }, { category: "TECH & DEVICES", word: "MONITOR" },
  { category: "TECH & DEVICES", word: "PRINTER" }, { category: "TECH & DEVICES", word: "ROUTER" }, { category: "TECH & DEVICES", word: "HEADPHONES" }, { category: "TECH & DEVICES", word: "SPEAKER" }, { category: "TECH & DEVICES", word: "CAMERA" },
  { category: "TECH & DEVICES", word: "SMARTWATCH" }, { category: "TECH & DEVICES", word: "TELEVISION" }, { category: "TECH & DEVICES", word: "PROJECTOR" }, { category: "TECH & DEVICES", word: "CONTROLLER" }, { category: "TECH & DEVICES", word: "DRONE" },
  { category: "TECH & DEVICES", word: "BATTERY" }, { category: "TECH & DEVICES", word: "CHARGER" }, { category: "TECH & DEVICES", word: "MICROPHONE" }, { category: "TECH & DEVICES", word: "WEBCAM" }, { category: "TECH & DEVICES", word: "PROCESSOR" },

  // 15. MUSICAL INSTRUMENTS (20)
  { category: "MUSICAL INSTRUMENTS", word: "PIANO" }, { category: "MUSICAL INSTRUMENTS", word: "GUITAR" }, { category: "MUSICAL INSTRUMENTS", word: "VIOLIN" }, { category: "MUSICAL INSTRUMENTS", word: "DRUMS" }, { category: "MUSICAL INSTRUMENTS", word: "FLUTE" },
  { category: "MUSICAL INSTRUMENTS", word: "TRUMPET" }, { category: "MUSICAL INSTRUMENTS", word: "SAXOPHONE" }, { category: "MUSICAL INSTRUMENTS", word: "CLARINET" }, { category: "MUSICAL INSTRUMENTS", word: "HARP" }, { category: "MUSICAL INSTRUMENTS", word: "ACCORDION" },
  { category: "MUSICAL INSTRUMENTS", word: "CELLO" }, { category: "MUSICAL INSTRUMENTS", word: "TROMBONE" }, { category: "MUSICAL INSTRUMENTS", word: "UKULELE" }, { category: "MUSICAL INSTRUMENTS", word: "BANJO" }, { category: "MUSICAL INSTRUMENTS", word: "HARMONICA" },
  { category: "MUSICAL INSTRUMENTS", word: "CYMBALS" }, { category: "MUSICAL INSTRUMENTS", word: "TAMBOURINE" }, { category: "MUSICAL INSTRUMENTS", word: "XYLOPHONE" }, { category: "MUSICAL INSTRUMENTS", word: "KEYBOARD" }, { category: "MUSICAL INSTRUMENTS", word: "ORGAN" }
];

function generateRoomCode() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  return code;
}

function shuffleArray(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// All real-time socket events MUST live inside this bracket block:
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('createRoom', ({ playerName, gameMode }) => {
    let roomCode = generateRoomCode();
    while (rooms[roomCode]) {
      roomCode = generateRoomCode();
    }

    rooms[roomCode] = {
      code: roomCode,
      hostId: socket.id,
      players: [{ id: socket.id, name: playerName }],
      phase: 'lobby',
      gameMode: gameMode || 'number', 
      round: 1,
      roles: {},
      theNumber: null,
      currentCategory: "",
      readyPlayers: {},
      turnOrder: [], 
      currentTurnIndex: 0,
      answers: {},
      continueVotes: {},
      votes: {},
      tieBreakerActive: false,
      failedImposterGuess: null,
      gameOverReason: ""
    };

    socket.join(roomCode);
    socket.emit('roomUpdated', rooms[roomCode]);
  });

  socket.on('joinRoom', ({ roomCode, playerName }) => {
    const code = roomCode.toUpperCase();
    const room = rooms[code];

    if (!room) return socket.emit('errorMsg', 'Room not found.');
    if (room.phase !== 'lobby') return socket.emit('errorMsg', 'Game has already started.');

    room.players.push({ id: socket.id, name: playerName });
    socket.join(code);
    io.to(code).emit('roomUpdated', room);
  });

  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 3) return socket.emit('errorMsg', 'Need at least 3 players to start!');

    room.phase = 'role';
    room.round = 1;
    room.tieBreakerActive = false;
    room.failedImposterGuess = null;
    room.answers = {};
    room.roles = {};
    room.readyPlayers = {};
    room.currentCategory = "";

    if (room.gameMode === 'rj') {
      const randomObject = rjWordPool[Math.floor(Math.random() * rjWordPool.length)];
      room.theNumber = randomObject.word; 
      room.currentCategory = randomObject.category; 
    } else {
      room.theNumber = Math.floor(Math.random() * 10) + 1;
      room.currentCategory = "NUMBERS";
    }

    const playerIndices = Array.from({ length: room.players.length }, (_, i) => i);
    const shuffledIndices = shuffleArray(playerIndices);
    const imposterIndex = shuffledIndices[0]; 

    room.players.forEach((player, idx) => {
      if (idx === imposterIndex) {
        room.roles[player.id] = 'imposter';
      } else {
        room.roles[player.id] = 'crewmate';
      }
    });

    room.turnOrder = shuffleArray(room.players);

    io.to(room.code).emit('goToRoleScreen', room);
  });

  socket.on('playerReady', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.readyPlayers[socket.id] = true;
    io.to(room.code).emit('readyListUpdated', room.readyPlayers);

    const allReady = room.players.every(p => room.readyPlayers[p.id]);
    if (allReady) {
      room.phase = 'turnReveal';
      io.to(room.code).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('startAnswering', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'answer';
    room.currentTurnIndex = 0;
    if (!room.answers[room.round]) {
      room.answers[room.round] = {};
    }

    io.to(room.code).emit('goToAnswerScreen', room);

    const firstPlayer = room.turnOrder[0];
    io.to(room.code).emit('nextTurnIndex', {
      activePlayerId: firstPlayer.id,
      activePlayerName: firstPlayer.name
    });
  });

  socket.on('submitClue', ({ roomCode, clueWord }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    const activePlayer = room.turnOrder[room.currentTurnIndex];
    if (socket.id !== activePlayer.id) return; 

    room.answers[room.round][socket.id] = clueWord;

    io.to(room.code).emit('clueRevealedLive', {
      playerId: socket.id,
      playerName: activePlayer.name,
      clueWord: clueWord,
      roundAnswers: room.answers[room.round]
    });

    room.currentTurnIndex++;

    if (room.currentTurnIndex < room.turnOrder.length) {
      const nextPlayer = room.turnOrder[room.currentTurnIndex];
      io.to(room.code).emit('nextTurnIndex', {
        activePlayerId: nextPlayer.id,
        activePlayerName: nextPlayer.name
      });
    } else {
      io.to(room.code).emit('showAllClues', room);
    }
  });

  socket.on('nextPhase', ({ roomCode, targetPhase }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    if (targetPhase === 'round2') {
      room.round = 2;
      io.to(room.code).emit('goToTurnRevealScreen', room);
    } 
    else if (targetPhase === 'askContinue') {
      room.continueVotes = {};
      io.to(room.code).emit('promptContinueVote');
    } 
    else if (targetPhase === 'vote') {
      room.votes = {};
      io.to(room.code).emit('goToVoteScreen', room);
    } 
    else if (targetPhase === 'tiebreakerRound') {
      room.tieBreakerActive = true;
      room.round++;
      io.to(room.code).emit('goToTurnRevealScreen', room);
    }
  });

  socket.on('submitContinueChoice', ({ roomCode, choice }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.continueVotes[socket.id] = choice;
    io.to(room.code).emit('continueStatusUpdated', room.continueVotes);

    const allVoted = room.players.every(p => room.continueVotes[p.id]);
    if (allVoted) {
      let moreCount = 0;
      let voteCount = 0;
      Object.values(room.continueVotes).forEach(v => {
        if (v === 'more') moreCount++;
        if (v === 'vote') voteCount++;
      });

      if (moreCount >= voteCount) {
        room.round++;
        io.to(room.code).emit('goToTurnRevealScreen', room);
      } else {
        room.votes = {};
        io.to(room.code).emit('goToVoteScreen', room);
      }
    }
  });

  socket.on('castVote', ({ roomCode, targetPlayerId }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;

    room.votes[socket.id] = targetPlayerId;
    io.to(room.code).emit('voteStatusUpdated', room.votes);

    const allVoted = room.players.every(p => room.votes[p.id]);
    if (allVoted) {
      const voteTally = {};
      room.players.forEach(p => voteTally[p.id] = 0);
      
      Object.values(room.votes).forEach(targetId => {
        if (voteTally[targetId] !== undefined) voteTally[targetId]++;
      });

      let maxVotes = -1;
      let highestVotedPlayers = [];

      Object.entries(voteTally).forEach(([pId, count]) => {
        if (count > maxVotes) {
          maxVotes = count;
          highestVotedPlayers = [pId];
        } else if (count === maxVotes) {
          highestVotedPlayers.push(pId);
        }
      });

      room.voteTally = voteTally;

      if (highestVotedPlayers.length > 1) {
        room.tieBreakerActive = true;
        room.gameOverReason = "It's a tie!";
        io.to(room.code).emit('goToResultScreen', room);
      } else {
        const exiledId = highestVotedPlayers[0];
        room.tieBreakerActive = false;

        if (room.roles[exiledId] === 'imposter') {
          room.gameOverReason = "Crewmates Win! The Imposter was voted out.";
        } else {
          room.gameOverReason = "Imposter Wins! A crewmate was voted out.";
        }
        io.to(room.code).emit('goToResultScreen', room);
      }
    }
  });

  socket.on('imposterGuessNumber', ({ roomCode, guessedNumber }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room) return;
    if (room.roles[socket.id] !== 'imposter') return; 

    room.tieBreakerActive = false;
    const standardGuess = guessedNumber.trim().toUpperCase();
    const standardSecret = String(room.theNumber).trim().toUpperCase();

    if (standardGuess === standardSecret) {
      room.gameOverReason = (room.gameMode === 'rj') ? "Imposter Wins! They guessed the secret word." : "Imposter Wins! They guessed the number.";
    } else {
      room.failedImposterGuess = guessedNumber;
      room.gameOverReason = "Crewmates Win! The Imposter guessed wrong.";
    }
    io.to(room.code).emit('goToResultScreen', room);
  });

  socket.on('resetGame', ({ roomCode }) => {
    const room = rooms[roomCode.toUpperCase()];
    if (!room || room.hostId !== socket.id) return;

    room.phase = 'lobby';
    room.round = 1;
    room.roles = {};
    room.theNumber = null;
    room.currentCategory = "";
    room.readyPlayers = {};
    room.currentTurnIndex = 0;
    room.answers = {};
    room.continueVotes = {};
    room.votes = {};
    room.tieBreakerActive = false;
    room.failedImposterGuess = null;
    room.gameOverReason = "";

    io.to(room.code).emit('roomUpdated', room);
  });

  socket.on('disconnect', () => {
    Object.keys(rooms).forEach(code => {
      const room = rooms[code];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index !== -1) {
        room.players.splice(index, 1);
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

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
