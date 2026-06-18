const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "../public")));

const rooms = {};

function generateRoomCode() {
  let code;
  do {
    code = Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase();
  } while (rooms[code]);

  return code;
}


function shuffle(arr){
  return [...arr].sort(()=>Math.random()-0.5);
}


function assignRoles(room){

  const imposter =
    room.players[
      Math.floor(
        Math.random()*room.players.length
      )
    ];

  room.players.forEach(p=>{
    room.roles[p.id] =
      p.id === imposter.id
      ? "imposter"
      : "crewmate";
  });
}


function sendPrivateRoles(room){

  room.players.forEach(player=>{

    io.to(player.id).emit(
      "roleInfo",
      {
        role:
          room.roles[player.id],

        secret:
          room.roles[player.id]==="imposter"
          ? null
          : room.secret
      }
    );

  });
}



function nextClueTurn(room){

  const answers =
    room.answers[room.round] || {};

  const next =
    room.turnOrder.find(
      p=>answers[p.id]===undefined
    );


  if(next){

    io.to(room.code)
    .emit(
      "nextTurnIndex",
      {
        activePlayerId:next.id,
        activePlayerName:next.name
      }
    );

  }else{

    io.to(room.code)
    .emit(
      "showAllClues",
      answers
    );

  }
}



function createDeck(){

 const suits=[
  "Clubs",
  "Diamonds",
  "Hearts",
  "Spades"
 ];

 const ranks=[
  "A","2","3","4","5","6",
  "7","8","9","10",
  "J","Q","K"
 ];


 let deck=[];


 suits.forEach(s=>{
  ranks.forEach(r=>{
   deck.push({
    suit:s,
    rank:r
   });
  });
 });


 return shuffle(deck);
}



function advanceCardTurn(room){

 let tries=0;

 while(tries < room.players.length){

  room.cardTurn =
   (room.cardTurn+1)
   %
   room.players.length;


  let p =
   room.players[room.cardTurn];


  if(
   room.hands[p.id] &&
   room.hands[p.id].length
  ){
    return;
  }

  tries++;
 }
}



io.on("connection",(socket)=>{


console.log(
"connected",
socket.id
);



socket.on(
"createRoom",
({playerName,gameMode})=>{


const code =
generateRoomCode();


rooms[code]={

 code,

 hostId:socket.id,

 gameMode:
 gameMode||"number",


 phase:"lobby",

 players:[
  {
   id:socket.id,
   name:playerName
  }
 ],


 roles:{},

 secret:null,

 round:1,

 turnOrder:[],

 answers:{},

 votes:{},

 voters:{},


 hands:{},

 board:{},

 standings:[],

 cardTurn:0

};


socket.join(code);

socket.emit(
"roomUpdated",
rooms[code]
);


});





socket.on(
"joinRoom",
({roomCode,playerName})=>{


const code =
roomCode.toUpperCase();


const room =
rooms[code];


if(!room)
return socket.emit(
"errorMsg",
"Room not found"
);


if(room.phase!=="lobby")
return;


room.players.push({
 id:socket.id,
 name:playerName
});


socket.join(code);


io.to(code)
.emit(
"roomUpdated",
room
);


});






socket.on(
"startGame",
({roomCode})=>{


const room =
rooms[roomCode];


if(
!room ||
room.hostId!==socket.id
)return;



if(room.players.length<2)
return socket.emit(
"errorMsg",
"Need 2 players"
);




if(room.gameMode==="card"){


room.phase="cards";


room.hands={};


let deck=createDeck();


room.players.forEach(p=>{
 room.hands[p.id]=[];
});


let i=0;


while(deck.length){

 let p =
 room.players[
 i%room.players.length
 ];

 room.hands[p.id]
 .push(deck.pop());

 i++;
}


io.to(roomCode)
.emit(
"sevenClubsStart",
{
 players:room.players,
 hand:null
}
);



room.players.forEach(p=>{

io.to(p.id)
.emit(
"sevenClubsHand",
room.hands[p.id]
);

});


return;

}





room.phase="roles";


room.secret =
room.gameMode==="rj"
?
"SPACE STATION"
:
Math.floor(Math.random()*10)+1;


assignRoles(room);


io.to(roomCode)
.emit(
"goToRoleScreen",
{
 players:room.players,
 gameMode:room.gameMode
}
);


sendPrivateRoles(room);



});
// ===============================
// NUMBER / RJ CLUE FLOW
// ===============================


socket.on(
"playerReady",
({roomCode})=>{

const room=rooms[roomCode];

if(!room)return;


room.ready =
room.ready || {};


room.ready[socket.id]=true;


if(
Object.keys(room.ready).length
===
room.players.length
){

room.turnOrder =
shuffle(room.players);


room.phase="clue";


io.to(roomCode)
.emit(
"goToAnswerScreen",
room
);


nextClueTurn(room);

}

});





socket.on(
"submitClue",
({roomCode,clueWord})=>{


const room =
rooms[roomCode];


if(!room)return;


room.answers[room.round] =
room.answers[room.round]||{};



if(
room.answers[room.round][socket.id]
)return;



const active =
room.turnOrder.find(
p =>
room.answers[room.round][p.id]
===undefined
);



if(
!active ||
active.id!==socket.id
)return;



room.answers[room.round][socket.id]
=
String(clueWord).trim();



io.to(roomCode)
.emit(
"clueRevealedLive",
{
playerId:socket.id,
clueWord
}
);



nextClueTurn(room);



});






// ===============================
// VOTING
// ===============================


socket.on(
"castVote",
({roomCode,targetPlayerId})=>{


const room=rooms[roomCode];


if(!room)return;


room.voters =
room.voters || {};


if(room.voters[socket.id])
return;



room.voters[socket.id]
=
targetPlayerId;



room.votes =
room.votes || {};


room.votes[targetPlayerId]
=
(room.votes[targetPlayerId]||0)+1;



if(
Object.keys(room.voters).length
===
room.players.length
){


let winner =
Object.entries(room.votes)
.sort((a,b)=>b[1]-a[1])[0][0];


const eliminated =
winner;



if(
room.roles[eliminated]
==="imposter"
){

room.result =
"CREWMATES WIN";

}else{

room.result =
"IMPOSTER WINS";

}



room.phase="result";


io.to(roomCode)
.emit(
"goToResultScreen",
{
result:room.result
}
);


}

});







socket.on(
"imposterGuessNumber",
({roomCode,guessedNumber})=>{


const room=rooms[roomCode];


if(!room)return;


if(
String(guessedNumber)
.trim()
.toUpperCase()
===
String(room.secret)
.trim()
.toUpperCase()
){

room.result =
"IMPOSTER WINS";

}else{

room.result =
"CREWMATES WIN";

}


room.phase="result";


io.to(roomCode)
.emit(
"goToResultScreen",
{
result:room.result
}
);



});







// ===============================
// SEVEN CLUBS
// ===============================


socket.on(
"sevenClubsPlayCard",
({roomCode,rank,suit})=>{


const room =
rooms[roomCode];


if(!room)return;



const player =
room.players
[room.cardTurn];



if(
!player ||
player.id!==socket.id
)
return;



const hand =
room.hands[socket.id];


const index =
hand.findIndex(
c =>
c.rank===rank &&
c.suit===suit
);



if(index===-1)
return;



// remove card

const card =
hand.splice(index,1)[0];



room.board =
room.board || {};

room.board[suit] =
room.board[suit]||[];



room.board[suit].push(card);



if(hand.length===0){

if(
!room.standings.includes(socket.id)
){

room.standings.push(
socket.id
);

}

}



advanceCardTurn(room);



io.to(roomCode)
.emit(
"sevenClubsUpdateBoard",
{
board:room.board,
activePlayer:
room.players[room.cardTurn],
standings:
room.standings
}
);



});







// ===============================
// RESET
// ===============================


socket.on(
"resetGame",
({roomCode})=>{


const room =
rooms[roomCode];


if(!room)return;



room.phase="lobby";

room.round=1;

room.roles={};

room.secret=null;

room.answers={};

room.votes={};

room.voters={};

room.hands={};

room.board={};

room.standings=[];



io.to(roomCode)
.emit(
"roomUpdated",
room
);



});







// ===============================
// DISCONNECT CLEANUP
// ===============================


socket.on(
"disconnect",
()=>{


for(
const code in rooms
){

const room =
rooms[code];


room.players =
room.players.filter(
p=>p.id!==socket.id
);



delete room.roles[socket.id];

delete room.hands[socket.id];

delete room.ready?.[socket.id];

delete room.voters?.[socket.id];



if(
room.players.length===0
){

delete rooms[code];


}else{


if(
room.hostId===socket.id
){

room.hostId =
room.players[0].id;

}



io.to(code)
.emit(
"roomUpdated",
room
);


}


}


});



});





server.listen(
PORT,
()=>{

console.log(
`Server running on ${PORT}`
);

});
